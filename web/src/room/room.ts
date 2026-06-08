// The transport seam between the solo game's view layer and the event-sourced
// engine. solo.ts programs against a Room, so the SAME UI and animation can be
// backed either by a LocalRoom (in-browser, offline, IndexedDB-persisted) or — at
// a later phase — a RemoteRoom that streams from the server Durable Object. A
// command is submitted; the events it produces are delivered to subscribers, which
// fold + animate them. Solo is then exactly "multiplayer with one local player who
// owns every piece": the only difference from the online game is where the engine
// runs and how many players claim seats.
import type {SoloState} from '../solo/model'
import type {SoloEvent} from '../solo/reducer'
import type {SoloCommand} from '../solo/session'

// Receives each batch of events a command produced, plus the authoritative state
// after they fold. For a LocalRoom this fires synchronously within submit(); a
// future RemoteRoom fires it as events stream in over SSE. The view folds the
// events one at a time into its own display state to animate (so the on-screen
// state can lag the authoritative state during a monster glide).
export type RoomListener = (events: SoloEvent[], state: SoloState) => void | Promise<void>

// The outcome of a submitted command: the events it produced (empty if rejected)
// and, on rejection, the reason — so the view can show denial feedback (the
// floating "blocked" label + sound) right where the player tapped.
export type SubmitResult = {events: SoloEvent[]; rejected: string | null}

export interface Room {
  // The seed-derived genesis identifier — used for resume and (later) promotion.
  readonly seed: number
  // The authoritative current state — read between turns, when no animation is in
  // flight (input is locked while a batch animates, so this is safe to decide on).
  getState(): SoloState
  // This client's seat id in multiplayer, or undefined when there are no seats
  // (offline solo — the local player commands whichever piece is active).
  mySeat(): string | undefined
  // Issue a command. The optional rng overrides the engine's rng for THIS command
  // only: solo passes its on-screen 3D-dice faces so the dice the player sees are
  // exactly the dice that resolve. Produced events are persisted (if the room is
  // durable) and delivered to every listener; the result reports rejection so the
  // view can show denial feedback.
  submit(command: SoloCommand, rng?: () => number): Promise<SubmitResult>
  // Subscribe to event batches. Returns an unsubscribe function.
  subscribe(listener: RoomListener): () => void
  // Release timers/listeners (and, later, network connections).
  close(): void
}
