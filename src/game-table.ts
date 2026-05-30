// One Durable Object per table. Holds the event log + current state, applies
// commands (single-threaded, so ordering is free), and pushes a per-player
// fog-gated view over SSE. In-memory only for now — restart loses the table;
// persistence is a later phase (see docs/MULTIPLAYER.md).
import type {DurableObjectState} from './cf'
import {
  visibleTokensFor,
  type Board,
  type Command,
  type CommandEnvelope,
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

const seedBoard = (): Board => ({
  assetRef: 'composed-board',
  width: 1000,
  height: 1000,
  gridScale: 50,
  sightRadius: 700,
  // One central wall so two players on opposite sides genuinely can't see each
  // other — makes the server-authoritative fog observable with no map loaded.
  occluders: [{type: 'wall', id: 'seed-wall', x1: 500, y1: 100, x2: 500, y2: 900}],
  doorStates: {}
})

export class GameTable {
  private readonly board: Board = seedBoard()
  private readonly tokens = new Map<PlayerId, Token>()
  private readonly connections = new Map<PlayerId, WritableStreamDefaultWriter<Uint8Array>>()
  private readonly log: DomainEvent[] = []
  private seq = 0

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/stream')) return this.openStream(request)
    if (url.pathname.endsWith('/commands')) return this.handleCommand(request)
    return new Response('Not found', {status: 404})
  }

  private append(event: EventInput): void {
    this.seq += 1
    this.log.push({...event, seq: this.seq} as DomainEvent)
  }

  private spawn(): {x: number; y: number} {
    const index = this.tokens.size
    // Alternate sides of the seed wall so newcomers start with someone hidden.
    const x = index % 2 === 0 ? 250 : 750
    const y = 150 + Math.floor(index / 2) * 120
    return {x, y: Math.min(y, this.board.height - 100)}
  }

  private openStream(request: Request): Response {
    const playerId = crypto.randomUUID().slice(0, 8)
    const {x, y} = this.spawn()
    const label = `P${this.tokens.size + 1}`
    const token: Token = {id: `token-${playerId}`, ownerId: playerId, label, x, y}
    this.tokens.set(playerId, token)
    this.append({type: 'PlayerJoined', playerId, label, x, y})

    const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    this.connections.set(playerId, writer)

    const snapshot: ViewMessage = {
      type: 'snapshot',
      you: playerId,
      board: this.board,
      tokens: visibleTokensFor(playerId, [...this.tokens.values()], this.board)
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

    const token = this.tokens.get(envelope.playerId)
    if (!token) return Response.json({error: 'Unknown player'}, {status: 404})

    this.apply(envelope.playerId, token, envelope.command)
    this.projectAll()
    return Response.json({accepted: true, seq: this.seq})
  }

  private apply(playerId: PlayerId, token: Token, command: Command): void {
    if (command.type === 'MoveToken') {
      token.x = clamp(command.x, 0, this.board.width)
      token.y = clamp(command.y, 0, this.board.height)
      this.append({type: 'TokenMoved', playerId, x: token.x, y: token.y})
      return
    }
    if (command.type === 'SetName') {
      token.label = command.name.slice(0, 24)
      this.append({type: 'PlayerRenamed', playerId, label: token.label})
      return
    }
    if (command.type === 'ToggleDoor') {
      this.board.doorStates = {...this.board.doorStates, [command.doorId]: {open: command.open}}
      this.append({type: 'DoorToggled', doorId: command.doorId, open: command.open})
    }
  }

  private projectAll(): void {
    const all = [...this.tokens.values()]
    for (const playerId of this.connections.keys()) {
      const update: ViewMessage = {
        type: 'update',
        doorStates: this.board.doorStates,
        tokens: visibleTokensFor(playerId, all, this.board)
      }
      void this.send(playerId, update)
    }
  }

  private async send(playerId: PlayerId, message: ViewMessage): Promise<void> {
    const writer = this.connections.get(playerId)
    if (!writer) return
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(message)}\n\n`))
    } catch {
      await this.dropPlayer(playerId)
    }
  }

  private async dropPlayer(playerId: PlayerId): Promise<void> {
    const writer = this.connections.get(playerId)
    this.connections.delete(playerId)
    if (this.tokens.delete(playerId)) {
      this.append({type: 'PlayerLeft', playerId})
    }
    if (writer) {
      try {
        await writer.close()
      } catch {
        // already closed
      }
    }
    this.projectAll()
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))
