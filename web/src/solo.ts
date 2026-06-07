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
  visibilityPolygon,
  type DoorOccluder,
  type Point
} from '../../core/los'
import {orderByInitiative} from '../../core/rules'
import {PARTY} from './solo/characters'
import {weaponById} from './solo/gear'
import {
  activeEntity,
  dexDm,
  isActive,
  moveBudgetPx,
  type Entity,
  type ItemStack,
  type SoloState
} from './solo/model'
import {buildWalkGrid, cellCenter, cellOf, isFloor, type Cell, type WalkGrid} from './solo/grid'
import {reduce} from './solo/reducer'
import './solo.css'

const SIGHT_RADIUS = 700

preloadCounterPortraits()
for (const image of counterPortraits.values()) image.addEventListener('load', requestDraw)

let state: SoloState | null = null
let showGrid = false

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let panel: HTMLDivElement

// ---- movement animation (tween) ------------------------------------------
// Mirrors the multiplayer client's ease so glides feel identical. renderPos is
// each entity's drawn position; the rAF loop is the sole owner of draw().
const MOVE_EASE_MS = 320
type Anim = {fromX: number; fromY: number; toX: number; toY: number; start: number}
const renderPos = new Map<string, Point>()
const anim = new Map<string, Anim>()
let rafId = 0

const now = (): number => performance.now()
const positionOf = (entity: Entity): Point => renderPos.get(entity.id) ?? {x: entity.x, y: entity.y}

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
    if (progress >= 1) anim.delete(id)
    else moving = true
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
  const entities = rollInitiative(spawnParty(map, grid))
  state = {
    seed,
    map,
    grid,
    doorStates: {},
    sightRadius: SIGHT_RADIUS,
    entities,
    turnPtr: 0,
    round: 1,
    moveRemainingPx: moveBudgetPx(grid.gridScale),
    phase: {t: 'playerTurn'},
    log: []
  }
  renderPos.clear()
  anim.clear()
  for (const entity of entities) renderPos.set(entity.id, {x: entity.x, y: entity.y})
  canvas.width = map.width
  canvas.height = map.height
  sizeFogLayers(map.width, map.height)
  renderPanel()
  requestDraw()
}

// ---- dispatch: reduce + animate the result --------------------------------
const dispatch = (action: Parameters<typeof reduce>[1]): void => {
  if (!state) return
  const before = new Map(state.entities.map((entity) => [entity.id, {x: entity.x, y: entity.y}]))
  state = reduce(state, action)
  for (const entity of state.entities) {
    const old = before.get(entity.id)
    if (old && (old.x !== entity.x || old.y !== entity.y)) {
      startEase(entity.id, renderPos.get(entity.id) ?? old, {x: entity.x, y: entity.y})
    }
  }
  renderPanel()
  requestDraw()
}

// ---- input ----------------------------------------------------------------
const boardPointFromEvent = (event: MouseEvent): Point => {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height
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

const onBoardClick = (event: MouseEvent): void => {
  if (!state) return
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc') return
  const point = boardPointFromEvent(event)
  const doorId = doorHitAt(point)
  if (doorId) dispatch({t: 'ToggleDoor', doorId})
  else dispatch({t: 'Move', to: point})
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
  for (const occluder of s.map.occluders) {
    if (occluder.type !== 'door') continue
    const door = occluder as DoorOccluder
    const open = s.doorStates[door.id]?.open ?? false
    const reachable = actor != null && distanceToOccluder({x: actor.x, y: actor.y}, door) <= reach
    if (!open && !reachable) continue
    ctx.save()
    ctx.lineCap = 'round'
    ctx.strokeStyle = open ? 'rgba(57, 255, 20, 0.9)' : 'rgba(57, 255, 20, 0.5)'
    ctx.lineWidth = open ? 9 : 5
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

const draw = (): void => {
  if (!state || !ctx) return
  const s = state
  renderMap(ctx, s.map)
  if (showGrid) drawFloorDebug(s)
  drawFog(s)
  drawDoorStates(s)
  drawMoveRing(s)
  for (const entity of s.entities) {
    if (!isActive(entity)) continue
    const at = positionOf(entity)
    drawCounterToken(
      ctx,
      {kind: entity.kind, label: entity.label, x: at.x, y: at.y},
      {
        gridScale: s.map.gridScale,
        portraits: counterPortraits,
        counterDefinitions,
        isPov: entity.id === activeEntity(s)?.id
      }
    )
  }
}

// ---- panel ----------------------------------------------------------------
const initiativeRailHtml = (s: SoloState): string =>
  s.entities
    .map((entity, index) => {
      const def = counterDefinitions.find((d) => d.kind === entity.kind)
      const active = index === s.turnPtr ? ' is-active' : ''
      return `<li class="solo-combatant${active}">
        <img class="solo-combatant-portrait" src="${def?.portrait ?? ''}" alt="" />
        <span class="solo-combatant-label">${entity.label}</span>
        <span class="solo-combatant-score">${entity.initiative ?? '—'}</span>
      </li>`
    })
    .join('')

const renderPanel = (): void => {
  if (!state) return
  const s = state
  const actor = activeEntity(s)
  const squares = Math.max(0, Math.round(s.moveRemainingPx / s.grid.gridScale))
  panel.innerHTML = `
    <header class="solo-brand">
      <img class="solo-brand-mark" src="/favicon.svg" alt="" />
      <div class="solo-brand-text">
        <span class="solo-brand-eyebrow">CEPHEUS</span>
        <span class="solo-brand-tool">Survive the Horde</span>
        <span class="solo-brand-role">Round ${s.round} · seed ${s.seed}</span>
      </div>
    </header>
    <section class="solo-section">
      <h2 class="solo-h">Squad — initiative</h2>
      <ol class="solo-combat-list">${initiativeRailHtml(s)}</ol>
    </section>
    <section class="solo-section">
      <div class="solo-turn">${actor ? `${actor.label}'s turn · ${squares} sq left` : ''}</div>
      <div class="solo-log">${s.log[s.log.length - 1] ?? ''}</div>
      <button id="solo-end" class="solo-button">End turn ↻</button>
      <button id="solo-new" class="solo-button solo-button-ghost">New deck</button>
      <label class="solo-check"><input type="checkbox" id="solo-grid" ${showGrid ? 'checked' : ''}/> Show floor grid</label>
    </section>
    <p class="solo-hint">Click within the green ring to move. Click an adjacent door to
    open or close it. End the turn to pass to the next of the squad.</p>`

  panel.querySelector<HTMLButtonElement>('#solo-end')?.addEventListener('click', () => dispatch({t: 'EndTurn'}))
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
  canvas = app.querySelector('#solo-canvas') as HTMLCanvasElement
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is required.')
  ctx = context
  canvas.addEventListener('click', onBoardClick)

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
    cellOf: (x: number, y: number) => (state ? cellOf(state.grid, x, y) : null)
  }
}
