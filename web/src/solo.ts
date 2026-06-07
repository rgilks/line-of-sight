// Cepheus · Survive the Horde — single-player game (static page, no server). The
// computer runs everything locally.
//
// Phase 2: turn-based movement. On a character's turn you click within their move
// ring to glide there (walkable + visible + unoccupied), open adjacent doors, and
// end the turn to pass to the next in initiative order. Fog reveals the union of
// the squad's line of sight, with visited areas kept as dim memory.
//
// Reuses the shared core (deck generator, geometry, dice, rules) and the
// multiplayer client's pure pieces (deck renderer, counter rendering, portraits).
import {generateMap} from './synth/generate-map'
import {renderMap} from './synth/render-map'
import {defaultSpec, type GeneratedMap} from './synth/types'
import {drawCounterToken} from './counter-render'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import {roll2D6} from '../../core/dice'
import {
  distanceToOccluder,
  doorReachForGrid,
  hasLineOfSight,
  visibilityPolygon,
  type DoorOccluder,
  type Point
} from '../../core/los'
import {orderByInitiative} from '../../core/rules'
import {PARTY} from './solo/characters'
import {MONSTERS} from './solo/monsters'
import {weaponById} from './solo/gear'
import {rangeBandFor} from './solo/combat'
import {decideMonster} from './solo/ai'
import {createDiceRoller, type DiceRoller} from '@rgilks/cepheus-dice'
import {
  activeEntity,
  dexDm,
  entityById,
  isActive,
  isDead,
  isDown,
  moveBudgetPx,
  withinReach,
  type Entity,
  type GroundItem,
  type ItemStack,
  type Prop,
  type SoloState
} from './solo/model'
import {buildWalkGrid, cellCenter, cellOf, isFloor, type Cell, type WalkGrid} from './solo/grid'
import {reduce} from './solo/reducer'
import './solo.css'

const SIGHT_RADIUS = 700
const WAVES_TOTAL = 3

preloadCounterPortraits()
for (const image of counterPortraits.values()) image.addEventListener('load', requestDraw)

let state: SoloState | null = null
let showGrid = false
let selectedId: string | null = null // the entity the player has tapped (target / patient)
let monsterCounter = 0

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let panel: HTMLDivElement
let boardViewport: HTMLDivElement
let diceOverlay: HTMLDivElement
let diceRoller: DiceRoller

// An rng that yields the given die faces first (mapped to rollD6 buckets), then
// falls back to Math.random — so a visual roll's faces drive the to-hit throw.
const queuedFaces =
  (faces: number[]): (() => number) =>
  () => {
    const next = faces.shift()
    return next === undefined ? Math.random() : (next - 0.5) / 6
  }

// Camera: the canvas backing store stays at map resolution; we zoom by sizing its
// display box (map × zoom) inside a scrollable viewport and pan via scroll. Click
// mapping reads the rendered rect, so it stays correct at any zoom.
let zoom = 1
const MIN_ZOOM = 0.15
const MAX_ZOOM = 5
let panPointer: {id: number; startX: number; startY: number; scrollLeft: number; scrollTop: number} | null = null
let touchPan: {x: number; y: number; scrollLeft: number; scrollTop: number} | null = null
let pinch: {startDist: number; startZoom: number; boardX: number; boardY: number} | null = null
let touchMoved = false

// ---- movement animation (tween) ------------------------------------------
// Mirrors the multiplayer client's ease so glides feel identical. renderPos is
// each entity's drawn position; the rAF loop is the sole owner of draw().
const MOVE_EASE_MS = 320
type Anim = {fromX: number; fromY: number; toX: number; toY: number; start: number}
const renderPos = new Map<string, Point>()
const anim = new Map<string, Anim>()
const tweenWaiters = new Map<string, Array<() => void>>()
let rafId = 0
let busy = false // true while the monster AI is taking its turns (locks player input)

const now = (): number => performance.now()
const positionOf = (entity: Entity): Point => renderPos.get(entity.id) ?? {x: entity.x, y: entity.y}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Resolves once entity `id`'s in-flight glide finishes (or immediately if none).
const waitTween = (id: string): Promise<void> =>
  new Promise((resolve) => {
    if (!anim.has(id)) {
      resolve()
      return
    }
    const waiters = tweenWaiters.get(id) ?? []
    waiters.push(resolve)
    tweenWaiters.set(id, waiters)
  })

const startEase = (id: string, from: Point, to: Point): void => {
  anim.set(id, {fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, start: now()})
  ensureRaf()
}

const stepRenderPos = (t: number): boolean => {
  let moving = false
  for (const [id, a] of anim) {
    const progress = Math.min(1, (t - a.start) / MOVE_EASE_MS)
    const eased = 1 - (1 - progress) ** 3
    renderPos.set(id, {x: a.fromX + (a.toX - a.fromX) * eased, y: a.fromY + (a.toY - a.fromY) * eased})
    if (progress >= 1) {
      anim.delete(id)
      const waiters = tweenWaiters.get(id)
      if (waiters) {
        tweenWaiters.delete(id)
        for (const resolve of waiters) resolve()
      }
    } else {
      moving = true
    }
  }
  return moving
}

function requestDraw(): void {
  ensureRaf()
}

const ensureRaf = (): void => {
  if (rafId === 0) rafId = requestAnimationFrame(frame)
}

const frame = (t: number): void => {
  rafId = 0
  const moving = stepRenderPos(t)
  draw()
  if (moving) ensureRaf()
}

// ---- offscreen fog layers (sized per map) --------------------------------
const explored = document.createElement('canvas')
const exploredCtx = explored.getContext('2d') as CanvasRenderingContext2D
const cur = document.createElement('canvas')
const curCtx = cur.getContext('2d') as CanvasRenderingContext2D
const scratch = document.createElement('canvas')
const scratchCtx = scratch.getContext('2d') as CanvasRenderingContext2D

const sizeFogLayers = (w: number, h: number): void => {
  for (const layer of [explored, cur, scratch]) {
    layer.width = w
    layer.height = h
  }
  exploredCtx.clearRect(0, 0, w, h)
}

// ---- spawning -------------------------------------------------------------
const nearestFloorCells = (grid: WalkGrid, start: Cell, count: number): Cell[] => {
  const found: Cell[] = []
  const seen = new Set<string>([`${start.cx},${start.cy}`])
  const queue: Cell[] = [start]
  while (queue.length > 0 && found.length < count) {
    const cell = queue.shift() as Cell
    if (isFloor(grid, cell.cx, cell.cy)) found.push(cell)
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0]
    ]) {
      const next = {cx: cell.cx + dx, cy: cell.cy + dy}
      const key = `${next.cx},${next.cy}`
      if (seen.has(key)) continue
      seen.add(key)
      queue.push(next)
    }
  }
  return found
}

// The party boards together: cluster them on floor near a central room's center.
const spawnParty = (map: GeneratedMap, grid: WalkGrid): Entity[] => {
  const mid = {x: map.width / 2, y: map.height / 2}
  const home =
    [...map.rooms]
      .filter((room) => room.w * room.h >= 4)
      .sort(
        (a, b) =>
          Math.hypot((a.x + a.w / 2) * map.gridScale - mid.x, (a.y + a.h / 2) * map.gridScale - mid.y) -
          Math.hypot((b.x + b.w / 2) * map.gridScale - mid.x, (b.y + b.h / 2) * map.gridScale - mid.y)
      )[0] ?? map.rooms[0]
  const center: Cell = {cx: Math.floor(home.x + home.w / 2), cy: Math.floor(home.y + home.h / 2)}
  const cells = nearestFloorCells(grid, center, PARTY.length)
  return PARTY.map((pre, index) => {
    const at = cellCenter(grid, (cells[index] ?? center).cx, (cells[index] ?? center).cy)
    const weapon = weaponById(pre.weaponId)
    const inventory: ItemStack[] = []
    if (weapon.magazine && pre.spareAmmo > 0) {
      inventory.push({kind: 'ammo', weaponId: pre.weaponId, count: pre.spareAmmo})
    }
    if (pre.medkits > 0) inventory.push({kind: 'medkit', count: pre.medkits})
    return {
      id: pre.id,
      faction: 'pc' as const,
      kind: pre.kind,
      label: pre.label,
      x: at.x,
      y: at.y,
      stats: {...pre.stats},
      statsMax: {...pre.stats},
      skills: {...pre.skills},
      weaponId: pre.weaponId,
      armorId: pre.armorId,
      inventory,
      loadedRounds: weapon.magazine ?? 0,
      initiative: null,
      order: index
    }
  })
}

const roomCenterPx = (map: GeneratedMap, room: {x: number; y: number; w: number; h: number}): Point => ({
  x: (room.x + room.w / 2) * map.gridScale,
  y: (room.y + room.h / 2) * map.gridScale
})

const monsterEntity = (block: (typeof MONSTERS)[number], x: number, y: number): Entity => {
  monsterCounter += 1
  return {
    id: `mon-${monsterCounter}-${block.id}`,
    faction: 'monster',
    kind: block.kind,
    label: block.name,
    x,
    y,
    stats: {...block.stats},
    statsMax: {...block.stats},
    skills: {...block.skills},
    weaponId: block.weaponId,
    armorId: block.armorId,
    inventory: [],
    loadedRounds: 0,
    moveMeters: block.moveMeters,
    initiative: null,
    order: 100 + monsterCounter,
    behaviour: block.behaviour
  }
}

// The interior floor cell just inside each hull airlock — where boarding waves
// appear. Marches inward from each airlock door (ids 'airlock-n/s/w/e…').
const airlockSpawnCells = (map: GeneratedMap, grid: WalkGrid): Cell[] => {
  const cells: Cell[] = []
  const seen = new Set<string>()
  for (const o of map.occluders) {
    if (o.type !== 'door' || !o.id.startsWith('airlock')) continue
    const dirChar = o.id.charAt('airlock-'.length)
    const dir =
      dirChar === 'n' ? {x: 0, y: 1} : dirChar === 's' ? {x: 0, y: -1} : dirChar === 'w' ? {x: 1, y: 0} : {x: -1, y: 0}
    const midX = (o.x1 + o.x2) / 2
    const midY = (o.y1 + o.y2) / 2
    for (let k = 1; k <= 8; k += 1) {
      const c = cellOf(grid, midX + dir.x * k * grid.gridScale, midY + dir.y * k * grid.gridScale)
      if (isFloor(grid, c.cx, c.cy)) {
        const key = `${c.cx},${c.cy}`
        if (!seen.has(key)) {
          seen.add(key)
          cells.push(c)
        }
        break
      }
    }
  }
  return cells
}

// Build wave `n`: aliens at the airlocks (more, and a heavier mix, each wave).
// They path inward toward the squad on their turns.
const buildWave = (map: GeneratedMap, grid: WalkGrid, n: number): Entity[] => {
  const cells = airlockSpawnCells(map, grid)
  if (cells.length === 0) return []
  const count = Math.min(2 + n, 6, cells.length)
  const out: Entity[] = []
  for (let i = 0; i < count; i += 1) {
    const cell = cells[i % cells.length]
    const at = cellCenter(grid, cell.cx, cell.cy)
    out.push(monsterEntity(MONSTERS[(i + n) % MONSTERS.length], at.x, at.y))
  }
  return out
}

// Scatter ammo + medkits across mid-deck rooms so the squad must move to resupply.
const scatterLoot = (map: GeneratedMap, grid: WalkGrid): GroundItem[] => {
  const rooms = [...map.rooms].filter((room) => room.w * room.h >= 4)
  const stacks: ItemStack[] = [
    {kind: 'ammo', weaponId: 'autorifle', count: 40},
    {kind: 'ammo', weaponId: 'shotgun', count: 12},
    {kind: 'medkit', count: 1},
    {kind: 'medkit', count: 1}
  ]
  const out: GroundItem[] = []
  for (let i = 0; i < stacks.length && rooms.length > 0; i += 1) {
    const room = rooms[(i * 3 + 1) % rooms.length]
    const center = roomCenterPx(map, room)
    const start = cellOf(grid, center.x, center.y)
    const cell = nearestFloorCells(grid, start, 1)[0] ?? start
    const at = cellCenter(grid, cell.cx, cell.cy)
    out.push({id: `loot-${i}`, x: at.x, y: at.y, stack: stacks[i]})
  }
  return out
}

// Solid, pushable crates: promote the generator's 'crate' furniture (cargo rooms)
// AND scatter a few loose crates in other rooms so every deck has barricade
// material. One prop per cell; skips cells a character stands on. Crate
// decorations are dropped from the rendered map so they don't double-draw.
const MAX_PROPS = 10
const makeProps = (map: GeneratedMap, grid: WalkGrid, entities: Entity[]): Prop[] => {
  const occupied = new Set(
    entities.map((e) => {
      const c = cellOf(grid, e.x, e.y)
      return `${c.cx},${c.cy}`
    })
  )
  const props: Prop[] = []
  const used = new Set<string>()
  const tryAdd = (cx: number, cy: number): void => {
    const key = `${cx},${cy}`
    if (props.length >= MAX_PROPS || used.has(key) || occupied.has(key) || !isFloor(grid, cx, cy)) return
    used.add(key)
    const at = cellCenter(grid, cx, cy)
    props.push({id: `crate-${props.length}`, x: at.x, y: at.y})
  }

  // 1. Promote any cargo-room crate furniture.
  const crates = map.decorations.filter((d) => d.kind === 'crate')
  map.decorations = map.decorations.filter((d) => d.kind !== 'crate')
  for (const crate of crates) {
    tryAdd(Math.floor((crate.x + crate.w / 2) / grid.gridScale), Math.floor((crate.y + crate.h / 2) / grid.gridScale))
  }

  // 2. Guarantee barricade material: a loose crate near the centre of several rooms.
  const rooms = [...map.rooms].filter((room) => room.w * room.h >= 4)
  for (let i = 0; i < rooms.length && props.length < 6; i += 1) {
    const room = rooms[(i * 5 + 2) % rooms.length]
    tryAdd(Math.floor(room.x + room.w / 2), Math.floor(room.y + room.h / 2))
  }
  return props
}

const rollInitiative = (entities: Entity[]): Entity[] => {
  for (const entity of entities) {
    const [a, b] = roll2D6()
    entity.initiative = a + b + dexDm(entity)
  }
  return orderByInitiative(entities)
}

// ---- new game -------------------------------------------------------------
const newGame = (seed = Math.floor(Math.random() * 100000)): void => {
  const map = generateMap(defaultSpec(seed))
  const grid = buildWalkGrid(map)
  monsterCounter = 0
  const entities = rollInitiative([...spawnParty(map, grid), ...buildWave(map, grid, 1)])
  const firstPc = entities.findIndex((entity) => entity.faction === 'pc' && isActive(entity))
  selectedId = null
  busy = false
  state = {
    seed,
    map,
    grid,
    // Doors open at start so the horde can roam; the squad closes a door (or shoves
    // a crate into it) to wall monsters out.
    doorStates: Object.fromEntries(
      map.occluders.filter((o) => o.type === 'door').map((d) => [d.id, {open: true}])
    ),
    sightRadius: SIGHT_RADIUS,
    entities,
    ground: scatterLoot(map, grid),
    props: makeProps(map, grid, entities),
    turnPtr: firstPc >= 0 ? firstPc : 0,
    round: 1,
    wave: 1,
    wavesTotal: WAVES_TOTAL,
    moveRemainingPx: moveBudgetPx(grid.gridScale),
    actionUsed: false,
    phase: {t: 'playerTurn'},
    log: ['Wave 1 boards. Hold the line.']
  }
  renderPos.clear()
  anim.clear()
  for (const entity of entities) renderPos.set(entity.id, {x: entity.x, y: entity.y})
  canvas.width = map.width
  canvas.height = map.height
  sizeFogLayers(map.width, map.height)
  fitBoardToViewport()
  renderPanel()
  requestDraw()
}

// ---- dispatch: reduce + animate the result --------------------------------
const dispatch = (action: Parameters<typeof reduce>[1], rng?: () => number): void => {
  if (!state) return
  const before = new Map(state.entities.map((entity) => [entity.id, {x: entity.x, y: entity.y}]))
  state = reduce(state, action, rng)
  for (const entity of state.entities) {
    const old = before.get(entity.id)
    if (old && (old.x !== entity.x || old.y !== entity.y)) {
      startEase(entity.id, renderPos.get(entity.id) ?? old, {x: entity.x, y: entity.y})
    }
  }
  renderPanel()
  requestDraw()
}

// When the squad has cleared every monster, spawn the next wave at the airlocks —
// or, if the final wave is down, win.
const afterTurnUpkeep = (): void => {
  if (!state || state.phase.t !== 'playerTurn') return
  if (state.entities.some((entity) => entity.faction === 'monster' && !isDead(entity))) return
  if (state.wave >= state.wavesTotal) {
    state = {...state, phase: {t: 'won'}}
    renderPanel()
    requestDraw()
    return
  }
  dispatch({t: 'AddWave', monsters: buildWave(state.map, state.grid, state.wave + 1)})
}

// Run monster turns to completion: each plans (decideMonster), glides its steps,
// then attacks. Player input is locked meanwhile.
const runMonsters = async (): Promise<void> => {
  busy = true
  renderPanel()
  afterTurnUpkeep()
  let guard = 0
  while (state && state.phase.t === 'playerTurn' && activeEntity(state)?.faction === 'monster' && guard < 400) {
    guard += 1
    const id = (activeEntity(state) as Entity).id
    const plan = decideMonster(state, id)
    for (const cell of plan.moves) {
      if (!state) break
      dispatch({t: 'Move', to: cellCenter(state.grid, cell.cx, cell.cy)})
      await waitTween(id)
    }
    if (state && state.phase.t === 'playerTurn' && plan.attackTargetId) {
      dispatch({t: 'Attack', targetId: plan.attackTargetId})
      await delay(220)
    }
    if (state) dispatch({t: 'EndTurn'})
    afterTurnUpkeep()
  }
  busy = false
  renderPanel()
  requestDraw()
}

// A player action during their own turn (movement, an action, a door, a push).
const playerAct = (action: Parameters<typeof reduce>[1]): void => {
  if (busy || !state || state.phase.t !== 'playerTurn') return
  dispatch(action)
}

const showDice = (): void => {
  diceOverlay.style.display = 'block'
  diceRoller.resize()
}
const hideDice = (): void => {
  diceOverlay.style.display = 'none'
}

// An attack: roll the 3D dice, then resolve the to-hit with the settled faces.
const onAttack = async (targetId: string): Promise<void> => {
  if (busy || !state || state.phase.t !== 'playerTurn') return
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc' || state.actionUsed) return
  busy = true
  renderPanel()
  showDice()
  const {faces} = await diceRoller.roll(2)
  dispatch({t: 'Attack', targetId}, queuedFaces([...faces]))
  await delay(800)
  hideDice()
  busy = false
  renderPanel()
  requestDraw()
}

// End the player's turn, then hand off to the monster AI.
const endTurn = (): void => {
  if (busy || !state || state.phase.t !== 'playerTurn') return
  dispatch({t: 'EndTurn'})
  void runMonsters()
}

// ---- camera: zoom (wheel / pinch) + pan (drag / scroll) -------------------
const updateCanvasDisplaySize = (): void => {
  if (!state) return
  canvas.style.width = `${state.map.width * zoom}px`
  canvas.style.height = `${state.map.height * zoom}px`
}

const fitBoardToViewport = (): void => {
  if (!state || !boardViewport) return
  const pad = 24
  const availWidth = boardViewport.clientWidth - pad
  const availHeight = boardViewport.clientHeight - pad
  if (availWidth <= 0 || availHeight <= 0) return
  zoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.min(availWidth / state.map.width, availHeight / state.map.height))
  )
  updateCanvasDisplaySize()
  boardViewport.scrollLeft = 0
  boardViewport.scrollTop = 0
}

const setZoom = (
  next: number,
  anchor?: {boardX: number; boardY: number; viewportX: number; viewportY: number}
): void => {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
  updateCanvasDisplaySize()
  if (anchor && boardViewport) {
    boardViewport.scrollLeft = anchor.boardX * zoom - anchor.viewportX
    boardViewport.scrollTop = anchor.boardY * zoom - anchor.viewportY
  }
}

const handleWheel = (event: WheelEvent): void => {
  if (!state || !boardViewport) return
  event.preventDefault()
  const rect = canvas.getBoundingClientRect()
  const vp = boardViewport.getBoundingClientRect()
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
  setZoom(zoom * factor, {
    boardX: ((event.clientX - rect.left) / rect.width) * state.map.width,
    boardY: ((event.clientY - rect.top) / rect.height) * state.map.height,
    viewportX: event.clientX - vp.left,
    viewportY: event.clientY - vp.top
  })
}

// Desktop pan: right/middle drag, or ⌘/Ctrl + left-drag (left alone is "act").
const shouldStartPan = (event: PointerEvent): boolean =>
  event.button === 1 || event.button === 2 || (event.button === 0 && (event.metaKey || event.ctrlKey))

const onPanMove = (event: PointerEvent): void => {
  if (!boardViewport || !panPointer || panPointer.id !== event.pointerId) return
  event.preventDefault()
  boardViewport.scrollLeft = panPointer.scrollLeft - (event.clientX - panPointer.startX)
  boardViewport.scrollTop = panPointer.scrollTop - (event.clientY - panPointer.startY)
}

const endPan = (event: PointerEvent): void => {
  if (!panPointer || panPointer.id !== event.pointerId) return
  panPointer = null
  boardViewport?.classList.remove('is-panning')
  window.removeEventListener('pointermove', onPanMove)
  window.removeEventListener('pointerup', endPan)
  window.removeEventListener('pointercancel', endPan)
}

const onPanPointerDown = (event: PointerEvent): void => {
  if (!boardViewport || !shouldStartPan(event)) return
  event.preventDefault()
  panPointer = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: boardViewport.scrollLeft,
    scrollTop: boardViewport.scrollTop
  }
  boardViewport.classList.add('is-panning')
  window.addEventListener('pointermove', onPanMove)
  window.addEventListener('pointerup', endPan)
  window.addEventListener('pointercancel', endPan)
}

const blockContextMenu = (event: Event): void => event.preventDefault()

// Touch: one finger pans (or taps to act), two fingers pinch-zoom.
type TouchPt = {id: number; x: number; y: number}
const touchList = (event: TouchEvent): TouchPt[] =>
  Array.from(event.touches).map((t) => ({id: t.identifier, x: t.clientX, y: t.clientY}))

const onTouchStart = (event: TouchEvent): void => {
  if (!boardViewport || !state) return
  const touches = touchList(event)
  touchMoved = false
  if (touches.length === 1) {
    touchPan = {x: touches[0].x, y: touches[0].y, scrollLeft: boardViewport.scrollLeft, scrollTop: boardViewport.scrollTop}
    pinch = null
  } else if (touches.length >= 2) {
    const rect = canvas.getBoundingClientRect()
    const midX = (touches[0].x + touches[1].x) / 2
    const midY = (touches[0].y + touches[1].y) / 2
    pinch = {
      startDist: Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y),
      startZoom: zoom,
      boardX: ((midX - rect.left) / rect.width) * state.map.width,
      boardY: ((midY - rect.top) / rect.height) * state.map.height
    }
    touchPan = null
  }
}

const onTouchMove = (event: TouchEvent): void => {
  if (!boardViewport) return
  const touches = touchList(event)
  if (pinch && touches.length >= 2) {
    event.preventDefault()
    touchMoved = true
    const vp = boardViewport.getBoundingClientRect()
    const midX = (touches[0].x + touches[1].x) / 2
    const midY = (touches[0].y + touches[1].y) / 2
    const dist = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
    setZoom(pinch.startZoom * (dist / Math.max(1, pinch.startDist)), {
      boardX: pinch.boardX,
      boardY: pinch.boardY,
      viewportX: midX - vp.left,
      viewportY: midY - vp.top
    })
  } else if (touchPan && touches.length === 1) {
    const dx = touches[0].x - touchPan.x
    const dy = touches[0].y - touchPan.y
    if (Math.hypot(dx, dy) > 6) touchMoved = true
    if (touchMoved) {
      event.preventDefault()
      boardViewport.scrollLeft = touchPan.scrollLeft - dx
      boardViewport.scrollTop = touchPan.scrollTop - dy
    }
  }
}

const onTouchEnd = (event: TouchEvent): void => {
  if (!touchMoved && !pinch && event.changedTouches.length === 1) {
    const t = event.changedTouches[0]
    actAt(t.clientX, t.clientY)
  }
  if (event.touches.length === 0) {
    touchPan = null
    pinch = null
  }
}

// ---- input ----------------------------------------------------------------
const boardPointFromXY = (clientX: number, clientY: number): Point => {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height
  }
}

// A door the active PC could toggle and that the click landed on (near its
// segment). Returns its id, else null → the click is a move instead.
const doorHitAt = (point: Point): string | null => {
  if (!state) return null
  const actor = activeEntity(state)
  if (!actor) return null
  const reach = doorReachForGrid(state.grid.gridScale)
  const near = state.grid.gridScale * 0.6
  let best: {id: string; d: number} | null = null
  for (const occluder of state.map.occluders) {
    if (occluder.type !== 'door') continue
    if (distanceToOccluder(point, occluder) > near) continue
    if (distanceToOccluder({x: actor.x, y: actor.y}, occluder) > reach) continue
    const d = distanceToOccluder(point, occluder)
    if (!best || d < best.d) best = {id: occluder.id, d}
  }
  return best?.id ?? null
}

// Is (x,y) within any conscious PC's current line of sight? Gates monster + loot
// visibility (you only see hostiles you can actually see).
const visibleToSquad = (s: SoloState, x: number, y: number): boolean =>
  s.entities.some(
    (e) =>
      e.faction === 'pc' &&
      isActive(e) &&
      Math.hypot(e.x - x, e.y - y) <= s.sightRadius &&
      hasLineOfSight({x: e.x, y: e.y}, {x, y}, s.map.occluders, s.doorStates)
  )

// The entity the click landed on: any PC, or a monster the squad can currently see.
const entityHitAt = (point: Point): Entity | null => {
  if (!state) return null
  const tol = state.map.gridScale * 0.7
  let best: {entity: Entity; d: number} | null = null
  for (const entity of state.entities) {
    if (isDead(entity)) continue
    if (entity.faction === 'monster' && !visibleToSquad(state, entity.x, entity.y)) continue
    const at = positionOf(entity)
    const d = Math.hypot(at.x - point.x, at.y - point.y)
    if (d <= tol && (!best || d < best.d)) best = {entity, d}
  }
  return best?.entity ?? null
}

// Act at a screen point: toggle an adjacent door, select a tapped entity (target /
// patient), else move the active PC there.
function actAt(clientX: number, clientY: number): void {
  if (!state || busy) return
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc') return
  const point = boardPointFromXY(clientX, clientY)
  const doorId = doorHitAt(point)
  if (doorId) {
    playerAct({t: 'ToggleDoor', doorId})
    return
  }
  const hit = entityHitAt(point)
  if (hit) {
    selectedId = selectedId === hit.id ? null : hit.id
    renderPanel()
    requestDraw()
    return
  }
  playerAct({t: 'Move', to: point})
}

// Mouse "act" is a plain left click (touch is handled by the touch listeners;
// ⌘/Ctrl-left and right/middle are pan).
const onActionPointerDown = (event: PointerEvent): void => {
  if (event.pointerType === 'touch') return
  if (event.button !== 0 || event.metaKey || event.ctrlKey) return
  actAt(event.clientX, event.clientY)
}

// ---- rendering ------------------------------------------------------------
const tracePolygon = (target: CanvasRenderingContext2D, polygon: Point[]): void => {
  target.moveTo(polygon[0].x, polygon[0].y)
  for (const point of polygon.slice(1)) target.lineTo(point.x, point.y)
  target.closePath()
}

// Three-tier fog over the union of the squad's line of sight: clear where any PC
// can currently see, dim grey where the squad has been (memory), opaque dark
// where never seen.
const drawFog = (s: SoloState): void => {
  const w = s.map.width
  const h = s.map.height

  curCtx.clearRect(0, 0, w, h)
  curCtx.fillStyle = '#fff'
  for (const entity of s.entities) {
    if (entity.faction !== 'pc' || !isActive(entity)) continue
    const at = positionOf(entity)
    const polygon = visibilityPolygon(at.x, at.y, w, h, s.sightRadius, s.map.occluders, s.doorStates)
    if (polygon.length < 3) continue
    curCtx.beginPath()
    tracePolygon(curCtx, polygon)
    curCtx.fill()
  }
  exploredCtx.drawImage(cur, 0, 0)

  // Grey veil everywhere outside the current view (memory + not-yet-darkened).
  scratchCtx.globalCompositeOperation = 'source-over'
  scratchCtx.clearRect(0, 0, w, h)
  scratchCtx.fillStyle = 'rgba(8, 11, 10, 0.62)'
  scratchCtx.fillRect(0, 0, w, h)
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.drawImage(cur, 0, 0)
  scratchCtx.globalCompositeOperation = 'source-over'
  ctx.drawImage(scratch, 0, 0)

  // Opaque dark wherever never explored (covers the grey there).
  scratchCtx.globalCompositeOperation = 'source-over'
  scratchCtx.clearRect(0, 0, w, h)
  scratchCtx.fillStyle = '#050606'
  scratchCtx.fillRect(0, 0, w, h)
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.drawImage(explored, 0, 0)
  scratchCtx.globalCompositeOperation = 'source-over'
  ctx.drawImage(scratch, 0, 0)
}

const drawDoorStates = (s: SoloState): void => {
  const reach = doorReachForGrid(s.grid.gridScale)
  const actor = activeEntity(s)
  // Only hint doors the active PC can actually reach (open = solid "close me",
  // closed = dashed "open me"); far doors just read as gaps/lines in the deck art.
  for (const occluder of s.map.occluders) {
    if (occluder.type !== 'door') continue
    const door = occluder as DoorOccluder
    const reachable = actor != null && actor.faction === 'pc' && distanceToOccluder({x: actor.x, y: actor.y}, door) <= reach
    if (!reachable) continue
    const open = s.doorStates[door.id]?.open ?? false
    ctx.save()
    ctx.lineCap = 'round'
    ctx.strokeStyle = open ? 'rgba(57, 255, 20, 0.85)' : 'rgba(255, 159, 28, 0.85)'
    ctx.lineWidth = open ? 8 : 6
    if (!open) ctx.setLineDash([6, 5])
    ctx.beginPath()
    ctx.moveTo(door.x1, door.y1)
    ctx.lineTo(door.x2, door.y2)
    ctx.stroke()
    ctx.restore()
  }
}

const drawMoveRing = (s: SoloState): void => {
  const actor = activeEntity(s)
  if (!actor || actor.faction !== 'pc' || s.moveRemainingPx <= 1) return
  const at = positionOf(actor)
  ctx.save()
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.55)'
  ctx.lineWidth = 2
  ctx.setLineDash([8, 7])
  ctx.beginPath()
  ctx.arc(at.x, at.y, s.moveRemainingPx, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

const drawFloorDebug = (s: SoloState): void => {
  const g = s.grid
  ctx.save()
  ctx.fillStyle = 'rgba(57, 255, 20, 0.10)'
  for (let cy = 0; cy < g.rows; cy += 1) {
    for (let cx = 0; cx < g.cols; cx += 1) {
      if (g.floor[cy * g.cols + cx] === 1) ctx.fillRect(cx * g.gridScale, cy * g.gridScale, g.gridScale, g.gridScale)
    }
  }
  ctx.restore()
}

const drawGroundItem = (s: SoloState, item: GroundItem): void => {
  const r = s.map.gridScale * 0.22
  ctx.save()
  ctx.translate(item.x, item.y)
  ctx.fillStyle = item.stack.kind === 'medkit' ? 'rgba(57,255,20,0.92)' : 'rgba(255,210,74,0.92)'
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.rect(-r, -r, r * 2, r * 2)
  ctx.fill()
  ctx.stroke()
  if (item.stack.kind === 'medkit') {
    // a small cross
    ctx.strokeStyle = '#041006'
    ctx.lineWidth = Math.max(2, r * 0.35)
    ctx.beginPath()
    ctx.moveTo(0, -r * 0.55)
    ctx.lineTo(0, r * 0.55)
    ctx.moveTo(-r * 0.55, 0)
    ctx.lineTo(r * 0.55, 0)
    ctx.stroke()
  }
  ctx.restore()
}

const drawSelectionRing = (at: Point, faction: Entity['faction'], gridScale: number): void => {
  const radius = gridScale * 0.62
  ctx.save()
  ctx.strokeStyle = faction === 'monster' ? 'rgba(255,72,72,0.95)' : 'rgba(57,255,20,0.95)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

const drawTargetingLine = (from: Point, to: Point): void => {
  ctx.save()
  ctx.strokeStyle = 'rgba(255,72,72,0.7)'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 6])
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

const drawProps = (s: SoloState): void => {
  const sz = s.map.gridScale * 0.74
  for (const prop of s.props) {
    ctx.save()
    ctx.translate(prop.x, prop.y)
    ctx.fillStyle = 'rgba(96, 74, 38, 0.92)'
    ctx.strokeStyle = 'rgba(255, 200, 120, 0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(-sz / 2, -sz / 2, sz, sz)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(-sz / 2, -sz / 2)
    ctx.lineTo(sz / 2, sz / 2)
    ctx.moveTo(sz / 2, -sz / 2)
    ctx.lineTo(-sz / 2, sz / 2)
    ctx.stroke()
    ctx.restore()
  }
}

const draw = (): void => {
  if (!state || !ctx) return
  const s = state
  renderMap(ctx, s.map)
  drawProps(s)
  if (showGrid) drawFloorDebug(s)
  drawFog(s)
  drawDoorStates(s)
  drawMoveRing(s)

  for (const item of s.ground) {
    if (visibleToSquad(s, item.x, item.y)) drawGroundItem(s, item)
  }

  const actor = activeEntity(s)
  const selected = selectedId ? entityById(s, selectedId) : undefined
  if (actor && actor.faction === 'pc' && selected && selected.faction === 'monster' && visibleToSquad(s, selected.x, selected.y)) {
    drawTargetingLine(positionOf(actor), positionOf(selected))
  }

  for (const entity of s.entities) {
    if (isDead(entity)) continue
    if (entity.faction === 'monster' && !visibleToSquad(s, entity.x, entity.y)) continue
    const at = positionOf(entity)
    drawCounterToken(
      ctx,
      {kind: entity.kind, label: entity.label, x: at.x, y: at.y},
      {
        gridScale: s.map.gridScale,
        portraits: counterPortraits,
        counterDefinitions,
        isPov: entity.id === actor?.id
      }
    )
    if (entity.id === selectedId) drawSelectionRing(at, entity.faction, s.map.gridScale)
  }
}

// ---- panel ----------------------------------------------------------------
const endPct = (e: Entity): number => Math.round((Math.max(0, e.stats.end) / Math.max(1, e.statsMax.end)) * 100)

const escapeHtml = (text: string): string =>
  text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

const squadRailHtml = (s: SoloState): string =>
  s.entities
    .filter((e) => e.faction === 'pc')
    .map((e) => {
      const def = counterDefinitions.find((d) => d.kind === e.kind)
      const active = e.id === activeEntity(s)?.id ? ' is-active' : ''
      const selected = e.id === selectedId ? ' is-selected' : ''
      const condition = isDead(e) ? ' · KIA' : isDown(e) ? ' · DOWN' : ''
      return `<li class="solo-combatant${active}${selected}" data-select="${e.id}">
        <img class="solo-combatant-portrait" src="${def?.portrait ?? ''}" alt="" />
        <div class="solo-combatant-main">
          <span class="solo-combatant-label">${e.label}${condition}</span>
          <div class="solo-bar"><div class="solo-bar-fill" style="width:${endPct(e)}%"></div></div>
        </div>
        <span class="solo-combatant-score">${e.initiative ?? '—'}</span>
      </li>`
    })
    .join('')

const btn = (id: string, label: string, enabled: boolean, ghost = false): string =>
  `<button id="${id}" class="solo-button${ghost ? ' solo-button-ghost' : ''} solo-button-sm"${enabled ? '' : ' disabled'}>${label}</button>`

const renderPanel = (): void => {
  if (!state) return
  const s = state
  const actor = activeEntity(s)
  const weapon = actor ? weaponById(actor.weaponId) : null
  const selected = selectedId ? entityById(s, selectedId) : undefined
  const squares = actor ? Math.max(0, Math.round(s.moveRemainingPx / s.grid.gridScale)) : 0

  // Attack availability against a selected, visible enemy.
  const enemy = selected && selected.faction === 'monster' && visibleToSquad(s, selected.x, selected.y) ? selected : undefined
  let attackLabel = 'Attack'
  let canAttack = false
  let targetNote = ''
  if (actor && enemy && weapon) {
    const band = rangeBandFor(Math.hypot(actor.x - enemy.x, actor.y - enemy.y), s.grid.gridScale)
    const inRange = weapon.rangeDm[band] !== undefined
    const hasAmmo = weapon.magazine === undefined || actor.loadedRounds > 0
    canAttack = !s.actionUsed && isActive(actor) && inRange && hasAmmo
    attackLabel = `Attack ${enemy.label}`
    targetNote = `${enemy.label} · ${enemy.stats.end}/${enemy.statsMax.end} END · ${inRange ? band : `out of range (${band})`}${hasAmmo ? '' : ' · no ammo'}`
  }

  const canReload =
    !!actor &&
    isActive(actor) &&
    !s.actionUsed &&
    weapon?.magazine !== undefined &&
    actor.loadedRounds < (weapon.magazine ?? 0) &&
    actor.inventory.some((i) => i.kind === 'ammo' && i.weaponId === actor.weaponId && i.count > 0)

  const patient = selected && selected.faction === 'pc' && !isDead(selected) ? selected : actor
  const canMedkit =
    !!actor &&
    isActive(actor) &&
    !s.actionUsed &&
    actor.inventory.some((i) => i.kind === 'medkit' && i.count > 0) &&
    !!patient &&
    patient.stats.end < patient.statsMax.end &&
    (patient.id === actor.id || withinReach(actor, patient, s.grid.gridScale))

  const loot = actor ? s.ground.find((g) => Math.hypot(actor.x - g.x, actor.y - g.y) <= 1.6 * s.grid.gridScale) : undefined
  const canPickup = !!actor && isActive(actor) && !s.actionUsed && !!loot

  const pushable = actor
    ? s.props.find((p) => {
        const ac = cellOf(s.grid, actor.x, actor.y)
        const pc = cellOf(s.grid, p.x, p.y)
        return Math.abs(pc.cx - ac.cx) + Math.abs(pc.cy - ac.cy) === 1
      })
    : undefined
  const canPush = !!actor && isActive(actor) && !s.actionUsed && !!pushable

  const ammo = actor && weapon?.magazine !== undefined ? `${actor.loadedRounds}/${weapon.magazine}` : '—'
  const recentLog = s.log.slice(-6).map(escapeHtml).join('<br/>')
  const over = s.phase.t === 'lost' || s.phase.t === 'won'
  const overText = s.phase.t === 'won' ? 'Survived — the deck is clear.' : 'Squad lost.'
  const turnLine = busy
    ? 'Hostiles acting…'
    : actor
      ? `${actor.label}'s turn · ${squares} sq · ${weapon?.name ?? ''} ${ammo}`
      : ''

  panel.innerHTML = `
    <header class="solo-brand">
      <img class="solo-brand-mark" src="/favicon.svg" alt="" />
      <div class="solo-brand-text">
        <span class="solo-brand-eyebrow">CEPHEUS</span>
        <span class="solo-brand-tool">Survive the Horde</span>
        <span class="solo-brand-role">Round ${s.round} · Wave ${s.wave}/${s.wavesTotal} · seed ${s.seed}</span>
      </div>
    </header>
    <section class="solo-section">
      <h2 class="solo-h">Squad</h2>
      <ol class="solo-combat-list">${squadRailHtml(s)}</ol>
    </section>
    ${
      over
        ? `<section class="solo-section"><div class="solo-banner${s.phase.t === 'won' ? ' is-won' : ''}">${overText}</div>
           <button id="solo-new" class="solo-button">New game</button></section>`
        : `<section class="solo-section">
      <div class="solo-turn">${turnLine}</div>
      ${targetNote ? `<div class="solo-target">${escapeHtml(targetNote)}</div>` : ''}
      <div class="solo-actions">
        ${btn('solo-attack', attackLabel, canAttack)}
        ${btn('solo-reload', 'Reload', canReload, true)}
        ${btn('solo-medkit', 'Medkit', canMedkit, true)}
        ${btn('solo-pickup', 'Pick up', canPickup, true)}
        ${btn('solo-push', 'Push crate', canPush, true)}
      </div>
      <button id="solo-end" class="solo-button">End turn ↻</button>
    </section>
    <section class="solo-section">
      <div class="solo-log">${recentLog}</div>
    </section>
    <section class="solo-section">
      <button id="solo-new" class="solo-button solo-button-ghost solo-button-sm">New deck</button>
      <label class="solo-check"><input type="checkbox" id="solo-grid" ${showGrid ? 'checked' : ''}/> Show floor grid</label>
    </section>
    <p class="solo-hint">Tap a foe to target it, then Attack. Tap the floor to move, a
    squadmate to treat them, an adjacent door to open it.</p>`
    }`

  for (const el of panel.querySelectorAll<HTMLElement>('[data-select]')) {
    el.addEventListener('click', () => {
      const id = el.dataset.select ?? null
      selectedId = selectedId === id ? null : id
      renderPanel()
      requestDraw()
    })
  }
  panel.querySelector<HTMLButtonElement>('#solo-attack')?.addEventListener('click', () => {
    if (enemy) void onAttack(enemy.id)
  })
  panel.querySelector<HTMLButtonElement>('#solo-reload')?.addEventListener('click', () => playerAct({t: 'Reload'}))
  panel.querySelector<HTMLButtonElement>('#solo-medkit')?.addEventListener('click', () => {
    if (patient) playerAct({t: 'UseMedkit', targetId: patient.id})
  })
  panel.querySelector<HTMLButtonElement>('#solo-pickup')?.addEventListener('click', () => {
    if (loot) playerAct({t: 'PickUp', groundItemId: loot.id})
  })
  panel.querySelector<HTMLButtonElement>('#solo-push')?.addEventListener('click', () => {
    if (pushable) playerAct({t: 'PushProp', propId: pushable.id})
  })
  panel.querySelector<HTMLButtonElement>('#solo-end')?.addEventListener('click', () => endTurn())
  panel.querySelector<HTMLButtonElement>('#solo-new')?.addEventListener('click', () => newGame())
  panel.querySelector<HTMLInputElement>('#solo-grid')?.addEventListener('change', (event) => {
    showGrid = (event.target as HTMLInputElement).checked
    requestDraw()
  })
}

// ---- mount ----------------------------------------------------------------
const mount = (): void => {
  const app = document.getElementById('app')
  if (!app) throw new Error('#app not found')
  app.innerHTML = `
    <div class="solo-shell">
      <aside class="solo-panel" id="solo-panel"></aside>
      <div class="solo-board"><canvas id="solo-canvas"></canvas></div>
    </div>`
  panel = app.querySelector('#solo-panel') as HTMLDivElement
  boardViewport = app.querySelector('.solo-board') as HTMLDivElement
  canvas = app.querySelector('#solo-canvas') as HTMLCanvasElement
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is required.')
  ctx = context
  canvas.addEventListener('pointerdown', onActionPointerDown)
  canvas.addEventListener('pointerdown', onPanPointerDown)
  canvas.addEventListener('wheel', handleWheel, {passive: false})
  canvas.addEventListener('contextmenu', blockContextMenu)
  canvas.addEventListener('touchstart', onTouchStart, {passive: false})
  canvas.addEventListener('touchmove', onTouchMove, {passive: false})
  canvas.addEventListener('touchend', onTouchEnd)
  window.addEventListener('resize', updateCanvasDisplaySize)

  diceOverlay = document.createElement('div')
  diceOverlay.id = 'solo-dice'
  boardViewport.appendChild(diceOverlay)
  diceRoller = createDiceRoller(diceOverlay, {
    colors: {body: '#ecd5bb', pip: '#222222'},
    modelUrl: '/gltf/dice.gltf'
  })

  const seedParam = new URLSearchParams(location.search).get('seed')
  const seed = seedParam !== null && Number.isFinite(Number(seedParam)) ? Number(seedParam) : undefined
  newGame(seed)
}

mount()

if (import.meta.env.DEV) {
  ;(window as unknown as {__solo: unknown}).__solo = {
    newGame,
    dispatch,
    peek: () => state,
    cellOf: (x: number, y: number) => (state ? cellOf(state.grid, x, y) : null),
    // Test helpers (dev only): reposition an entity, select a target, force redraw.
    place: (id: string, x: number, y: number) => {
      if (!state) return
      const e = entityById(state, id)
      if (e) {
        e.x = x
        e.y = y
        renderPos.set(id, {x, y})
      }
      renderPanel()
      requestDraw()
    },
    select: (id: string | null) => {
      selectedId = id
      renderPanel()
      requestDraw()
    },
    attack: (id: string) => onAttack(id),
    endTurn: async () => {
      endTurn()
      // give the async monster driver time to finish (tweens + beats)
      for (let i = 0; i < 200 && busy; i += 1) await delay(30)
    },
    // Fast-forward `n` turns synchronously (no tweens): PCs idle, monsters use the
    // real AI + reducer, waves spawn on clear. For headless verification only.
    simulate: (n: number) => {
      for (let k = 0; k < n && state && state.phase.t === 'playerTurn'; k += 1) {
        const actor = activeEntity(state)
        if (actor?.faction === 'monster') {
          const plan = decideMonster(state, actor.id)
          for (const cell of plan.moves) state = reduce(state, {t: 'Move', to: cellCenter(state.grid, cell.cx, cell.cy)})
          if (plan.attackTargetId) state = reduce(state, {t: 'Attack', targetId: plan.attackTargetId})
        }
        state = reduce(state, {t: 'EndTurn'})
        if (state.phase.t === 'playerTurn' && !state.entities.some((e) => e.faction === 'monster' && !isDead(e))) {
          if (state.wave >= state.wavesTotal) state = {...state, phase: {t: 'won'}}
          else state = reduce(state, {t: 'AddWave', monsters: buildWave(state.map, state.grid, state.wave + 1)})
        }
      }
      renderPanel()
      requestDraw()
    }
  }
}
