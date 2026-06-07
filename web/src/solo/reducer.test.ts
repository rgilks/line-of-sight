import {describe, expect, it} from 'vitest'
import {defaultSpec, type GeneratedMap} from '../synth/types'
import type {Occluder} from '../../../core/los'
import {buildWalkGrid} from './grid'
import {moveBudgetPx, type Entity, type SoloState} from './model'
import {reduce} from './reducer'

// A 10×10 open room (cells 1..8 are floor) at 30px/cell, no occluders unless
// supplied — so line of sight is unobstructed and we test budget/walk/occupancy.
const makeMap = (occluders: Occluder[] = []): GeneratedMap => ({
  spec: defaultSpec(1),
  width: 300,
  height: 300,
  gridScale: 30,
  rooms: [{x: 1, y: 1, w: 8, h: 8, id: 'room-1', type: 'common', label: 'COMMON'}],
  corridors: [],
  decorations: [],
  occluders
})

const pc = (id: string, cx: number, cy: number, order: number): Entity => ({
  id,
  faction: 'pc',
  kind: 'marine',
  label: id,
  x: (cx + 0.5) * 30,
  y: (cy + 0.5) * 30,
  stats: {str: 7, dex: 7, end: 7},
  statsMax: {str: 7, dex: 7, end: 7},
  initiative: 7,
  order
})

const makeState = (entities: Entity[], occluders: Occluder[] = []): SoloState => {
  const map = makeMap(occluders)
  const grid = buildWalkGrid(map)
  return {
    seed: 1,
    map,
    grid,
    doorStates: {},
    sightRadius: 1000,
    entities,
    turnPtr: 0,
    round: 1,
    moveRemainingPx: moveBudgetPx(grid.gridScale),
    phase: {t: 'playerTurn'},
    log: []
  }
}

describe('solo reducer — Move', () => {
  it('moves the active PC to a reachable floor cell and spends budget', () => {
    const state = makeState([pc('a', 2, 2, 0)])
    const next = reduce(state, {t: 'Move', to: {x: (4 + 0.5) * 30, y: (2 + 0.5) * 30}})
    expect(next.entities[0].x).toBe((4 + 0.5) * 30)
    expect(next.moveRemainingPx).toBeCloseTo(moveBudgetPx(30) - 60)
  })

  it('refuses a move beyond the movement budget', () => {
    const state = makeState([pc('a', 1, 1, 0)])
    const next = reduce(state, {t: 'Move', to: {x: (8 + 0.5) * 30, y: (8 + 0.5) * 30}})
    expect(next.entities[0].x).toBe((1 + 0.5) * 30) // unchanged
    expect(next.moveRemainingPx).toBe(state.moveRemainingPx)
  })

  it('refuses a move onto a cell occupied by a squadmate', () => {
    const state = makeState([pc('a', 2, 2, 0), pc('b', 3, 2, 1)])
    const next = reduce(state, {t: 'Move', to: {x: (3 + 0.5) * 30, y: (2 + 0.5) * 30}})
    expect(next.entities[0].x).toBe((2 + 0.5) * 30) // blocked, unchanged
  })

  it('refuses a move into a non-floor cell', () => {
    const state = makeState([pc('a', 1, 1, 0)])
    const next = reduce(state, {t: 'Move', to: {x: 5, y: 5}}) // cell (0,0) = hull margin
    expect(next.entities[0].x).toBe((1 + 0.5) * 30)
  })
})

describe('solo reducer — EndTurn', () => {
  it('advances to the next combatant, then wraps to a new round', () => {
    const state = makeState([pc('a', 2, 2, 0), pc('b', 4, 4, 1)])
    const afterFirst = reduce(state, {t: 'EndTurn'})
    expect(afterFirst.turnPtr).toBe(1)
    expect(afterFirst.round).toBe(1)
    expect(afterFirst.moveRemainingPx).toBe(moveBudgetPx(30))

    const afterWrap = reduce(afterFirst, {t: 'EndTurn'})
    expect(afterWrap.turnPtr).toBe(0)
    expect(afterWrap.round).toBe(2)
  })
})

describe('solo reducer — ToggleDoor', () => {
  // A door segment just east of the actor, within door reach.
  const door: Occluder = {type: 'door', id: 'door-1', x1: 90, y1: 60, x2: 90, y2: 90, open: false}

  it('opens a reachable door', () => {
    const state = makeState([pc('a', 2, 2, 0)], [door])
    const next = reduce(state, {t: 'ToggleDoor', doorId: 'door-1'})
    expect(next.doorStates['door-1']?.open).toBe(true)
  })

  it('leaves a far door untouched', () => {
    const state = makeState([pc('a', 6, 6, 0)], [door])
    const next = reduce(state, {t: 'ToggleDoor', doorId: 'door-1'})
    expect(next.doorStates['door-1']?.open).toBeUndefined()
  })
})
