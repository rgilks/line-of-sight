import {describe, expect, it} from 'vitest'
import {generateMap} from '../synth/generate-map'
import {defaultSpec} from '../synth/types'
import {makeRng} from '../synth/rng'
import {buildWalkGrid, cellOf, isFloor, type Cell, type WalkGrid} from './grid'
import {doorStatesFromLocks, planLockAndLoot, reachableCells} from './loot'

// A small real deck (the generator is pure) keeps these fast while exercising the
// actual rooms + door occluders the loot layer reads. Spawn = a cluster of floor
// cells near the centre, mirroring how the squad spawns mid-deck.
const deck = (seed: number) => {
  const map = generateMap({...defaultSpec(seed), cols: 28, rows: 28})
  const grid = buildWalkGrid(map)
  const c0 = cellOf(grid, map.width / 2, map.height / 2)
  const spawn: Cell[] = []
  for (let r = 0; r < 10 && spawn.length < 4; r += 1) {
    for (let dy = -r; dy <= r && spawn.length < 4; dy += 1) {
      for (let dx = -r; dx <= r && spawn.length < 4; dx += 1) {
        if (isFloor(grid, c0.cx + dx, c0.cy + dy)) spawn.push({cx: c0.cx + dx, cy: c0.cy + dy})
      }
    }
  }
  return {map, grid, spawn}
}
const cellKey = (grid: WalkGrid, x: number, y: number): string => {
  const c = cellOf(grid, x, y)
  return `${c.cx},${c.cy}`
}
const floorTotal = (grid: WalkGrid): number => {
  let n = 0
  for (let i = 0; i < grid.floor.length; i += 1) if (grid.floor[i] === 1) n += 1
  return n
}
const SEEDS = [1, 7, 11, 23, 42]

describe('loot — planLockAndLoot', () => {
  it('places containers on unique floor cells and seals only internal doors', () => {
    const {map, grid, spawn} = deck(7)
    const {locks, containers} = planLockAndLoot(map, grid, spawn, makeRng(3), new Set())
    expect(containers.length).toBeGreaterThan(0)
    for (const c of containers) {
      const cell = cellOf(grid, c.x, c.y)
      expect(isFloor(grid, cell.cx, cell.cy)).toBe(true)
    }
    expect(new Set(containers.map((c) => c.id)).size).toBe(containers.length)
    for (const id of Object.keys(locks)) {
      const lock = locks[id]
      expect(id.startsWith('door-')).toBe(true)
      expect(['key', 'hack']).toContain(lock.kind)
      expect(lock.unlocked).toBe(false)
      if (lock.kind === 'key') expect(typeof lock.keyId).toBe('string')
    }
  })

  it('never walls the squad in: spawn reaches most of the deck without a card or hack', () => {
    for (const seed of SEEDS) {
      const {map, grid, spawn} = deck(seed)
      const {locks} = planLockAndLoot(map, grid, spawn, makeRng(seed), new Set())
      const reached = reachableCells(map, grid, doorStatesFromLocks(map, locks), spawn)
      expect(reached.size).toBeGreaterThanOrEqual(floorTotal(grid) * 0.5)
    }
  })

  it('places every used keycard clearance in the freely-reachable region (no soft-lock)', () => {
    for (const seed of SEEDS) {
      const {map, grid, spawn} = deck(seed)
      const {locks, containers} = planLockAndLoot(map, grid, spawn, makeRng(seed), new Set())
      const free = reachableCells(map, grid, doorStatesFromLocks(map, locks), spawn)
      const usedClearances = new Set(
        Object.values(locks)
          .filter((l) => l.kind === 'key')
          .map((l) => l.keyId)
      )
      for (const clearance of usedClearances) {
        const cardIsFree = containers.some(
          (c) => c.loot?.kind === 'keycard' && c.loot.keyId === clearance && free.has(cellKey(grid, c.x, c.y))
        )
        expect(cardIsFree).toBe(true)
      }
    }
  })
})
