// Generic A* over a 4-connected grid. Pure and dependency-free, so both the
// single-player monster AI and (later) any server-side pathing can share it.
//
// `canEnter(cx,cy)` decides whether a cell may be occupied; `canStep(from,to)`
// (optional) gates the move across a shared edge — the single-player game uses it
// to block walls and closed doors between two otherwise-open floor cells. The
// goal cell is always allowed as the path's endpoint even if canEnter rejects it
// (so a monster can path to the cell a character is standing on, then stop short).

export type Cell = {cx: number; cy: number}

export type PathOpts = {
  canEnter: (cx: number, cy: number) => boolean
  canStep?: (from: Cell, to: Cell) => boolean
}

const key = (cx: number, cy: number): string => `${cx},${cy}`
const manhattan = (a: Cell, b: Cell): number => Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy)

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0]
]

/**
 * Shortest 4-connected path from `start` to `goal` inclusive, or null if none.
 * Cost is 1 per step.
 */
export const findPath = (start: Cell, goal: Cell, cols: number, rows: number, opts: PathOpts): Cell[] | null => {
  const goalKey = key(goal.cx, goal.cy)
  const startKey = key(start.cx, start.cy)
  if (startKey === goalKey) return [start]

  const open: Cell[] = [start]
  const cameFrom = new Map<string, Cell>()
  const gScore = new Map<string, number>([[startKey, 0]])
  const fScore = new Map<string, number>([[startKey, manhattan(start, goal)]])
  const openKeys = new Set<string>([startKey])

  while (open.length > 0) {
    // Extract the open node with the lowest fScore (linear scan — fine for ~784 cells).
    let bestIndex = 0
    for (let i = 1; i < open.length; i += 1) {
      const fi = fScore.get(key(open[i].cx, open[i].cy)) ?? Infinity
      const fb = fScore.get(key(open[bestIndex].cx, open[bestIndex].cy)) ?? Infinity
      if (fi < fb) bestIndex = i
    }
    const current = open.splice(bestIndex, 1)[0]
    const currentKey = key(current.cx, current.cy)
    openKeys.delete(currentKey)

    if (currentKey === goalKey) {
      const path: Cell[] = [current]
      let cursor = current
      while (cameFrom.has(key(cursor.cx, cursor.cy))) {
        cursor = cameFrom.get(key(cursor.cx, cursor.cy)) as Cell
        path.push(cursor)
      }
      return path.reverse()
    }

    for (const [dx, dy] of NEIGHBOURS) {
      const next: Cell = {cx: current.cx + dx, cy: current.cy + dy}
      if (next.cx < 0 || next.cy < 0 || next.cx >= cols || next.cy >= rows) continue
      const nextKey = key(next.cx, next.cy)
      const isGoal = nextKey === goalKey
      if (!isGoal && !opts.canEnter(next.cx, next.cy)) continue
      if (opts.canStep && !opts.canStep(current, next)) continue

      const tentative = (gScore.get(currentKey) ?? Infinity) + 1
      if (tentative < (gScore.get(nextKey) ?? Infinity)) {
        cameFrom.set(nextKey, current)
        gScore.set(nextKey, tentative)
        fScore.set(nextKey, tentative + manhattan(next, goal))
        if (!openKeys.has(nextKey)) {
          open.push(next)
          openKeys.add(nextKey)
        }
      }
    }
  }
  return null
}
