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

// Merge runs that share a grid line and overlap/touch, so a thick wall (many
// adjacent rows/cols of pixels) collapses to one segment per grid line.
const mergeRuns = (runs: Run[], gridScale: number): Run[] => {
  const byLine = new Map<string, Run[]>()
  for (const run of runs) {
    const line = run.horizontal ? run.y1 : run.x1
    const key = `${run.horizontal ? 'h' : 'v'}:${line}`
    const list = byLine.get(key) ?? []
    list.push(run)
    byLine.set(key, list)
  }

  const merged: Run[] = []
  for (const list of byLine.values()) {
    const horizontal = list[0].horizontal
    list.sort((a, b) => (horizontal ? a.x1 - b.x1 : a.y1 - b.y1))
    let current = {...list[0]}
    for (let i = 1; i < list.length; i += 1) {
      const run = list[i]
      const curEnd = horizontal ? current.x2 : current.y2
      const runStart = horizontal ? run.x1 : run.y1
      if (runStart <= curEnd + gridScale) {
        if (horizontal) current.x2 = Math.max(current.x2, run.x2)
        else current.y2 = Math.max(current.y2, run.y2)
      } else {
        merged.push(current)
        current = {...run}
      }
    }
    merged.push(current)
  }
  return merged.filter((run) => run.x1 !== run.x2 || run.y1 !== run.y2)
}

// Step 6 — doors as grid-aligned gaps between collinear wall runs on the same
// line. A short gap (roughly one cell) flanked by walls reads as a doorway.
const detectDoorGaps = (
  runs: Run[],
  gridScale: number
): Array<{x1: number; y1: number; x2: number; y2: number}> => {
  const doors: Array<{x1: number; y1: number; x2: number; y2: number}> = []
  const byLine = new Map<string, Run[]>()
  for (const run of runs) {
    const line = run.horizontal ? run.y1 : run.x1
    const key = `${run.horizontal ? 'h' : 'v'}:${line}`
    const list = byLine.get(key) ?? []
    list.push(run)
    byLine.set(key, list)
  }

  const minGap = gridScale * 0.5
  const maxGap = gridScale * 1.5
  for (const list of byLine.values()) {
    const horizontal = list[0].horizontal
    list.sort((a, b) => (horizontal ? a.x1 - b.x1 : a.y1 - b.y1))
    for (let i = 0; i < list.length - 1; i += 1) {
      const a = list[i]
      const b = list[i + 1]
      const gap = horizontal ? b.x1 - a.x2 : b.y1 - a.y2
      if (gap >= minGap && gap <= maxGap) {
        doors.push(
          horizontal
            ? {x1: a.x2, y1: a.y1, x2: b.x1, y2: a.y1}
            : {x1: a.x1, y1: a.y2, x2: a.x1, y2: b.y1}
        )
      }
    }
  }
  return doors
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
  const runs = mergeRuns(extractAxisRuns(walls, grid, minRunLength), grid)
  const doorGaps = detectDoorGaps(runs, grid)

  const occluders: Occluder[] = []
  runs
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
