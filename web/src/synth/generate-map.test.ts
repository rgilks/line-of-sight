import {describe, expect, it} from 'vitest'
import {generateMap} from './generate-map'
import {defaultSpec} from './types'

describe('generateMap', () => {
  it('is deterministic for a given seed', () => {
    const a = generateMap(defaultSpec(42))
    const b = generateMap(defaultSpec(42))
    expect(a.occluders).toEqual(b.occluders)
    expect(a.rooms).toEqual(b.rooms)
  })

  it('different seeds give different maps', () => {
    const a = generateMap(defaultSpec(1))
    const b = generateMap(defaultSpec(2))
    expect(a.occluders).not.toEqual(b.occluders)
  })

  it('produces rooms, walls, and doors', () => {
    const map = generateMap(defaultSpec(7))
    expect(map.rooms.length).toBeGreaterThan(1)
    expect(map.occluders.some((o) => o.type === 'wall')).toBe(true)
    expect(map.occluders.some((o) => o.type === 'door')).toBe(true)
  })

  it('honors required room types', () => {
    const spec = {...defaultSpec(3), required: ['bridge', 'cargo'] as const}
    const map = generateMap({...spec, required: [...spec.required]})
    const types = new Set(map.rooms.map((r) => r.type))
    expect(types.has('bridge')).toBe(true)
    expect(types.has('cargo')).toBe(true)
  })

  it('keeps every room reachable (doors form a connected graph)', () => {
    const map = generateMap(defaultSpec(99))
    // Build room adjacency from door positions: a door lies on a shared wall, so
    // the two rooms whose boundary contains the door segment are connected.
    const g = map.gridScale
    const doors = map.occluders.filter((o) => o.type === 'door')
    const roomAt = (px: number, py: number): number =>
      map.rooms.findIndex(
        (r) =>
          px >= r.x * g && px <= (r.x + r.w) * g && py >= r.y * g && py <= (r.y + r.h) * g
      )

    const parent = map.rooms.map((_, i) => i)
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]]
      return x
    }
    for (const d of doors) {
      const midX = (d.x1 + d.x2) / 2
      const midY = (d.y1 + d.y2) / 2
      // Sample just either side of the door line to find the two rooms it joins.
      const horizontal = d.y1 === d.y2
      const r1 = horizontal ? roomAt(midX, midY - g * 0.5) : roomAt(midX - g * 0.5, midY)
      const r2 = horizontal ? roomAt(midX, midY + g * 0.5) : roomAt(midX + g * 0.5, midY)
      if (r1 >= 0 && r2 >= 0) parent[find(r1)] = find(r2)
    }
    const roots = new Set(map.rooms.map((_, i) => find(i)))
    expect(roots.size).toBe(1) // all rooms in one connected component
  })

  it('furniture stays inside the board', () => {
    const map = generateMap(defaultSpec(5))
    for (const d of map.decorations) {
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.y).toBeGreaterThanOrEqual(0)
      expect(d.x + d.w).toBeLessThanOrEqual(map.width + 1)
      expect(d.y + d.h).toBeLessThanOrEqual(map.height + 1)
    }
  })
})
