import {describe, expect, it} from 'vitest'
import {
  moveRadiusPixels,
  SRD_DEFAULT_MOVE_FEET,
  SRD_FEET_PER_SQUARE,
  validateTokenMove,
  type Board,
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
  feetPerSquare: SRD_FEET_PER_SQUARE,
  defaultMoveFeet: SRD_DEFAULT_MOVE_FEET
})

const viewer = (x: number, y: number, moveFeet?: number): Token => ({
  id: 'token-p1',
  ownerId: 'p1',
  label: 'P1',
  kind: 'officer',
  x,
  y,
  moveFeet
})

describe('moveRadiusPixels', () => {
  it('maps 30 ft at 5 ft/square and 50 px grid to 300 board pixels', () => {
    const board = seedBoard()
    expect(moveRadiusPixels(viewer(0, 0), board)).toBe(300)
  })

  it('honours per-token move feet override', () => {
    const board = seedBoard()
    expect(moveRadiusPixels(viewer(0, 0, 60), board)).toBe(600)
  })
})

describe('validateTokenMove', () => {
  it('allows movement within sight and within 30 ft', () => {
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
    if (!result.ok) expect(result.reason).toContain('30 ft')
  })

  it('allows a GM to ignore movement limits', () => {
    const board = {...seedBoard(), occluders: []}
    const me = viewer(100, 100)
    expect(validateTokenMove(me, board, {x: 900, y: 900}, {gm: true}).ok).toBe(true)
  })
})
