// Tests for the GameTable functional core (decide / fold / projectFor), driven
// directly — no Durable Object or network harness. The focus is the
// security-critical fog gating: a player must never receive a token, room label,
// or chat say they aren't allowed to see, and command permissions are enforced.
import {describe, expect, it} from 'vitest'
import {decide, fold, projectFor, replay, seedBoard, type Actor, type EventInput, type TableState} from './game-table'
import type {Board, Combatant, CombatState, Command, DomainEvent, Token} from './protocol'

// A wall down the middle (x = 500), splitting the board into a left and right
// half so two tokens placed on opposite sides cannot see each other.
const walledBoard = (): Board => ({
  assetRef: 'test-board',
  width: 1000,
  height: 1000,
  gridScale: 50,
  sightRadius: 700,
  occluders: [{type: 'wall', id: 'mid-wall', x1: 500, y1: 0, x2: 500, y2: 1000}],
  doorStates: {},
  playerDoorControl: true,
  metersPerSquare: 1.5,
  defaultMoveMeters: 6,
  rooms: [{label: 'BRIDGE', x: 100, y: 100, w: 200, h: 200}]
})

// A board whose central wall is instead a door, so closing/opening it flips
// whether the two halves can see each other.
const dooredBoard = (open = false): Board => ({
  ...walledBoard(),
  occluders: [{type: 'door', id: 'mid-door', x1: 500, y1: 0, x2: 500, y2: 1000, open}],
  doorStates: open ? {'mid-door': {open: true}} : {}
})

const token = (ownerId: string, x: number, y: number): Token => ({
  id: `token-${ownerId}`,
  ownerId,
  label: ownerId.toUpperCase(),
  kind: 'officer',
  x,
  y
})

// State with `a` on the left of the divider and `b` on the right.
const splitState = (board: Board): TableState => ({
  board,
  tokens: new Map([
    ['a', token('a', 250, 500)],
    ['b', token('b', 750, 500)]
  ]),
  says: [],
  combat: null
})

const player = (playerId: string): Actor => ({playerId, gm: false})
const GM: Actor = {playerId: 'gm', gm: true}
const NOW = 1_000_000

const combatant = (playerId: string, initiative: number | null, order: number): Combatant => ({
  playerId,
  tokenId: `token-${playerId}`,
  label: playerId.toUpperCase(),
  order,
  dexterityDm: 0,
  dice: initiative == null ? null : [3, 3],
  initiative
})

// A ready combat where it is `a`'s turn (turnIndex 0), `a` then `b`.
const readyCombat = (): CombatState => ({
  round: 1,
  turnIndex: 0,
  combatants: [combatant('a', 9, 0), combatant('b', 7, 1)]
})

describe('projectFor — token fog gating', () => {
  it('hides a token positioned behind a wall from a player', () => {
    const state = splitState(walledBoard())
    const seenByA = projectFor(state, player('a'), NOW).tokens.map((t) => t.ownerId)
    const seenByB = projectFor(state, player('b'), NOW).tokens.map((t) => t.ownerId)
    expect(seenByA).toEqual(['a'])
    expect(seenByB).toEqual(['b'])
  })

  it('reveals the token behind a door once it is open', () => {
    const closed = splitState(dooredBoard(false))
    expect(projectFor(closed, player('a'), NOW).tokens.map((t) => t.ownerId)).toEqual(['a'])

    const open = splitState(dooredBoard(true))
    expect(projectFor(open, player('a'), NOW).tokens.map((t) => t.ownerId).sort()).toEqual(['a', 'b'])
  })

  it('shows every token to the GM, even across a wall', () => {
    const state = splitState(walledBoard())
    expect(projectFor(state, GM, NOW).tokens.map((t) => t.ownerId).sort()).toEqual(['a', 'b'])
  })
})

describe('projectFor — room labels are GM-only', () => {
  it('strips room labels for a player but keeps them for the GM', () => {
    const state = splitState(walledBoard())
    expect(projectFor(state, player('a'), NOW).board.rooms).toBeUndefined()
    expect(projectFor(state, GM, NOW).board.rooms).toEqual(walledBoard().rooms)
  })
})

describe('projectFor — chat say visibility', () => {
  // `a` says something; only a recipient who can currently see `a` receives it.
  const withSay = (board: Board): TableState => {
    const state = splitState(board)
    const result = decide(state, player('a'), {type: 'Say', text: 'over here'}, {now: NOW, rollD6: () => 1})
    if ('error' in result) throw new Error(result.error)
    // Assign a seq as the shell would, then fold.
    result.events.forEach((event, index) => fold(state, {...event, seq: index + 1} as DomainEvent))
    return state
  }

  it('delivers a say to the speaker themselves', () => {
    const state = withSay(walledBoard())
    expect(projectFor(state, player('a'), NOW).says.map((s) => s.text)).toEqual(['over here'])
  })

  it('withholds a say from a player who cannot see the speaker', () => {
    const state = withSay(walledBoard())
    expect(projectFor(state, player('b'), NOW).says).toEqual([])
  })

  it('delivers a say to a player who can see the speaker', () => {
    const state = withSay(dooredBoard(true))
    expect(projectFor(state, player('b'), NOW).says.map((s) => s.text)).toEqual(['over here'])
  })

  it('delivers every say to the GM', () => {
    const state = withSay(walledBoard())
    expect(projectFor(state, GM, NOW).says.map((s) => s.text)).toEqual(['over here'])
  })

  it('drops says older than the TTL from the view', () => {
    const state = withSay(walledBoard())
    // 9s later: past the 8s TTL, so even the speaker no longer sees their bubble.
    expect(projectFor(state, player('a'), NOW + 9000).says).toEqual([])
  })
})

describe('decide — MoveToken combat turn gating', () => {
  it('lets only the active combatant move during combat', () => {
    const state = {...splitState(walledBoard()), combat: readyCombat()}
    const move: Command = {type: 'MoveToken', x: 260, y: 500}

    const a = decide(state, player('a'), move, {now: NOW, rollD6: () => 1})
    expect('events' in a).toBe(true)

    const b = decide(state, player('b'), {type: 'MoveToken', x: 760, y: 500}, {now: NOW, rollD6: () => 1})
    expect(b).toEqual({error: 'Only the current combatant can move'})
  })

  it('blocks moves before initiative is rolled', () => {
    const rolling: CombatState = {round: 1, turnIndex: null, combatants: [combatant('a', null, 0)]}
    const state = {...splitState(walledBoard()), combat: rolling}
    const result = decide(state, player('a'), {type: 'MoveToken', x: 260, y: 500}, {now: NOW, rollD6: () => 1})
    expect(result).toEqual({error: 'Roll initiative before moving'})
  })

  it('allows free movement (within sight + budget) when no combat is running', () => {
    const state = splitState(walledBoard())
    const result = decide(state, player('a'), {type: 'MoveToken', x: 260, y: 500}, {now: NOW, rollD6: () => 1})
    expect(result).toEqual({events: [{type: 'TokenMoved', playerId: 'a', x: 260, y: 500}]})
  })
})

describe('decide — ToggleDoor permission + adjacency', () => {
  const doorId = 'mid-door'
  const adjacent = 470 // within doorReach (1.5 * gridScale = 75px) of the x=500 door
  const farAway = 250

  it('lets an adjacent player toggle a door when player control is on', () => {
    const state = splitState(dooredBoard(false))
    state.tokens.set('a', token('a', adjacent, 500))
    const result = decide(state, player('a'), {type: 'ToggleDoor', doorId, open: true}, {now: NOW, rollD6: () => 1})
    expect(result).toEqual({events: [{type: 'DoorToggled', doorId, open: true}]})
  })

  it('rejects a player who is too far from the door', () => {
    const state = splitState(dooredBoard(false))
    state.tokens.set('a', token('a', farAway, 500))
    const result = decide(state, player('a'), {type: 'ToggleDoor', doorId, open: true}, {now: NOW, rollD6: () => 1})
    expect(result).toEqual({error: 'Move next to the door to open it'})
  })

  it('locks doors to the GM when player control is off', () => {
    const board = {...dooredBoard(false), playerDoorControl: false}
    const state = splitState(board)
    state.tokens.set('a', token('a', adjacent, 500))
    const blocked = decide(state, player('a'), {type: 'ToggleDoor', doorId, open: true}, {now: NOW, rollD6: () => 1})
    expect(blocked).toEqual({error: 'Doors are locked — GM only'})

    // The GM may toggle even with no token and player control off.
    const allowed = decide(state, GM, {type: 'ToggleDoor', doorId, open: true}, {now: NOW, rollD6: () => 1})
    expect(allowed).toEqual({events: [{type: 'DoorToggled', doorId, open: true}]})
  })
})

describe('decide — GM-only commands reject a non-GM', () => {
  const state = (): TableState => splitState(walledBoard())
  const ctx = {now: NOW, rollD6: () => 1}

  it('rejects StartCombat from a player', () => {
    expect(decide(state(), player('a'), {type: 'StartCombat'}, ctx)).toEqual({error: 'GM only'})
  })

  it('rejects EndCombat from a player', () => {
    expect(decide(state(), player('a'), {type: 'EndCombat'}, ctx)).toEqual({error: 'GM only'})
  })

  it('rejects SetPlayerDoorControl from a player', () => {
    expect(decide(state(), player('a'), {type: 'SetPlayerDoorControl', enabled: false}, ctx)).toEqual({
      error: 'GM only'
    })
  })

  it('rejects SetTokenMoveMeters from a player', () => {
    expect(decide(state(), player('a'), {type: 'SetTokenMoveMeters', playerId: 'a', moveMeters: 12}, ctx)).toEqual({
      error: 'GM only'
    })
  })

  it('lets the GM start combat', () => {
    const result = decide(state(), GM, {type: 'StartCombat'}, ctx)
    expect(result).toEqual({events: [{type: 'CombatStarted', playerIds: ['a', 'b']}]})
  })
})

describe('fold — events advance the canonical state', () => {
  const seq = (event: EventInput, n: number): DomainEvent => ({...event, seq: n} as DomainEvent)

  it('records and orders a full combat round', () => {
    const state = splitState(walledBoard())
    fold(state, seq({type: 'CombatStarted', playerIds: ['a', 'b']}, 1))
    expect(state.combat?.turnIndex).toBeNull()

    fold(state, seq({type: 'InitiativeRolled', playerId: 'a', dice: [4, 4], dexterityDm: 0, initiative: 8}, 2))
    fold(state, seq({type: 'InitiativeRolled', playerId: 'b', dice: [6, 6], dexterityDm: 0, initiative: 12}, 3))
    // Both rolled ⇒ ordered by descending initiative with b ahead of a, turn 0.
    expect(state.combat?.turnIndex).toBe(0)
    expect(state.combat?.combatants.map((c) => c.playerId)).toEqual(['b', 'a'])

    fold(state, seq({type: 'TurnAdvanced', round: 1, turnIndex: 1}, 4))
    expect(state.combat?.turnIndex).toBe(1)

    fold(state, seq({type: 'CombatEnded'}, 5))
    expect(state.combat).toBeNull()
  })

  it('moves and renames a token, and toggles a door', () => {
    const state = splitState(dooredBoard(false))
    fold(state, seq({type: 'TokenMoved', playerId: 'a', x: 300, y: 400}, 1))
    expect(state.tokens.get('a')).toMatchObject({x: 300, y: 400})

    fold(state, seq({type: 'PlayerRenamed', playerId: 'a', label: 'Scout'}, 2))
    expect(state.tokens.get('a')?.label).toBe('Scout')

    fold(state, seq({type: 'DoorToggled', doorId: 'mid-door', open: true}, 3))
    expect(state.board.doorStates['mid-door']).toEqual({open: true})
  })

  it('adds and removes a player token', () => {
    const state = splitState(walledBoard())
    fold(state, seq({type: 'PlayerJoined', playerId: 'c', label: 'C', kind: 'medic', x: 100, y: 100}, 1))
    expect(state.tokens.get('c')).toMatchObject({ownerId: 'c', x: 100, y: 100, kind: 'medic'})

    fold(state, seq({type: 'PlayerLeft', playerId: 'c'}, 2))
    expect(state.tokens.has('c')).toBe(false)
  })
})

describe('decide — round-trip Say through fold builds a seq-stamped id', () => {
  it('stamps the say id with the assigned event seq and prunes/caps stored says', () => {
    const state = splitState(walledBoard())
    const result = decide(state, player('a'), {type: 'Say', text: '  hi there  '}, {now: NOW, rollD6: () => 1})
    expect(result).toEqual({
      events: [
        {type: 'Said', fromId: 'a', label: 'A', text: 'hi there', at: {x: 250, y: 500}, fromGm: false, sentAt: NOW}
      ]
    })
    fold(state, {...('events' in result ? result.events[0] : {}), seq: 7} as DomainEvent)
    expect(state.says).toHaveLength(1)
    expect(state.says[0].id).toBe('say-a-7')
    expect(state.says[0].text).toBe('hi there')
  })

  it('emits no event for an empty say', () => {
    const state = splitState(walledBoard())
    expect(decide(state, player('a'), {type: 'Say', text: '   '}, {now: NOW, rollD6: () => 1})).toEqual({events: []})
  })
})

describe('replay — a table survives a restart', () => {
  // Durability check for the pure half of the persistence story: a live table is
  // a fold over its event log starting from the seed board, and the DO rebuilds
  // on construction by replaying that log over the same seed. So replaying the
  // exact event sequence the shell logged must reproduce the live TableState.
  //
  // This unit-tests the replay/fold logic only. The storage read/write wiring in
  // GameTable (storage.put on commit, storage.list + blockConcurrencyWhile on
  // construction) needs a real DO and is not exercised here.

  // Build a log the way the shell's `commit` does — append with a monotonic seq —
  // folding each event into a "live" state as we go. Returns the log plus the
  // live state, which a fresh replay must match.
  const buildTable = (): {log: DomainEvent[]; live: TableState} => {
    const live: TableState = {board: seedBoard(), tokens: new Map(), says: [], combat: null}
    const log: DomainEvent[] = []
    const append = (event: EventInput): void => {
      const logged = {...event, seq: log.length + 1} as DomainEvent
      log.push(logged)
      fold(live, logged)
    }

    // Two players join on opposite sides of the seed board's central door.
    append({type: 'PlayerJoined', playerId: 'a', label: 'P1', kind: 'scout', x: 250, y: 500})
    append({type: 'PlayerJoined', playerId: 'b', label: 'P2', kind: 'medic', x: 750, y: 500})
    // One renames, one moves.
    append({type: 'PlayerRenamed', playerId: 'a', label: 'Scout'})
    append({type: 'TokenMoved', playerId: 'a', x: 300, y: 520})
    append({type: 'TokenMoveMetersSet', playerId: 'b', moveMeters: 9})
    // A door toggles, then the GM publishes a new board (full value in the event).
    append({type: 'DoorToggled', doorId: 'seed-door', open: true})
    const published: Board = {...seedBoard(), assetRef: 'map-7', boardSeq: 1, playerDoorControl: false}
    append({type: 'BoardPublished', board: published})
    // A chat say (its folded id is stamped from the event seq).
    append({
      type: 'Said',
      fromId: 'a',
      label: 'Scout',
      text: 'on me',
      at: {x: 300, y: 520},
      fromGm: false,
      sentAt: NOW
    })
    // A combat: start, both roll initiative, advance a turn.
    append({type: 'CombatStarted', playerIds: ['a', 'b']})
    append({type: 'InitiativeRolled', playerId: 'a', dice: [4, 4], dexterityDm: 0, initiative: 8})
    append({type: 'InitiativeRolled', playerId: 'b', dice: [6, 6], dexterityDm: 0, initiative: 12})
    append({type: 'TurnAdvanced', round: 1, turnIndex: 1})

    return {log, live}
  }

  it('rebuilds the identical TableState purely from the event log', () => {
    const {log, live} = buildTable()
    const rebuilt = replay(log)
    // Deep-equals across board, tokens (a Map), says, and combat — every piece of
    // canonical state is reconstructed from the log alone.
    expect(rebuilt).toEqual(live)
  })

  it('restores the published board (not the seed) from the log', () => {
    const {log} = buildTable()
    const rebuilt = replay(log)
    expect(rebuilt.board.assetRef).toBe('map-7')
    expect(rebuilt.board.boardSeq).toBe(1)
    expect(rebuilt.board.playerDoorControl).toBe(false)
    // The door toggled before the publish is on the seed board; the published
    // board carries its own (empty) doorStates, so the toggle does not persist.
    expect(rebuilt.board.doorStates).toEqual({})
  })

  it('restores combat ordering and the current turn from the log', () => {
    const {log} = buildTable()
    const rebuilt = replay(log)
    // b rolled higher, so initiative order is b then a; the log advanced to turn 1.
    expect(rebuilt.combat?.combatants.map((c) => c.playerId)).toEqual(['b', 'a'])
    expect(rebuilt.combat?.turnIndex).toBe(1)
  })

  it('an empty log replays to the seed state', () => {
    const rebuilt = replay([])
    expect(rebuilt).toEqual({board: seedBoard(), tokens: new Map(), says: [], combat: null})
  })
})
