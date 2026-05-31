// Synthetic deck generator — the structural-truth layer. Pure and seeded: a
// deterministic function of MapSpec. No DOM/Cloudflare, like los-core, so it can
// move into the core and be unit-tested without a browser.
//
// Model (mirrors the Starship Geomorphs tile grammar):
//   - An octagonal HULL skin at the board bounds (chamfered corners).
//   - A MARGIN gap between the hull and the room block (where the originals put
//     fuel/conduits) — so rooms never stair-step against the angled hull.
//   - A CORRIDOR network of full-span bands (one per axis = a cross, more = a
//     ladder/grid, one = a spine), placed off-centre per seed so the macro-layout
//     varies. Each band reaches the hull at its ends via an AIRLOCK.
//   - ROOMS fill the rectangular regions between bands (BSP), each doored ONTO a
//     corridor where possible (room↔room only as a fallback).
//
// Walls are extracted from cell-tag boundaries (no duplicate coincident walls).
// Walls + doors + hull are the line-of-sight occluders; furniture is decorative
// only and never blocks sight (the geomorph convention) — so LOS is exact by
// construction regardless of how richly rooms are decorated.
import type {Occluder} from '../los-core'
import {chance, makeRng, pick, randInt, shuffle, type Rng} from './rng'
import type {Decoration, GeneratedMap, MapSpec, Rect, Room, RoomType} from './types'

const CORRIDOR = 0 // cell tag for corridor cells; room tags are >= 1
const OUT = -1 // sentinel tag for anything outside the inner field

// ---- BSP partition of a cell rectangle into room-sized leaves ---------------

const splitRect = (rng: Rng, rect: Rect, spec: MapSpec): Rect[] => {
  const canH = rect.h >= spec.minRoom * 2 + 1
  const canV = rect.w >= spec.minRoom * 2 + 1
  if (!canH && !canV) return [rect]
  if (rect.w <= spec.maxRoom && rect.h <= spec.maxRoom && chance(rng, 0.4)) return [rect]

  const horizontal = canH && (!canV || rect.h > rect.w)
  if (horizontal) {
    const cut = randInt(rng, spec.minRoom, rect.h - spec.minRoom)
    return [
      ...splitRect(rng, {x: rect.x, y: rect.y, w: rect.w, h: cut}, spec),
      ...splitRect(rng, {x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut}, spec)
    ]
  }
  const cut = randInt(rng, spec.minRoom, rect.w - spec.minRoom)
  return [
    ...splitRect(rng, {x: rect.x, y: rect.y, w: cut, h: rect.h}, spec),
    ...splitRect(rng, {x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h}, spec)
  ]
}

// ---- Room typing: honor required types, fill the rest by theme ---------------

type Theme = MapSpec['theme']

// Per theme: `focal` rooms appear at most once each (a deck has one bridge, one
// medbay) and take the largest rooms; `common` rooms fill the rest by weighted
// pick — repeats in the list raise a type's weight.
const themePalette: Record<Theme, {focal: RoomType[]; common: RoomType[]}> = {
  civilian: {
    focal: ['bridge', 'medbay'],
    common: ['quarters', 'quarters', 'quarters', 'common', 'fresher', 'storage']
  },
  military: {
    focal: ['bridge', 'medbay'],
    common: ['quarters', 'quarters', 'engineering', 'storage', 'storage', 'common']
  },
  industrial: {
    focal: ['bridge', 'medbay'],
    common: ['cargo', 'cargo', 'engineering', 'engineering', 'storage', 'common']
  },
  derelict: {
    focal: ['bridge'],
    common: ['storage', 'storage', 'cargo', 'quarters', 'engineering', 'common']
  }
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

const assignTypes = (rng: Rng, rects: Rect[], spec: MapSpec): Room[] => {
  // Largest rooms get required types, then one of each focal type; the rest fill
  // from the weighted common palette — so focal rooms stay singular and central
  // instead of a deck sprouting six bridges.
  const order = [...rects].sort((a, b) => b.w * b.h - a.w * a.h)
  const {focal, common} = themePalette[spec.theme]
  const queue = [...spec.required, ...focal.filter((t) => !spec.required.includes(t))]
  return order.map((rect, index) => {
    const type = queue.shift() ?? pick(rng, common)
    return {...rect, id: `room-${String(index + 1).padStart(3, '0')}`, type, label: roomLabels[type]}
  })
}

// ---- Cell-grid layout: hull, margin, corridor bands, regions, rooms ----------

type Layout = {
  field: Rect // inner room/corridor area, in global cell coords
  vBands: {x: number; w: number}[] // vertical corridor bands (global cells)
  hBands: {y: number; h: number}[] // horizontal corridor bands (global cells)
  rooms: Room[]
  corridorRects: Rect[] // band + sliver rects (global cells) for floor shading
  tag: number[][] // field-local [y][x] -> CORRIDOR | room tag (1-based)
}

// Corridor archetypes: counts of vertical/horizontal full-span bands. Any axis
// with >= 2 bands always pairs with >= 1 perpendicular band, so the corridor
// network is always connected (single-band cases are one connected band).
const ARCHETYPES: {nV: number; nH: number; weight: number}[] = [
  {nV: 1, nH: 1, weight: 4}, // cross (off-centre)
  {nV: 1, nH: 0, weight: 2}, // vertical spine
  {nV: 0, nH: 1, weight: 2}, // horizontal spine
  {nV: 2, nH: 1, weight: 2}, // ladder
  {nV: 1, nH: 2, weight: 2}, // ladder
  {nV: 2, nH: 2, weight: 1} // grid
]

const pickArchetype = (rng: Rng): {nV: number; nH: number} => {
  const total = ARCHETYPES.reduce((s, a) => s + a.weight, 0)
  let r = rng() * total
  for (const a of ARCHETYPES) if ((r -= a.weight) < 0) return a
  return ARCHETYPES[0]
}

// Place `count` bands of width `w` in [0, length), each gap (including the two
// ends) at least `minGap`, with the slack distributed randomly so positions are
// off-centre and asymmetric. Drops a band if there isn't room.
const bandPositions = (rng: Rng, length: number, count: number, w: number, minGap: number): number[] => {
  if (count <= 0) return []
  const need = count * w + (count + 1) * minGap
  if (length < need) return bandPositions(rng, length, count - 1, w, minGap)
  let extra = length - need
  const positions: number[] = []
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    const share = Math.floor(extra / (count - i + 1))
    const gap = minGap + randInt(rng, 0, share)
    extra -= gap - minGap
    cursor += gap
    positions.push(cursor)
    cursor += w
  }
  return positions
}

// Open intervals [start, end) of interior between consecutive bands (and edges).
const intervals = (length: number, starts: number[], w: number): [number, number][] => {
  const iv: [number, number][] = []
  let cursor = 0
  for (const s of starts) {
    if (s - cursor >= 1) iv.push([cursor, s])
    cursor = s + w
  }
  if (length - cursor >= 1) iv.push([cursor, length])
  return iv
}

const buildLayout = (rng: Rng, spec: MapSpec): Layout => {
  const m = spec.hullMargin
  const field: Rect = {x: m, y: m, w: spec.cols - 2 * m, h: spec.rows - 2 * m}
  const cw = Math.max(1, spec.corridorWidth)

  const {nV, nH} = pickArchetype(rng)
  const vStarts = bandPositions(rng, field.w, nV, cw, spec.minRoom)
  const hStarts = bandPositions(rng, field.h, nH, cw, spec.minRoom)
  // Guarantee at least one band so there is circulation and an airlock.
  if (vStarts.length === 0 && hStarts.length === 0) {
    const v = bandPositions(rng, field.w, 1, cw, spec.minRoom)
    if (v.length) vStarts.push(...v)
    else hStarts.push(...bandPositions(rng, field.h, 1, cw, spec.minRoom))
  }

  const inV = (lx: number): boolean => vStarts.some((s) => lx >= s && lx < s + cw)
  const inH = (ly: number): boolean => hStarts.some((s) => ly >= s && ly < s + cw)

  // Rectangular regions = (column interval) x (row interval) between bands.
  const colsIv = intervals(field.w, vStarts, cw)
  const rowsIv = intervals(field.h, hStarts, cw)
  const regions: Rect[] = []
  for (const [cx0, cx1] of colsIv)
    for (const [ry0, ry1] of rowsIv) regions.push({x: cx0, y: ry0, w: cx1 - cx0, h: ry1 - ry0})

  const roomable = (r: Rect): boolean => r.w >= spec.minRoom && r.h >= spec.minRoom
  const rectsLocal = regions.filter(roomable).flatMap((r) => splitRect(rng, r, spec))
  const slivers = regions.filter((r) => !roomable(r))
  const rooms = assignTypes(rng, rectsLocal, spec).map((room) => ({
    ...room,
    x: field.x + room.x,
    y: field.y + room.y
  }))

  // Tag grid (field-local): corridor bands, then room ids, then fold any leftover
  // (sliver) cells into corridor so there are never enclosed voids.
  const tag: number[][] = Array.from({length: field.h}, () => Array.from({length: field.w}, () => OUT))
  for (let ly = 0; ly < field.h; ly += 1)
    for (let lx = 0; lx < field.w; lx += 1) if (inV(lx) || inH(ly)) tag[ly][lx] = CORRIDOR
  rooms.forEach((room, index) => {
    const id = index + 1
    for (let ly = room.y - field.y; ly < room.y - field.y + room.h; ly += 1)
      for (let lx = room.x - field.x; lx < room.x - field.x + room.w; lx += 1)
        if (tag[ly]?.[lx] === OUT) tag[ly][lx] = id
  })
  for (let ly = 0; ly < field.h; ly += 1)
    for (let lx = 0; lx < field.w; lx += 1) if (tag[ly][lx] === OUT) tag[ly][lx] = CORRIDOR

  const vBands = vStarts.map((s) => ({x: field.x + s, w: cw}))
  const hBands = hStarts.map((s) => ({y: field.y + s, h: cw}))
  const corridorRects: Rect[] = [
    ...vBands.map((b) => ({x: b.x, y: field.y, w: b.w, h: field.h})),
    ...hBands.map((b) => ({x: field.x, y: b.y, w: field.w, h: b.h})),
    ...slivers.map((r) => ({x: field.x + r.x, y: field.y + r.y, w: r.w, h: r.h}))
  ]

  return {field, vBands, hBands, rooms, corridorRects, tag}
}

// ---- Doors + connectivity ---------------------------------------------------

type Edge = {x: number; y: number; horizontal: boolean} // field-local unit edge
type Boundary = {a: number; b: number; edges: Edge[]} // a<b interior tag pair

const tagAt = (tag: number[][], x: number, y: number): number =>
  y >= 0 && y < tag.length && x >= 0 && x < tag[0].length ? tag[y][x] : OUT

// Collect the unit edges between every pair of differing tags. Horizontal edges
// sit on a grid line y between cells (x,y-1)/(x,y); vertical edges on line x.
const collectBoundaries = (tag: number[][]): Map<string, Boundary> => {
  const fh = tag.length
  const fw = tag[0].length
  const map = new Map<string, Boundary>()
  const add = (a: number, b: number, edge: Edge): void => {
    if (a === OUT || b === OUT) return // field perimeter handled separately
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = `${lo}:${hi}`
    const found = map.get(key) ?? {a: lo, b: hi, edges: []}
    found.edges.push(edge)
    map.set(key, found)
  }
  for (let y = 0; y <= fh; y += 1)
    for (let x = 0; x < fw; x += 1) {
      const t = tagAt(tag, x, y - 1)
      const b = tagAt(tag, x, y)
      if (t !== b) add(t, b, {x, y, horizontal: true})
    }
  for (let x = 0; x <= fw; x += 1)
    for (let y = 0; y < fh; y += 1) {
      const l = tagAt(tag, x - 1, y)
      const r = tagAt(tag, x, y)
      if (l !== r) add(l, r, {x, y, horizontal: false})
    }
  return map
}

// Pick the door cell for a boundary: the midpoint of its longest contiguous run.
const doorEdge = (boundary: Boundary): Edge => {
  const {edges} = boundary
  const horizontal = edges[0].horizontal
  const sorted = [...edges].sort((p, q) => (horizontal ? p.x - q.x : p.y - q.y))
  let best: Edge[] = []
  let run: Edge[] = []
  const coord = (e: Edge): number => (horizontal ? e.x : e.y)
  const line = (e: Edge): number => (horizontal ? e.y : e.x)
  for (const e of sorted) {
    const prev = run[run.length - 1]
    if (prev && line(e) === line(prev) && coord(e) === coord(prev) + 1) run.push(e)
    else run = [e]
    if (run.length > best.length) best = [...run]
  }
  return best[Math.floor(best.length / 2)]
}

const chooseDoors = (rng: Rng, roomCount: number, boundaries: Boundary[]): {edge: Edge}[] => {
  // Nodes: rooms 1..roomCount -> 0..roomCount-1; corridor (tag 0) -> roomCount.
  const corridorNode = roomCount
  const node = (tagValue: number): number => (tagValue === CORRIDOR ? corridorNode : tagValue - 1)
  const parent = Array.from({length: roomCount + 1}, (_, i) => i)
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

  // Prefer room↔corridor edges in the spanning tree so rooms open onto the
  // corridor, like the originals; shuffle within each class for variety.
  const withMeta = boundaries.map((bd) => ({bd, toCorridor: bd.a === CORRIDOR || bd.b === CORRIDOR}))
  const ordered = [
    ...shuffle(rng, withMeta.filter((e) => e.toCorridor)),
    ...shuffle(rng, withMeta.filter((e) => !e.toCorridor))
  ]
  const chosen: {edge: Edge}[] = []
  const extras: Boundary[] = []
  for (const {bd} of ordered) {
    if (union(node(bd.a), node(bd.b))) chosen.push({edge: doorEdge(bd)})
    else extras.push(bd)
  }
  for (const bd of extras) if (chance(rng, 0.12)) chosen.push({edge: doorEdge(bd)})
  return chosen
}

// ---- Wall extraction (cell boundaries minus doors), merged into segments -----

const edgeKey = (e: Edge): string => `${e.horizontal ? 'h' : 'v'}:${e.x}:${e.y}`

const extractWalls = (tag: number[][], doorEdges: Set<string>, field: Rect, g: number): Occluder[] => {
  const fh = tag.length
  const fw = tag[0].length
  const vSet = new Set<string>()
  const hSet = new Set<string>()
  for (let y = 0; y <= fh; y += 1)
    for (let x = 0; x < fw; x += 1) {
      if (tagAt(tag, x, y - 1) === tagAt(tag, x, y)) continue
      if (!doorEdges.has(edgeKey({x, y, horizontal: true}))) hSet.add(`${x}:${y}`)
    }
  for (let x = 0; x <= fw; x += 1)
    for (let y = 0; y < fh; y += 1) {
      if (tagAt(tag, x - 1, y) === tagAt(tag, x, y)) continue
      if (!doorEdges.has(edgeKey({x, y, horizontal: false}))) vSet.add(`${x}:${y}`)
    }

  const walls: Occluder[] = []
  const px = (cx: number, cy: number): [number, number] => [(field.x + cx) * g, (field.y + cy) * g]
  let id = 0
  for (let y = 0; y <= fh; y += 1) {
    let x = 0
    while (x < fw) {
      if (!hSet.has(`${x}:${y}`)) {
        x += 1
        continue
      }
      let end = x
      while (hSet.has(`${end}:${y}`)) end += 1
      const [x1, y1] = px(x, y)
      const [x2, y2] = px(end, y)
      walls.push({type: 'wall', id: `w${(id += 1)}`, x1, y1, x2, y2})
      x = end
    }
  }
  for (let x = 0; x <= fw; x += 1) {
    let y = 0
    while (y < fh) {
      if (!vSet.has(`${x}:${y}`)) {
        y += 1
        continue
      }
      let end = y
      while (vSet.has(`${x}:${end}`)) end += 1
      const [x1, y1] = px(x, y)
      const [x2, y2] = px(x, end)
      walls.push({type: 'wall', id: `w${(id += 1)}`, x1, y1, x2, y2})
      y = end
    }
  }
  return walls
}

// ---- Hull octagon + airlocks ------------------------------------------------

const hullAndAirlocks = (
  spec: MapSpec,
  layout: Layout
): {hull: Occluder[]; airlocks: Occluder[]; stubs: Rect[]; stubWalls: Occluder[]} => {
  const g = spec.gridScale
  const {cols, rows} = spec
  const ch = Math.max(2, Math.round(Math.min(cols, rows) * 0.12)) // chamfer in cells
  const W = cols * g
  const H = rows * g
  const c = ch * g
  const {field} = layout
  const fx2 = field.x + field.w
  const fy2 = field.y + field.h

  const seg = (id: string, x1: number, y1: number, x2: number, y2: number): Occluder => ({
    type: 'wall',
    id: `hull-${id}`,
    x1,
    y1,
    x2,
    y2
  })
  const sw = (id: string, x1: number, y1: number, x2: number, y2: number): Occluder => ({
    type: 'wall',
    id: `stub-${id}`,
    x1,
    y1,
    x2,
    y2
  })

  // A straight hull side carved to leave each airlock opening as a gap.
  const carvedSide = (
    id: string,
    along: 'h' | 'v',
    fixed: number,
    from: number,
    to: number,
    openings: [number, number][]
  ): Occluder[] => {
    const out: Occluder[] = []
    let cursor = from
    let n = 0
    const mk = (p1: number, p2: number): void => {
      if (p2 - p1 < g * 0.2) return
      n += 1
      out.push(along === 'h' ? seg(`${id}${n}`, p1, fixed, p2, fixed) : seg(`${id}${n}`, fixed, p1, fixed, p2))
    }
    for (const [s, e] of [...openings].sort((a, b) => a[0] - b[0])) {
      mk(cursor, s)
      cursor = Math.max(cursor, e)
    }
    mk(cursor, to)
    return out
  }

  const topBottom = layout.vBands.map((b): [number, number] => [b.x * g, (b.x + b.w) * g])
  const leftRight = layout.hBands.map((b): [number, number] => [b.y * g, (b.y + b.h) * g])

  const hull: Occluder[] = [
    seg('tl', c, 0, 0, c),
    seg('tr', W - c, 0, W, c),
    seg('br', W, H - c, W - c, H),
    seg('bl', c, H, 0, H - c),
    ...carvedSide('top', 'h', 0, c, W - c, topBottom),
    ...carvedSide('bottom', 'h', H, c, W - c, topBottom),
    ...carvedSide('left', 'v', 0, c, H - c, leftRight),
    ...carvedSide('right', 'v', W, c, H - c, leftRight)
  ]

  const airlocks: Occluder[] = []
  const stubs: Rect[] = []
  const stubWalls: Occluder[] = []
  layout.vBands.forEach((b, i) => {
    const x1 = b.x * g
    const x2 = (b.x + b.w) * g
    airlocks.push({type: 'door', id: `airlock-n${i}`, x1, y1: 0, x2, y2: 0, open: false})
    airlocks.push({type: 'door', id: `airlock-s${i}`, x1, y1: H, x2, y2: H, open: false})
    stubs.push({x: b.x, y: 0, w: b.w, h: field.y})
    stubs.push({x: b.x, y: fy2, w: b.w, h: rows - fy2})
    stubWalls.push(sw(`n${i}a`, x1, 0, x1, field.y * g), sw(`n${i}b`, x2, 0, x2, field.y * g))
    stubWalls.push(sw(`s${i}a`, x1, fy2 * g, x1, H), sw(`s${i}b`, x2, fy2 * g, x2, H))
  })
  layout.hBands.forEach((b, i) => {
    const y1 = b.y * g
    const y2 = (b.y + b.h) * g
    airlocks.push({type: 'door', id: `airlock-w${i}`, x1: 0, y1, x2: 0, y2, open: false})
    airlocks.push({type: 'door', id: `airlock-e${i}`, x1: W, y1, x2: W, y2, open: false})
    stubs.push({x: 0, y: b.y, w: field.x, h: b.h})
    stubs.push({x: fx2, y: b.y, w: cols - fx2, h: b.h})
    stubWalls.push(sw(`w${i}a`, 0, y1, field.x * g, y1), sw(`w${i}b`, 0, y2, field.x * g, y2))
    stubWalls.push(sw(`e${i}a`, fx2 * g, y1, W, y1), sw(`e${i}b`, fx2 * g, y2, W, y2))
  })

  return {hull, airlocks, stubs, stubWalls}
}

// ---- Furniture: decorative only, per room type ------------------------------

const furnishRoom = (rng: Rng, room: Room, g: number, density: number): Decoration[] => {
  const items: Decoration[] = []
  const inset = g * 0.2
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
      const bunks = Math.max(1, Math.floor((w / g) * density))
      for (let i = 0; i < bunks; i += 1) {
        if (!chance(rng, density)) continue
        add('bunk', (i * w) / bunks, 0, (w / bunks) * 0.8, g * 0.7)
      }
      break
    }
    case 'bridge': {
      add('console', w / 2 - g * 0.9, 0, g * 1.8, g * 0.5)
      add('chair', w / 2 - g * 0.3, h * 0.45, g * 0.6, g * 0.6)
      break
    }
    case 'cargo': {
      const cols = Math.max(1, Math.floor((w / g) * 0.6))
      const rows = Math.max(1, Math.floor((h / g) * 0.6))
      for (let cx = 0; cx < cols; cx += 1)
        for (let cy = 0; cy < rows; cy += 1) {
          if (!chance(rng, density * 0.8)) continue
          add('crate', (cx * w) / cols, (cy * h) / rows, (w / cols) * 0.7, (h / rows) * 0.7)
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
      const shelves = Math.max(1, Math.floor((h / g) * density))
      for (let i = 0; i < shelves; i += 1) add('shelf', 0, (i * h) / shelves, g * 0.5, g * 0.6)
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

  const layout = buildLayout(rng, spec)
  const {field} = layout
  const boundaries = [...collectBoundaries(layout.tag).values()]
  const doors = chooseDoors(rng, layout.rooms.length, boundaries)

  // Door occluders + the set of edges to skip when extracting walls.
  const doorEdges = new Set<string>()
  const px = (cx: number, cy: number): [number, number] => [(field.x + cx) * g, (field.y + cy) * g]
  const doorOccluders: Occluder[] = doors.map(({edge}, index) => {
    doorEdges.add(edgeKey(edge))
    const [x1, y1] = px(edge.x, edge.y)
    const [x2, y2] = edge.horizontal ? px(edge.x + 1, edge.y) : px(edge.x, edge.y + 1)
    return {type: 'door', id: `door-${String(index + 1).padStart(3, '0')}`, x1, y1, x2, y2, open: false}
  })

  // Open the field perimeter where corridor bands meet it (airlock inner
  // openings) so the corridor connects out through the margin to the stubs.
  const fw = field.w
  const fh = field.h
  for (const b of layout.vBands) {
    const lx = b.x - field.x
    for (let k = 0; k < b.w; k += 1) {
      doorEdges.add(edgeKey({x: lx + k, y: 0, horizontal: true}))
      doorEdges.add(edgeKey({x: lx + k, y: fh, horizontal: true}))
    }
  }
  for (const b of layout.hBands) {
    const ly = b.y - field.y
    for (let k = 0; k < b.h; k += 1) {
      doorEdges.add(edgeKey({x: 0, y: ly + k, horizontal: false}))
      doorEdges.add(edgeKey({x: fw, y: ly + k, horizontal: false}))
    }
  }

  const walls = extractWalls(layout.tag, doorEdges, field, g)
  const {hull, airlocks, stubs, stubWalls} = hullAndAirlocks(spec, layout)
  const decorations = layout.rooms.flatMap((room) => furnishRoom(rng, room, g, spec.furnitureDensity))

  return {
    spec,
    width: spec.cols * g,
    height: spec.rows * g,
    gridScale: g,
    rooms: layout.rooms,
    corridors: [...layout.corridorRects, ...stubs],
    decorations,
    occluders: [...walls, ...stubWalls, ...hull, ...doorOccluders, ...airlocks]
  }
}
