// Walkability derived from a generated deck. The generator returns no occupancy
// grid, but a cell is floor iff it lies inside any room OR any corridor rect
// (map.corridors already includes the leftover slivers and the airlock stubs).
// Static per map — occupancy (other entities) and closed doors layer on top at
// query time, never baked in here.
import type {GeneratedMap, Rect} from '../synth/types'

export type Cell = {cx: number; cy: number}

export type WalkGrid = {
  cols: number
  rows: number
  gridScale: number
  floor: Uint8Array // row-major, 1 = floor
}

const fillRect = (floor: Uint8Array, cols: number, rows: number, r: Rect): void => {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(cols, Math.ceil(r.x + r.w))
  const y1 = Math.min(rows, Math.ceil(r.y + r.h))
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) floor[y * cols + x] = 1
  }
}

export const buildWalkGrid = (map: GeneratedMap): WalkGrid => {
  const cols = Math.round(map.width / map.gridScale)
  const rows = Math.round(map.height / map.gridScale)
  const floor = new Uint8Array(cols * rows)
  for (const room of map.rooms) fillRect(floor, cols, rows, room)
  for (const corridor of map.corridors) fillRect(floor, cols, rows, corridor)
  return {cols, rows, gridScale: map.gridScale, floor}
}

export const inBounds = (grid: WalkGrid, cx: number, cy: number): boolean =>
  cx >= 0 && cy >= 0 && cx < grid.cols && cy < grid.rows

export const isFloor = (grid: WalkGrid, cx: number, cy: number): boolean =>
  inBounds(grid, cx, cy) && grid.floor[cy * grid.cols + cx] === 1

/** Board pixel → cell coordinate. */
export const cellOf = (grid: WalkGrid, x: number, y: number): Cell => ({
  cx: Math.floor(x / grid.gridScale),
  cy: Math.floor(y / grid.gridScale)
})

/** Cell coordinate → board pixel at the cell's center. */
export const cellCenter = (grid: WalkGrid, cx: number, cy: number): {x: number; y: number} => ({
  x: (cx + 0.5) * grid.gridScale,
  y: (cy + 0.5) * grid.gridScale
})

/** Whether a board-pixel position falls on a floor cell. */
export const isWalkablePixel = (grid: WalkGrid, x: number, y: number): boolean => {
  const {cx, cy} = cellOf(grid, x, y)
  return isFloor(grid, cx, cy)
}
