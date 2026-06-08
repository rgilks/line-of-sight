import {describe, expect, it} from 'vitest'
import {findPath, type Cell} from './pathfinding'

const openGrid = {canEnter: () => true}

describe('findPath', () => {
  it('finds a straight path in open space', () => {
    const path = findPath({cx: 0, cy: 0}, {cx: 3, cy: 0}, 5, 5, openGrid)
    expect(path).not.toBeNull()
    expect(path?.length).toBe(4) // 0,1,2,3
    expect(path?.[0]).toEqual({cx: 0, cy: 0})
    expect(path?.[path.length - 1]).toEqual({cx: 3, cy: 0})
  })

  it('routes around a blocked column', () => {
    // Wall down column cx=1 for rows 0..1, gap at row 2.
    const blocked = new Set(['1,0', '1,1'])
    const path = findPath({cx: 0, cy: 0}, {cx: 2, cy: 0}, 4, 4, {
      canEnter: (cx, cy) => !blocked.has(`${cx},${cy}`)
    })
    expect(path).not.toBeNull()
    // Must detour through row 2, so longer than the manhattan distance of 2.
    expect(path?.length ?? 0).toBeGreaterThan(3)
    expect(path?.every((c) => !blocked.has(`${c.cx},${c.cy}`))).toBe(true)
  })

  it('respects canStep edges (a closed door between adjacent cells)', () => {
    // No cell is blocked, but the edge between (1,0) and (2,0) cannot be crossed.
    const path = findPath({cx: 0, cy: 0}, {cx: 3, cy: 0}, 4, 3, {
      canEnter: () => true,
      canStep: (from, to) =>
        !(
          (from.cx === 1 && to.cx === 2 && from.cy === 0 && to.cy === 0) ||
          (from.cx === 2 && to.cx === 1 && from.cy === 0 && to.cy === 0)
        )
    })
    expect(path).not.toBeNull()
    // It detours via row 1 rather than crossing the blocked edge on row 0.
    expect(path?.some((c) => c.cy === 1)).toBe(true)
  })

  it('returns null when the goal is walled off', () => {
    const blocked = new Set(['1,0', '1,1', '1,2', '0,1', '2,1'])
    const path = findPath({cx: 0, cy: 0}, {cx: 2, cy: 0}, 3, 3, {
      canEnter: (cx, cy) => !blocked.has(`${cx},${cy}`)
    })
    // (0,0) is boxed in by the blocked set except (0,0)<->(0,1) blocked too → no path
    expect(path).toBeNull()
  })

  it('reaches a goal cell even if canEnter rejects it (occupied target)', () => {
    const goal: Cell = {cx: 2, cy: 0}
    const path = findPath({cx: 0, cy: 0}, goal, 4, 3, {
      canEnter: (cx, cy) => !(cx === 2 && cy === 0) // goal is "occupied"
    })
    expect(path).not.toBeNull()
    expect(path?.[path.length - 1]).toEqual(goal)
  })

  it('handles a large grid without stalling (heap, not an O(n²) scan)', () => {
    // Corner-to-corner on an 80×80 open grid, then a sealed-goal exhaustive search.
    // With a linear-scan open set both are O(n²) and crawl; the heap keeps them quick.
    const open = findPath({cx: 0, cy: 0}, {cx: 79, cy: 79}, 80, 80, {canEnter: () => true})
    expect(open?.length).toBe(159) // 79 + 79 + 1
    const sealed = findPath({cx: 0, cy: 0}, {cx: 79, cy: 79}, 80, 80, {
      canEnter: (cx, cy) => !(cx === 78 && cy === 79) && !(cx === 79 && cy === 78) // wall off the goal
    })
    expect(sealed).toBeNull()
  })
})
