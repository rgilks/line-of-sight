// Searchable containers + locked doors: the loot/clue layer laid over a generated
// deck. Pure and seeded (its own rng), so placement is stable per map seed and
// unit-testable without a browser. The structural generator (synth/) stays
// game-agnostic; this is where game flavour — stashes, access cards, sealed rooms —
// lives.
//
// Two guarantees the planner upholds, both about never softlocking the player:
//   1. From their spawn, the squad can always reach most of the deck WITHOUT any
//      keycard or hack (sealed doors only ever gate side rooms, never the way out).
//   2. Every keycard clearance used on a sealed door has a matching card sitting in
//      the freely-reachable region — so a card is never locked behind the very door
//      (or chain of doors) it opens.
import {hasLineOfSight, type Occluder} from '../../../core/los'
import {cellCenter, cellOf, isFloor, type Cell, type WalkGrid} from './grid'
import type {Container, ContainerKind, DoorLock, DoorStates, ItemStack} from './model'
import type {GeneratedMap, Room, RoomType} from '../synth/types'
import {chance, pick, randInt, shuffle, type Rng} from '../synth/rng'

// What fixture each room type keeps (drives the search glyph + flavour). Rooms
// whose type isn't listed get no container.
const ROOM_CONTAINER: Partial<Record<RoomType, ContainerKind>> = {
  quarters: 'locker',
  storage: 'crate',
  medbay: 'cabinet',
  fresher: 'cabinet',
  cargo: 'crate',
  engineering: 'terminal',
  bridge: 'terminal',
  common: 'cabinet'
}

// Keycard clearances (door access colours). Several doors can share one, so a
// single card opens more than one door. The renderer maps these ids to colours.
export const KEY_CLEARANCES = ['blue', 'amber', 'violet', 'red'] as const

// One-line clues: atmosphere first, with a few that hint at the systems (sealed
// armoury, engineering override) so a careful search rewards the player.
const CLUES: string[] = [
  'Scrawled note: "Don\'t open the cargo doors. That\'s how they got in."',
  'Cracked datapad — crew manifest: 14 aboard. None answering hails.',
  'Maintenance log: airlock seals failing along the outer ring.',
  'A bloodied handprint smeared down the bulkhead toward the vents.',
  'Security memo: "Armoury sealed. Engineering holds the override codes."',
  'Half-finished message: "If you find this, get to the bridge before—"',
  'Ration wrappers and spent stims. Someone holed up here a long while.',
  "Ship's log: \"Distress beacon away. Six days, no reply.\"",
  "A child's drawing of the stars, pinned above an empty bunk.",
  'Scratched into the panel: a tally of days. It stops at eleven.',
  'Med-scanner readout: "Subject vitals — none. Mass still in motion."',
  'Note taped to the console: "Check the vents before you sleep."',
  'Engineering ticket: reactor stable, but the doors keep locking themselves.',
  'A scorched keycard slot — someone tried to force this one open.',
  'Recovered audio: claws on metal, then a long burst of static.'
]

const AMMO_WEAPONS = ['autorifle', 'autopistol', 'shotgun'] as const
const ammoStack = (rng: Rng): ItemStack => {
  const weaponId = pick(rng, AMMO_WEAPONS)
  const count = weaponId === 'shotgun' ? randInt(rng, 4, 8) : randInt(rng, 10, 24)
  return {kind: 'ammo', weaponId, count}
}
// Findable upgrades: the squad starts with basic sidearms / no armour and scavenges
// these. Better gear is rarer.
const LOOT_WEAPONS = ['autorifle', 'shotgun', 'autopistol'] as const
const LOOT_ARMORS = ['cloth', 'cloth', 'combat'] as const
const weaponStack = (rng: Rng): ItemStack => ({kind: 'weapon', weaponId: pick(rng, LOOT_WEAPONS), count: 1})
const armorStack = (rng: Rng): ItemStack => ({kind: 'armor', armorId: pick(rng, LOOT_ARMORS), count: 1})

const ck = (cx: number, cy: number): string => `${cx},${cy}`

// ---- connectivity (walls + closed doors honoured via the LOS primitive) -----

/** Door start-state map: a sealed (locked, not-unlocked) door is closed; the rest open. */
export const doorStatesFromLocks = (map: GeneratedMap, locks: Record<string, DoorLock>): DoorStates => {
  const states: DoorStates = {}
  for (const o of map.occluders) if (o.type === 'door') states[o.id] = {open: !(locks[o.id] && !locks[o.id].unlocked)}
  return states
}

// The two floor cells a door connects (just inside each side of its midpoint).
const doorCells = (grid: WalkGrid, door: Occluder): [Cell, Cell] => {
  const mx = (door.x1 + door.x2) / 2
  const my = (door.y1 + door.y2) / 2
  const len = Math.hypot(door.x2 - door.x1, door.y2 - door.y1) || 1
  const nx = (-(door.y2 - door.y1) / len) * grid.gridScale * 0.6
  const ny = ((door.x2 - door.x1) / len) * grid.gridScale * 0.6
  return [cellOf(grid, mx + nx, my + ny), cellOf(grid, mx - nx, my - ny)]
}

/**
 * Flood-fill the floor cells reachable from `spawn`, crossing a cell boundary only
 * where line of sight is clear (walls block; a door passes only if open in
 * `doorStates`). Stops early once `limit` cells are seen, when provided.
 */
export const reachableCells = (
  map: GeneratedMap,
  grid: WalkGrid,
  doorStates: DoorStates,
  spawn: Cell[],
  limit = Infinity
): Set<string> => {
  const seen = new Set<string>()
  const queue: Cell[] = []
  for (const c of spawn) {
    if (isFloor(grid, c.cx, c.cy) && !seen.has(ck(c.cx, c.cy))) {
      seen.add(ck(c.cx, c.cy))
      queue.push(c)
    }
  }
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ]
  for (let head = 0; head < queue.length && seen.size < limit; head += 1) {
    const cur = queue[head]
    const a = cellCenter(grid, cur.cx, cur.cy)
    for (const [dx, dy] of dirs) {
      const nx = cur.cx + dx
      const ny = cur.cy + dy
      const key = ck(nx, ny)
      if (seen.has(key) || !isFloor(grid, nx, ny)) continue
      const b = cellCenter(grid, nx, ny)
      if (!hasLineOfSight(a, b, map.occluders, doorStates)) continue
      seen.add(key)
      queue.push({cx: nx, cy: ny})
    }
  }
  return seen
}

const floorCount = (grid: WalkGrid): number => {
  let n = 0
  for (let i = 0; i < grid.floor.length; i += 1) if (grid.floor[i] === 1) n += 1
  return n
}

// ---- container cell selection (wall-hugging floor cell per room) -------------

const containerCell = (grid: WalkGrid, room: Room, used: Set<string>): Cell | undefined => {
  const ring: Cell[] = []
  for (let cx = room.x; cx < room.x + room.w; cx += 1) ring.push({cx, cy: room.y}, {cx, cy: room.y + room.h - 1})
  for (let cy = room.y; cy < room.y + room.h; cy += 1) ring.push({cx: room.x, cy}, {cx: room.x + room.w - 1, cy})
  for (const c of ring) if (isFloor(grid, c.cx, c.cy) && !used.has(ck(c.cx, c.cy))) return c
  return undefined
}

type Slot = {room: Room; cell: Cell}

const pickSlots = (map: GeneratedMap, grid: WalkGrid, rng: Rng, avoid: Set<string>): Slot[] => {
  const eligible = shuffle(
    rng,
    map.rooms.filter((room) => ROOM_CONTAINER[room.type] !== undefined && room.w * room.h >= 4)
  )
  const target = Math.min(eligible.length, 6 + Math.round(map.rooms.length / 12))
  const used = new Set(avoid)
  const slots: Slot[] = []
  for (const room of eligible) {
    if (slots.length >= target) break
    const cell = containerCell(grid, room, used)
    if (!cell) continue
    used.add(ck(cell.cx, cell.cy))
    slots.push({room, cell})
  }
  return slots
}

// ---- the plan ---------------------------------------------------------------

export type LootPlan = {locks: Record<string, DoorLock>; containers: Container[]}

/**
 * Plan the deck's sealed doors and searchable containers together, so keycards
 * are always obtainable and the squad is never walled into its spawn. See the
 * file header for the two guarantees.
 */
export const planLockAndLoot = (
  map: GeneratedMap,
  grid: WalkGrid,
  spawn: Cell[],
  rng: Rng,
  avoid: Set<string>
): LootPlan => {
  const slots = pickSlots(map, grid, rng, avoid)

  // 1. Tentatively seal a fifth of the internal doors (never the hull airlocks).
  const internal = map.occluders.filter((o) => o.type === 'door' && o.id.startsWith('door-'))
  const wantLocked = internal.length === 0 ? 0 : Math.min(Math.max(2, Math.round(internal.length * 0.2)), 14)
  const lockedIds = new Set(shuffle(rng, internal).slice(0, wantLocked).map((d) => d.id))
  const doorById = new Map(internal.map((d) => [d.id, d]))

  // 2. Connectivity guard: while the spawn can't freely reach most of the deck,
  //    unlock a frontier sealed door (one with a reachable side and a sealed-off
  //    side). This only ever opens doors that wall the squad in.
  const total = floorCount(grid)
  const need = Math.ceil(total * 0.55)
  for (let guard = 0; guard < 64; guard += 1) {
    const reached = reachableCells(map, grid, doorStatesFromLocks(map, locksFrom(lockedIds)), spawn, need)
    if (reached.size >= need) break
    const frontier = [...lockedIds]
      .map((id) => doorById.get(id))
      .find((door) => {
        if (!door) return false
        const [a, b] = doorCells(grid, door)
        return reached.has(ck(a.cx, a.cy)) !== reached.has(ck(b.cx, b.cy))
      })
    if (!frontier) break
    lockedIds.delete(frontier.id)
  }

  // 3. The final freely-reachable region (sealed doors closed). Keycards must live
  //    here so none is ever stranded behind the door it opens.
  const free = reachableCells(map, grid, doorStatesFromLocks(map, locksFrom(lockedIds)), spawn)
  const freeSlots = slots.filter((s) => free.has(ck(s.cell.cx, s.cell.cy)))

  // 4. Assign kind + clearance to the surviving sealed doors. Half hack, half key;
  //    key doors share a small set of clearances (so one card opens several). Only
  //    use as many clearances as we have free slots to seed cards into; if there is
  //    nowhere to put a card, leave those doors as hack instead of unreachable.
  const survivors = shuffle(rng, [...lockedIds].map((id) => doorById.get(id)).filter((d): d is Occluder => !!d))
  const locks: Record<string, DoorLock> = {}
  const keyDoors: string[] = []
  // Leave free slots for the cards PLUS a starter weapon + armour.
  const cardReserve = Math.min(KEY_CLEARANCES.length, Math.max(0, freeSlots.length - 4))
  survivors.forEach((door, i) => {
    if (i % 2 === 0 && cardReserve > 0) {
      const keyId = KEY_CLEARANCES[keyDoors.length % cardReserve]
      locks[door.id] = {kind: 'key', keyId, unlocked: false}
      keyDoors.push(keyId)
    } else {
      locks[door.id] = {kind: 'hack', unlocked: false}
    }
  })
  const usedClearances = [...new Set(keyDoors)]

  // 5. Fill the container slots. Reserve free slots for each clearance's card and a
  //    starter weapon + armour (so the squad can always gear up without a key);
  //    everything else gets supplies, an upgrade, or a clue.
  const clues = shuffle(rng, CLUES)
  const containers: Container[] = []
  const freeSet = new Set(freeSlots)
  const reserved = new Map<Slot, ItemStack>()
  let fi = 0
  const reserveNext = (stack: ItemStack): void => {
    while (fi < freeSlots.length && reserved.has(freeSlots[fi])) fi += 1
    if (fi < freeSlots.length) reserved.set(freeSlots[fi], stack)
  }
  for (const keyId of usedClearances) reserveNext({kind: 'keycard', keyId, count: 1})
  reserveNext(weaponStack(rng)) // a ranged weapon, reachable from the start
  reserveNext(armorStack(rng)) // a set of body armour, reachable from the start
  slots.forEach((slot, i) => {
    const kind = ROOM_CONTAINER[slot.room.type] as ContainerKind
    const at = cellCenter(grid, slot.cell.cx, slot.cell.cy)
    let loot = reserved.get(slot)
    let clue: string | undefined
    if (loot) {
      clue = chance(rng, 0.35) ? clues[i % clues.length] : undefined
    } else {
      // supplies / upgrade / clue (cards only ever come from reserved free slots)
      const r = rng()
      if (r < 0.32) loot = ammoStack(rng)
      else if (r < 0.52) loot = {kind: 'medkit', count: 1}
      else if (r < 0.63) loot = weaponStack(rng)
      else if (r < 0.71) loot = armorStack(rng)
      clue = !loot || chance(rng, 0.5) ? clues[i % clues.length] : undefined
    }
    containers.push({id: `cont-${i}`, x: at.x, y: at.y, kind, searched: false, loot, clue, locked: !freeSet.has(slot)})
  })

  return {locks, containers}
}

const locksFrom = (ids: Set<string>): Record<string, DoorLock> => {
  const out: Record<string, DoorLock> = {}
  for (const id of ids) out[id] = {kind: 'key', unlocked: false}
  return out
}
