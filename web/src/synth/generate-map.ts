// Synthetic deck generator — the structural-truth layer. Pure and seeded: a
// deterministic function of MapSpec. No DOM/Cloudflare, like los-core, so it can
// move into the core and be unit-tested without a browser.
//
// Model (mirrors the Starship Geomorphs tile grammar):
//   - An octagonal HULL skin at the board bounds (chamfered corners).
//   - A MARGIN gap between the hull and the room block (where the originals put
//     fuel/conduits) — so rooms never stair-step against the angled hull.
//   - A CORRIDOR cross through the inner field reaching the four edge midpoints;
//     AIRLOCKS connect those points out through the margin to the hull.
//   - ROOMS fill the four quadrants (BSP), each doored ONTO the corridor where
//     possible (room↔room only as a fallback), so circulation reads like a deck.
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

const themeFill: Record<Theme, RoomType[]> = {
  civilian: ['quarters', 'common', 'fresher', 'storage', 'medbay'],
  military: ['quarters', 'engineering', 'storage', 'medbay', 'bridge'],
  industrial: ['cargo', 'engineering', 'storage', 'common'],
  derelict: ['storage', 'cargo', 'quarters', 'engineering', 'common']
}

type Theme = MapSpec['theme']

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
  // Largest cells get the "important" required rooms so they read as focal
  // spaces; the rest fill from the theme palette.
  const order = [...rects].sort((a, b) => b.w * b.h - a.w * a.h)
  const fill = themeFill[spec.theme]
  const required = [...spec.required]
  return order.map((rect, index) => {
    const type = required.shift() ?? pick(rng, fill)
    return {...rect, id: `room-${String(index + 1).padStart(3, '0')}`, type, label: roomLabels[type]}
  })
}

// ---- Cell-grid layout: hull, margin, corridor cross, quadrant rooms ----------

type Layout = {
  field: Rect // inner room/corridor area, in global cell coords
  vBand: {x: number; w: number} // vertical corridor band (global cells)
  hBand: {y: number; h: number} // horizontal corridor band (global cells)
  rooms: Room[]
  tag: number[][] // field-local [y][x] -> CORRIDOR | room tag (1-based room index)
}

const buildLayout = (rng: Rng, spec: MapSpec): Layout => {
  const m = spec.hullMargin
  const field: Rect = {x: m, y: m, w: spec.cols - 2 * m, h: spec.rows - 2 * m}
  const cw = Math.max(1, spec.corridorWidth)

  // Corridor cross, centered in the field (local coords).
  const vlx = Math.floor((field.w - cw) / 2)
  const hly = Math.floor((field.h - cw) / 2)

  const inV = (lx: number): boolean => lx >= vlx && lx < vlx + cw
  const inH = (ly: number): boolean => ly >= hly && ly < hly + cw

  // Four quadrant rectangles (local), the field minus the cross.
  const quadrants: Rect[] = [
    {x: 0, y: 0, w: vlx, h: hly}, // TL
    {x: vlx + cw, y: 0, w: field.w - (vlx + cw), h: hly}, // TR
    {x: 0, y: hly + cw, w: vlx, h: field.h - (hly + cw)}, // BL
    {x: vlx + cw, y: hly + cw, w: field.w - (vlx + cw), h: field.h - (hly + cw)} // BR
  ].filter((q) => q.w >= spec.minRoom && q.h >= spec.minRoom)

  const rectsLocal = quadrants.flatMap((q) =>
    splitRect(rng, q, spec).map((r) => ({x: q.x + (r.x - q.x), y: q.y + (r.y - q.y), w: r.w, h: r.h}))
  )
  // splitRect already returns rects in the quadrant's own coords; keep as-is.
  const rooms = assignTypes(rng, rectsLocal, spec).map((room) => ({
    ...room,
    x: field.x + room.x,
    y: field.y + room.y
  }))

  // Tag grid (field-local). Corridor first, then stamp room ids.
  const tag: number[][] = Array.from({length: field.h}, () => Array.from({length: field.w}, () => OUT))
  for (let ly = 0; ly < field.h; ly += 1)
    for (let lx = 0; lx < field.w; lx += 1) if (inV(lx) || inH(ly)) tag[ly][lx] = CORRIDOR
  rooms.forEach((room, index) => {
    const id = index + 1
    for (let ly = room.y - field.y; ly < room.y - field.y + room.h; ly += 1)
      for (let lx = room.x - field.x; lx < room.x - field.x + room.w; lx += 1)
        if (tag[ly]?.[lx] === OUT) tag[ly][lx] = id
  })

  return {
    field,
    vBand: {x: field.x + vlx, w: cw},
    hBand: {y: field.y + hly, h: cw},
    rooms,
    tag
  }
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
  // group into runs along the shared line
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

const chooseDoors = (
  rng: Rng,
  roomCount: number,
  boundaries: Boundary[]
): {edge: Edge}[] => {
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
  // perimeter (interior↔OUT) and interior↔interior both become walls, unless a
  // door sits on that edge.
  for (let y = 0; y <= fh; y += 1)
    for (let x = 0; x < fw; x += 1) {
      if (tagAt(tag, x, y - 1) === tagAt(tag, x, y)) continue
      const e: Edge = {x, y, horizontal: true}
      if (!doorEdges.has(edgeKey(e))) hSet.add(`${x}:${y}`)
    }
  for (let x = 0; x <= fw; x += 1)
    for (let y = 0; y < fh; y += 1) {
      if (tagAt(tag, x - 1, y) === tagAt(tag, x, y)) continue
      const e: Edge = {x, y, horizontal: false}
      if (!doorEdges.has(edgeKey(e))) vSet.add(`${x}:${y}`)
    }

  const walls: Occluder[] = []
  const px = (cx: number, cy: number): [number, number] => [(field.x + cx) * g, (field.y + cy) * g]
  let id = 0
  // merge horizontal runs (same y, consecutive x)
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
  // merge vertical runs (same x, consecutive y)
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
  const {cols, rows, hullMargin: m} = spec
  const ch = Math.max(2, Math.round(Math.min(cols, rows) * 0.12)) // chamfer in cells
  const W = cols * g
  const H = rows * g
  const c = ch * g

  // Connection spans on each hull side (where the corridor bands reach out).
  const vx1 = layout.vBand.x * g
  const vx2 = (layout.vBand.x + layout.vBand.w) * g
  const hy1 = layout.hBand.y * g
  const hy2 = (layout.hBand.y + layout.hBand.h) * g

  const seg = (id: string, x1: number, y1: number, x2: number, y2: number): Occluder => ({
    type: 'wall',
    id: `hull-${id}`,
    x1,
    y1,
    x2,
    y2
  })
  // A straight hull side, carved to leave the airlock opening [s,e] (1D).
  const carvedSide = (
    id: string,
    along: 'h' | 'v',
    fixed: number,
    from: number,
    to: number,
    s: number,
    e: number
  ): Occluder[] => {
    const out: Occluder[] = []
    const mk = (p1: number, p2: number, n: number): void => {
      if (p2 - p1 < g * 0.2) return
      out.push(
        along === 'h'
          ? seg(`${id}${n}`, p1, fixed, p2, fixed)
          : seg(`${id}${n}`, fixed, p1, fixed, p2)
      )
    }
    mk(from, s, 1)
    mk(e, to, 2)
    return out
  }

  const hull: Occluder[] = [
    // chamfer diagonals
    seg('tl', c, 0, 0, c),
    seg('tr', W - c, 0, W, c),
    seg('br', W, H - c, W - c, H),
    seg('bl', c, H, 0, H - c),
    // straight sides, each carved for its airlock opening
    ...carvedSide('top', 'h', 0, c, W - c, vx1, vx2),
    ...carvedSide('bottom', 'h', H, c, W - c, vx1, vx2),
    ...carvedSide('left', 'v', 0, c, H - c, hy1, hy2),
    ...carvedSide('right', 'v', W, c, H - c, hy1, hy2)
  ]

  // Airlock doors sit on the hull line across each opening.
  const airlocks: Occluder[] = [
    {type: 'door', id: 'airlock-n', x1: vx1, y1: 0, x2: vx2, y2: 0, open: false},
    {type: 'door', id: 'airlock-s', x1: vx1, y1: H, x2: vx2, y2: H, open: false},
    {type: 'door', id: 'airlock-w', x1: 0, y1: hy1, x2: 0, y2: hy2, open: false},
    {type: 'door', id: 'airlock-e', x1: W, y1: hy1, x2: W, y2: hy2, open: false}
  ]

  // Corridor stubs crossing the margin (for floor shading), in cell coords.
  const fx2 = layout.field.x + layout.field.w
  const fy2 = layout.field.y + layout.field.h
  const stubs: Rect[] = [
    {x: layout.vBand.x, y: 0, w: layout.vBand.w, h: m},
    {x: layout.vBand.x, y: fy2, w: layout.vBand.w, h: rows - fy2},
    {x: 0, y: layout.hBand.y, w: m, h: layout.hBand.h},
    {x: fx2, y: layout.hBand.y, w: cols - fx2, h: layout.hBand.h}
  ]

  // Stub side walls bridge the margin from the field edge to the hull.
  const sw = (id: string, x1: number, y1: number, x2: number, y2: number): Occluder => ({
    type: 'wall',
    id: `stub-${id}`,
    x1,
    y1,
    x2,
    y2
  })
  const stubWalls: Occluder[] = [
    sw('n1', vx1, 0, vx1, m * g),
    sw('n2', vx2, 0, vx2, m * g),
    sw('s1', vx1, fy2 * g, vx1, H),
    sw('s2', vx2, fy2 * g, vx2, H),
    sw('w1', 0, hy1, m * g, hy1),
    sw('w2', 0, hy2, m * g, hy2),
    sw('e1', fx2 * g, hy1, W, hy1),
    sw('e2', fx2 * g, hy2, W, hy2)
  ]

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
  const boundaries = [...collectBoundaries(layout.tag).values()]
  const doors = chooseDoors(rng, layout.rooms.length, boundaries)

  // Door occluders + the set of edges to skip when extracting walls.
  const doorEdges = new Set<string>()
  const px = (cx: number, cy: number): [number, number] => [
    (layout.field.x + cx) * g,
    (layout.field.y + cy) * g
  ]
  const doorOccluders: Occluder[] = doors.map(({edge}, index) => {
    doorEdges.add(edgeKey(edge))
    const [x1, y1] = px(edge.x, edge.y)
    const [x2, y2] = edge.horizontal ? px(edge.x + 1, edge.y) : px(edge.x, edge.y + 1)
    return {type: 'door', id: `door-${String(index + 1).padStart(3, '0')}`, x1, y1, x2, y2, open: false}
  })

  // Open the field perimeter where the corridor bands meet it (airlock inner
  // openings) so the corridor connects out to the stubs.
  const fw = layout.field.w
  const fh = layout.field.h
  const vlx = layout.vBand.x - layout.field.x
  const hly = layout.hBand.y - layout.field.y
  for (let k = 0; k < layout.vBand.w; k += 1) {
    doorEdges.add(edgeKey({x: vlx + k, y: 0, horizontal: true}))
    doorEdges.add(edgeKey({x: vlx + k, y: fh, horizontal: true}))
  }
  for (let k = 0; k < layout.hBand.h; k += 1) {
    doorEdges.add(edgeKey({x: 0, y: hly + k, horizontal: false}))
    doorEdges.add(edgeKey({x: fw, y: hly + k, horizontal: false}))
  }

  const walls = extractWalls(layout.tag, doorEdges, layout.field, g)
  const {hull, airlocks, stubs, stubWalls} = hullAndAirlocks(spec, layout)
  const decorations = layout.rooms.flatMap((room) => furnishRoom(rng, room, g, spec.furnitureDensity))

  return {
    spec,
    width: spec.cols * g,
    height: spec.rows * g,
    gridScale: g,
    rooms: layout.rooms,
    corridors: [
      {x: layout.vBand.x, y: layout.field.y, w: layout.vBand.w, h: layout.field.h},
      {x: layout.field.x, y: layout.hBand.y, w: layout.field.w, h: layout.hBand.h},
      ...stubs
    ],
    decorations,
    occluders: [...walls, ...stubWalls, ...hull, ...doorOccluders, ...airlocks]
  }
}
