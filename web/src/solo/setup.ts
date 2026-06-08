// Pure game setup for "Survive the Horde": builds the authoritative initial
// SoloState from a seed — the deck, the squad, the first wave, loot, sealed
// doors, and initiative — with no DOM. Shared by the local /solo driver
// (web/src/solo.ts) and the server-authoritative SoloRoom, so both construct an
// identical game from the same seed. The only injected impurity is `rng`
// (initiative); pass a seeded rng for a fully reproducible game, or the default
// Math.random for a fresh one. Monster ids and join-order derive from wave +
// index, so there is no hidden mutable counter and a game replays cleanly.
import {generateMap} from '../synth/generate-map'
import {defaultSpec, type GeneratedMap} from '../synth/types'
import {makeRng} from '../synth/rng'
import {roll2D6, type Rng} from '../../../core/dice'
import {orderByInitiative} from '../../../core/rules'
import type {Point} from '../../../core/los'
import {PARTY} from './characters'
import {MONSTERS} from './monsters'
import {weaponById} from './gear'
import {planLockAndLoot} from './loot'
import {buildWalkGrid, cellCenter, cellOf, isFloor, type Cell, type WalkGrid} from './grid'
import {
  dexDm,
  isActive,
  turnBudgetPx,
  type Entity,
  type GroundItem,
  type ItemStack,
  type Prop,
  type SoloState
} from './model'

// Each character's personal sight radius in board pixels, and how many boarding
// waves the squad must survive to win.
const SIGHT_RADIUS = 700
const WAVES_TOTAL = 3

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

// A monster's id and join-order derive from its wave and index, so the game has
// no hidden mutable counter and replays deterministically.
const monsterEntity = (
  block: (typeof MONSTERS)[number],
  x: number,
  y: number,
  wave: number,
  index: number
): Entity => ({
  id: `mon-w${wave}-${index}-${block.id}`,
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
  order: 100 + wave * 100 + index,
  behaviour: block.behaviour
})

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
export const buildWave = (map: GeneratedMap, grid: WalkGrid, n: number): Entity[] => {
  const cells = airlockSpawnCells(map, grid)
  if (cells.length === 0) return []
  // A boarding horde: one alien per distinct spawn square, scaling up each wave.
  const count = Math.min(cells.length, 4 + n * 2)
  const out: Entity[] = []
  for (let i = 0; i < count; i += 1) {
    const cell = cells[i % cells.length]
    const at = cellCenter(grid, cell.cx, cell.cy)
    out.push(monsterEntity(MONSTERS[(i + n) % MONSTERS.length], at.x, at.y, n, i))
  }
  return out
}

// Scatter ammo + medkits across mid-deck rooms so the squad must move to resupply.
const scatterLoot = (map: GeneratedMap, grid: WalkGrid): GroundItem[] => {
  const rooms = [...map.rooms].filter((room) => room.w * room.h >= 4)
  const stacks: ItemStack[] = [
    {kind: 'weapon', weaponId: 'autorifle', count: 1},
    {kind: 'armor', armorId: 'cloth', count: 1},
    {kind: 'ammo', weaponId: 'autopistol', count: 24},
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

// Roll 2D6 + DEX DM initiative for every entity and order them. The rng is
// injected so the server can replay a game's initiative deterministically.
const rollInitiative = (entities: Entity[], rng: Rng): Entity[] => {
  for (const entity of entities) {
    const [a, b] = roll2D6(rng)
    entity.initiative = a + b + dexDm(entity)
  }
  return orderByInitiative(entities)
}

// Build the authoritative initial game state for `seed`. `rng` drives initiative
// (default Math.random for a fresh game; pass a seeded rng for a reproducible one).
export const createSoloGame = (seed: number, rng: Rng = Math.random): SoloState => {
  const map = generateMap(defaultSpec(seed))
  const grid = buildWalkGrid(map)
  const entities = rollInitiative([...spawnParty(map, grid), ...buildWave(map, grid, 1)], rng)
  const firstPc = entities.findIndex((entity) => entity.faction === 'pc' && isActive(entity))
  // A seeded rng (distinct from initiative) so loot + locks are stable for a deck.
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
  return {
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
}
