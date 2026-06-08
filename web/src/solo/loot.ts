// Searchable containers + locked doors: the loot/clue layer laid over a generated
// deck. Pure and seeded (its own rng), so placement is stable per map seed and
// unit-testable without a browser. The structural generator (synth/) stays
// game-agnostic; this is where game flavour — stashes, access cards, sealed rooms —
// lives.
import {cellCenter, isFloor, type Cell, type WalkGrid} from './grid'
import type {Container, ContainerKind, DoorLock, ItemStack, LockKind} from './model'
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

type Content = {loot?: ItemStack; clue: boolean}

// A bag of `n` contents to deal out across the deck's containers: at least a
// couple of access cards (so every key-locked door is openable), a spread of
// ammo and medkits, and the rest data-only clues. Shuffled so the cards aren't
// always in the same room type.
const contentBag = (rng: Rng, n: number): Content[] => {
  const bag: Content[] = []
  for (let i = 0; i < Math.min(n, 2); i += 1) bag.push({loot: {kind: 'keycard', count: 1}, clue: chance(rng, 0.5)})
  while (bag.length < n) {
    const r = rng()
    if (r < 0.34) bag.push({loot: ammoStack(rng), clue: chance(rng, 0.25)})
    else if (r < 0.58) bag.push({loot: {kind: 'medkit', count: 1}, clue: chance(rng, 0.25)})
    else if (r < 0.72) bag.push({loot: {kind: 'keycard', count: 1}, clue: chance(rng, 0.4)})
    else bag.push({clue: true})
  }
  return shuffle(rng, bag)
}

const ck = (cx: number, cy: number): string => `${cx},${cy}`

// A floor cell for a container: walk the room's wall ring (cupboards sit against
// the bulkhead) and take the first free, unused floor cell.
const containerCell = (grid: WalkGrid, room: Room, used: Set<string>): Cell | undefined => {
  const ring: Cell[] = []
  for (let cx = room.x; cx < room.x + room.w; cx += 1) {
    ring.push({cx, cy: room.y}, {cx, cy: room.y + room.h - 1})
  }
  for (let cy = room.y; cy < room.y + room.h; cy += 1) {
    ring.push({cx: room.x, cy}, {cx: room.x + room.w - 1, cy})
  }
  for (const c of ring) if (isFloor(grid, c.cx, c.cy) && !used.has(ck(c.cx, c.cy))) return c
  return undefined
}

/**
 * Place searchable containers across the deck: one per suitable room (wall-hugging
 * cell), capped and scaled to deck size, avoiding cells already taken by entities,
 * crates, or floor loot. Contents come from a single shuffled bag so every deck
 * has access cards and a fair spread of supplies.
 */
export const placeContainers = (map: GeneratedMap, grid: WalkGrid, rng: Rng, avoid: Set<string>): Container[] => {
  const eligible = shuffle(
    rng,
    map.rooms.filter((room) => ROOM_CONTAINER[room.type] !== undefined && room.w * room.h >= 4)
  )
  const target = Math.min(eligible.length, 6 + Math.round(map.rooms.length / 12))
  const used = new Set(avoid)
  const slots: {room: Room; cell: Cell}[] = []
  for (const room of eligible) {
    if (slots.length >= target) break
    const cell = containerCell(grid, room, used)
    if (!cell) continue
    used.add(ck(cell.cx, cell.cy))
    slots.push({room, cell})
  }
  const bag = contentBag(rng, slots.length)
  const clues = shuffle(rng, CLUES)
  return slots.map((slot, i) => {
    const kind = ROOM_CONTAINER[slot.room.type] as ContainerKind
    const at = cellCenter(grid, slot.cell.cx, slot.cell.cy)
    const content = bag[i]
    return {
      id: `cont-${i}`,
      x: at.x,
      y: at.y,
      kind,
      searched: false,
      loot: content.loot,
      clue: content.clue ? clues[i % clues.length] : undefined
    }
  })
}

/**
 * Seal a subset of the internal doors (never the hull airlocks), splitting them
 * between keycard locks and hackable locks. ~⅕ of doors, capped, so sealed rooms
 * are a reward to break into rather than a wall across the deck.
 */
export const generateLocks = (map: GeneratedMap, rng: Rng): Record<string, DoorLock> => {
  const internal = map.occluders.filter((o) => o.type === 'door' && o.id.startsWith('door-'))
  if (internal.length === 0) return {}
  const count = Math.min(Math.max(2, Math.round(internal.length * 0.2)), 14)
  const locks: Record<string, DoorLock> = {}
  shuffle(rng, internal)
    .slice(0, count)
    .forEach((door, i) => {
      const kind: LockKind = i % 2 === 0 ? 'key' : 'hack'
      locks[door.id] = {kind, unlocked: false}
    })
  return locks
}
