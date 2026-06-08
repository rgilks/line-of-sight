import {describe, expect, it} from 'vitest'
import {defaultSpec, type GeneratedMap} from '../synth/types'
import type {Occluder} from '../../../core/los'
import type {Rng} from '../../../core/dice'
import {buildWalkGrid} from './grid'
import {moveBudgetPx, turnBudgetPx, type Container, type Entity, type SoloState} from './model'
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
  stance: 'standing',
  aim: 0,
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
    containers: [],
    locks: {},
    turnPtr: 0,
    round: 1,
    wave: 1,
    wavesTotal: 3,
    moveRemainingPx: turnBudgetPx(grid.gridScale),
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
  stance: 'standing',
  aim: 0,
  initiative: 5,
  order: 9
})

describe('solo reducer — Move', () => {
  it('moves the active PC to a reachable floor cell and spends budget', () => {
    const state = makeState([pc('a', 2, 2, 0)])
    const next = reduce(state, {t: 'Move', to: {x: (4 + 0.5) * 30, y: (2 + 0.5) * 30}})
    expect(next.entities[0].x).toBe((4 + 0.5) * 30)
    expect(next.moveRemainingPx).toBeCloseTo(turnBudgetPx(30) - 60)
  })

  it('refuses a move beyond the movement budget', () => {
    // Only a sliver of budget left → a multi-cell move is refused.
    const state = {...makeState([pc('a', 1, 1, 0)]), moveRemainingPx: 100}
    const next = reduce(state, {t: 'Move', to: {x: (8 + 0.5) * 30, y: (8 + 0.5) * 30}})
    expect(next.entities[0].x).toBe((1 + 0.5) * 30) // unchanged
    expect(next.moveRemainingPx).toBe(100)
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

  it('doubles movement cost while crouched', () => {
    const state = makeState([{...pc('a', 2, 2, 0), stance: 'crouched'}])
    const next = reduce(state, {t: 'Move', to: {x: (4 + 0.5) * 30, y: (2 + 0.5) * 30}})
    expect(next.moveRemainingPx).toBeCloseTo(turnBudgetPx(30) - 120)
  })
})

describe('solo reducer — SetStance', () => {
  it('changes stance as a minor action', () => {
    const state = makeState([pc('a', 2, 2, 0)])
    const budget = turnBudgetPx(30)
    const next = reduce(state, {t: 'SetStance', stance: 'crouched'})
    expect(next.entities[0].stance).toBe('crouched')
    expect(next.moveRemainingPx).toBeCloseTo(budget - moveBudgetPx(30))
    expect(next.log.at(-1)).toContain('crouched')
  })

  it('does not spend budget when already in that stance', () => {
    const state = makeState([{...pc('a', 2, 2, 0), stance: 'prone'}])
    const next = reduce(state, {t: 'SetStance', stance: 'prone'})
    expect(next.moveRemainingPx).toBe(turnBudgetPx(30))
  })
})

describe('solo reducer — EndTurn', () => {
  it('advances to the next combatant, then wraps to a new round', () => {
    const state = makeState([pc('a', 2, 2, 0), pc('b', 4, 4, 1)])
    const afterFirst = reduce(state, {t: 'EndTurn'})
    expect(afterFirst.turnPtr).toBe(1)
    expect(afterFirst.round).toBe(1)
    expect(afterFirst.moveRemainingPx).toBe(turnBudgetPx(30))

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

  it('cannot fire on a foe behind a wall, even within range', () => {
    // Wall segment at x=120 between the attacker (x=75) and the monster (x=135).
    const wall: Occluder = {type: 'wall', id: 'w', x1: 120, y1: 60, x2: 120, y2: 90}
    const state = makeState([pc('a', 2, 2, 0), mob('m', 4, 2)], [wall])
    const next = reduce(state, {t: 'Attack', targetId: 'm'}, seqRng([6, 6, 4, 4, 4]))
    expect(next.entities.find((e) => e.id === 'm')?.stats.end).toBe(10) // unharmed
    expect(next.actionUsed).toBe(false) // no shot taken — action preserved
    expect(next.log.some((line) => /line of sight/i.test(line))).toBe(true)
  })

  it('refuses a second significant action in the same turn', () => {
    const state = {...makeState([pc('a', 2, 2, 0), mob('m', 3, 2)]), actionUsed: true}
    const next = reduce(state, {t: 'Attack', targetId: 'm'}, seqRng([6, 6, 4, 4, 4]))
    expect(next.entities.find((e) => e.id === 'm')?.stats.end).toBe(10) // unchanged
  })

  it('reloads from spare ammo up to the magazine (a minor action)', () => {
    const low = {...pc('a', 2, 2, 0), loadedRounds: 2, inventory: [{kind: 'ammo' as const, weaponId: 'autopistol', count: 45}]}
    const next = reduce(makeState([low]), {t: 'Reload'})
    const after = next.entities[0]
    expect(after.loadedRounds).toBe(15)
    expect(after.inventory[0].count).toBe(32) // 45 − 13 taken
    expect(next.actionUsed).toBe(false) // reload is a minor — the significant action is still free
    expect(next.moveRemainingPx).toBe(turnBudgetPx(30) - moveBudgetPx(30)) // spent one minor action
  })

  it('can run further when no action is taken (three minor moves)', () => {
    const state = makeState([pc('a', 1, 1, 0)])
    // A diagonal dash across the room (~6 cells) is fine on the full 3-minor budget…
    const far = reduce(state, {t: 'Move', to: {x: (7 + 0.5) * 30, y: (7 + 0.5) * 30}})
    expect(far.entities[0].x).toBe((7 + 0.5) * 30)
    // …but the same distance is refused once two minors are already spent (only ~6 m left).
    const tired = {...state, moveRemainingPx: moveBudgetPx(30)}
    const blocked = reduce(tired, {t: 'Move', to: {x: (7 + 0.5) * 30, y: (7 + 0.5) * 30}})
    expect(blocked.entities[0].x).toBe((1 + 0.5) * 30) // unchanged
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

describe('solo reducer — Aim', () => {
  it('takes aim as a significant action: +1 and spends two minors', () => {
    const next = reduce(makeState([pc('a', 2, 2, 0)]), {t: 'Aim'})
    expect(next.entities[0].aim).toBe(1)
    expect(next.actionUsed).toBe(true)
    expect(next.moveRemainingPx).toBe(turnBudgetPx(30) - 2 * moveBudgetPx(30))
  })

  it('loses aim when moving', () => {
    const aimed = {...pc('a', 2, 2, 0), aim: 2}
    const next = reduce(makeState([aimed]), {t: 'Move', to: {x: (3 + 0.5) * 30, y: (2 + 0.5) * 30}})
    expect(next.entities[0].aim).toBe(0)
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

describe('solo reducer — locked doors', () => {
  const door: Occluder = {type: 'door', id: 'door-1', x1: 90, y1: 60, x2: 90, y2: 90, open: false}
  const sealed = (entities: Entity[], kind: 'key' | 'hack'): SoloState => ({
    ...makeState(entities, [door]),
    locks: {'door-1': {kind, unlocked: false}}
  })

  it('a key lock refuses to open without a keycard', () => {
    const next = reduce(sealed([pc('a', 2, 2, 0)], 'key'), {t: 'ToggleDoor', doorId: 'door-1'})
    expect(next.doorStates['door-1']?.open ?? false).toBe(false)
    expect(next.log.at(-1)).toContain('locked')
  })

  it('a key lock opens for a keycard and keeps the card', () => {
    const carrier = {...pc('a', 2, 2, 0), inventory: [{kind: 'keycard' as const, count: 1}]}
    const next = reduce(sealed([carrier], 'key'), {t: 'ToggleDoor', doorId: 'door-1'})
    expect(next.doorStates['door-1'].open).toBe(true)
    expect(next.locks['door-1'].unlocked).toBe(true)
    expect(next.entities[0].inventory).toContainEqual({kind: 'keycard', count: 1})
    expect(next.actionUsed).toBe(false) // badging in is a minor action
  })

  it('a key lock opens only for the matching clearance', () => {
    const blue: SoloState = {
      ...makeState([{...pc('a', 2, 2, 0), inventory: [{kind: 'keycard', keyId: 'red', count: 1}]}], [door]),
      locks: {'door-1': {kind: 'key', keyId: 'blue', unlocked: false}}
    }
    const wrong = reduce(blue, {t: 'ToggleDoor', doorId: 'door-1'})
    expect(wrong.doorStates['door-1']?.open ?? false).toBe(false)
    expect(wrong.log.at(-1)).toContain('blue')

    const carrier = {...pc('a', 2, 2, 0), inventory: [{kind: 'keycard' as const, keyId: 'blue', count: 1}]}
    const right = reduce({...blue, entities: [carrier]}, {t: 'ToggleDoor', doorId: 'door-1'})
    expect(right.doorStates['door-1'].open).toBe(true)
    expect(right.locks['door-1'].unlocked).toBe(true)
  })

  it('a hack lock opens on a successful Electronics check (significant action)', () => {
    const eng = {...pc('a', 2, 2, 0), skills: {Electronics: 2}}
    const next = reduce(sealed([eng], 'hack'), {t: 'ToggleDoor', doorId: 'door-1'}, seqRng([6, 6]))
    expect(next.doorStates['door-1'].open).toBe(true)
    expect(next.locks['door-1'].unlocked).toBe(true)
    expect(next.actionUsed).toBe(true)
  })

  it('a failed hack spends the action but leaves the door sealed', () => {
    const eng = {...pc('a', 2, 2, 0), skills: {Electronics: 0}}
    const next = reduce(sealed([eng], 'hack'), {t: 'ToggleDoor', doorId: 'door-1'}, seqRng([1, 1]))
    expect(next.doorStates['door-1']?.open ?? false).toBe(false)
    expect(next.locks['door-1'].unlocked).toBe(false)
    expect(next.actionUsed).toBe(true)
  })
})

describe('solo reducer — Search', () => {
  const container = (cx: number, cy: number, fields: Partial<Container>): Container => ({
    id: 'c1',
    x: (cx + 0.5) * 30,
    y: (cy + 0.5) * 30,
    kind: 'locker',
    searched: false,
    ...fields
  })
  const withContainer = (c: Container): SoloState => ({...makeState([pc('a', 2, 2, 0)]), containers: [c]})

  it('pockets loot, marks searched, and spends a minor action', () => {
    const state = withContainer(container(2, 3, {loot: {kind: 'ammo', weaponId: 'autopistol', count: 12}}))
    const next = reduce(state, {t: 'Search', containerId: 'c1'})
    expect(next.containers[0].searched).toBe(true)
    expect(next.entities[0].inventory).toContainEqual({kind: 'ammo', weaponId: 'autopistol', count: 12})
    expect(next.moveRemainingPx).toBeCloseTo(turnBudgetPx(30) - moveBudgetPx(30))
    expect(next.actionUsed).toBe(false)
  })

  it('logs a clue and refuses to search the same container twice', () => {
    const state = withContainer(container(2, 3, {clue: 'A scrawled note.'}))
    const once = reduce(state, {t: 'Search', containerId: 'c1'})
    expect(once.log.some((line) => line.includes('A scrawled note.'))).toBe(true)
    expect(reduce(once, {t: 'Search', containerId: 'c1'})).toBe(once) // already searched → no-op
  })

  it('refuses to search a container out of reach', () => {
    const state = withContainer(container(7, 7, {loot: {kind: 'medkit', count: 1}}))
    const next = reduce(state, {t: 'Search', containerId: 'c1'})
    expect(next.containers[0].searched).toBe(false)
    expect(next.entities[0].inventory).toHaveLength(0)
  })
})

describe('solo reducer — gear pickup', () => {
  it('equips a weapon off the floor (loaded) and drops the old one', () => {
    const a = {...pc('a', 2, 2, 0), weaponId: 'blade', loadedRounds: 0}
    const state: SoloState = {
      ...makeState([a]),
      ground: [{id: 'g1', x: a.x, y: a.y, stack: {kind: 'weapon', weaponId: 'autorifle', count: 1}}]
    }
    const next = reduce(state, {t: 'PickUp', groundItemId: 'g1'})
    expect(next.entities[0].weaponId).toBe('autorifle')
    expect(next.entities[0].loadedRounds).toBe(20) // autorifle magazine, found loaded
    expect(next.ground.some((g) => g.stack.kind === 'weapon' && g.stack.weaponId === 'blade')).toBe(true)
  })

  it('dons armour off the floor', () => {
    const a = {...pc('a', 2, 2, 0), armorId: null}
    const state: SoloState = {
      ...makeState([a]),
      ground: [{id: 'g1', x: a.x, y: a.y, stack: {kind: 'armor', armorId: 'combat', count: 1}}]
    }
    const next = reduce(state, {t: 'PickUp', groundItemId: 'g1'})
    expect(next.entities[0].armorId).toBe('combat')
  })
})
