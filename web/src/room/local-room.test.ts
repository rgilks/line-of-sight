import {describe, expect, it} from 'vitest'
import {activeEntity} from '../solo/model'
import type {SoloEvent} from '../solo/reducer'
import {createSession, replay, sessionStep} from '../solo/session'
import {LocalRoom} from './local-room'

// End the active PC's turn repeatedly (letting the AI run between), up to `n`
// turns or until the game leaves the player phase.
const endTurns = async (room: LocalRoom, n: number): Promise<void> => {
  for (let i = 0; i < n && room.getState().phase.t === 'playerTurn'; i += 1) {
    const active = activeEntity(room.getState())
    if (!active || active.faction !== 'pc') break
    await room.submit({action: {t: 'EndTurn'}, byActor: active.id})
  }
}

describe('LocalRoom', () => {
  it('drives play through the same engine as a direct session (identical events + state)', async () => {
    const SEED = 9090
    // Direct session: end the active PC's turn repeatedly via sessionStep.
    let direct = createSession(SEED)
    const directEvents: SoloEvent[] = []
    for (let i = 0; i < 6 && direct.state.phase.t === 'playerTurn'; i += 1) {
      const active = activeEntity(direct.state)
      if (!active || active.faction !== 'pc') break
      const result = sessionStep(direct, {action: {t: 'EndTurn'}, byActor: active.id})
      direct = result.session
      directEvents.push(...result.events)
    }

    // LocalRoom: the SAME sequence via submit, events captured through a listener.
    const room = await LocalRoom.open('test-eq', SEED)
    const roomEvents: SoloEvent[] = []
    room.subscribe((events) => {
      roomEvents.push(...events)
    })
    await endTurns(room, 6)

    // The event log and the resulting state are byte-identical — solo-via-LocalRoom
    // is the same engine the server drives, so deleting solo's duplicate AI loop is
    // a behaviour-preserving change.
    expect(roomEvents.length).toBe(directEvents.length)
    expect(JSON.stringify(roomEvents)).toBe(JSON.stringify(directEvents))
    expect(JSON.stringify(room.getState().entities)).toBe(JSON.stringify(direct.state.entities))
    expect(room.getState().round).toBe(direct.state.round)
    expect(room.getState().wave).toBe(direct.state.wave)
    room.close()
  })

  it('replays its persisted events back to the same state (offline resume)', async () => {
    const SEED = 313
    const room = await LocalRoom.open('test-resume', SEED)
    const events: SoloEvent[] = []
    room.subscribe((evts) => {
      events.push(...evts)
    })
    await endTurns(room, 5)

    const restored = replay(SEED, events)
    expect(JSON.stringify(restored.state.entities)).toBe(JSON.stringify(room.getState().entities))
    expect(restored.state.round).toBe(room.getState().round)
    expect(restored.state.phase).toEqual(room.getState().phase)
    room.close()
  })
})
