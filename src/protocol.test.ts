import {describe, expect, it} from 'vitest'
import {
  activeCombatant,
  canToggleDoorFrom,
  CEPHEUS_DEFAULT_MOVE_METERS,
  CEPHEUS_METERS_PER_SQUARE,
  combatReady,
  doorReach,
  isPlayersCombatTurn,
  moveRadiusPixels,
  orderCombatantsByInitiative,
  validateTokenMove,
  type Board,
  type Combatant,
  type CombatState,
  type Token
} from './protocol'

const seedBoard = (): Board => ({
  assetRef: 'composed-board',
  width: 1000,
  height: 1000,
  gridScale: 50,
  sightRadius: 700,
  occluders: [
    {type: 'wall', id: 'seed-wall-top', x1: 500, y1: 100, x2: 500, y2: 430},
    {type: 'door', id: 'seed-door', x1: 500, y1: 430, x2: 500, y2: 570, open: false},
    {type: 'wall', id: 'seed-wall-bottom', x1: 500, y1: 570, x2: 500, y2: 900}
  ],
  doorStates: {},
  playerDoorControl: true,
  metersPerSquare: CEPHEUS_METERS_PER_SQUARE,
  defaultMoveMeters: CEPHEUS_DEFAULT_MOVE_METERS
})

const viewer = (x: number, y: number, moveMeters?: number): Token => ({
  id: 'token-p1',
  ownerId: 'p1',
  label: 'P1',
  kind: 'officer',
  x,
  y,
  moveMeters
})

describe('moveRadiusPixels', () => {
  it('maps 6 m at 1.5 m/square and 50 px grid to 200 board pixels (4 squares)', () => {
    const board = seedBoard()
    expect(moveRadiusPixels(viewer(0, 0), board)).toBe(200)
  })

  it('honours per-token move metres override', () => {
    const board = seedBoard()
    expect(moveRadiusPixels(viewer(0, 0, 9), board)).toBe(300)
  })
})

describe('validateTokenMove', () => {
  it('allows movement within sight and within the move budget', () => {
    const board = seedBoard()
    const me = viewer(250, 500)
    expect(validateTokenMove(me, board, {x: 300, y: 520}).ok).toBe(true)
  })

  it('blocks movement behind a closed door', () => {
    const board = seedBoard()
    const me = viewer(250, 500)
    expect(validateTokenMove(me, board, {x: 750, y: 500}).ok).toBe(false)
  })

  it('allows movement through an open door when line of sight exists', () => {
    const board = {...seedBoard(), doorStates: {'seed-door': {open: true}}}
    const me = viewer(250, 500)
    expect(validateTokenMove(me, board, {x: 400, y: 500}).ok).toBe(true)
  })

  it('blocks movement farther than the per-turn budget in open space', () => {
    const board = {...seedBoard(), occluders: []}
    const me = viewer(100, 100)
    const tooFar = {x: 100 + moveRadiusPixels(me, board) + 40, y: 100}
    const result = validateTokenMove(me, board, tooFar)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('6 m')
  })

  it('allows a GM to ignore movement limits', () => {
    const board = {...seedBoard(), occluders: []}
    const me = viewer(100, 100)
    expect(validateTokenMove(me, board, {x: 900, y: 900}, {gm: true}).ok).toBe(true)
  })
})

describe('canToggleDoorFrom', () => {
  const door = (): Board['occluders'][number] => ({
    type: 'door',
    id: 'seed-door',
    x1: 500,
    y1: 430,
    x2: 500,
    y2: 570,
    open: false
  })

  it('lets an adjacent player toggle the door', () => {
    const board = seedBoard() // gridScale 50 ⇒ reach 75px
    expect(doorReach(board)).toBe(75)
    // Standing 60px to the left of the door segment, beside its mid-span.
    expect(canToggleDoorFrom(viewer(440, 500), board, door())).toBe(true)
  })

  it('blocks a player too far from the door', () => {
    const board = seedBoard()
    // 250px away — across the room.
    expect(canToggleDoorFrom(viewer(250, 500), board, door())).toBe(false)
  })

  it('always lets the GM toggle, even with no token', () => {
    const board = seedBoard()
    expect(canToggleDoorFrom(null, board, door(), {gm: true})).toBe(true)
    expect(canToggleDoorFrom(viewer(0, 0), board, door(), {gm: true})).toBe(true)
  })

  it('returns false for a non-door occluder', () => {
    const board = seedBoard()
    const wall = board.occluders[0]
    expect(canToggleDoorFrom(viewer(500, 100), board, wall)).toBe(false)
  })
})

const combatant = (
  playerId: string,
  label: string,
  initiative: number | null,
  order: number
): Combatant => ({
  playerId,
  tokenId: `token-${playerId}`,
  label,
  order,
  dexterityDm: 0,
  dice: initiative == null ? null : [3, 3],
  initiative
})

describe('combat helpers', () => {
  it('orders combatants by descending initiative with stable join-order ties', () => {
    const p1 = combatant('p1', 'P1', 8, 0)
    const p2 = combatant('p2', 'P2', 12, 1)
    const p3 = combatant('p3', 'P3', 8, 2)
    expect(orderCombatantsByInitiative([p1, p2, p3]).map((entry) => entry.playerId)).toEqual([
      'p2',
      'p1',
      'p3'
    ])
  })

  it('is ready only after every combatant has initiative and a turn index exists', () => {
    const rolling: CombatState = {
      round: 1,
      turnIndex: null,
      combatants: [combatant('p1', 'P1', 8, 0), combatant('p2', 'P2', null, 1)]
    }
    const ready: CombatState = {
      round: 1,
      turnIndex: 0,
      combatants: [combatant('p1', 'P1', 8, 0), combatant('p2', 'P2', 7, 1)]
    }
    expect(combatReady(rolling)).toBe(false)
    expect(combatReady(ready)).toBe(true)
    expect(activeCombatant(ready)?.playerId).toBe('p1')
    expect(isPlayersCombatTurn(ready, 'p1')).toBe(true)
    expect(isPlayersCombatTurn(ready, 'p2')).toBe(false)
  })
})
