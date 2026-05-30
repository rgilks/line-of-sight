// One Durable Object per table. Holds the event log + current state, applies
// commands (single-threaded, so ordering is free), and pushes a per-player
// fog-gated view over SSE. In-memory only for now — restart loses the table;
// persistence is a later phase (see docs/MULTIPLAYER.md).
import type {DurableObjectState} from './cf'
import {
  COUNTER_KINDS,
  visibleTokensFor,
  type Board,
  type Command,
  type CommandEnvelope,
  type CounterKind,
  type DomainEvent,
  type PlayerId,
  type Token,
  type ViewMessage
} from './protocol'

const encoder = new TextEncoder()

// Distributive Omit so it preserves the discriminated union (plain Omit would
// collapse DomainEvent's variants and drop their per-type fields).
type EventInput = DomainEvent extends infer E
  ? E extends DomainEvent
    ? Omit<E, 'seq'>
    : never
  : never

type Connection = {writer: WritableStreamDefaultWriter<Uint8Array>; gm: boolean}

// Default board: a central wall with a DOOR in the middle, so two players on
// opposite sides start blocked and opening the door reveals them — the whole
// system is demonstrable with no map uploaded. A GM publish replaces this.
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
  doorStates: {}
})

export class GameTable {
  private board: Board = seedBoard()
  private readonly tokens = new Map<PlayerId, Token>()
  private readonly connections = new Map<PlayerId, Connection>()
  private readonly log: DomainEvent[] = []
  private seq = 0

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/stream')) return this.openStream(request)
    if (url.pathname.endsWith('/commands')) return this.handleCommand(request)
    if (url.pathname.endsWith('/board')) return this.publishBoard(request)
    return new Response('Not found', {status: 404})
  }

  private append(event: EventInput): void {
    this.seq += 1
    this.log.push({...event, seq: this.seq} as DomainEvent)
  }

  private spawn(): {x: number; y: number} {
    const index = this.tokens.size
    // Alternate sides of the seed wall, aligned with the door's y so opening it
    // immediately reveals the player opposite.
    const x = index % 2 === 0 ? 250 : 750
    const y = 500 + Math.floor(index / 2) * 90
    return {x, y: Math.min(y, this.board.height - 80)}
  }

  // Pick a counter portrait for a joining player — distinct from those in use
  // while any remain free, then allow repeats.
  private pickKind(): CounterKind {
    const used = new Set([...this.tokens.values()].map((token) => token.kind))
    const free = COUNTER_KINDS.filter((kind) => !used.has(kind))
    const pool = free.length > 0 ? free : COUNTER_KINDS
    return pool[Math.floor(Math.random() * pool.length)]
  }

  // Tokens this connection may see: a GM sees all; a player is fog-gated.
  private tokensFor(playerId: PlayerId): Token[] {
    const all = [...this.tokens.values()]
    return this.connections.get(playerId)?.gm ? all : visibleTokensFor(playerId, all, this.board)
  }

  private openStream(request: Request): Response {
    const gm = new URL(request.url).searchParams.get('gm') === '1'
    const playerId = crypto.randomUUID().slice(0, 8)

    const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>()
    this.connections.set(playerId, {writer: writable.getWriter(), gm})

    // A GM is a spectator: no token, sees everything, manages doors.
    if (!gm) {
      const {x, y} = this.spawn()
      const label = `P${this.tokens.size + 1}`
      const kind = this.pickKind()
      this.tokens.set(playerId, {id: `token-${playerId}`, ownerId: playerId, label, kind, x, y})
      this.append({type: 'PlayerJoined', playerId, label, kind, x, y})
    }

    const snapshot: ViewMessage = {
      type: 'snapshot',
      you: playerId,
      board: this.board,
      tokens: this.tokensFor(playerId)
    }
    void this.send(playerId, snapshot)
    this.projectAll()

    request.signal.addEventListener('abort', () => void this.dropPlayer(playerId))

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      }
    })
  }

  private async handleCommand(request: Request): Promise<Response> {
    let envelope: CommandEnvelope
    try {
      envelope = (await request.json()) as CommandEnvelope
    } catch {
      return Response.json({error: 'Invalid JSON'}, {status: 400})
    }

    if (!this.connections.has(envelope.playerId)) {
      return Response.json({error: 'Unknown player'}, {status: 404})
    }

    const error = this.apply(envelope.playerId, envelope.command)
    if (error) return Response.json({error}, {status: 403})
    this.projectAll()
    return Response.json({accepted: true, seq: this.seq})
  }

  // Returns an error string if the command is not allowed for this player.
  private apply(playerId: PlayerId, command: Command): string | null {
    if (command.type === 'ToggleDoor') {
      this.board.doorStates = {...this.board.doorStates, [command.doorId]: {open: command.open}}
      this.append({type: 'DoorToggled', doorId: command.doorId, open: command.open})
      return null
    }

    const token = this.tokens.get(playerId)
    if (!token) return 'No token to act on'

    if (command.type === 'MoveToken') {
      token.x = clamp(command.x, 0, this.board.width)
      token.y = clamp(command.y, 0, this.board.height)
      this.append({type: 'TokenMoved', playerId, x: token.x, y: token.y})
      return null
    }
    if (command.type === 'SetName') {
      token.label = command.name.slice(0, 24)
      this.append({type: 'PlayerRenamed', playerId, label: token.label})
    }
    return null
  }

  // GM authoring: replace the board (new map assetRef + occluders) and push it
  // to everyone connected. No token/connection required — this is the publish
  // step from the single-player authoring tool.
  private async publishBoard(request: Request): Promise<Response> {
    let board: Board
    try {
      board = (await request.json()) as Board
    } catch {
      return Response.json({error: 'Invalid JSON'}, {status: 400})
    }
    if (!board || typeof board.width !== 'number' || !Array.isArray(board.occluders)) {
      return Response.json({error: 'Invalid board'}, {status: 400})
    }

    this.board = {...board, doorStates: board.doorStates ?? {}}
    this.append({type: 'BoardPublished', assetRef: board.assetRef})
    this.projectAll()
    return Response.json({ok: true, seq: this.seq})
  }

  private projectAll(): void {
    for (const playerId of this.connections.keys()) {
      const update: ViewMessage = {
        type: 'update',
        board: this.board,
        tokens: this.tokensFor(playerId)
      }
      void this.send(playerId, update)
    }
  }

  private async send(playerId: PlayerId, message: ViewMessage): Promise<void> {
    const connection = this.connections.get(playerId)
    if (!connection) return
    try {
      await connection.writer.write(encoder.encode(`data: ${JSON.stringify(message)}\n\n`))
    } catch {
      await this.dropPlayer(playerId)
    }
  }

  private async dropPlayer(playerId: PlayerId): Promise<void> {
    const connection = this.connections.get(playerId)
    this.connections.delete(playerId)
    if (this.tokens.delete(playerId)) {
      this.append({type: 'PlayerLeft', playerId})
    }
    if (connection) {
      try {
        await connection.writer.close()
      } catch {
        // already closed
      }
    }
    this.projectAll()
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))
