// Synthetic deck generator — the structural-truth layer. Pure and seeded: a
// deterministic function of MapSpec. No DOM/Cloudflare, like los-core, so it can
// move into the core and be unit-tested without a browser.
//
// Pipeline: BSP partition the deck into rooms → assign room types (honoring the
// spec's `required` list) → emit walls as room boundaries → cut doors into shared
// walls while guaranteeing every room is reachable → scatter decorative furniture
// per room type. Walls + doors are the line-of-sight occluders; furniture never
// blocks sight (matching the geomorph convention).
import type {Occluder} from '../los-core'
import {chance, makeRng, pick, randInt, shuffle, type Rng} from './rng'
import type {Decoration, GeneratedMap, MapSpec, Room, RoomType} from './types'

type Cell = {x: number; y: number; w: number; h: number}

// ---- BSP partition: recursively split the deck into leaf cells (rooms) -------

const splitCell = (rng: Rng, cell: Cell, spec: MapSpec): Cell[] => {
  // Stop when the cell is small enough that splitting would breach minRoom, or
  // randomly once under maxRoom so room sizes vary.
  const canSplitH = cell.h >= spec.minRoom * 2 + 1
  const canSplitV = cell.w >= spec.minRoom * 2 + 1
  if (!canSplitH && !canSplitV) return [cell]
  if (cell.w <= spec.maxRoom && cell.h <= spec.maxRoom && chance(rng, 0.5)) return [cell]

  // Prefer splitting the longer axis so rooms stay roughly square.
  const horizontal = canSplitH && (!canSplitV || cell.h > cell.w)
  if (horizontal) {
    const cut = randInt(rng, spec.minRoom, cell.h - spec.minRoom)
    return [
      ...splitCell(rng, {x: cell.x, y: cell.y, w: cell.w, h: cut}, spec),
      ...splitCell(rng, {x: cell.x, y: cell.y + cut, w: cell.w, h: cell.h - cut}, spec)
    ]
  }
  const cut = randInt(rng, spec.minRoom, cell.w - spec.minRoom)
  return [
    ...splitCell(rng, {x: cell.x, y: cell.y, w: cut, h: cell.h}, spec),
    ...splitCell(rng, {x: cell.x + cut, y: cell.y, w: cell.w - cut, h: cell.h}, spec)
  ]
}

// ---- Room typing: honor required types, fill the rest by theme ---------------

const themeFill: Record<MapSpec['theme'], RoomType[]> = {
  civilian: ['quarters', 'common', 'fresher', 'storage', 'medbay'],
  military: ['quarters', 'engineering', 'storage', 'medbay', 'bridge'],
  industrial: ['cargo', 'engineering', 'storage', 'common'],
  derelict: ['storage', 'cargo', 'quarters', 'engineering', 'common']
}

const roomLabels: Record<RoomType, string> = {
  bridge: 'BRIDGE',
  quarters: 'QUARTERS',
  cargo: 'CARGO',
  medbay: 'MEDBAY',
  engineering: 'ENGINEERING',
  common: 'COMMON',
  fresher: 'FRESHER',
  storage: 'STORAGE',
  airlock: 'A/L'
}

const assignTypes = (rng: Rng, cells: Cell[], spec: MapSpec): Room[] => {
  // Largest cells get the "important" required rooms (bridge, cargo) so they read
  // as the deck's focal spaces; remaining cells fill from the theme palette.
  const order = [...cells].sort((a, b) => b.w * b.h - a.w * a.h)
  const fill = themeFill[spec.theme]
  const required = [...spec.required]

  return order.map((cell, index) => {
    const type = required.shift() ?? pick(rng, fill)
    return {
      id: `room-${String(index + 1).padStart(3, '0')}`,
      type,
      x: cell.x,
      y: cell.y,
      w: cell.w,
      h: cell.h,
      label: roomLabels[type]
    }
  })
}

// ---- Walls: every room boundary becomes wall segments (pixel coords) ---------

const roomWalls = (room: Room, g: number): Occluder[] => {
  const x1 = room.x * g
  const y1 = room.y * g
  const x2 = (room.x + room.w) * g
  const y2 = (room.y + room.h) * g
  const seg = (n: number, ax1: number, ay1: number, ax2: number, ay2: number): Occluder => ({
    type: 'wall',
    id: `${room.id}-w${n}`,
    x1: ax1,
    y1: ay1,
    x2: ax2,
    y2: ay2
  })
  return [
    seg(1, x1, y1, x2, y1), // top
    seg(2, x2, y1, x2, y2), // right
    seg(3, x2, y2, x1, y2), // bottom
    seg(4, x1, y2, x1, y1) // left
  ]
}

// ---- Doors + connectivity: cut openings in shared walls so the deck connects -

// Two rooms share a wall if they abut along a grid line with overlap >= 1 cell.
type Adjacency = {a: number; b: number; horizontal: boolean; at: number; from: number; to: number}

const findAdjacencies = (rooms: Room[]): Adjacency[] => {
  const adj: Adjacency[] = []
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      const a = rooms[i]
      const b = rooms[j]
      // Vertical shared wall (a right edge == b left edge, or vice-versa).
      const [left, right] = a.x < b.x ? [a, b] : [b, a]
      if (left.x + left.w === right.x) {
        const from = Math.max(left.y, right.y)
        const to = Math.min(left.y + left.h, right.y + right.h)
        if (to - from >= 1) adj.push({a: i, b: j, horizontal: false, at: right.x, from, to})
      }
      // Horizontal shared wall (a bottom edge == b top edge).
      const [top, bottom] = a.y < b.y ? [a, b] : [b, a]
      if (top.y + top.h === bottom.y) {
        const from = Math.max(top.x, bottom.x)
        const to = Math.min(top.x + top.w, bottom.x + bottom.w)
        if (to - from >= 1) adj.push({a: i, b: j, horizontal: true, at: bottom.y, from, to})
      }
    }
  }
  return adj
}

// Choose a spanning set of doors so the whole deck is connected (union-find over
// a shuffled adjacency list = a random spanning tree), then add a few extra doors
// for loops so it doesn't feel like a strict tree.
const chooseDoors = (
  rng: Rng,
  roomCount: number,
  adjacencies: Adjacency[]
): Adjacency[] => {
  const parent = Array.from({length: roomCount}, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (x: number, y: number): boolean => {
    const rx = find(x)
    const ry = find(y)
    if (rx === ry) return false
    parent[rx] = ry
    return true
  }

  const shuffled = shuffle(rng, adjacencies)
  const chosen: Adjacency[] = []
  const extras: Adjacency[] = []
  for (const edge of shuffled) {
    if (union(edge.a, edge.b)) chosen.push(edge)
    else extras.push(edge)
  }
  // Add ~15% of the redundant connections back as extra doors for loops.
  for (const edge of extras) if (chance(rng, 0.15)) chosen.push(edge)
  return chosen
}

const doorOccluders = (doors: Adjacency[], g: number): Occluder[] =>
  doors.map((d, index) => {
    // Place a 1-cell door centered on the overlapping span.
    const mid = Math.floor((d.from + d.to) / 2)
    const id = `door-${String(index + 1).padStart(3, '0')}`
    return d.horizontal
      ? {type: 'door', id, x1: mid * g, y1: d.at * g, x2: (mid + 1) * g, y2: d.at * g, open: false}
      : {type: 'door', id, x1: d.at * g, y1: mid * g, x2: d.at * g, y2: (mid + 1) * g, open: false}
  })

// Carve door openings out of the wall segments that cross them, so a closed door
// sits in a real gap (the visibility core treats walls as solid and doors as
// toggleable — overlapping a wall over a door would make the door pointless).
const carveDoors = (walls: Occluder[], doors: Occluder[], g: number): Occluder[] => {
  const carved: Occluder[] = []
  for (const wall of walls) {
    const horizontal = wall.y1 === wall.y2
    const overlapping = doors.filter(
      (d) =>
        (d.y1 === d.y2) === horizontal &&
        (horizontal ? Math.abs(d.y1 - wall.y1) < 1 : Math.abs(d.x1 - wall.x1) < 1)
    )
    const cuts = overlapping
      .map((d) => (horizontal ? [Math.min(d.x1, d.x2), Math.max(d.x1, d.x2)] : [Math.min(d.y1, d.y2), Math.max(d.y1, d.y2)]))
      .filter(([s, e]) => {
        const ws = horizontal ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2)
        const we = horizontal ? Math.max(wall.x1, wall.x2) : Math.max(wall.y1, wall.y2)
        return s >= ws && e <= we
      })
      .sort((p, q) => p[0] - q[0])

    if (cuts.length === 0) {
      carved.push(wall)
      continue
    }
    const line = horizontal ? wall.y1 : wall.x1
    let cursor = horizontal ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2)
    const end = horizontal ? Math.max(wall.x1, wall.x2) : Math.max(wall.y1, wall.y2)
    let part = 0
    const pushPiece = (s: number, e: number): void => {
      if (e - s < g * 0.1) return
      part += 1
      carved.push(
        horizontal
          ? {type: 'wall', id: `${wall.id}p${part}`, x1: s, y1: line, x2: e, y2: line}
          : {type: 'wall', id: `${wall.id}p${part}`, x1: line, y1: s, x2: line, y2: e}
      )
    }
    for (const [s, e] of cuts) {
      pushPiece(cursor, s)
      cursor = Math.max(cursor, e)
    }
    pushPiece(cursor, end)
  }
  return carved
}

// ---- Furniture: decorative only, per room type ------------------------------

const furnishRoom = (rng: Rng, room: Room, g: number, density: number): Decoration[] => {
  const items: Decoration[] = []
  const inset = g * 0.18
  const x0 = room.x * g + inset
  const y0 = room.y * g + inset
  const w = room.w * g - inset * 2
  const h = room.h * g - inset * 2
  if (w <= 0 || h <= 0) return items

  const add = (kind: string, fx: number, fy: number, fw: number, fh: number): void => {
    items.push({kind, x: x0 + fx, y: y0 + fy, w: fw, h: fh})
  }

  switch (room.type) {
    case 'quarters': {
      // Bunks along the top wall.
      const bunks = Math.max(1, Math.floor((w / g) * density))
      for (let i = 0; i < bunks; i += 1) {
        if (!chance(rng, density)) continue
        add('bunk', (i * w) / bunks, 0, (w / bunks) * 0.8, g * 0.7)
      }
      break
    }
    case 'bridge': {
      add('console', w / 2 - g * 0.9, 0, g * 1.8, g * 0.5) // forward console bank
      add('chair', w / 2 - g * 0.3, h * 0.45, g * 0.6, g * 0.6)
      break
    }
    case 'cargo': {
      // Grid of crates.
      const cols = Math.max(1, Math.floor((w / g) * 0.6))
      const rows = Math.max(1, Math.floor((h / g) * 0.6))
      for (let cx = 0; cx < cols; cx += 1) {
        for (let cy = 0; cy < rows; cy += 1) {
          if (!chance(rng, density * 0.8)) continue
          add('crate', (cx * w) / cols, (cy * h) / rows, (w / cols) * 0.7, (h / rows) * 0.7)
        }
      }
      break
    }
    case 'medbay': {
      add('bed', g * 0.2, g * 0.2, g * 1.6, g * 0.7)
      add('cabinet', w - g * 0.6, 0, g * 0.5, h * 0.5)
      break
    }
    case 'engineering': {
      add('reactor', w / 2 - g * 0.7, h / 2 - g * 0.7, g * 1.4, g * 1.4)
      break
    }
    case 'fresher': {
      add('fixture', 0, 0, g * 0.6, g * 0.6)
      add('fixture', w - g * 0.6, 0, g * 0.6, g * 0.6)
      break
    }
    case 'common': {
      add('table', w / 2 - g * 0.8, h / 2 - g * 0.5, g * 1.6, g)
      break
    }
    case 'storage': {
      for (let i = 0; i < Math.floor((h / g) * density); i += 1) {
        add('shelf', 0, (i * h) / Math.max(1, Math.floor(h / g)), g * 0.5, g * 0.6)
      }
      break
    }
    default:
      break
  }
  return items
}

// ---- Entry point ------------------------------------------------------------

export const generateMap = (spec: MapSpec): GeneratedMap => {
  const rng = makeRng(spec.seed)
  const g = spec.gridScale

  const cells = splitCell(rng, {x: 0, y: 0, w: spec.cols, h: spec.rows}, spec)
  const rooms = assignTypes(rng, cells, spec)

  const adjacencies = findAdjacencies(rooms)
  const doorEdges = chooseDoors(rng, rooms.length, adjacencies)
  const doors = doorOccluders(doorEdges, g)

  const rawWalls = rooms.flatMap((room) => roomWalls(room, g))
  const walls = carveDoors(rawWalls, doors, g)

  const decorations = rooms.flatMap((room) => furnishRoom(rng, room, g, spec.furnitureDensity))

  return {
    spec,
    width: spec.cols * g,
    height: spec.rows * g,
    gridScale: g,
    rooms,
    decorations,
    occluders: [...walls, ...doors]
  }
}
