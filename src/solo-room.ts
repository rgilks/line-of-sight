// SoloRoom: a server-authoritative "Survive the Horde" game in one Durable
// Object. It wraps the pure session core (web/src/solo/session): players POST
// commands (each naming its character), the room applies them through the
// session, runs the monster AI, persists the player-command log, and broadcasts
// the new state to every connected viewer over SSE. The game is deterministic
// from (seed + command log), so a restart replays the log to recover.
//
// Isolated from the multiplayer GameTable — a separate DO class and routes
// (/api/solo/:id/{stream,commands}); the live table is untouched. This is the
// thin transport/persistence shell; all rules live in the pure session core.
import type {DurableObjectState} from './cf'
import {createSession, replay, sessionStep, type SoloCommand, type SoloSession} from '../web/src/solo/session'
import {projectController} from '../web/src/solo/projection'
import type {Action, SoloState} from '../web/src/solo/model'

const encoder = new TextEncoder()
const CMD_PREFIX = 'cmd:'
// Zero-padded so storage.list() (lexicographic) yields commands in apply order.
const CMD_KEY = (n: number): string => `${CMD_PREFIX}${String(n).padStart(12, '0')}`

// A phone controlling a character carries its actor id (it gets the per-character
// LOS-gated controller projection); the board display has none (omniscient view).
type Connection = {writer: WritableStreamDefaultWriter<Uint8Array>; actor: string | null}

// Actions a phone controller may issue. System/director actions (AddWave) are
// rejected at the transport before they reach the engine.
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

// The wire state for a viewer. `grid` is server-only (movement logic); the static
// `map` rides the snapshot once, and updates carry only the changing fields.
const forSnapshot = ({grid: _grid, ...rest}: SoloState): Omit<SoloState, 'grid'> => rest
const forUpdate = ({grid: _grid, map: _map, ...rest}: SoloState): Omit<SoloState, 'grid' | 'map'> => rest

export class SoloRoom {
  private session: SoloSession | null = null
  private readonly connections = new Map<string, Connection>()
  private readonly storage: DurableObjectState['storage']

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage
    // Durability: persist the seed + the player-command log; on restart replay
    // them (the AI is re-derived) so a Worker/DO eviction loses nothing.
    void state.blockConcurrencyWhile(async () => {
      const seed = await this.storage.get<number>('seed')
      if (seed === undefined) return
      const stored = await this.storage.list<SoloCommand>({prefix: CMD_PREFIX})
      this.session = replay(seed, [...stored.values()])
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/stream')) return this.openStream(request, url)
    if (url.pathname.endsWith('/commands')) return this.handleCommand(request)
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
    // A phone controlling a character passes ?actor=<id>; the board display
    // (TV/monitor) omits it and gets the omniscient view.
    const actor = url.searchParams.get('actor')
    const id = crypto.randomUUID().slice(0, 8)
    const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>()
    const connection: Connection = {writer: writable.getWriter(), actor}
    this.connections.set(id, connection)
    void this.send(id, this.snapshotFor(connection, session.state))
    request.signal.addEventListener('abort', () => {
      const connection = this.connections.get(id)
      this.connections.delete(id)
      if (connection) void connection.writer.close().catch(() => {})
    })
    return new Response(readable, {
      headers: {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'}
    })
  }

  private async handleCommand(request: Request): Promise<Response> {
    let body: SoloCommand
    try {
      body = (await request.json()) as SoloCommand
    } catch {
      return Response.json({error: 'Invalid JSON'}, {status: 400})
    }
    if (!this.session) return Response.json({error: 'No game in this room yet'}, {status: 409})
    if (!body || typeof body.byActor !== 'string' || !body.action || !PLAYER_ACTIONS.has(body.action.t)) {
      return Response.json({error: 'Invalid command'}, {status: 400})
    }
    const before = this.session.state
    const {session, aiActions} = sessionStep(this.session, body)
    this.session = session
    if (session.state === before) return Response.json({accepted: false}) // rejected: not your turn
    // Persist only the player command — the AI turns are re-derived on replay.
    void this.storage.put(CMD_KEY(session.log.length), body)
    this.broadcast(aiActions)
    return Response.json({accepted: true})
  }

  // The snapshot for a viewer: a phone controller gets its per-character,
  // LOS-gated projection (it renders no map); the board display gets the full
  // state including the map (sent once).
  private snapshotFor(connection: Connection, state: SoloState): unknown {
    return connection.actor
      ? {type: 'snapshot', view: 'controller', controller: projectController(state, connection.actor)}
      : {type: 'snapshot', view: 'board', state: forSnapshot(state)}
  }

  // The update after a command: controllers get their re-projected view; the
  // board gets the changed fields (no map) plus the AI actions for animation.
  private updateFor(connection: Connection, state: SoloState, aiActions: Action[]): unknown {
    return connection.actor
      ? {type: 'update', view: 'controller', controller: projectController(state, connection.actor)}
      : {type: 'update', view: 'board', state: forUpdate(state), aiActions}
  }

  private broadcast(aiActions: Action[]): void {
    if (!this.session) return
    const state = this.session.state
    for (const [id, connection] of this.connections) {
      void this.send(id, this.updateFor(connection, state, aiActions))
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
