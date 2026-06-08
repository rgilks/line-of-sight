import {describe, expect, it} from 'vitest'
import {activeEntity} from './model'
import {createSession, replay, sessionStep, type SoloSession} from './session'

// End turns for whatever PC is active (letting the AI run between rounds) for up
// to `n` player turns, or until the game ends.
const playTurns = (session: SoloSession, n: number): SoloSession => {
  let s = session
  for (let i = 0; i < n && s.state.phase.t === 'playerTurn'; i += 1) {
    const active = activeEntity(s.state)
    if (!active || active.faction !== 'pc') break
    s = sessionStep(s, {action: {t: 'EndTurn'}, byActor: active.id}).session
  }
  return s
}

describe('solo session', () => {
  it('rejects a command from a player who is not the active character', () => {
    const session = createSession(1234)
    const active = activeEntity(session.state)
    const other = session.state.entities.find((e) => e.faction === 'pc' && e.id !== active?.id)
    if (!other) throw new Error('expected a second PC')
    const {session: after} = sessionStep(session, {action: {t: 'EndTurn'}, byActor: other.id})
    expect(after.state).toBe(session.state) // unchanged
    expect(after.events).toHaveLength(0) // no events recorded
  })

  it('runs the monster AI when a PC ends its turn', () => {
    const monsterPos = (s: SoloSession): string =>
      s.state.entities
        .filter((e) => e.faction === 'monster')
        .map((e) => `${Math.round(e.x)},${Math.round(e.y)}`)
        .join('|')
    const session = createSession(1234)
    const before = monsterPos(session)
    const after = playTurns(session, 8)
    expect(activeEntity(after.state)?.faction).toBe('pc') // control returned to a PC
    expect(monsterPos(after)).not.toBe(before) // the horde advanced
  })

  it('replays deterministically from seed + event log (DO restart)', () => {
    const live = playTurns(createSession(777), 8)
    const restored = replay(777, live.events)
    expect(JSON.stringify(restored.state.entities)).toBe(JSON.stringify(live.state.entities))
    expect(restored.state.turnPtr).toBe(live.state.turnPtr)
    expect(restored.state.round).toBe(live.state.round)
    expect(restored.state.wave).toBe(live.state.wave)
    expect(restored.state.phase).toEqual(live.state.phase)
  })

  it('a d-pad step moves the active character one cell, and replays', () => {
    let session = createSession(1234)
    const id = activeEntity(session.state)?.id
    if (!id) throw new Error('no active entity')
    const start = session.state.entities.find((e) => e.id === id)
    const from = start ? {x: start.x, y: start.y} : {x: 0, y: 0}
    const eightWays: ReadonlyArray<readonly [number, number]> = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1]
    ]
    for (const [dx, dy] of eightWays) {
      const next = sessionStep(session, {step: {dx, dy}, byActor: id})
      const me = next.session.state.entities.find((e) => e.id === id)
      if (me && (me.x !== from.x || me.y !== from.y)) {
        session = next.session
        break
      }
    }
    const moved = session.state.entities.find((e) => e.id === id)
    expect(!!moved && (moved.x !== from.x || moved.y !== from.y)).toBe(true)
    // The step is recorded and replays to the same position (deterministic).
    const replayed = replay(1234, session.events).state.entities.find((e) => e.id === id)
    expect(replayed?.x).toBe(moved?.x)
    expect(replayed?.y).toBe(moved?.y)
  })

  it('multiplayer: seats claim through the session, pieces redistribute, the owner gate holds', () => {
    let s = createSession(42)
    const pcs = () => s.state.entities.filter((e) => e.faction === 'pc')
    const owned = (seat: string) => pcs().filter((p) => p.owner === seat).length

    // Host claims → owns every piece.
    s = sessionStep(s, {action: {t: 'ClaimSeat', seatId: 'h', joinedAt: 0}}).session
    expect(pcs().every((p) => p.owner === 'h')).toBe(true)

    // A second player joins → pieces split 2/2; the active piece stays with the host.
    s = sessionStep(s, {action: {t: 'ClaimSeat', seatId: 'p2', joinedAt: 1}}).session
    expect(owned('h')).toBe(2)
    expect(owned('p2')).toBe(2)
    const active = s.state.entities[s.state.turnPtr]
    expect(active.owner).toBe('h')

    // The other seat may NOT command the host's active piece; the owner may.
    expect(sessionStep(s, {action: {t: 'EndTurn'}, byActor: active.id, byPlayer: 'p2'}).events).toHaveLength(0)
    expect(sessionStep(s, {action: {t: 'EndTurn'}, byActor: active.id, byPlayer: 'h'}).events.length).toBeGreaterThan(0)
  })
})
