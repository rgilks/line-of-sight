// Generic A* over a 4-connected grid. Pure and dependency-free, so both the
// single-player monster AI and (later) any server-side pathing can share it.
//
// `canEnter(cx,cy)` decides whether a cell may be occupied; `canStep(from,to)`
// (optional) gates the move across a shared edge — the single-player game uses it
// to block walls and closed doors between two otherwise-open floor cells. The
// goal cell is always allowed as the path's endpoint even if canEnter rejects it
// (so a monster can path to the cell a character is standing on, then stop short).
//
// The open set is a binary min-heap, so popping the lowest-fScore node is
// O(log n). That matters on large decks: a long or impossible search visits many
// cells, and a linear scan there is O(n²) and can stall the main thread.

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

// A tiny binary min-heap of (cell, fScore). Cells may be pushed more than once
// (lazy decrease-key); the popped duplicate is ignored via the closed set.
type HeapNode = {cell: Cell; f: number}
class MinHeap {
  private readonly items: HeapNode[] = []
  get size(): number {
    return this.items.length
  }
  push(cell: Cell, f: number): void {
    const items = this.items
    items.push({cell, f})
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent].f <= items[i].f) break
      const tmp = items[parent]
      items[parent] = items[i]
      items[i] = tmp
      i = parent
    }
  }
  pop(): Cell | undefined {
    const items = this.items
    if (items.length === 0) return undefined
    const top = items[0]
    const last = items.pop() as HeapNode
    if (items.length > 0) {
      items[0] = last
      const n = items.length
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let smallest = i
        if (l < n && items[l].f < items[smallest].f) smallest = l
        if (r < n && items[r].f < items[smallest].f) smallest = r
        if (smallest === i) break
        const tmp = items[smallest]
        items[smallest] = items[i]
        items[i] = tmp
        i = smallest
      }
    }
    return top.cell
  }
}

/**
 * Shortest 4-connected path from `start` to `goal` inclusive, or null if none.
 * Cost is 1 per step. The manhattan heuristic is admissible + consistent here, so
 * the first time the goal is popped its path is optimal.
 */
export const findPath = (start: Cell, goal: Cell, cols: number, rows: number, opts: PathOpts): Cell[] | null => {
  const goalKey = key(goal.cx, goal.cy)
  const startKey = key(start.cx, start.cy)
  if (startKey === goalKey) return [start]

  const heap = new MinHeap()
  const cameFrom = new Map<string, Cell>()
  const gScore = new Map<string, number>([[startKey, 0]])
  const closed = new Set<string>()
  heap.push(start, manhattan(start, goal))

  while (heap.size > 0) {
    const current = heap.pop() as Cell
    const currentKey = key(current.cx, current.cy)

    if (currentKey === goalKey) {
      const path: Cell[] = [current]
      let cursor = current
      while (cameFrom.has(key(cursor.cx, cursor.cy))) {
        cursor = cameFrom.get(key(cursor.cx, cursor.cy)) as Cell
        path.push(cursor)
      }
      return path.reverse()
    }

    if (closed.has(currentKey)) continue // a stale (already-expanded) heap entry
    closed.add(currentKey)

    for (const [dx, dy] of NEIGHBOURS) {
      const next: Cell = {cx: current.cx + dx, cy: current.cy + dy}
      if (next.cx < 0 || next.cy < 0 || next.cx >= cols || next.cy >= rows) continue
      const nextKey = key(next.cx, next.cy)
      if (closed.has(nextKey)) continue
      const isGoal = nextKey === goalKey
      if (!isGoal && !opts.canEnter(next.cx, next.cy)) continue
      if (opts.canStep && !opts.canStep(current, next)) continue

      const tentative = (gScore.get(currentKey) ?? Infinity) + 1
      if (tentative < (gScore.get(nextKey) ?? Infinity)) {
        cameFrom.set(nextKey, current)
        gScore.set(nextKey, tentative)
        heap.push(next, tentative + manhattan(next, goal))
      }
    }
  }
  return null
}
