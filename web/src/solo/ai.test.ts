import {describe, expect, it} from 'vitest'
import {defaultSpec, type GeneratedMap} from '../synth/types'
import {buildWalkGrid} from './grid'
import {moveBudgetPx, type Entity, type SoloState} from './model'
import {decideMonster} from './ai'

// 10×10 open room (cells 1..8 floor), no occluders.
const makeMap = (): GeneratedMap => ({
  spec: defaultSpec(1),
  width: 300,
  height: 300,
  gridScale: 30,
  rooms: [{x: 1, y: 1, w: 8, h: 8, id: 'r', type: 'common', label: 'C'}],
  corridors: [],
  decorations: [],
  occluders: []
})

const ent = (over: Partial<Entity>): Entity => ({
  id: 'x',
  faction: 'pc',
  kind: 'marine',
  label: 'x',
  x: 0,
  y: 0,
  stats: {str: 7, dex: 7, end: 7},
  statsMax: {str: 7, dex: 7, end: 7},
  skills: {},
  weaponId: 'blade',
  armorId: null,
  inventory: [],
  loadedRounds: 0,
  stance: 'standing',
  initiative: 5,
  order: 0,
  ...over
})

const cell = (cx: number, cy: number): {x: number; y: number} => ({x: (cx + 0.5) * 30, y: (cy + 0.5) * 30})

const makeState = (entities: Entity[]): SoloState => {
  const map = makeMap()
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

describe('decideMonster', () => {
  it('attacks an adjacent PC without moving', () => {
    const monster = ent({id: 'm', faction: 'monster', weaponId: 'claws', skills: {'Melee Combat': 1}, ...cell(2, 2)})
    const pc = ent({id: 'p', faction: 'pc', ...cell(3, 2)})
    const plan = decideMonster(makeState([monster, pc]), 'm')
    expect(plan.attackTargetId).toBe('p')
    expect(plan.moves.length).toBe(0)
  })

  it('paths toward a distant PC, stepping in the right direction', () => {
    const monster = ent({
      id: 'm',
      faction: 'monster',
      weaponId: 'claws',
      skills: {'Melee Combat': 1},
      moveMeters: 9,
      ...cell(2, 2)
    })
    const pc = ent({id: 'p', faction: 'pc', ...cell(7, 2)})
    const plan = decideMonster(makeState([monster, pc]), 'm')
    expect(plan.moves.length).toBeGreaterThan(0)
    expect(plan.moves[0].cx).toBe(3) // moves east toward the PC
  })

  it('does nothing when no PCs remain', () => {
    const monster = ent({id: 'm', faction: 'monster', weaponId: 'claws', ...cell(2, 2)})
    const plan = decideMonster(makeState([monster]), 'm')
    expect(plan).toEqual({moves: []})
  })
})
