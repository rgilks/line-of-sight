// EXPERIMENTAL wall/door detector spike — NOT wired into the app.
//
// Implements the stroke-thickness pipeline from docs/WALL_DOOR_DETECTION.md:
//   binarize → connected-component text/furniture strip → distance-transform
//   thickness gate → axis-run extraction → grid/axis snap → door gaps.
//
// The premise (per the research): walls are THICK grid-aligned strokes; almost
// all noise (furniture outlines, text, door arcs, the grid) is THIN. So instead
// of scanning pixel runs and rejecting noise case-by-case, we delete everything
// thin up front with one geometric gate, then extract lines from what survives.
//
// This is a deliberately dependency-free pure-TS implementation (no OpenCV.js):
// if a hand-rolled distance transform already beats the current detector on real
// maps, we avoid shipping ~8-10MB of WASM. It mirrors analyzeImageRgba's
// signature so the A/B harness can swap detectors with one import.
//
// Pure: no DOM, no Cloudflare, no Preact — same constraints as los-core.ts, so
// it can move into the core unchanged if the spike proves out.
import type {Occluder} from './los-core'

export type SpikeOptions = {
  // Luminance below this (0-255), with alpha above alphaMin, counts as ink.
  luminanceMax?: number
  alphaMin?: number
  // A stroke is a "wall" if its local half-width (the max distance-transform
  // value along its medial ridge) is at least this many pixels. Derived from
  // gridScale when omitted: walls are a meaningful fraction of a cell.
  minWallHalfWidth?: number
  // Components whose pixel area is below this are dropped as specks before the
  // thickness gate (kills antialiasing crumbs).
  minComponentArea?: number
}

type Mask = {width: number; height: number; data: Uint8Array}

const luminance = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b

// Step 1 — binarize to an ink mask (1 = dark & opaque), matching los-core's gate.
const binarize = (
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  luminanceMax: number,
  alphaMin: number
): Mask => {
  const data = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    const a = rgba[i * 4 + 3]
    data[i] = a >= alphaMin && luminance(r, g, b) < luminanceMax ? 1 : 0
  }
  return {width, height, data}
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher, 2-pass 1D).
// Returns, for every foreground pixel, the distance to the nearest background
// pixel. The ridge (per-component max) of this field is half the local stroke
// width — the key quantity the research says to gate on.
const distanceTransform = (mask: Mask): Float64Array => {
  const {width, height, data} = mask
  const INF = 1e20
  // Seed: 0 at background, INF at foreground (we want distance TO background).
  const grid = new Float64Array(width * height)
  for (let i = 0; i < width * height; i += 1) grid[i] = data[i] === 1 ? INF : 0

  const f = new Float64Array(Math.max(width, height))
  const d = new Float64Array(Math.max(width, height))
  const v = new Int32Array(Math.max(width, height))
  const z = new Float64Array(Math.max(width, height) + 1)

  const dt1d = (n: number): void => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q += 1) {
      let s =
        (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k -= 1
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k += 1
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q += 1) {
      while (z[k + 1] < q) k += 1
      const dist = q - v[k]
      d[q] = dist * dist + f[v[k]]
    }
  }

  // Columns.
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) f[y] = grid[y * width + x]
    dt1d(height)
    for (let y = 0; y < height; y += 1) grid[y * width + x] = d[y]
  }
  // Rows.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) f[x] = grid[y * width + x]
    dt1d(width)
    for (let x = 0; x < width; x += 1) grid[y * width + x] = d[x]
  }

  const out = new Float64Array(width * height)
  for (let i = 0; i < width * height; i += 1) out[i] = Math.sqrt(grid[i])
  return out
}

// Step 2+3 — label connected components (4-conn), then keep a component only if
// its max distance-transform value clears the wall half-width threshold AND it
// is big enough to matter. This is the single gate that replaces per-failure
// special cases: thin furniture/text/arcs/grid never reach the threshold.
const thickWallMask = (
  mask: Mask,
  dt: Float64Array,
  minWallHalfWidth: number,
  minComponentArea: number
): Mask => {
  const {width, height, data} = mask
  const label = new Int32Array(width * height).fill(0)
  const keep = new Uint8Array(width * height)
  const stack: number[] = []
  let next = 0

  for (let start = 0; start < width * height; start += 1) {
    if (data[start] === 0 || label[start] !== 0) continue
    next += 1
    label[start] = next
    stack.length = 0
    stack.push(start)
    const pixels: number[] = []
    let maxDt = 0

    while (stack.length > 0) {
      const p = stack.pop() as number
      pixels.push(p)
      if (dt[p] > maxDt) maxDt = dt[p]
      const x = p % width
      const y = (p - x) / width
      if (x > 0 && data[p - 1] === 1 && label[p - 1] === 0) {
        label[p - 1] = next
        stack.push(p - 1)
      }
      if (x < width - 1 && data[p + 1] === 1 && label[p + 1] === 0) {
        label[p + 1] = next
        stack.push(p + 1)
      }
      if (y > 0 && data[p - width] === 1 && label[p - width] === 0) {
        label[p - width] = next
        stack.push(p - width)
      }
      if (y < height - 1 && data[p + width] === 1 && label[p + width] === 0) {
        label[p + width] = next
        stack.push(p + width)
      }
    }

    // A wall component is thick (ridge >= half-width) and not a speck.
    if (maxDt >= minWallHalfWidth && pixels.length >= minComponentArea) {
      for (const p of pixels) keep[p] = 1
    }
  }

  return {width, height, data: keep}
}

// Step 4 — extract axis-aligned wall runs from the cleaned thick mask by row and
// column scanning. (Spike scope: the cleaned mask is overwhelmingly axis-aligned
// once thin diagonal arcs are gone; diagonal handling via LSD-on-skeleton is the
// documented next increment, not this first pass.) Runs are snapped to the grid.
type Run = {x1: number; y1: number; x2: number; y2: number; horizontal: boolean}

const extractAxisRuns = (
  mask: Mask,
  gridScale: number,
  minRunLength: number
): Run[] => {
  const {width, height, data} = mask
  const runs: Run[] = []
  const snap = (value: number): number => Math.round(value / gridScale) * gridScale

  // Horizontal runs: scan each row.
  for (let y = 0; y < height; y += 1) {
    let x = 0
    while (x < width) {
      while (x < width && data[y * width + x] === 0) x += 1
      const start = x
      while (x < width && data[y * width + x] === 1) x += 1
      if (x - start >= minRunLength) {
        runs.push({x1: snap(start), y1: snap(y), x2: snap(x), y2: snap(y), horizontal: true})
      }
    }
  }
  // Vertical runs: scan each column.
  for (let x = 0; x < width; x += 1) {
    let y = 0
    while (y < height) {
      while (y < height && data[y * width + x] === 0) y += 1
      const start = y
      while (y < height && data[y * width + x] === 1) y += 1
      if (y - start >= minRunLength) {
        runs.push({x1: snap(x), y1: snap(start), x2: snap(x), y2: snap(y), horizontal: false})
      }
    }
  }
  return runs
}

type Segment = {x1: number; y1: number; x2: number; y2: number}

const lineSegment = (horizontal: boolean, line: number, start: number, end: number): Segment =>
  horizontal
    ? {x1: start, y1: line, x2: end, y2: line}
    : {x1: line, y1: start, x2: line, y2: end}

// Assemble per-grid-line runs into walls AND doors in one pass. The key fix over
// a naive merge: use TWO gap scales. Tiny gaps (snapping/anti-alias noise) are
// unioned into a single wall; a medium gap between two real wall flanks is a
// DOOR (matching the maps: doors are ~1-cell breaks in a thick wall). A naive
// merge that bridged up to a full cell swallowed every door, which is why the
// first spike found none.
const assembleLines = (
  runs: Run[],
  gridScale: number
): {walls: Segment[]; doors: Segment[]} => {
  const joinGap = gridScale * 0.3 // below this, two runs are one continuous wall
  const minDoorGap = gridScale * 0.4
  const maxDoorGap = gridScale * 1.7
  const minFlank = gridScale * 0.6 // a door needs real wall on both sides
  const minWallLength = gridScale * 0.45

  type Line = {horizontal: boolean; line: number; intervals: Array<[number, number]>}
  const byLine = new Map<string, Line>()
  for (const run of runs) {
    const horizontal = run.horizontal
    const line = horizontal ? run.y1 : run.x1
    const key = `${horizontal ? 'h' : 'v'}:${line}`
    const entry = byLine.get(key) ?? {horizontal, line, intervals: []}
    entry.intervals.push(
      horizontal
        ? [Math.min(run.x1, run.x2), Math.max(run.x1, run.x2)]
        : [Math.min(run.y1, run.y2), Math.max(run.y1, run.y2)]
    )
    byLine.set(key, entry)
  }

  const walls: Segment[] = []
  const doors: Segment[] = []
  for (const {horizontal, line, intervals} of byLine.values()) {
    intervals.sort((a, b) => a[0] - b[0])
    // Union intervals separated by less than joinGap into solid wall spans.
    const spans: Array<[number, number]> = [[...intervals[0]]]
    for (let i = 1; i < intervals.length; i += 1) {
      const [s, e] = intervals[i]
      const cur = spans[spans.length - 1]
      if (s <= cur[1] + joinGap) cur[1] = Math.max(cur[1], e)
      else spans.push([s, e])
    }

    for (const [s, e] of spans) {
      if (e - s >= minWallLength) walls.push(lineSegment(horizontal, line, s, e))
    }
    // A door is a gap, in the door-size range, flanked by real wall on each side.
    for (let i = 0; i < spans.length - 1; i += 1) {
      const a = spans[i]
      const b = spans[i + 1]
      const gap = b[0] - a[1]
      const aLen = a[1] - a[0]
      const bLen = b[1] - b[0]
      if (gap >= minDoorGap && gap <= maxDoorGap && aLen >= minFlank && bLen >= minFlank) {
        doors.push(lineSegment(horizontal, line, a[1], b[0]))
      }
    }
  }
  return {walls, doors}
}

// Spike entry point — same shape as analyzeImageRgba so the A/B harness swaps it
// in with one import change.
export const analyzeImageRgbaSpike = (
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  gridScale: number,
  options: SpikeOptions = {}
): Occluder[] => {
  if (width <= 0 || height <= 0) throw new Error('Image dimensions must be positive.')
  if (rgba.length !== width * height * 4) {
    throw new Error('RGBA buffer length does not match image dimensions.')
  }

  const grid = Number.isFinite(gridScale) && gridScale > 0 ? gridScale : 50
  const luminanceMax = options.luminanceMax ?? 58
  const alphaMin = options.alphaMin ?? 32
  const minWallHalfWidth = options.minWallHalfWidth ?? Math.max(2.5, grid * 0.06)
  const minComponentArea = options.minComponentArea ?? Math.max(40, grid * grid * 0.05)
  const minRunLength = Math.max(grid * 0.5, 16)

  const mask = binarize(width, height, rgba, luminanceMax, alphaMin)
  const dt = distanceTransform(mask)
  const walls = thickWallMask(mask, dt, minWallHalfWidth, minComponentArea)
  const {walls: wallSegments, doors: doorGaps} = assembleLines(
    extractAxisRuns(walls, grid, minRunLength),
    grid
  )

  const occluders: Occluder[] = []
  wallSegments
    .sort((a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1))
    .slice(0, 500)
    .forEach((run, index) => {
      occluders.push({
        type: 'wall',
        id: `wall-${String(index + 1).padStart(4, '0')}`,
        x1: run.x1,
        y1: run.y1,
        x2: run.x2,
        y2: run.y2
      })
    })
  doorGaps.slice(0, 200).forEach((gap, index) => {
    occluders.push({
      type: 'door',
      id: `door-${String(index + 1).padStart(4, '0')}`,
      x1: gap.x1,
      y1: gap.y1,
      x2: gap.x2,
      y2: gap.y2,
      open: false
    })
  })
  return occluders
}
