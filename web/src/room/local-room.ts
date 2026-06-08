// A Room backed by the pure event-sourced engine running in the browser — the
// offline, single-device implementation. It holds a SoloSession, applies commands
// through the SAME step()/runAi() the server Durable Object uses (so the monster
// AI lives in exactly one place), persists the event log to IndexedDB, and
// delivers produced events to subscribers for animation. Resume folds the saved
// log over the seed-derived genesis — identical to the server's replay().
import {activeEntity, type SoloState} from '../solo/model'
import {createSession, replay, runAi, step, type SoloCommand, type SoloSession} from '../solo/session'
import {clearGame, loadGame, saveGame} from '../solo/idb'
import type {Room, RoomListener, SubmitResult} from './room'

const randomSeed = (): number => Math.floor(Math.random() * 100000)

export class LocalRoom implements Room {
  readonly seed: number
  private session: SoloSession
  private readonly gameId: string
  private readonly listeners = new Set<RoomListener>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(session: SoloSession, gameId: string) {
    this.session = session
    this.seed = session.seed
    this.gameId = gameId
  }

  // Resume a saved game when one exists and matches the requested seed (or no seed
  // was asked for); otherwise start fresh. Persistence is best-effort, so in
  // environments without IndexedDB (tests) this just starts a fresh seeded game.
  static async open(gameId: string, requestedSeed?: number): Promise<LocalRoom> {
    const saved = await loadGame(gameId)
    if (saved && saved.events.length > 0 && (requestedSeed === undefined || requestedSeed === saved.seed)) {
      return new LocalRoom(replay(saved.seed, saved.events), gameId)
    }
    const room = new LocalRoom(createSession(requestedSeed ?? randomSeed()), gameId)
    room.scheduleSave()
    return room
  }

  // Start a brand-new game under this id, discarding any saved progress ("New
  // deck"). Always fresh — unlike open(), which resumes when a save exists.
  static async fresh(gameId: string, seed?: number): Promise<LocalRoom> {
    await clearGame(gameId)
    const room = new LocalRoom(createSession(seed ?? randomSeed()), gameId)
    room.scheduleSave()
    return room
  }

  getState(): SoloState {
    return this.session.state
  }

  subscribe(listener: RoomListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Apply a command (player action or d-pad step), running the monster AI to
  // completion via the engine, then persist and broadcast the produced events. The
  // optional rng overrides the session rng for this command (solo's 3D-dice faces).
  async submit(command: SoloCommand, rng?: () => number): Promise<SubmitResult> {
    const {state, events, rejected} = step(this.session.state, command, rng ?? this.session.rng)
    if (events.length === 0) return {events, rejected} // not your turn / illegal
    this.session = {...this.session, state, events: [...this.session.events, ...events]}
    this.scheduleSave()
    for (const listener of this.listeners) await listener(events, state)
    return {events, rejected: null}
  }

  // After resuming a game that was closed mid-horde-turn, the active entity is a
  // monster; run the AI to completion so control returns to the player rather than
  // stalling. The produced events are persisted and animated like any other batch.
  async resumeIdleAi(): Promise<void> {
    if (activeEntity(this.session.state)?.faction !== 'monster') return
    const {state, events} = runAi(this.session.state, this.session.rng)
    if (events.length === 0) return
    this.session = {...this.session, state, events: [...this.session.events, ...events]}
    this.scheduleSave()
    for (const listener of this.listeners) await listener(events, state)
  }

  close(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.listeners.clear()
  }

  // Coalesce rapid writes (a monster turn produces many events) into one save.
  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void saveGame(this.gameId, {seed: this.seed, events: [...this.session.events], updatedAt: Date.now()})
    }, 250)
  }
}
