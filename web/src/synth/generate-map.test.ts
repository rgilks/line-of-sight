import {describe, expect, it} from 'vitest'
import {generateMap} from './generate-map'
import {defaultSpec, type GeneratedMap} from './types'

const walls = (m: GeneratedMap) => m.occluders.filter((o) => o.type === 'wall')
const doors = (m: GeneratedMap) => m.occluders.filter((o) => o.type === 'door')
const innerDoors = (m: GeneratedMap) => doors(m).filter((o) => o.id.startsWith('door'))
const airlocks = (m: GeneratedMap) => doors(m).filter((o) => o.id.startsWith('airlock'))

describe('generateMap', () => {
  it('is deterministic for a given seed', () => {
    const a = generateMap(defaultSpec(42))
    const b = generateMap(defaultSpec(42))
    expect(a.occluders).toEqual(b.occluders)
    expect(a.rooms).toEqual(b.rooms)
    expect(a.corridors).toEqual(b.corridors)
  })

  it('different seeds give different maps', () => {
    const a = generateMap(defaultSpec(1))
    const b = generateMap(defaultSpec(2))
    expect(a.occluders).not.toEqual(b.occluders)
  })

  it('produces rooms, corridors, walls, doors, hull and airlocks', () => {
    const m = generateMap(defaultSpec(7))
    expect(m.rooms.length).toBeGreaterThan(1)
    expect(m.corridors.length).toBeGreaterThan(0)
    expect(walls(m).length).toBeGreaterThan(0)
    expect(innerDoors(m).length).toBeGreaterThan(0)
    expect(m.occluders.some((o) => o.id.startsWith('hull'))).toBe(true)
    expect(airlocks(m).length).toBeGreaterThanOrEqual(2)
  })

  it('honors required room types', () => {
    const spec = {...defaultSpec(3), required: ['bridge', 'cargo'] as const}
    const m = generateMap({...spec, required: [...spec.required]})
    const types = new Set(m.rooms.map((r) => r.type))
    expect(types.has('bridge')).toBe(true)
    expect(types.has('cargo')).toBe(true)
  })

  it('keeps focal rooms (bridge, medbay) singular across seeds', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const m = generateMap({...defaultSpec(seed), theme: 'military'})
      const counts = new Map<string, number>()
      for (const room of m.rooms) counts.set(room.type, (counts.get(room.type) ?? 0) + 1)
      expect(counts.get('bridge') ?? 0).toBeLessThanOrEqual(1)
      expect(counts.get('medbay') ?? 0).toBeLessThanOrEqual(1)
    }
  })

  it('rooms do not overlap each other', () => {
    const m = generateMap(defaultSpec(11))
    for (let i = 0; i < m.rooms.length; i += 1)
      for (let j = i + 1; j < m.rooms.length; j += 1) {
        const a = m.rooms[i]
        const b = m.rooms[j]
        const overlap =
          Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w) && Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h)
        expect(overlap).toBe(false)
      }
  })

  it('keeps every room reachable through the corridor/door graph', () => {
    const m = generateMap(defaultSpec(99))
    const g = m.gridScale
    // Region of a sampled point: a room index, the corridor super-node, or -1.
    const CORRIDOR = m.rooms.length
    const regionAt = (px: number, py: number): number => {
      const cx = px / g
      const cy = py / g
      const ri = m.rooms.findIndex((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h)
      if (ri >= 0) return ri
      const inCorridor = m.corridors.some((c) => cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h)
      return inCorridor ? CORRIDOR : -1
    }

    const parent = Array.from({length: m.rooms.length + 1}, (_, i) => i)
    const find = (x: number): number => {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]]
      return x
    }
    for (const d of innerDoors(m)) {
      const midX = (d.x1 + d.x2) / 2
      const midY = (d.y1 + d.y2) / 2
      const horizontal = d.y1 === d.y2
      const r1 = horizontal ? regionAt(midX, midY - g * 0.5) : regionAt(midX - g * 0.5, midY)
      const r2 = horizontal ? regionAt(midX, midY + g * 0.5) : regionAt(midX + g * 0.5, midY)
      if (r1 >= 0 && r2 >= 0) parent[find(r1)] = find(r2)
    }
    // Every room must share a component with the corridor super-node.
    const corridorRoot = find(CORRIDOR)
    for (let i = 0; i < m.rooms.length; i += 1) expect(find(i)).toBe(corridorRoot)
  })

  it('furniture stays inside the board', () => {
    const m = generateMap(defaultSpec(5))
    for (const d of m.decorations) {
      expect(d.x).toBeGreaterThanOrEqual(0)
      expect(d.y).toBeGreaterThanOrEqual(0)
      expect(d.x + d.w).toBeLessThanOrEqual(m.width + 1)
      expect(d.y + d.h).toBeLessThanOrEqual(m.height + 1)
    }
  })

  it('every chamfer diagonal seals to straight walls (exact LOS)', () => {
    // Each chamfer endpoint must lie ON some axis-aligned wall segment — not
    // merely coincide with a wall endpoint, since merged runs put a valid seal
    // mid-segment. If an endpoint is on no wall, sight leaks through the corner.
    const eps = 0.001
    const onSegment = (px: number, py: number, w: {x1: number; y1: number; x2: number; y2: number}): boolean => {
      if (Math.abs(w.y1 - w.y2) < eps) {
        // horizontal
        return Math.abs(py - w.y1) < eps && px >= Math.min(w.x1, w.x2) - eps && px <= Math.max(w.x1, w.x2) + eps
      }
      if (Math.abs(w.x1 - w.x2) < eps) {
        // vertical
        return Math.abs(px - w.x1) < eps && py >= Math.min(w.y1, w.y2) - eps && py <= Math.max(w.y1, w.y2) + eps
      }
      return false // diagonal wall — not an axis-aligned sealer
    }

    let chamferTotal = 0
    for (let seed = 1; seed <= 60; seed += 1) {
      const m = generateMap({...defaultSpec(seed), cols: 30, rows: 30})
      const straight = walls(m).filter((w) => !w.id.startsWith('cham'))
      const chamfers = walls(m).filter((w) => w.id.startsWith('cham'))
      chamferTotal += chamfers.length
      for (const c of chamfers) {
        const a = straight.some((w) => onSegment(c.x1, c.y1, w))
        const b = straight.some((w) => onSegment(c.x2, c.y2, w))
        expect(a, `cham ${c.id} seed ${seed} end1 unsealed`).toBe(true)
        expect(b, `cham ${c.id} seed ${seed} end2 unsealed`).toBe(true)
      }
    }
    expect(chamferTotal).toBeGreaterThan(0) // the feature actually fires
  })
})
