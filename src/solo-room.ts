// SoloRoom: a server-authoritative "Survive the Horde" game in one Durable Object.
// It wraps the pure session core (web/src/solo/session): clients POST commands, the
// room applies them through the session, runs the monster AI, persists the resulting
// EVENT log, and broadcasts to every connection over SSE. The game replays from
// (seed + event log) to recover — the same event-sourced model as the GameTable.
//
// Three connection kinds, all over /stream:
//   • play (?play=1)   — a full /solo client over a RemoteRoom. It is assigned a
//                        SEAT on connect (which redistributes piece ownership across
//                        the present seats), gets an initial state snapshot, then
//                        EVENT batches it folds + animates locally. This is the
//                        unified multiplayer client: solo === one local seat.
//   • controller (?actor=) — a phone driving one character (LOS-gated projection).
//   • board (neither)  — an omniscient shared-screen state view.
// A game is promoted from offline solo by POSTing {seed, events} to /import.
import type {DurableObjectState} from './cf'
import {createSession, replay, sessionStep, type SoloCommand, type SoloSession} from '../web/src/solo/session'
import {projectController} from '../web/src/solo/projection'
import type {SoloEvent} from '../web/src/solo/reducer'
import type {Action, SoloState} from '../web/src/solo/model'

const encoder = new TextEncoder()
const EVT_PREFIX = 'evt:'
// Zero-padded so storage.list() (lexicographic) yields events in fold order.
const EVT_KEY = (n: number): string => `${EVT_PREFIX}${String(n).padStart(12, '0')}`

// A connection: a `play` client carries its assigned seat (and folds events); a
// controller carries its actor id (LOS-gated projection); a board has neither.
type Connection = {writer: WritableStreamDefaultWriter<Uint8Array>; actor: string | null; seat: string | null}

// Actions a client may POST. System/director actions (AddWave) and seat lifecycle
// (handled server-side on connect/disconnect) are rejected at the transport.
const PLAYER_ACTIONS = new Set<Action['t']>([
  'Move',
  'ToggleDoor',
  'Attack',
  'Reload',
  'UseMedkit',
  'PickUp',
  'Drop',
  'Search',
  'PushProp',
  'SetStance',
  'Aim',
  'EndTurn'
])

// The wire state for a viewer. `grid` is server-only (a play client rebuilds it from
// the map); the static `map` rides the snapshot once, updates carry changing fields.
const forSnapshot = ({grid: _grid, ...rest}: SoloState): Omit<SoloState, 'grid'> => rest
const forUpdate = ({grid: _grid, map: _map, ...rest}: SoloState): Omit<SoloState, 'grid' | 'map'> => rest

export class SoloRoom {
  private session: SoloSession | null = null
  private readonly connections = new Map<string, Connection>()
  private readonly storage: DurableObjectState['storage']
  private nextJoin = 0 // monotonic seat-join counter (stamps Seat.joinedAt)

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage
    // Durability: persist the seed + the event log; on restart fold the events over
    // a seed-derived genesis so a Worker/DO eviction loses nothing. The AI's turns
    // and seat changes are stored facts, not re-derived — the GameTable model.
    void state.blockConcurrencyWhile(async () => {
      const seed = await this.storage.get<number>('seed')
      if (seed === undefined) return
      const stored = await this.storage.list<SoloEvent>({prefix: EVT_PREFIX})
      this.session = replay(seed, [...stored.values()])
      this.nextJoin = this.session.state.seats.reduce((m, s) => Math.max(m, s.joinedAt + 1), 0)
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/stream')) return this.openStream(request, url)
    if (url.pathname.endsWith('/commands')) return this.handleCommand(request)
    if (url.pathname.endsWith('/import')) return this.handleImport(request)
    return new Response('Not found', {status: 404})
  }

  // Create the game lazily on first connect, seeded by ?seed= (or random), and
  // persist the seed so a restart rebuilds the same deck.
  private ensureSession(seedParam: string | null): SoloSession {
    if (this.session) return this.session
    const parsed = seedParam !== null ? Number(seedParam) : Number.NaN
    const seed = Number.isFinite(parsed) ? Math.floor(parsed) : Math.floor(Math.random() * 100000)
    this.session = createSession(seed)
    void this.storage.put('seed', seed)
    return this.session
  }

  private openStream(request: Request, url: URL): Response {
    const session = this.ensureSession(url.searchParams.get('seed'))
    const wantsPlay = url.searchParams.get('play') === '1'
    const actor = url.searchParams.get('actor')
    const id = crypto.randomUUID().slice(0, 8)
    const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>()
    // A play client claims a seat (redistributing ownership) before its snapshot, so
    // the snapshot already reflects which pieces it owns.
    let seat: string | null = null
    if (wantsPlay) {
      seat = `seat-${this.nextJoin}`
      this.apply({action: {t: 'ClaimSeat', seatId: seat, joinedAt: this.nextJoin}})
      this.nextJoin += 1
    }
    const connection: Connection = {writer: writable.getWriter(), actor, seat}
    this.connections.set(id, connection)
    void this.send(id, this.snapshotFor(connection, (this.session ?? session).state))
    request.signal.addEventListener('abort', () => {
      const conn = this.connections.get(id)
      this.connections.delete(id)
      if (conn) void conn.writer.close().catch(() => {})
      // Releasing the seat redistributes its pieces back across the remaining seats.
      if (conn?.seat) this.apply({action: {t: 'ReleaseSeat', seatId: conn.seat}})
    })
    return new Response(readable, {
      headers: {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'}
    })
  }

  private async handleCommand(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({error: 'Invalid JSON'}, {status: 400})
    }
    if (!this.session) return Response.json({error: 'No game in this room yet'}, {status: 409})
    // Validate the untrusted command: an actor plus EITHER a whitelisted action OR a
    // d-pad step. `byPlayer` (the seat) is optional and, when present, must own the
    // active piece for the engine to accept the command.
    const cmd = body as {
      byActor?: unknown
      byPlayer?: unknown
      action?: {t?: unknown}
      step?: {dx?: unknown; dy?: unknown}
    }
    const isStep = !!cmd.step && typeof cmd.step.dx === 'number' && typeof cmd.step.dy === 'number'
    const isAction = !!cmd.action && typeof cmd.action.t === 'string' && PLAYER_ACTIONS.has(cmd.action.t as Action['t'])
    if (typeof cmd.byActor !== 'string' || (!isStep && !isAction)) {
      return Response.json({error: 'Invalid command'}, {status: 400})
    }
    if (cmd.byPlayer !== undefined && typeof cmd.byPlayer !== 'string') {
      return Response.json({error: 'Invalid command'}, {status: 400})
    }
    const events = this.apply(body as SoloCommand)
    return Response.json({accepted: events.length > 0})
  }

  // Promote an offline solo game to this server room: a one-time hydrate from the
  // client's {seed, events}. Guarded — only if no session exists yet; a second
  // import (or import into a live room) is a 409, which the client treats as
  // "already promoted, just connect".
  private async handleImport(request: Request): Promise<Response> {
    if (this.session) return Response.json({error: 'Room already has a game'}, {status: 409})
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return Response.json({error: 'Invalid JSON'}, {status: 400})
    }
    const data = body as {seed?: unknown; events?: unknown}
    if (typeof data.seed !== 'number' || !Array.isArray(data.events)) {
      return Response.json({error: 'Expected {seed, events}'}, {status: 400})
    }
    const events = data.events as SoloEvent[]
    this.session = replay(data.seed, events)
    this.nextJoin = this.session.state.seats.reduce((m, s) => Math.max(m, s.joinedAt + 1), 0)
    void this.storage.put('seed', data.seed)
    events.forEach((event, i) => {
      void this.storage.put(EVT_KEY(i), event)
    })
    return Response.json({ok: true})
  }

  // Apply a command through the session: persist the produced events and broadcast
  // them. Returns the events (empty if rejected). The single mutation path for
  // player commands, seat claims/releases, and (via them) the monster AI.
  private apply(command: SoloCommand): SoloEvent[] {
    if (!this.session) return []
    const startIndex = this.session.events.length
    const {session, events} = sessionStep(this.session, command)
    this.session = session
    if (events.length === 0) return []
    events.forEach((event, i) => {
      void this.storage.put(EVT_KEY(startIndex + i), event)
    })
    this.broadcast(events)
    return events
  }

  // The initial message for a connection: a play client gets the full state + its
  // seat; a controller its LOS-gated projection; a board the omniscient state.
  private snapshotFor(connection: Connection, state: SoloState): unknown {
    if (connection.seat) return {type: 'snapshot', view: 'play', seat: connection.seat, state: forSnapshot(state)}
    return connection.actor
      ? {type: 'snapshot', view: 'controller', controller: projectController(state, connection.actor)}
      : {type: 'snapshot', view: 'board', state: forSnapshot(state)}
  }

  // The per-command message: a play client folds the raw events (so its display
  // state stays in lockstep with the server); a controller re-projects; the board
  // gets the changed fields.
  private updateFor(connection: Connection, state: SoloState, events: SoloEvent[]): unknown {
    if (connection.seat) return {type: 'events', events}
    return connection.actor
      ? {type: 'update', view: 'controller', controller: projectController(state, connection.actor)}
      : {type: 'update', view: 'board', state: forUpdate(state)}
  }

  private broadcast(events: SoloEvent[]): void {
    if (!this.session) return
    const state = this.session.state
    for (const [id, connection] of this.connections) {
      void this.send(id, this.updateFor(connection, state, events))
    }
  }

  private async send(id: string, message: unknown): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    try {
      await connection.writer.write(encoder.encode(`data: ${JSON.stringify(message)}\n\n`))
    } catch {
      this.connections.delete(id)
    }
  }
}
