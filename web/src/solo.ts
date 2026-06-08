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
import {makeRng} from './synth/rng'
import {counterTokenSize, drawCounterToken} from './counter-render'
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
import {orderByInitiative, pointInPolygon} from '../../core/rules'
import {PARTY} from './solo/characters'
import {MONSTERS} from './solo/monsters'
import {ARMORS, weaponById} from './solo/gear'
import {parseDamage, predictAttack, rangeBandFor} from './solo/combat'
import {decideMonster} from './solo/ai'
import {planLockAndLoot} from './solo/loot'
import {createDiceRoller, type DiceRoller} from '@rgilks/cepheus-dice'
import {
  activeEntity,
  canSeePoint,
  dexDm,
  entityById,
  isActive,
  isDead,
  isDown,
  AIM_MAX,
  MINOR_ACTIONS_PER_ROUND,
  moveBudgetPx,
  SIGNIFICANT_ACTION_COST,
  STANCES,
  stanceLabel,
  turnBudgetPx,
  keyLabel,
  withinReach,
  type CombatStance,
  type Container,
  type DoorLock,
  type Entity,
  type GroundItem,
  type ItemStack,
  type Prop,
  type SoloState
} from './solo/model'
import {buildWalkGrid, cellCenter, cellOf, isFloor, type Cell, type WalkGrid} from './solo/grid'
import {reduce} from './solo/reducer'
import {clearEffects, drawEffects, effectsActive, playUi, primeAudio, setFxTimeScale, spawnAttackFx, spawnDenied, spawnHint} from './solo/fx'
import type {AttackFx} from './solo/model'
import './solo.css'

const SIGHT_RADIUS = 700
const WAVES_TOTAL = 3

preloadCounterPortraits()
for (const image of counterPortraits.values()) image.addEventListener('load', requestDraw)

let state: SoloState | null = null
let showGrid = false
let logExpanded = false // combat log: two lines by default, expandable
let selectedId: string | null = null // the entity the player has tapped (target / patient)
let reachable: Array<{cx: number; cy: number}> = [] // cells the active PC can move to (recomputed per action)
let monsterCounter = 0

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let panel: HTMLDivElement
let boardViewport: HTMLDivElement
let diceOverlay: HTMLDivElement
let diceRoller: DiceRoller
let endFab: HTMLButtonElement | null = null // floating End-Turn button over the board

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
// A trackpad/mouse press on the board. A plain left press is a tentative tap
// (acts on release) until it moves past TAP_SLOP, at which point it becomes a pan
// — so a macOS three-finger drag (which the OS delivers as a left-button drag)
// pans the view. Middle/right or ⌘/Ctrl-left pan from the start.
let boardDrag: {
  id: number
  startX: number
  startY: number
  scrollLeft: number
  scrollTop: number
  panning: boolean
  tap: boolean
} | null = null
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
let diceUp = false // true while the dice overlay is shown (hold the camera)

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
  // Follow the active token as it glides (the camera keeps it framed with the
  // nearest enemy). Skip while the dice overlay is up so it doesn't drift.
  if (moving && state && !diceUp) {
    const actor = activeEntity(state)
    if (actor && anim.has(actor.id)) focusOnActive()
  }
  draw()
  if (moving || effectsActive(t)) ensureRaf()
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
      stance: 'standing',
      aim: 0,
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
    stance: 'standing',
    aim: 0,
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
    // Collect up to 3 floor cells marching inward, so each airlock is a wider
    // boarding point — more distinct spawn squares for a real horde.
    let got = 0
    for (let k = 1; k <= 8 && got < 3; k += 1) {
      const c = cellOf(grid, midX + dir.x * k * grid.gridScale, midY + dir.y * k * grid.gridScale)
      if (!isFloor(grid, c.cx, c.cy)) continue
      const key = `${c.cx},${c.cy}`
      if (!seen.has(key)) {
        seen.add(key)
        cells.push(c)
        got += 1
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
  // A boarding horde: one alien per distinct spawn square, scaling up each wave.
  const count = Math.min(cells.length, 4 + n * 2)
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
  // A seeded rng (distinct from initiative's Math.random) so loot + locks are
  // stable for a given ?seed= deck.
  const lootRng = makeRng(seed * 2 + 1)
  const ground = scatterLoot(map, grid)
  const props = makeProps(map, grid, entities)
  // Keep containers off cells already taken by the squad, crates, or floor loot.
  const occupied = new Set<string>()
  for (const e of entities) {
    const c = cellOf(grid, e.x, e.y)
    occupied.add(`${c.cx},${c.cy}`)
  }
  for (const p of props) {
    const c = cellOf(grid, p.x, p.y)
    occupied.add(`${c.cx},${c.cy}`)
  }
  for (const gi of ground) {
    const c = cellOf(grid, gi.x, gi.y)
    occupied.add(`${c.cx},${c.cy}`)
  }
  // Sealed doors + searchable containers, planned together so every keycard is
  // reachable and the squad is never walled into its spawn.
  const spawnCells = entities.filter((e) => e.faction === 'pc').map((e) => cellOf(grid, e.x, e.y))
  const {locks, containers} = planLockAndLoot(map, grid, spawnCells, lootRng, occupied)
  selectedId = null
  busy = false
  state = {
    seed,
    map,
    grid,
    // Unlocked doors start open so the horde can roam; the squad closes a door (or
    // shoves a crate into it) to wall monsters out. Sealed doors start closed.
    doorStates: Object.fromEntries(
      map.occluders.filter((o) => o.type === 'door').map((d) => [d.id, {open: locks[d.id] ? false : true}])
    ),
    sightRadius: SIGHT_RADIUS,
    entities,
    ground,
    props,
    containers,
    locks,
    turnPtr: firstPc >= 0 ? firstPc : 0,
    round: 1,
    wave: 1,
    wavesTotal: WAVES_TOTAL,
    moveRemainingPx: turnBudgetPx(grid.gridScale),
    actionUsed: false,
    phase: {t: 'playerTurn'},
    log: ['Wave 1 boards. Hold the line.']
  }
  renderPos.clear()
  anim.clear()
  clearEffects()
  for (const entity of entities) renderPos.set(entity.id, {x: entity.x, y: entity.y})
  canvas.width = map.width
  canvas.height = map.height
  sizeFogLayers(map.width, map.height)
  focusOnSquad()
  focusOnActive()
  renderPanel()
  requestDraw()
}

// ---- dispatch: reduce + animate the result --------------------------------
const dispatch = (action: Parameters<typeof reduce>[1], rng?: () => number): void => {
  if (!state) return
  const before = new Map(state.entities.map((entity) => [entity.id, {x: entity.x, y: entity.y}]))
  const wasLost = state.phase.t === 'lost'
  state = reduce(state, action, rng)
  for (const entity of state.entities) {
    const old = before.get(entity.id)
    if (old && (old.x !== entity.x || old.y !== entity.y)) {
      startEase(entity.id, renderPos.get(entity.id) ?? old, {x: entity.x, y: entity.y})
    }
  }
  if (!wasLost && state.phase.t === 'lost') playUi('lose')
  if (action.t === 'EndTurn' || action.t === 'AddWave') focusOnActive()
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
    playUi('win')
    renderPanel()
    requestDraw()
    return
  }
  playUi('wave')
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
      const prevFx = state.lastAttack
      dispatch({t: 'Attack', targetId: plan.attackTargetId})
      await delay(fireAttackFx(prevFx) ? 560 : 220)
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
  // The overlay lives inside the scrollable board, so when the player has zoomed
  // in and panned, a plain inset:0 overlay scrolls away with the content. Pin it
  // over the *visible* viewport (offset by the current scroll) so the dice always
  // land centred on screen at the same size, whatever the zoom/pan.
  diceOverlay.style.left = `${boardViewport.scrollLeft}px`
  diceOverlay.style.top = `${boardViewport.scrollTop}px`
  diceOverlay.style.width = `${boardViewport.clientWidth}px`
  diceOverlay.style.height = `${boardViewport.clientHeight}px`
  diceOverlay.style.display = 'block'
  diceUp = true
  diceRoller.resize()
}
const hideDice = (): void => {
  diceOverlay.style.display = 'none'
  diceUp = false
}

// If the just-dispatched action resolved a fresh attack (a new lastAttack object),
// play its weapon sound + projectile/strike + impact effect. Returns whether it fired.
const fireAttackFx = (prev: AttackFx | undefined): boolean => {
  const fa = state?.lastAttack
  if (!state || !fa || fa === prev) return false
  const attacker = entityById(state, fa.attackerId)
  const target = entityById(state, fa.targetId)
  if (!attacker || !target) return false
  spawnAttackFx({
    from: positionOf(attacker),
    to: positionOf(target),
    weapon: weaponById(fa.weaponId),
    hit: fa.hit,
    effect: fa.effect,
    damage: fa.damage,
    killed: fa.killed,
    targetFaction: target.faction,
    gridScale: state.map.gridScale
  })
  requestDraw()
  return true
}

// An attack: roll the 3D dice, resolve the to-hit with the settled faces, then —
// once the dice clear — fire the weapon (sound + tracer/strike + impact burst).
const onAttack = async (targetId: string): Promise<void> => {
  if (busy || !state || state.phase.t !== 'playerTurn') return
  const actor = activeEntity(state)
  const target = entityById(state, targetId)
  if (!actor || !target || !canAttackTarget(target)) return // also gates range / LOS / ammo / action budget
  const gridScale = state.grid.gridScale
  busy = true
  renderPanel()
  showDice()
  const prevFx = state.lastAttack
  // First roll: the 2D6 to-hit (shown).
  const toHit = await diceRoller.roll(2)
  const faces = [...toHit.faces]
  // On a hit, roll and SHOW the weapon's damage dice; their settled faces feed the
  // reducer's damage roll, so the dice on screen are the damage that's applied
  // (plus the weapon's flat modifier and the Effect).
  const pred = predictAttack(actor, target, gridScale, faces[0] ?? 1, faces[1] ?? 1)
  if (pred.hit) {
    const dmgDice = parseDamage(weaponById(actor.weaponId).damage).count
    await delay(220)
    const damage = await diceRoller.roll(dmgDice)
    faces.push(...damage.faces)
  }
  dispatch({t: 'Attack', targetId}, queuedFaces(faces))
  await delay(520)
  hideDice()
  if (fireAttackFx(prevFx)) await delay(720)
  busy = false
  renderPanel()
  requestDraw()
}

// Can the active character attack `target` right now — their turn, their own line
// of sight, in range, with ammo? Mirrors the panel's Attack-button gate, so the
// quick-attack gestures (double-click / F) only fire on a real shot.
const canAttackTarget = (target: Entity): boolean => {
  if (busy || !state || state.phase.t !== 'playerTurn') return false
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc' || !isActive(actor) || state.actionUsed) return false
  if (state.moveRemainingPx + 0.5 < SIGNIFICANT_ACTION_COST * moveBudgetPx(state.grid.gridScale, actor.moveMeters)) return false
  if (target.faction !== 'monster' || isDead(target) || !canSeePoint(state, actor, target.x, target.y)) return false
  const weapon = weaponById(actor.weaponId)
  if (weapon.rangeDm[rangeBandFor(Math.hypot(actor.x - target.x, actor.y - target.y), state.grid.gridScale)] === undefined) {
    return false
  }
  return weapon.magazine === undefined || actor.loadedRounds > 0
}

// End the player's turn, then hand off to the monster AI.
const endTurn = (): void => {
  if (busy || !state || state.phase.t !== 'playerTurn') return
  playUi('endTurn')
  dispatch({t: 'EndTurn'})
  void runMonsters()
}

// The floating End-Turn button shows only while it's the player's turn to act.
const updateEndFab = (): void => {
  if (!endFab) return
  endFab.hidden = !(!!state && state.phase.t === 'playerTurn' && !busy)
}

// Keyboard: Space / Enter end the turn (no trip to the side panel); Esc clears
// the current target. Ignored while typing in a field.
const onKey = (event: KeyboardEvent): void => {
  const el = event.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault()
    endTurn()
  } else if (event.key === 'f' || event.key === 'F') {
    // Fire at the current target.
    const target = state && selectedId ? entityById(state, selectedId) : undefined
    if (target && canAttackTarget(target)) {
      event.preventDefault()
      void onAttack(target.id)
    }
  } else if (event.key === 'Escape' && selectedId) {
    selectedId = null
    renderPanel()
    requestDraw()
  }
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

// Open zoomed in on the squad: frame the PCs' bounding box plus a few squares of
// breathing room, and centre the view on them. Falls back to a full-map fit if
// the viewport isn't laid out yet or there are no PCs.
const focusOnSquad = (): void => {
  if (!state || !boardViewport) return
  const pcs = state.entities.filter((e) => e.faction === 'pc')
  const availW = boardViewport.clientWidth
  const availH = boardViewport.clientHeight
  if (pcs.length === 0 || availW <= 0 || availH <= 0) {
    fitBoardToViewport()
    return
  }
  const pad = state.map.gridScale * 3.5 // ~3.5 squares of space around the squad
  const minX = Math.min(...pcs.map((p) => p.x)) - pad
  const maxX = Math.max(...pcs.map((p) => p.x)) + pad
  const minY = Math.min(...pcs.map((p) => p.y)) - pad
  const maxY = Math.max(...pcs.map((p) => p.y)) + pad
  const boxW = Math.max(1, maxX - minX)
  const boxH = Math.max(1, maxY - minY)
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availW / boxW, availH / boxH)))
  updateCanvasDisplaySize()
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  boardViewport.scrollLeft = cx * zoom - availW / 2
  boardViewport.scrollTop = cy * zoom - availH / 2
}

// Pan the viewport so a board point sits in the middle of the visible map area.
const focusOnPoint = (x: number, y: number): void => {
  if (!state || !boardViewport) return
  const availW = boardViewport.clientWidth
  const availH = boardViewport.clientHeight
  if (availW <= 0 || availH <= 0) return
  const maxScrollX = Math.max(0, state.map.width * zoom - availW)
  const maxScrollY = Math.max(0, state.map.height * zoom - availH)
  boardViewport.scrollLeft = Math.min(maxScrollX, Math.max(0, x * zoom - availW / 2))
  boardViewport.scrollTop = Math.min(maxScrollY, Math.max(0, y * zoom - availH / 2))
}

// The living enemy nearest the actor (for PCs, only ones the squad can see).
const nearestEnemyOf = (s: SoloState, actor: Entity): Entity | undefined => {
  let best: Entity | undefined
  let bestD = Infinity
  for (const e of s.entities) {
    if (e.faction === actor.faction || isDead(e)) continue
    if (actor.faction === 'pc' && !visibleToSquad(s, e.x, e.y)) continue
    const d = Math.hypot(e.x - actor.x, e.y - actor.y)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return best
}

// Centre on whoever holds the initiative — but pan to keep the nearest enemy in
// view too, even if that pushes the active character toward an edge.
const focusOnActive = (): void => {
  if (!state || !boardViewport) return
  const actor = activeEntity(state)
  if (!actor) return
  const availW = boardViewport.clientWidth
  const availH = boardViewport.clientHeight
  if (availW <= 0 || availH <= 0) return
  const at = renderPos.get(actor.id) ?? {x: actor.x, y: actor.y}
  const enemy = nearestEnemyOf(state, actor)
  if (!enemy) {
    focusOnPoint(at.x, at.y)
    return
  }
  const z = zoom
  const ep = renderPos.get(enemy.id) ?? {x: enemy.x, y: enemy.y}
  let left = at.x * z - availW / 2 // start centred on the character
  let top = at.y * z - availH / 2
  const m = Math.min(availW, availH) * 0.16 // keep the enemy this far inside the edge
  const cm = Math.min(availW, availH) * 0.1 // but never let the character leave the view
  const ex = ep.x * z
  const ey = ep.y * z
  const ax = at.x * z
  const ay = at.y * z
  if (ex < left + m) left = ex - m // shift to bring the enemy on-screen…
  else if (ex > left + availW - m) left = ex - availW + m
  if (ey < top + m) top = ey - m
  else if (ey > top + availH - m) top = ey - availH + m
  if (ax < left + cm) left = ax - cm // …but not so far the character drops off it
  else if (ax > left + availW - cm) left = ax - availW + cm
  if (ay < top + cm) top = ay - cm
  else if (ay > top + availH - cm) top = ay - availH + cm
  const maxLeft = Math.max(0, state.map.width * z - availW)
  const maxTop = Math.max(0, state.map.height * z - availH)
  boardViewport.scrollLeft = Math.min(maxLeft, Math.max(0, left))
  boardViewport.scrollTop = Math.min(maxTop, Math.max(0, top))
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

// Movement (px) before a plain left press stops being a tap and becomes a pan.
const TAP_SLOP = 5

const onBoardDragMove = (event: PointerEvent): void => {
  if (!boardViewport || !boardDrag || boardDrag.id !== event.pointerId) return
  const dx = event.clientX - boardDrag.startX
  const dy = event.clientY - boardDrag.startY
  if (!boardDrag.panning && Math.hypot(dx, dy) <= TAP_SLOP) return // still possibly a tap
  if (!boardDrag.panning) {
    boardDrag.panning = true
    boardViewport.classList.add('is-panning')
  }
  event.preventDefault()
  boardViewport.scrollLeft = boardDrag.scrollLeft - dx
  boardViewport.scrollTop = boardDrag.scrollTop - dy
}

const onBoardDragEnd = (event: PointerEvent): void => {
  if (!boardDrag || boardDrag.id !== event.pointerId) return
  const tapped = boardDrag.tap && !boardDrag.panning
  const {clientX, clientY} = event
  boardDrag = null
  boardViewport?.classList.remove('is-panning')
  window.removeEventListener('pointermove', onBoardDragMove)
  window.removeEventListener('pointerup', onBoardDragEnd)
  window.removeEventListener('pointercancel', onBoardDragEnd)
  if (tapped) actAt(clientX, clientY) // a click that never dragged = an action
}

// One press handler for mouse + trackpad. ⌘/Ctrl-left, middle, and right pan from
// the start; a plain left press is a tap that turns into a pan once it drags
// (covers the macOS three-finger drag, which arrives as a left-button drag).
const onBoardPointerDown = (event: PointerEvent): void => {
  if (event.pointerType === 'touch' || !boardViewport) return // touch handled separately
  const panFromStart = event.button === 1 || event.button === 2 || (event.button === 0 && (event.metaKey || event.ctrlKey))
  const tap = event.button === 0 && !event.metaKey && !event.ctrlKey
  if (!panFromStart && !tap) return
  event.preventDefault()
  boardDrag = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: boardViewport.scrollLeft,
    scrollTop: boardViewport.scrollTop,
    panning: panFromStart,
    tap
  }
  if (panFromStart) boardViewport.classList.add('is-panning')
  window.addEventListener('pointermove', onBoardDragMove)
  window.addEventListener('pointerup', onBoardDragEnd)
  window.addEventListener('pointercancel', onBoardDragEnd)
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

// Midpoint of a door segment (for placing a "locked" denial right on it).
const doorMidpoint = (doorId: string): Point | null => {
  const door = state?.map.occluders.find((o) => o.id === doorId && o.type === 'door')
  return door ? {x: (door.x1 + door.x2) / 2, y: (door.y1 + door.y2) / 2} : null
}

// An unsearched container the click landed on (and the squad can see). Searched
// ones are inert, so they fall through to a normal move.
const containerHitAt = (point: Point): Container | null => {
  if (!state) return null
  const tol = state.map.gridScale * 0.6
  let best: {container: Container; d: number} | null = null
  for (const container of state.containers) {
    if (container.searched || !visibleToSquad(state, container.x, container.y)) continue
    const d = Math.hypot(container.x - point.x, container.y - point.y)
    if (d <= tol && (!best || d < best.d)) best = {container, d}
  }
  return best?.container ?? null
}

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
    const before = state.doorStates[doorId]?.open ?? false
    const logLen = state.log.length
    playerAct({t: 'ToggleDoor', doorId})
    const after = state?.doorStates[doorId]?.open ?? false
    if (state && after === before && state.log.length > logLen) {
      // Refused (sealed without a card/hack, or out of actions) — show why on the door.
      const mid = doorMidpoint(doorId)
      if (mid) spawnDenied(mid, state.log[state.log.length - 1], state.map.gridScale)
      playUi('denied')
      requestDraw()
    } else {
      playUi('door')
    }
    return
  }
  const hit = entityHitAt(point)
  if (hit) {
    const isOwnTurn = hit.faction === 'pc' && hit.id === actor.id
    // Double-click your own (active) token to end the turn — first tap selects you
    // and shows the hint, the second tap ends it.
    if (isOwnTurn && hit.id === selectedId) {
      endTurn()
      return
    }
    // Tapping an already-targeted foe fires (so a double-click attacks outright).
    if (hit.id === selectedId && canAttackTarget(hit)) {
      void onAttack(hit.id)
      return
    }
    selectedId = selectedId === hit.id ? null : hit.id
    if (selectedId) {
      playUi('select')
      if (isOwnTurn) spawnHint(positionOf(hit), 'Double-click: end turn', state.map.gridScale)
    }
    renderPanel()
    requestDraw()
    return
  }
  // A container: search it when adjacent, else fall through to walk toward it.
  const container = containerHitAt(point)
  if (container && Math.hypot(actor.x - container.x, actor.y - container.y) <= 1.6 * state.grid.gridScale) {
    playUi('pickup')
    playerAct({t: 'Search', containerId: container.id})
    return
  }
  const moverId = actor.id
  const from = {x: actor.x, y: actor.y}
  const logLen = state.log.length
  playerAct({t: 'Move', to: point})
  const moved = entityById(state, moverId)
  if (moved && (moved.x !== from.x || moved.y !== from.y)) {
    playUi('move')
  } else if (state.log.length > logLen) {
    // The move was refused — show why, right where they clicked.
    const cell = cellOf(state.grid, point.x, point.y)
    const at = cellCenter(state.grid, cell.cx, cell.cy)
    spawnDenied(at, state.log[state.log.length - 1], state.map.gridScale)
    playUi('denied')
    requestDraw()
  }
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

// Keycard clearance colours (ids match loot.ts KEY_CLEARANCES); hack locks read cyan.
const KEY_COLORS: Record<string, string> = {
  blue: 'rgba(86, 156, 255, 1)',
  amber: 'rgba(255, 178, 60, 1)',
  violet: 'rgba(197, 120, 255, 1)',
  red: 'rgba(255, 96, 84, 1)'
}
const HACK_COLOR = 'rgba(94, 214, 240, 1)'
const lockColor = (lock: DoorLock): string =>
  lock.kind === 'hack' ? HACK_COLOR : (KEY_COLORS[lock.keyId ?? ''] ?? KEY_COLORS.amber)

// A small padlock at a sealed door — coloured by keycard clearance, cyan for a
// hackable one — on a dark backing disc so it reads over the deck art.
const drawLockGlyph = (x: number, y: number, gs: number, lock: DoorLock): void => {
  const col = lockColor(lock)
  const w = gs * 0.4
  const h = gs * 0.34
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = 'rgba(6, 9, 9, 0.82)' // dark disc so the lock reads over the door art
  ctx.beginPath()
  ctx.arc(0, 0, gs * 0.42, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = col
  ctx.lineWidth = Math.max(1.4, gs * 0.045)
  ctx.beginPath()
  ctx.arc(0, 0, gs * 0.42, 0, Math.PI * 2) // tinted rim
  ctx.stroke()
  ctx.lineWidth = Math.max(1.8, gs * 0.06)
  ctx.beginPath()
  ctx.arc(0, -h * 0.22, w * 0.32, Math.PI, 0) // shackle
  ctx.stroke()
  ctx.fillStyle = col
  ctx.fillRect(-w * 0.42, -h * 0.08, w * 0.84, h * 0.7) // body
  ctx.restore()
}

const drawDoorStates = (s: SoloState): void => {
  const reach = doorReachForGrid(s.grid.gridScale)
  const actor = activeEntity(s)
  // Only hint doors the active PC can actually reach (open = solid "close me",
  // closed = dashed "open me"); far doors just read as gaps/lines in the deck art.
  for (const occluder of s.map.occluders) {
    if (occluder.type !== 'door') continue
    const door = occluder as DoorOccluder
    const lock = s.locks[door.id]
    // A sealed door shows a padlock wherever the squad can see it; it is closed, so
    // the open/close hint below doesn't apply. The midpoint sits on the wall line
    // (LOS there is flaky), so test the two cell-centres the door separates — a PC
    // in or seeing either side reveals the lock.
    if (lock && !lock.unlocked) {
      const mx = (door.x1 + door.x2) / 2
      const my = (door.y1 + door.y2) / 2
      const len = Math.hypot(door.x2 - door.x1, door.y2 - door.y1) || 1
      const nx = (-(door.y2 - door.y1) / len) * s.grid.gridScale * 0.5
      const ny = ((door.x2 - door.x1) / len) * s.grid.gridScale * 0.5
      const seen =
        visibleToSquad(s, mx + nx, my + ny) || visibleToSquad(s, mx - nx, my - ny) || visibleToSquad(s, mx, my)
      if (seen) drawLockGlyph(mx, my, s.grid.gridScale, lock)
      continue
    }
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

// Which floor cells the active PC can actually move to this turn: in budget, in
// their own line of sight, on floor, and unoccupied — exactly the moves the
// reducer accepts. Recomputed per action (cheap: one visibility polygon + a small
// cell sweep), cached for the render loop.
const computeReachable = (): void => {
  reachable = []
  if (!state || busy || state.phase.t !== 'playerTurn') return
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc' || !isActive(actor)) return
  const gs = state.grid.gridScale
  const budget = state.moveRemainingPx
  if (budget < gs * 0.4) return
  const poly = visibilityPolygon(actor.x, actor.y, state.map.width, state.map.height, state.sightRadius, state.map.occluders, state.doorStates)
  if (poly.length < 3) return
  const blocked = new Set<string>()
  for (const e of state.entities) {
    if (e.id === actor.id || isDead(e)) continue
    const c = cellOf(state.grid, e.x, e.y)
    blocked.add(`${c.cx},${c.cy}`)
  }
  for (const prop of state.props) {
    const c = cellOf(state.grid, prop.x, prop.y)
    blocked.add(`${c.cx},${c.cy}`)
  }
  const ac = cellOf(state.grid, actor.x, actor.y)
  const reach = Math.ceil(budget / gs) + 1
  for (let cy = ac.cy - reach; cy <= ac.cy + reach; cy += 1) {
    for (let cx = ac.cx - reach; cx <= ac.cx + reach; cx += 1) {
      if (cx === ac.cx && cy === ac.cy) continue
      if (!isFloor(state.grid, cx, cy) || blocked.has(`${cx},${cy}`)) continue
      const c = cellCenter(state.grid, cx, cy)
      if (Math.hypot(c.x - actor.x, c.y - actor.y) > budget + 0.5) continue
      if (!pointInPolygon({x: c.x, y: c.y}, poly)) continue
      reachable.push({cx, cy})
    }
  }
}

const drawReachable = (s: SoloState): void => {
  if (reachable.length === 0) return
  const gs = s.grid.gridScale
  ctx.save()
  ctx.fillStyle = 'rgba(57, 255, 20, 0.13)'
  for (const {cx, cy} of reachable) ctx.fillRect(cx * gs + 1, cy * gs + 1, gs - 2, gs - 2)
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

// Searchable fixtures (lockers/cabinets/crates/terminals). Unsearched ones carry a
// bright edge + highlight ring; searched ones go dim with an open lid. Drawn only
// where the squad can see, so they live under the fog like floor loot.
const drawContainers = (s: SoloState): void => {
  const gs = s.map.gridScale
  for (const c of s.containers) {
    if (!visibleToSquad(s, c.x, c.y)) continue
    const r = gs * 0.3
    const terminal = c.kind === 'terminal'
    const edge = c.searched
      ? 'rgba(120, 138, 148, 0.55)'
      : terminal
        ? 'rgba(94, 214, 240, 0.95)'
        : 'rgba(255, 200, 110, 0.95)'
    const body = c.searched ? 'rgba(40, 48, 52, 0.7)' : terminal ? 'rgba(20, 46, 56, 0.92)' : 'rgba(48, 60, 44, 0.92)'
    ctx.save()
    ctx.translate(c.x, c.y)
    ctx.fillStyle = body
    ctx.strokeStyle = edge
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(-r, -r, r * 2, r * 2)
    ctx.fill()
    ctx.stroke()
    ctx.lineWidth = Math.max(1.3, r * 0.16)
    if (terminal) {
      ctx.beginPath() // a couple of screen lines
      ctx.moveTo(-r * 0.5, -r * 0.2)
      ctx.lineTo(r * 0.5, -r * 0.2)
      ctx.moveTo(-r * 0.5, r * 0.12)
      ctx.lineTo(r * 0.2, r * 0.12)
      ctx.stroke()
    } else {
      ctx.beginPath() // lid line
      ctx.moveTo(-r, -r * 0.28)
      ctx.lineTo(r, -r * 0.28)
      ctx.stroke()
      if (!c.searched) {
        ctx.beginPath() // clasp
        ctx.arc(0, r * 0.14, r * 0.16, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    if (!c.searched) {
      ctx.strokeStyle = terminal ? 'rgba(94, 214, 240, 0.45)' : 'rgba(255, 205, 120, 0.45)'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.rect(-r - 3, -r - 3, (r + 3) * 2, (r + 3) * 2)
      ctx.stroke()
    }
    ctx.restore()
  }
}

// Health as a fraction of total physical characteristics (STR+DEX+END). Damage
// drains END first then STR/DEX, so this hits 0 exactly when the entity dies —
// a truer "health level" than END alone.
const vitalityRatio = (e: Entity): number => {
  const cur = Math.max(0, e.stats.str) + Math.max(0, e.stats.dex) + Math.max(0, e.stats.end)
  const max = e.statsMax.str + e.statsMax.dex + e.statsMax.end
  return max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0
}

const healthColor = (ratio: number): string =>
  ratio > 0.5 ? '#3ddc6b' : ratio > 0.25 ? '#ffc24b' : '#ff5a4e'

// A slim health bar under a token, coloured by remaining vitality.
const drawHealthBar = (at: Point, entity: Entity, gridScale: number): void => {
  const size = counterTokenSize(gridScale)
  const w = size * 0.92
  const h = Math.max(4, size * 0.13)
  const x = at.x - w / 2
  const y = at.y + size / 2 + Math.max(3, size * 0.14)
  const ratio = vitalityRatio(entity)
  ctx.save()
  ctx.fillStyle = 'rgba(4, 8, 5, 0.85)'
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2)
  ctx.fillStyle = healthColor(ratio)
  ctx.fillRect(x, y, w * ratio, h)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
  ctx.lineWidth = 1
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2)
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

// Red dashed = the active character has a clear shot. Grey dotted = the foe is
// visible to the squad but this character has no line of sight (no shot).
const drawTargetingLine = (from: Point, to: Point, clear: boolean): void => {
  ctx.save()
  ctx.strokeStyle = clear ? 'rgba(255,72,72,0.7)' : 'rgba(150,156,148,0.45)'
  ctx.lineWidth = 2
  ctx.setLineDash(clear ? [6, 6] : [2, 7])
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
  drawReachable(s)
  drawContainers(s)

  for (const item of s.ground) {
    if (visibleToSquad(s, item.x, item.y)) drawGroundItem(s, item)
  }

  const actor = activeEntity(s)
  const selected = selectedId ? entityById(s, selectedId) : undefined
  if (actor && actor.faction === 'pc' && selected && selected.faction === 'monster' && visibleToSquad(s, selected.x, selected.y)) {
    drawTargetingLine(positionOf(actor), positionOf(selected), canSeePoint(s, actor, selected.x, selected.y))
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
    if (vitalityRatio(entity) < 1) drawHealthBar(at, entity, s.map.gridScale)
    if (entity.id === selectedId) drawSelectionRing(at, entity.faction, s.map.gridScale)
  }

  // Combat effects (muzzle flashes, tracers, slashes, impact bursts, callouts) on top.
  drawEffects(ctx)
}

// ---- panel ----------------------------------------------------------------
const escapeHtml = (text: string): string =>
  text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

// --- Traveller-style character read-outs for the combat HUD ----------------
const hexDigit = (n: number): string => Math.max(0, Math.round(n)).toString(16).toUpperCase()
const uppOf = (e: Entity): string => `${hexDigit(e.stats.str)}${hexDigit(e.stats.dex)}${hexDigit(e.stats.end)}`
const topSkillsOf = (e: Entity, max = 3): string[] =>
  Object.entries(e.skills)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, level]) => `${name}-${level}`)
const gearOf = (e: Entity): string => {
  const w = weaponById(e.weaponId)
  const ammo = w.magazine !== undefined ? ` ${e.loadedRounds}/${w.magazine}` : ''
  const armour = e.armorId ? `${ARMORS[e.armorId]?.name ?? '—'} AR${ARMORS[e.armorId]?.ar ?? 0}` : 'unarmoured'
  return `${w.name}${ammo} · ${armour}`
}
const weaponCompactOf = (e: Entity): string => {
  const w = weaponById(e.weaponId)
  return w.magazine !== undefined ? `${w.name} ${e.loadedRounds}/${w.magazine}` : w.name
}
const endOf = (e: Entity): string => `${e.stats.end}/${e.statsMax.end}`
// Carried keycards as small colour-coded chips, so the player can match a card to
// the matching sealed-door padlock.
const keycardChipsHtml = (e: Entity): string => {
  const cards = e.inventory.filter((s) => s.kind === 'keycard' && s.count > 0)
  if (cards.length === 0) return ''
  return `<div class="solo-track-keys">${cards
    .map(
      (c) =>
        `<span class="solo-key-chip" style="--key:${KEY_COLORS[c.keyId ?? ''] ?? KEY_COLORS.amber}">${escapeHtml(keyLabel(c.keyId))} key${c.count > 1 ? ` ×${c.count}` : ''}</span>`
    )
    .join('')}</div>`
}
const conditionBadge = (e: Entity): string =>
  isDead(e) ? '<span class="solo-badge is-kia">KIA</span>' : isDown(e) ? '<span class="solo-badge is-down">DOWN</span>' : ''

// Turn order starting at the active combatant; squad always listed, visible foes only.
const trackCombatants = (s: SoloState): Entity[] => {
  const out: Entity[] = []
  const count = s.entities.length
  for (let i = 0; i < count; i += 1) {
    const entity = s.entities[(s.turnPtr + i) % count]
    if (entity.faction === 'pc' || (!isDead(entity) && visibleToSquad(s, entity.x, entity.y))) out.push(entity)
  }
  return out
}

type TrackCombat = {
  playerTurn: boolean
  squares: number
  actionUsed: boolean
  stance: CombatStance
  canSetStance: boolean
  attackLabel: string
  canAttack: boolean
  canReload: boolean
  canMedkit: boolean
  canPickup: boolean
  canSearch: boolean
  canPush: boolean
  aim: number
  canAim: boolean
  targetNote: string
}

const SOLO_ICON = {
  attack:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  aim:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>',
  reload:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-5.3 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 6.5 4.5 9 7 11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  medkit:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 10v6M9 13h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pickup:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9V6a4 4 0 1 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="6" y="9" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 12v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  push:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 14h5M18 11l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  stand:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="2.2" fill="currentColor"/><path d="M12 8v9M9.5 20h5M10 12l2 3 2-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  crouch:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="14" cy="7" r="2.2" fill="currentColor"/><path d="M8 18h8M10.5 18l1.5-5 3 2 2-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  prone:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="2.2" fill="currentColor"/><path d="M10 12h10M10 12l2-2M10 12l2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  end:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h8l-2 12H10L8 6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 6l1-2h4l1 2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
} as const

const iconBtn = (id: string | null, icon: string, label: string, enabled: boolean, extraClass = ''): string => {
  const idAttr = id ? ` id="${id}"` : ''
  return `<button${idAttr} class="solo-icon-btn${extraClass ? ` ${extraClass}` : ''}" type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${enabled ? '' : ' disabled'}>${icon}</button>`
}

const stanceBtn = (value: CombatStance, current: CombatStance, enabled: boolean): string => {
  const label = stanceLabel(value)
  const active = value === current ? ' is-active' : ''
  const icon = SOLO_ICON[value === 'standing' ? 'stand' : value === 'crouched' ? 'crouch' : 'prone']
  return `<button class="solo-icon-btn is-stance${active}" type="button" data-stance="${value}" title="${label}" aria-label="${label}" aria-pressed="${value === current}"${enabled ? '' : ' disabled'}>${icon}</button>`
}

const trackControlsHtml = (combat: TrackCombat): string => {
  const actionChip = combat.actionUsed
    ? '<span class="solo-chip is-spent">Action spent</span>'
    : '<span class="solo-chip is-ready">Action ready</span>'
  return `<div class="solo-track-controls">
    <div class="solo-track-chips">
      <span class="solo-chip">${combat.squares} sq left</span>
      ${actionChip}
      <span class="solo-chip solo-chip-stance">${stanceLabel(combat.stance)}</span>
      ${combat.aim > 0 ? `<span class="solo-chip solo-chip-aim">Aim +${combat.aim}</span>` : ''}
    </div>
    ${combat.targetNote ? `<div class="solo-target-card">${escapeHtml(combat.targetNote)}</div>` : ''}
    <div class="solo-icon-bar">
      <div class="solo-icon-group" role="group" aria-label="Combat stance">
        ${STANCES.map((value) => stanceBtn(value, combat.stance, combat.canSetStance)).join('')}
      </div>
      <span class="solo-icon-sep" aria-hidden="true"></span>
      ${iconBtn('solo-attack', SOLO_ICON.attack, combat.attackLabel, combat.canAttack, 'is-primary')}
      ${iconBtn('solo-aim', SOLO_ICON.aim, combat.aim > 0 ? `Aim (+${combat.aim})` : 'Aim', combat.canAim, combat.aim > 0 ? 'is-aiming' : '')}
      ${iconBtn('solo-reload', SOLO_ICON.reload, 'Reload', combat.canReload)}
      ${iconBtn('solo-medkit', SOLO_ICON.medkit, 'Medkit', combat.canMedkit)}
      ${iconBtn('solo-pickup', SOLO_ICON.pickup, 'Pick up', combat.canPickup)}
      ${iconBtn('solo-search', SOLO_ICON.search, 'Search', combat.canSearch)}
      ${iconBtn('solo-push', SOLO_ICON.push, 'Push crate', combat.canPush)}
      ${iconBtn('solo-end', SOLO_ICON.end, 'End turn (Space)', true, 'is-end')}
    </div>
  </div>`
}

const trackRowHtml = (s: SoloState, entity: Entity, rank: number, combat: TrackCombat | null): string => {
  const def = counterDefinitions.find((d) => d.kind === entity.kind)
  const actor = activeEntity(s)
  const active = entity.id === actor?.id
  const selected = entity.id === selectedId
  const expanded = active || selected
  const acting = active && entity.faction === 'pc' && !!combat?.playerTurn
  const foe = entity.faction === 'monster'
  const hp = vitalityRatio(entity)
  const detail =
    entity.faction === 'pc' && expanded
      ? `<div class="solo-track-detail">
          <span class="solo-tag solo-tag-upp" title="STR DEX END (hex)">UPP ${uppOf(entity)}</span>
          ${topSkillsOf(entity)
            .map((skill) => `<span class="solo-tag">${escapeHtml(skill)}</span>`)
            .join('')}
          <span class="solo-track-gear">${escapeHtml(gearOf(entity))}</span>
          ${keycardChipsHtml(entity)}
        </div>`
      : foe
        ? ''
        : `<div class="solo-track-loadout">${escapeHtml(weaponCompactOf(entity))}</div>`
  const status = active ? '<span class="solo-track-now">NOW</span>' : ''
  const stanceTag =
    entity.faction === 'pc' && entity.stance !== 'standing'
      ? `<span class="solo-tag solo-tag-stance">${stanceLabel(entity.stance)}</span>`
      : ''
  const controls = acting && combat ? trackControlsHtml(combat) : ''
  return `<li class="solo-track-row${foe ? ' is-foe' : ' is-pc'}${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}${acting ? ' is-acting' : ''}" data-select="${entity.id}">
    <div class="solo-track-summary">
      <span class="solo-track-rank">${rank}</span>
      <img class="solo-track-portrait" src="${def?.portrait ?? ''}" alt="" />
      <div class="solo-track-body">
        <div class="solo-track-head">
          <span class="solo-track-name">${escapeHtml(entity.label)}</span>
          ${conditionBadge(entity)}
          ${stanceTag}
          ${status}
          <span class="solo-track-init" title="Initiative">${entity.initiative ?? '—'}</span>
        </div>
        <div class="solo-track-vitals">
          <span class="solo-track-end">END ${endOf(entity)}</span>
          <div class="solo-track-bar"><div class="solo-track-bar-fill" style="width:${Math.round(hp * 100)}%;background:${healthColor(hp)}"></div></div>
        </div>
        ${detail}
      </div>
    </div>
    ${controls}
  </li>`
}

const trackHtml = (s: SoloState, combat: TrackCombat | null): string =>
  trackCombatants(s).map((entity, index) => trackRowHtml(s, entity, index + 1, combat)).join('')

const logHtml = (lines: string[]): string =>
  lines.length === 0
    ? '<div class="solo-log-empty">No events yet.</div>'
    : lines.map((line) => `<div class="solo-log-line">${line}</div>`).join('')

const renderPanel = (): void => {
  if (!state) return
  const s = state
  const actor = activeEntity(s)
  const weapon = actor ? weaponById(actor.weaponId) : null
  const selected = selectedId ? entityById(s, selectedId) : undefined
  const squares = actor ? Math.max(0, Math.round(s.moveRemainingPx / s.grid.gridScale)) : 0
  // Action economy: a minor action costs one 6 m move's worth of budget; a
  // significant action (attack / first aid / shove) costs two, and only one is
  // allowed per round (actionUsed).
  const minorPx = actor ? moveBudgetPx(s.grid.gridScale, actor.moveMeters) : 0
  const canMinor = !!actor && isActive(actor) && s.moveRemainingPx + 0.5 >= minorPx
  const canSignificant = !!actor && isActive(actor) && !s.actionUsed && s.moveRemainingPx + 0.5 >= SIGNIFICANT_ACTION_COST * minorPx

  // Attack availability against a selected enemy. The active character can only
  // fire on a foe IT can see — not one only an ally has line of sight to.
  const selectedEnemy = selected && selected.faction === 'monster' ? selected : undefined
  const enemy = actor && selectedEnemy && canSeePoint(s, actor, selectedEnemy.x, selectedEnemy.y) ? selectedEnemy : undefined
  let attackLabel = 'Attack'
  let canAttack = false
  let targetNote = ''
  if (actor && enemy && weapon) {
    const band = rangeBandFor(Math.hypot(actor.x - enemy.x, actor.y - enemy.y), s.grid.gridScale)
    const inRange = weapon.rangeDm[band] !== undefined
    const hasAmmo = weapon.magazine === undefined || actor.loadedRounds > 0
    const meleeBlocked = actor.stance === 'prone' && weapon.skill === 'Melee Combat'
    canAttack = canSignificant && inRange && hasAmmo && !meleeBlocked
    attackLabel = meleeBlocked ? 'No melee while prone' : `Attack ${enemy.label}`
    targetNote = `${enemy.label} · ${enemy.stats.end}/${enemy.statsMax.end} END · ${inRange ? band : `out of range (${band})`}${hasAmmo ? '' : ' · no ammo'}${canAttack ? ' · double-click or F to fire' : ''}`
  } else if (selectedEnemy) {
    // Selected, squad-visible, but this character can't see it.
    attackLabel = 'No line of sight'
    targetNote = `${selectedEnemy.label} · no line of sight from ${actor?.label ?? 'here'}`
  }

  const canReload =
    canMinor &&
    weapon?.magazine !== undefined &&
    !!actor &&
    actor.loadedRounds < (weapon.magazine ?? 0) &&
    actor.inventory.some((i) => i.kind === 'ammo' && i.weaponId === actor.weaponId && i.count > 0)

  const patient = selected && selected.faction === 'pc' && !isDead(selected) ? selected : actor
  const canMedkit =
    canSignificant &&
    !!actor &&
    actor.inventory.some((i) => i.kind === 'medkit' && i.count > 0) &&
    !!patient &&
    patient.stats.end < patient.statsMax.end &&
    (patient.id === actor.id || withinReach(actor, patient, s.grid.gridScale))

  const loot = actor ? s.ground.find((g) => Math.hypot(actor.x - g.x, actor.y - g.y) <= 1.6 * s.grid.gridScale) : undefined
  const canPickup = canMinor && !!loot

  const searchTarget = actor
    ? s.containers.find((c) => !c.searched && Math.hypot(actor.x - c.x, actor.y - c.y) <= 1.6 * s.grid.gridScale)
    : undefined
  const canSearch = canMinor && !!searchTarget

  const pushable = actor
    ? s.props.find((p) => {
        const ac = cellOf(s.grid, actor.x, actor.y)
        const pc = cellOf(s.grid, p.x, p.y)
        return Math.abs(pc.cx - ac.cx) + Math.abs(pc.cy - ac.cy) === 1
      })
    : undefined
  const canPush = canSignificant && !!pushable

  const recentLog = s.log.slice(logExpanded ? -40 : -2).map(escapeHtml)
  const over = s.phase.t === 'lost' || s.phase.t === 'won'
  const overText = s.phase.t === 'won' ? 'Survived — the deck is clear.' : 'Squad lost.'
  const playerTurn = !!actor && actor.faction === 'pc' && !busy
  const trackCount = trackCombatants(s).length
  const trackCombat: TrackCombat | null = over
    ? null
    : {
        playerTurn,
        squares,
        actionUsed: s.actionUsed,
        stance: actor?.stance ?? 'standing',
        canSetStance: playerTurn && canMinor,
        attackLabel,
        canAttack,
        canReload,
        canMedkit,
        canPickup,
        canSearch,
        canPush,
        aim: actor?.aim ?? 0,
        canAim: canSignificant && (actor?.aim ?? 0) < AIM_MAX,
        targetNote
      }
  const busyBanner = busy ? '<div class="solo-busy-banner">Hostiles acting…</div>' : ''

  panel.innerHTML = `
    <header class="solo-hud-top">
      <img class="solo-hud-mark" src="/favicon.svg" alt="" />
      <div class="solo-hud-title">
        <span class="solo-hud-eyebrow">CEPHEUS</span>
        <span class="solo-hud-name">Survive the Horde</span>
      </div>
      <div class="solo-hud-meta">
        <span class="solo-hud-stat">R${s.round}</span>
        <span class="solo-hud-stat">W${s.wave}/${s.wavesTotal}</span>
      </div>
    </header>

    <section class="solo-hud-track">
      <div class="solo-hud-track-head">
        <h2 class="solo-hud-label">Turn order</h2>
        <span class="solo-hud-count">${trackCount}</span>
      </div>
      ${busyBanner}
      <ol class="solo-track-list">${trackHtml(s, trackCombat)}</ol>
    </section>

    ${
      over
        ? `<section class="solo-hud-outcome">
            <div class="solo-outcome${s.phase.t === 'won' ? ' is-won' : ''}">${overText}</div>
            <button id="solo-new" class="solo-foot-btn" type="button">New game</button>
          </section>`
        : ''
    }

    <section class="solo-hud-log${logExpanded ? ' is-expanded' : ''}">
      <div class="solo-hud-log-head">
        <h2 class="solo-hud-label">Combat log</h2>
        <button id="solo-log-toggle" class="solo-log-toggle" type="button" aria-expanded="${logExpanded}">${logExpanded ? 'Minimize' : 'Expand'}</button>
      </div>
      <div class="solo-log-feed">${logHtml(recentLog)}</div>
    </section>

    <footer class="solo-hud-foot">
      <button id="solo-new" class="solo-foot-btn" type="button">New deck</button>
      <label class="solo-foot-check"><input type="checkbox" id="solo-grid" ${showGrid ? 'checked' : ''}/> Grid</label>
      <p class="solo-foot-hint">Move + one action, or run ${MINOR_ACTIONS_PER_ROUND * 6} m. Double-click a foe (or <b>F</b>) to fire; double-click yourself (or <b>Space</b>) to end the turn.</p>
      <p class="solo-foot-hint">Search lockers &amp; terminals for ammo, medkits, and access cards. A sealed door wants its matching keycard or a hack (Electronics).</p>
    </footer>`

  for (const el of panel.querySelectorAll<HTMLElement>('[data-select]')) {
    el.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) return
      const id = el.dataset.select ?? null
      selectedId = selectedId === id ? null : id
      if (selectedId) playUi('select')
      renderPanel()
      requestDraw()
    })
  }
  panel.querySelector<HTMLButtonElement>('#solo-attack')?.addEventListener('click', () => {
    if (enemy) void onAttack(enemy.id)
  })
  panel.querySelector<HTMLButtonElement>('#solo-aim')?.addEventListener('click', () => {
    playUi('select')
    playerAct({t: 'Aim'})
  })
  panel.querySelector<HTMLButtonElement>('#solo-reload')?.addEventListener('click', () => {
    playUi('reload')
    playerAct({t: 'Reload'})
  })
  panel.querySelector<HTMLButtonElement>('#solo-medkit')?.addEventListener('click', () => {
    if (patient) {
      playUi('medkit')
      playerAct({t: 'UseMedkit', targetId: patient.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-pickup')?.addEventListener('click', () => {
    if (loot) {
      playUi('pickup')
      playerAct({t: 'PickUp', groundItemId: loot.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-search')?.addEventListener('click', () => {
    if (searchTarget) {
      playUi('pickup')
      playerAct({t: 'Search', containerId: searchTarget.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-push')?.addEventListener('click', () => {
    if (pushable) {
      playUi('push')
      playerAct({t: 'PushProp', propId: pushable.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-end')?.addEventListener('click', () => endTurn())
  for (const btn of panel.querySelectorAll<HTMLButtonElement>('[data-stance]')) {
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      const stance = btn.dataset.stance as CombatStance
      if (!STANCES.includes(stance)) return
      playUi('select')
      playerAct({t: 'SetStance', stance})
    })
  }
  panel.querySelector<HTMLButtonElement>('#solo-log-toggle')?.addEventListener('click', () => {
    logExpanded = !logExpanded
    renderPanel()
  })
  panel.querySelector<HTMLButtonElement>('#solo-new')?.addEventListener('click', () => newGame())
  panel.querySelector<HTMLInputElement>('#solo-grid')?.addEventListener('change', (event) => {
    showGrid = (event.target as HTMLInputElement).checked
    requestDraw()
  })
  updateEndFab()
  computeReachable()
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
  canvas.addEventListener('pointerdown', onBoardPointerDown)
  canvas.addEventListener('wheel', handleWheel, {passive: false})
  canvas.addEventListener('contextmenu', blockContextMenu)
  canvas.addEventListener('touchstart', onTouchStart, {passive: false})
  canvas.addEventListener('touchmove', onTouchMove, {passive: false})
  canvas.addEventListener('touchend', onTouchEnd)
  window.addEventListener('resize', () => {
    updateCanvasDisplaySize()
    focusOnActive()
  })
  // Unlock the Web Audio context on the first interaction so weapon sounds play.
  window.addEventListener('pointerdown', () => primeAudio(), {once: true})

  // Big End-Turn button floating over the board (no trip to the side panel), plus
  // Space/Enter as the keyboard equivalent.
  endFab = document.createElement('button')
  endFab.id = 'solo-end-fab'
  endFab.type = 'button'
  endFab.hidden = true
  endFab.innerHTML = 'End Turn <span class="solo-fab-key">Space</span>'
  endFab.addEventListener('click', () => endTurn())
  app.querySelector('.solo-shell')?.appendChild(endFab)
  window.addEventListener('keydown', onKey)

  diceOverlay = document.createElement('div')
  diceOverlay.id = 'solo-dice'
  boardViewport.appendChild(diceOverlay)
  diceRoller = createDiceRoller(diceOverlay, {
    colors: {body: '#ecd5bb', pip: '#222222'},
    modelUrl: '/gltf/dice.gltf',
    // 'void': dice spotlit over the dimmed board, not the green tray box.
    lighting: 'void'
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
    },
    // Preview the dice overlay without driving a full attack (visual tuning only).
    rollDice: async (n = 2) => {
      showDice()
      await diceRoller.roll(n)
    },
    hideDice,
    // Slow effects down (or back to 1) for inspection.
    fxTimeScale: (s = 1) => setFxTimeScale(s),
    // Preview a weapon's attack effect (sound + projectile/strike + impact + the
    // Effect callout) across the middle of the map, no combat needed.
    previewFx: (weaponId = 'autorifle', hit = true, effect = 3, killed = false) => {
      if (!state) return
      const cx = state.map.width / 2
      const cy = state.map.height / 2
      const span = state.map.gridScale * 3.5
      spawnAttackFx({
        from: {x: cx - span, y: cy},
        to: {x: cx + span, y: cy},
        weapon: weaponById(weaponId),
        hit,
        effect,
        damage: hit ? Math.max(1, 6 + effect) : 0,
        killed,
        targetFaction: 'monster',
        gridScale: state.map.gridScale
      })
      requestDraw()
    }
  }
}
