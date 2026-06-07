// Cepheus · Survive the Horde — single-player game (static page, no server). The
// computer runs everything locally. Phase 1: generate a deck, drop the four
// pre-gen characters together in a central room, roll initiative, and show the
// turn order. Movement, combat, monsters, and waves arrive in later phases.
//
// Reuses the shared core (deck generator, geometry) and the multiplayer client's
// pure pieces (deck renderer, counter rendering, portraits) — see core/ and
// web/src/synth, web/src/counter-render.
import {generateMap} from './synth/generate-map'
import {renderMap} from './synth/render-map'
import {defaultSpec, type GeneratedMap} from './synth/types'
import {drawCounterToken} from './counter-render'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import {roll2D6} from '../../core/dice'
import {orderByInitiative} from '../../core/rules'
import {PARTY} from './solo/characters'
import {dexDm, type Entity} from './solo/model'
import {buildWalkGrid, cellCenter, cellOf, isFloor, type Cell, type WalkGrid} from './solo/grid'
import './solo.css'

preloadCounterPortraits()
// Portraits load async; redraw each time one arrives so tokens fill in.
for (const image of counterPortraits.values()) image.addEventListener('load', () => draw())

type SoloState = {
  seed: number
  map: GeneratedMap
  grid: WalkGrid
  entities: Entity[] // ordered by initiative
  turnPtr: number
  round: number
}

let state: SoloState | null = null
let showGrid = false

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let panel: HTMLDivElement

// ---- spawning -------------------------------------------------------------

// Breadth-first walk of floor cells from a start cell, returning the first
// `count` distinct floor cells found (the start first). Used to cluster the
// party on contiguous floor near a room center regardless of room shape.
const nearestFloorCells = (grid: WalkGrid, start: Cell, count: number): Cell[] => {
  const found: Cell[] = []
  const seen = new Set<string>()
  const queue: Cell[] = [start]
  seen.add(`${start.cx},${start.cy}`)
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

// The party starts together in a central room (monsters board from the edges
// later). Pick the floor-bearing room whose center is nearest the map center.
const spawnParty = (map: GeneratedMap, grid: WalkGrid): Entity[] => {
  const mid = {x: map.width / 2, y: map.height / 2}
  const roomsByCentrality = [...map.rooms]
    .filter((room) => room.w * room.h >= 4)
    .sort((a, b) => {
      const da = Math.hypot((a.x + a.w / 2) * map.gridScale - mid.x, (a.y + a.h / 2) * map.gridScale - mid.y)
      const db = Math.hypot((b.x + b.w / 2) * map.gridScale - mid.x, (b.y + b.h / 2) * map.gridScale - mid.y)
      return da - db
    })
  const home = roomsByCentrality[0] ?? map.rooms[0]
  const center: Cell = {cx: Math.floor(home.x + home.w / 2), cy: Math.floor(home.y + home.h / 2)}
  const cells = nearestFloorCells(grid, center, PARTY.length)

  return PARTY.map((pre, index) => {
    const cell = cells[index] ?? center
    const at = cellCenter(grid, cell.cx, cell.cy)
    return {
      id: pre.id,
      faction: 'pc',
      kind: pre.kind,
      label: pre.label,
      x: at.x,
      y: at.y,
      stats: {...pre.stats},
      statsMax: {...pre.stats},
      initiative: null,
      order: index
    }
  })
}

// 2D6 + DEX DM for every entity, then sort into the turn order.
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
  state = {seed, map, grid, entities, turnPtr: 0, round: 1}

  canvas.width = map.width
  canvas.height = map.height
  renderPanel()
  draw()
}

// ---- rendering ------------------------------------------------------------

const drawFloorDebug = (s: SoloState): void => {
  const g = s.grid
  ctx.save()
  ctx.fillStyle = 'rgba(57, 255, 20, 0.10)'
  for (let cy = 0; cy < g.rows; cy += 1) {
    for (let cx = 0; cx < g.cols; cx += 1) {
      if (g.floor[cy * g.cols + cx] === 1) {
        ctx.fillRect(cx * g.gridScale, cy * g.gridScale, g.gridScale, g.gridScale)
      }
    }
  }
  ctx.restore()
}

const draw = (): void => {
  if (!state || !ctx) return
  const s = state
  renderMap(ctx, s.map)
  if (showGrid) drawFloorDebug(s)
  for (const entity of s.entities) {
    drawCounterToken(
      ctx,
      {kind: entity.kind, label: entity.label, x: entity.x, y: entity.y},
      {gridScale: s.map.gridScale, portraits: counterPortraits, counterDefinitions, isPov: entity.faction === 'pc'}
    )
  }
}

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
      <button id="solo-new" class="solo-button">New deck</button>
      <label class="solo-check"><input type="checkbox" id="solo-grid" ${showGrid ? 'checked' : ''}/> Show floor grid</label>
    </section>
    <p class="solo-hint">Phase 1 skeleton — your squad has boarded. Movement, items, and the
    alien waves come next.</p>`

  panel.querySelector<HTMLButtonElement>('#solo-new')?.addEventListener('click', () => newGame())
  panel.querySelector<HTMLInputElement>('#solo-grid')?.addEventListener('change', (event) => {
    showGrid = (event.target as HTMLInputElement).checked
    draw()
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
  // ?seed=<n> forces a specific deck (deterministic for testing); else random.
  const seedParam = new URLSearchParams(location.search).get('seed')
  const seed = seedParam !== null && Number.isFinite(Number(seedParam)) ? Number(seedParam) : undefined
  newGame(seed)
}

mount()

// Dev-only test hook: deterministic new game by seed + state peek. Tree-shaken
// from production builds (import.meta.env.DEV is false there).
if (import.meta.env.DEV) {
  ;(window as unknown as {__solo: unknown}).__solo = {
    newGame,
    peek: () => state,
    cellOf: (x: number, y: number) => (state ? cellOf(state.grid, x, y) : null)
  }
}
