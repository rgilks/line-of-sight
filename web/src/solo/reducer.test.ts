import {describe, expect, it} from 'vitest'
import {defaultSpec, type GeneratedMap} from '../synth/types'
import type {Occluder} from '../../../core/los'
import type {Rng} from '../../../core/dice'
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
  skills: {'Gun Combat': 1},
  weaponId: 'autopistol',
  armorId: null,
  inventory: [],
  loadedRounds: 15,
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
    ground: [],
    props: [],
    turnPtr: 0,
    round: 1,
    wave: 1,
    wavesTotal: 3,
    moveRemainingPx: moveBudgetPx(grid.gridScale),
    actionUsed: false,
    phase: {t: 'playerTurn'},
    log: []
  }
}

// Deterministic dice for the combat actions (see combat.test.ts).
const seqRng = (faces: number[]): Rng => {
  let i = 0
  return () => {
    const face = faces[i % faces.length]
    i += 1
    return (face - 0.5) / 6
  }
}

const mob = (id: string, cx: number, cy: number): Entity => ({
  id,
  faction: 'monster',
  kind: 'insectoid',
  label: id,
  x: (cx + 0.5) * 30,
  y: (cy + 0.5) * 30,
  stats: {str: 8, dex: 8, end: 10},
  statsMax: {str: 8, dex: 8, end: 10},
  skills: {'Melee Combat': 1},
  weaponId: 'claws',
  armorId: null,
  inventory: [],
  loadedRounds: 0,
  initiative: 5,
  order: 9
})

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

describe('solo reducer — combat actions', () => {
  it('attacks an adjacent monster: spends ammo + the action, deals damage', () => {
    const attacker = pc('a', 2, 2, 0) // autopistol, Gun Combat 1, loaded 15
    const state = makeState([attacker, mob('m', 3, 2)]) // monster one cell east (close)
    // 2D6 = 6,6 → 12 +1(skill) +0(dexDm 7) +0(autopistol close) = 13, effect 5
    // damage 3D6−3 = (4+4+4)−3 = 9 +5 = 14, no armour
    const next = reduce(state, {t: 'Attack', targetId: 'm'}, seqRng([6, 6, 4, 4, 4]))
    const monster = next.entities.find((e) => e.id === 'm')
    expect(monster?.stats.end).toBeLessThan(10)
    expect(next.entities.find((e) => e.id === 'a')?.loadedRounds).toBe(14)
    expect(next.actionUsed).toBe(true)
  })

  it('refuses a second significant action in the same turn', () => {
    const state = {...makeState([pc('a', 2, 2, 0), mob('m', 3, 2)]), actionUsed: true}
    const next = reduce(state, {t: 'Attack', targetId: 'm'}, seqRng([6, 6, 4, 4, 4]))
    expect(next.entities.find((e) => e.id === 'm')?.stats.end).toBe(10) // unchanged
  })

  it('reloads from spare ammo up to the magazine', () => {
    const low = {...pc('a', 2, 2, 0), loadedRounds: 2, inventory: [{kind: 'ammo' as const, weaponId: 'autopistol', count: 45}]}
    const next = reduce(makeState([low]), {t: 'Reload'})
    const after = next.entities[0]
    expect(after.loadedRounds).toBe(15)
    expect(after.inventory[0].count).toBe(32) // 45 − 13 taken
    expect(next.actionUsed).toBe(true)
  })
})

describe('solo reducer — PushProp', () => {
  it('shoves an adjacent crate one cell away onto open floor', () => {
    const actor = pc('a', 2, 2, 0)
    const state = {...makeState([actor]), props: [{id: 'crate-0', x: (3 + 0.5) * 30, y: (2 + 0.5) * 30}]}
    const next = reduce(state, {t: 'PushProp', propId: 'crate-0'})
    expect(next.props[0].x).toBe((4 + 0.5) * 30) // pushed one cell further east
    expect(next.actionUsed).toBe(true)
  })

  it('refuses to push a crate against a wall', () => {
    const actor = pc('a', 7, 7, 0) // by the SE corner of the 1..8 room
    const state = {...makeState([actor]), props: [{id: 'crate-0', x: (8 + 0.5) * 30, y: (7 + 0.5) * 30}]}
    const next = reduce(state, {t: 'PushProp', propId: 'crate-0'}) // cell 9 is hull wall
    expect(next.props[0].x).toBe((8 + 0.5) * 30) // unchanged
  })

  it('blocks movement onto a crate cell', () => {
    const actor = pc('a', 2, 2, 0)
    const state = {...makeState([actor]), props: [{id: 'crate-0', x: (3 + 0.5) * 30, y: (2 + 0.5) * 30}]}
    const next = reduce(state, {t: 'Move', to: {x: (3 + 0.5) * 30, y: (2 + 0.5) * 30}})
    expect(next.entities[0].x).toBe((2 + 0.5) * 30) // didn't move onto the crate
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
