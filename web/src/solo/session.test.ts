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
    expect(after.log).toHaveLength(0) // not recorded
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

  it('replays deterministically from seed + command log (DO restart)', () => {
    const live = playTurns(createSession(777), 8)
    const restored = replay(777, live.log)
    expect(JSON.stringify(restored.state.entities)).toBe(JSON.stringify(live.state.entities))
    expect(restored.state.turnPtr).toBe(live.state.turnPtr)
    expect(restored.state.round).toBe(live.state.round)
    expect(restored.state.wave).toBe(live.state.wave)
    expect(restored.state.phase).toEqual(live.state.phase)
  })
})
