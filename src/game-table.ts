// One Durable Object per table. Holds the event log + current state, applies
// commands (single-threaded, so ordering is free), and pushes a per-player
// fog-gated view over SSE. In-memory only for now — restart loses the table;
// persistence is a later phase (see docs/MULTIPLAYER.md).
import type {DurableObjectState} from './cf'
import {
  canToggleDoorFrom,
  COUNTER_KINDS,
  hasLineOfSight,
  validateTokenMove,
  visibleTokensFor,
  type Board,
  type ChatSay,
  type Command,
  type CommandEnvelope,
  type CounterKind,
  type DomainEvent,
  type PlayerId,
  type Token,
  type ViewMessage
} from './protocol'

// How long a chat say stays attached for new/lagging viewers; the client fades
// each bubble out over its own (shorter) lifetime.
const SAY_TTL_MS = 8000
const SAY_MAX = 40

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
  doorStates: {},
  playerDoorControl: true,
  metersPerSquare: 1.5,
  defaultMoveMeters: 6
})

export class GameTable {
  private board: Board = seedBoard()
  private boardSeq = 0
  private readonly tokens = new Map<PlayerId, Token>()
  private readonly connections = new Map<PlayerId, Connection>()
  private readonly log: DomainEvent[] = []
  private says: ChatSay[] = []
  private seq = 0
  // Per-table salt so the spawn-point shuffle is stable within a table but
  // differs between tables. Derived once from the (random) DO id name.
  private readonly spawnSalt = Math.floor(Math.random() * 1e9)

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
    const points = this.board.spawnPoints
    if (points && points.length > 0) {
      // Generated decks supply room centers. Assign them in a seed-shuffled order
      // (stable per table) so successive joiners land in different rooms; wrap and
      // jitter within the cell once we exceed the room count.
      const order = shuffleIndices(points.length, this.spawnSalt)
      const point = points[order[index % points.length]]
      const jitter = index < points.length ? 0 : this.board.gridScale * 0.4
      const jx = jitter === 0 ? 0 : (hashFloat(this.spawnSalt + index * 2) - 0.5) * 2 * jitter
      const jy = jitter === 0 ? 0 : (hashFloat(this.spawnSalt + index * 2 + 1) - 0.5) * 2 * jitter
      return {
        x: clamp(point.x + jx, 0, this.board.width),
        y: clamp(point.y + jy, 0, this.board.height)
      }
    }
    // Legacy seed board: alternate sides of the central wall, aligned with the
    // door's y so opening it immediately reveals the player opposite.
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

  // Board this connection may see. Room labels are GM-only knowledge, so they are
  // stripped for players at the server — never sent over the wire, not merely
  // hidden client-side.
  private boardFor(playerId: PlayerId): Board {
    if (this.connections.get(playerId)?.gm) return this.board
    const {rooms: _rooms, ...playerBoard} = this.board
    return playerBoard
  }

  private pruneSays(): void {
    const cutoff = Date.now() - SAY_TTL_MS
    this.says = this.says.filter((say) => say.sentAt >= cutoff)
    if (this.says.length > SAY_MAX) this.says = this.says.slice(-SAY_MAX)
  }

  // Chat says this connection may see: the GM and GM-authored says reach everyone;
  // a player's say reaches another player only if that recipient can currently see
  // the speaker's token (same line-of-sight gate as tokens, so a bubble never
  // leaks a hidden position).
  private saysFor(playerId: PlayerId): ChatSay[] {
    this.pruneSays()
    const gm = this.connections.get(playerId)?.gm === true
    if (gm) return this.says
    const viewer = this.tokens.get(playerId)
    return this.says.filter((say) => {
      if (say.fromGm) return true
      if (say.fromId === playerId) return true
      if (!viewer) return false
      const speaker = this.tokens.get(say.fromId)
      const at = speaker ? {x: speaker.x, y: speaker.y} : say.at
      if (Math.hypot(at.x - viewer.x, at.y - viewer.y) > this.board.sightRadius) return false
      return hasLineOfSight({x: viewer.x, y: viewer.y}, at, this.board.occluders, this.board.doorStates)
    })
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
      board: this.boardFor(playerId),
      tokens: this.tokensFor(playerId),
      says: this.saysFor(playerId)
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
    const connection = this.connections.get(playerId)

    if (command.type === 'SetPlayerDoorControl') {
      if (!connection?.gm) return 'GM only'
      this.board = {...this.board, playerDoorControl: command.enabled}
      this.append({type: 'PlayerDoorControlSet', enabled: command.enabled})
      return null
    }

    if (command.type === 'SetTokenMoveMeters') {
      if (!connection?.gm) return 'GM only'
      const target = this.tokens.get(command.playerId)
      if (!target) return 'Unknown player'
      const moveMeters = Math.max(0, Math.min(999, Math.round(command.moveMeters)))
      target.moveMeters = moveMeters
      this.append({type: 'TokenMoveMetersSet', playerId: command.playerId, moveMeters})
      return null
    }

    if (command.type === 'Say') {
      const text = command.text.trim().slice(0, 200)
      if (!text) return null
      const speaker = this.tokens.get(playerId)
      const gm = connection?.gm === true
      // A player without a token and not the GM can't speak (shouldn't happen).
      if (!speaker && !gm) return 'No token to speak from'
      this.says.push({
        id: `say-${playerId}-${this.seq + 1}`,
        fromId: playerId,
        label: gm ? 'GM' : (speaker?.label ?? '?'),
        text,
        at: speaker ? {x: speaker.x, y: speaker.y} : {x: 0, y: 0},
        fromGm: gm,
        sentAt: Date.now()
      })
      this.pruneSays()
      this.seq += 1 // says aren't domain events, but bump seq so clients see a change
      return null
    }

    if (command.type === 'ToggleDoor') {
      if (this.board.playerDoorControl === false && !connection?.gm) {
        return 'Doors are locked — GM only'
      }
      const door = this.board.occluders.find(
        (occluder) => occluder.type === 'door' && occluder.id === command.doorId
      )
      if (!door) return 'Unknown door'
      const actor = this.tokens.get(playerId) ?? null
      if (!canToggleDoorFrom(actor, this.board, door, {gm: connection?.gm})) {
        return 'Move next to the door to open it'
      }
      this.board.doorStates = {...this.board.doorStates, [command.doorId]: {open: command.open}}
      this.append({type: 'DoorToggled', doorId: command.doorId, open: command.open})
      return null
    }

    const token = this.tokens.get(playerId)
    if (!token) return 'No token to act on'

    if (command.type === 'MoveToken') {
      const destination = {x: command.x, y: command.y}
      const moveCheck = validateTokenMove(token, this.board, destination, {gm: connection?.gm})
      if (!moveCheck.ok) return moveCheck.reason
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

    this.boardSeq += 1
    this.board = {
      ...board,
      boardSeq: this.boardSeq,
      doorStates: board.doorStates ?? {},
      playerDoorControl: board.playerDoorControl ?? true,
      metersPerSquare: board.metersPerSquare ?? 1.5,
      defaultMoveMeters: board.defaultMoveMeters ?? 6
    }
    this.append({type: 'BoardPublished', assetRef: board.assetRef})
    this.projectAll()
    return Response.json({ok: true, seq: this.seq})
  }

  private projectAll(): void {
    for (const playerId of this.connections.keys()) {
      const update: ViewMessage = {
        type: 'update',
        board: this.boardFor(playerId),
        tokens: this.tokensFor(playerId),
        says: this.saysFor(playerId)
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

// Deterministic [0,1) hash for seeded jitter — keeps spawns reproducible per
// table without pulling in a PRNG dependency.
const hashFloat = (n: number): number => {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// A seed-stable shuffle of [0..count) via sort by hash — small n, so simplicity
// over Fisher-Yates. Same (count, salt) ⇒ same order.
const shuffleIndices = (count: number, salt: number): number[] =>
  Array.from({length: count}, (_, i) => i).sort(
    (a, b) => hashFloat(salt + a * 7.13) - hashFloat(salt + b * 7.13)
  )
