import {describe, expect, it} from 'vitest'
import {generateMap} from '../synth/generate-map'
import {defaultSpec} from '../synth/types'
import {makeRng} from '../synth/rng'
import {buildWalkGrid, cellOf, isFloor} from './grid'
import {generateLocks, placeContainers} from './loot'

// A small real deck (the generator is pure) keeps these fast while exercising the
// actual rooms + door occluders the loot layer reads.
const deck = (seed: number) => {
  const map = generateMap({...defaultSpec(seed), cols: 28, rows: 28})
  return {map, grid: buildWalkGrid(map)}
}
const cellKey = (grid: ReturnType<typeof buildWalkGrid>, x: number, y: number): string => {
  const c = cellOf(grid, x, y)
  return `${c.cx},${c.cy}`
}

describe('loot — placeContainers', () => {
  it('places containers on unique floor cells inside the deck', () => {
    const {map, grid} = deck(7)
    const containers = placeContainers(map, grid, makeRng(99), new Set())
    expect(containers.length).toBeGreaterThan(0)
    for (const c of containers) {
      const cell = cellOf(grid, c.x, c.y)
      expect(isFloor(grid, cell.cx, cell.cy)).toBe(true)
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.x).toBeLessThanOrEqual(map.width)
    }
    expect(new Set(containers.map((c) => c.id)).size).toBe(containers.length)
    const cells = containers.map((c) => cellKey(grid, c.x, c.y))
    expect(new Set(cells).size).toBe(cells.length)
  })

  it('guarantees a couple of access cards per deck', () => {
    const {map, grid} = deck(11)
    const containers = placeContainers(map, grid, makeRng(3), new Set())
    const cards = containers.filter((c) => c.loot?.kind === 'keycard').length
    expect(cards).toBeGreaterThanOrEqual(Math.min(2, containers.length))
  })

  it('never reuses an avoided cell', () => {
    const {map, grid} = deck(5)
    const first = placeContainers(map, grid, makeRng(1), new Set())
    const taken = new Set(first.map((c) => cellKey(grid, c.x, c.y)))
    const second = placeContainers(map, grid, makeRng(1), taken)
    for (const c of second) expect(taken.has(cellKey(grid, c.x, c.y))).toBe(false)
  })
})

describe('loot — generateLocks', () => {
  it('seals only internal doors, split between key and hack', () => {
    const {map} = deck(7)
    const locks = generateLocks(map, makeRng(2))
    const ids = Object.keys(locks)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.length).toBeLessThanOrEqual(14)
    for (const id of ids) {
      expect(id.startsWith('door-')).toBe(true)
      expect(['key', 'hack']).toContain(locks[id].kind)
      expect(locks[id].unlocked).toBe(false)
    }
    // both lock kinds appear when there are at least two locks
    if (ids.length >= 2) {
      const kinds = new Set(ids.map((id) => locks[id].kind))
      expect(kinds.size).toBe(2)
    }
  })
})
