// A Room backed by the server (a SoloRoom Durable Object) — the online, multi-player
// implementation behind the SAME interface as LocalRoom, so the /solo client is
// transport-agnostic. It connects a `play` SSE stream (which the server assigns a
// seat, redistributing piece ownership), folds the server's authoritative event
// batches into local state, and POSTs commands stamped with its seat. Dice are
// server-authoritative online, so submit sends no rng. The engine still folds the
// same events everywhere, so every client converges on identical state.
import {buildWalkGrid} from '../solo/grid'
import type {SoloState} from '../solo/model'
import {foldSolo, type SoloEvent} from '../solo/reducer'
import type {SoloCommand} from '../solo/session'
import type {Room, RoomListener, SubmitResult} from './room'

export class RemoteRoom implements Room {
  readonly seed: number
  private state: SoloState
  private seat: string | undefined
  private readonly room: string
  private source: EventSource | null = null
  private readonly listeners = new Set<RoomListener>()

  private constructor(room: string, state: SoloState, seat: string | undefined) {
    this.room = room
    this.state = state
    this.seed = state.seed
    this.seat = seat
  }

  // Connect and resolve once the initial play-snapshot arrives (so getState() is
  // valid before the view installs it). The grid is server-only, so rebuild it from
  // the map locally. Rejects on stream error / timeout.
  static open(room: string, seed?: number): Promise<RemoteRoom> {
    return new Promise((resolve, reject) => {
      const query = `play=1${seed !== undefined ? `&seed=${encodeURIComponent(seed)}` : ''}`
      const source = new EventSource(`/api/solo/${encodeURIComponent(room)}/stream?${query}`)
      let instance: RemoteRoom | null = null
      source.onmessage = (event) => {
        const message = JSON.parse(event.data) as {type?: string; view?: string; seat?: string; state?: SoloState}
        if (message.type !== 'snapshot' || message.view !== 'play' || !message.state) return
        const state = {...message.state, grid: buildWalkGrid(message.state.map)} as SoloState
        instance = new RemoteRoom(room, state, message.seat)
        instance.source = source
        source.onmessage = (next) => instance?.onMessage(next)
        resolve(instance)
      }
      source.onerror = () => {
        if (!instance) {
          source.close()
          reject(new Error('stream error'))
        }
      }
      setTimeout(() => {
        if (!instance) {
          source.close()
          reject(new Error('stream timeout'))
        }
      }, 8000)
    })
  }

  // Server event batch: fold into authoritative state, then hand the raw events to
  // listeners (the view's animation pump folds its own display copy from them).
  private onMessage(event: MessageEvent): void {
    const message = JSON.parse(event.data) as {type?: string; events?: SoloEvent[]}
    if (message.type !== 'events' || !message.events) return
    for (const e of message.events) this.state = foldSolo(this.state, e)
    for (const listener of this.listeners) void listener(message.events, this.state)
  }

  getState(): SoloState {
    return this.state
  }

  mySeat(): string | undefined {
    return this.seat
  }

  subscribe(listener: RoomListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // POST the command stamped with our seat; the server validates ownership and
  // broadcasts the resulting events over SSE (which onMessage animates). No rng —
  // the server rolls. The result reports server acceptance; the events arrive async.
  async submit(command: SoloCommand): Promise<SubmitResult> {
    const result = await fetch(`/api/solo/${encodeURIComponent(this.room)}/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...command, byPlayer: this.seat})
    })
      .then((r) => r.json() as Promise<{accepted?: boolean}>)
      .catch(() => ({accepted: false}))
    return {events: [], rejected: result.accepted ? null : null}
  }

  close(): void {
    this.source?.close()
    this.source = null
    this.listeners.clear()
  }
}
