// One Durable Object per table. Holds the event log + current state, applies
// commands (single-threaded, so ordering is free), and pushes a per-player
// fog-gated view over SSE. In-memory only for now — restart loses the table;
// persistence is a later phase (see docs/MULTIPLAYER.md).
//
// The game logic is a functional core (the pure section below): `decide` turns a
// command into events (or an error), `fold` applies one event to the canonical
// state, and `projectFor` renders the per-viewer fog-gated view. The GameTable
// class is the thin imperative shell — connections, SSE writers, the seq counter,
// and the canonical state — wiring those pure functions to I/O.
import type {DurableObjectState} from './cf'
import {
  activeCombatant,
  canToggleDoorFrom,
  COUNTER_KINDS,
  combatReady,
  hasLineOfSight,
  orderCombatantsByInitiative,
  validateTokenMove,
  visibleTokensFor,
  type Board,
  type Combatant,
  type CombatState,
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
const STREAM_HEARTBEAT_MS = 25000
const STREAM_HEARTBEAT = encoder.encode(': keepalive\n\n')
const OWNER_KEY_HASH = 'auth:owner-key-hash'
const GM_KEY_HEADER = 'x-los-gm-key'
const AUTH_TOKEN_BYTES = 24
const COMMAND_RATE = {limit: 80, windowMs: 10_000}
const BOARD_PUBLISH_RATE = {limit: 12, windowMs: 60_000}
const MAP_UPLOAD_RATE = {limit: 8, windowMs: 60_000}
const MAP_READ_RATE = {limit: 180, windowMs: 60_000}

// A DomainEvent minus its seq — what `decide` emits, before the shell assigns
// the monotonic seq. Distributive over the union so it preserves each variant's
// per-type fields (a plain Omit would collapse them).
export type EventInput = DomainEvent extends infer E ? (E extends DomainEvent ? Omit<E, 'seq'> : never) : never

type Connection = {
  writer: WritableStreamDefaultWriter<Uint8Array>
  gm: boolean
  authToken: string
  heartbeat: ReturnType<typeof setInterval>
}

type RateLimit = {limit: number; windowMs: number}
type RateBucket = {count: number; resetAt: number}

// ── Functional core ───────────────────────────────────────────────────────────
//
// All pure: no I/O, no DO references, no wall clock or RNG of their own. The
// canonical state is a plain value the shell folds events into; the projection is
// a pure function of that value + who is looking. Tested directly in
// game-table.test.ts.

// The canonical, projectable game state. Tokens are keyed by owner playerId, as
// the shell holds them.
export type TableState = {
  board: Board
  tokens: Map<PlayerId, Token>
  says: ChatSay[]
  combat: CombatState | null
}

// Who is acting / looking. The gm flag mirrors the connection's gm bit; the DO
// supplies it from the connection.
export type Actor = {playerId: PlayerId; gm: boolean}

// Non-deterministic inputs a command may need, injected so `decide` stays pure.
// `now` stamps chat says; `rollD6` rolls initiative.
export type DecideContext = {now: number; rollD6: () => number}

// Result of deciding a command: the events to fold, or a permission/validation
// error string (same strings the old `apply` returned).
export type DecideResult = {events: EventInput[]} | {error: string}

// The per-viewer read model, minus transport framing. `projectFor` returns this;
// the shell adds `type`/`you` to make a ViewMessage. Mirrors ViewMessage's body.
export type Projection = {
  board: Board
  tokens: Token[]
  says: ChatSay[]
  combat: CombatState | null
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

// Drop says older than the TTL, then cap to the most recent SAY_MAX. Pure: takes
// `now` rather than reading the clock.
const prunedSays = (says: ChatSay[], now: number): ChatSay[] => {
  const cutoff = now - SAY_TTL_MS
  const live = says.filter((say) => say.sentAt >= cutoff)
  return live.length > SAY_MAX ? live.slice(-SAY_MAX) : live
}

// Tokens this viewer may see: a GM sees all; a player is fog-gated by line of
// sight. This is the security boundary — see docs/MULTIPLAYER.md.
const projectTokens = (state: TableState, viewer: Actor): Token[] => {
  const all = [...state.tokens.values()]
  return viewer.gm ? all : visibleTokensFor(viewer.playerId, all, state.board)
}

// Board this viewer may see. Room labels are GM-only knowledge, so they are
// stripped for players at the server — never sent over the wire, not merely
// hidden client-side.
const projectBoard = (state: TableState, viewer: Actor): Board => {
  if (viewer.gm) return state.board
  const {rooms: _rooms, ...playerBoard} = state.board
  return playerBoard
}

const projectCombat = (state: TableState, viewer: Actor): CombatState | null => {
  if (!state.combat) return null
  if (viewer.gm) return state.combat

  const visiblePlayerIds = new Set(projectTokens(state, viewer).map((token) => token.ownerId))
  const combatants = state.combat.combatants.filter((combatant) => visiblePlayerIds.has(combatant.playerId))
  const active = activeCombatant(state.combat)
  const turnIndex = active ? combatants.findIndex((combatant) => combatant.playerId === active.playerId) : null
  return {
    ...state.combat,
    combatants,
    turnIndex: turnIndex != null && turnIndex >= 0 ? turnIndex : null
  }
}

// Chat says this viewer may see: the GM and GM-authored says reach everyone; a
// player's say reaches another player only if that recipient can currently see
// the speaker's token (same line-of-sight gate as tokens, so a bubble never leaks
// a hidden position). Prunes by `now` first, like the wire always did.
const projectSays = (state: TableState, viewer: Actor, now: number): ChatSay[] => {
  const says = prunedSays(state.says, now)
  if (viewer.gm) return says
  const self = state.tokens.get(viewer.playerId)
  return says.filter((say) => {
    if (say.fromGm) return true
    if (say.fromId === viewer.playerId) return true
    if (!self) return false
    const speaker = state.tokens.get(say.fromId)
    const at = speaker ? {x: speaker.x, y: speaker.y} : say.at
    if (Math.hypot(at.x - self.x, at.y - self.y) > state.board.sightRadius) return false
    return hasLineOfSight({x: self.x, y: self.y}, at, state.board.occluders, state.board.doorStates)
  })
}

// The whole per-viewer read model, fog-gated. The `snapshot` vs `update` framing
// and the `you` field are added by the shell.
export const projectFor = (state: TableState, viewer: Actor, now: number): Projection => ({
  board: projectBoard(state, viewer),
  tokens: projectTokens(state, viewer),
  says: projectSays(state, viewer, now),
  combat: projectCombat(state, viewer)
})

// Validate and authorize one command, returning the events to fold or an error.
// Mirrors the old `apply` exactly: same permission checks, same emitted events.
// Pure — randomness and the clock arrive via `ctx`.
export const decide = (state: TableState, actor: Actor, command: Command, ctx: DecideContext): DecideResult => {
  const {board, combat} = state

  if (command.type === 'SetPlayerDoorControl') {
    if (!actor.gm) return {error: 'GM only'}
    return {events: [{type: 'PlayerDoorControlSet', enabled: command.enabled}]}
  }

  if (command.type === 'SetTokenMoveMeters') {
    if (!actor.gm) return {error: 'GM only'}
    const target = state.tokens.get(command.playerId)
    if (!target) return {error: 'Unknown player'}
    const moveMeters = Math.max(0, Math.min(999, Math.round(command.moveMeters)))
    return {events: [{type: 'TokenMoveMetersSet', playerId: command.playerId, moveMeters}]}
  }

  if (command.type === 'Say') {
    const text = command.text.trim().slice(0, 200)
    if (!text) return {events: []}
    const speaker = state.tokens.get(actor.playerId)
    // A player without a token and not the GM can't speak (shouldn't happen).
    if (!speaker && !actor.gm) return {error: 'No token to speak from'}
    return {
      events: [
        {
          type: 'Said',
          fromId: actor.playerId,
          label: actor.gm ? 'GM' : (speaker?.label ?? '?'),
          text,
          at: speaker ? {x: speaker.x, y: speaker.y} : {x: 0, y: 0},
          fromGm: actor.gm,
          sentAt: ctx.now
        }
      ]
    }
  }

  if (command.type === 'StartCombat') {
    if (!actor.gm) return {error: 'GM only'}
    if (combat) return {error: 'Combat is already running'}
    const combatants = [...state.tokens.values()].map(
      (token, order): Combatant => ({
        playerId: token.ownerId,
        tokenId: token.id,
        label: token.label,
        order,
        dexterityDm: 0,
        dice: null,
        initiative: null
      })
    )
    if (combatants.length === 0) return {error: 'No counters to put into combat'}
    return {events: [{type: 'CombatStarted', playerIds: combatants.map((combatant) => combatant.playerId)}]}
  }

  if (command.type === 'RollInitiative') {
    if (!combat) return {error: 'Combat has not started'}
    const combatant = combat.combatants.find((entry) => entry.playerId === actor.playerId)
    if (!combatant) return {error: 'You are not in this combat'}
    if (combatant.initiative != null) return {error: 'Initiative already rolled'}
    const dice: [number, number] = [ctx.rollD6(), ctx.rollD6()]
    const initiative = dice[0] + dice[1] + combatant.dexterityDm
    return {
      events: [
        {type: 'InitiativeRolled', playerId: actor.playerId, dice, dexterityDm: combatant.dexterityDm, initiative}
      ]
    }
  }

  if (command.type === 'AdvanceTurn') {
    if (!combat) return {error: 'Combat has not started'}
    if (!combatReady(combat)) return {error: 'Waiting for initiative rolls'}
    const current = activeCombatant(combat)
    if (!actor.gm && current?.playerId !== actor.playerId) {
      return {error: 'Only the current combatant can end their turn'}
    }
    const nextIndex = (combat.turnIndex + 1) % combat.combatants.length
    const nextRound = nextIndex === 0 ? combat.round + 1 : combat.round
    return {events: [{type: 'TurnAdvanced', round: nextRound, turnIndex: nextIndex}]}
  }

  if (command.type === 'EndCombat') {
    if (!actor.gm) return {error: 'GM only'}
    if (!combat) return {events: []}
    return {events: [{type: 'CombatEnded'}]}
  }

  if (command.type === 'ToggleDoor') {
    if (board.playerDoorControl === false && !actor.gm) {
      return {error: 'Doors are locked — GM only'}
    }
    const door = board.occluders.find((occluder) => occluder.type === 'door' && occluder.id === command.doorId)
    if (!door) return {error: 'Unknown door'}
    const token = state.tokens.get(actor.playerId) ?? null
    if (!canToggleDoorFrom(token, board, door, {gm: actor.gm})) {
      return {error: 'Move next to the door to open it'}
    }
    return {events: [{type: 'DoorToggled', doorId: command.doorId, open: command.open}]}
  }

  const token = state.tokens.get(actor.playerId)
  if (!token) return {error: 'No token to act on'}

  if (command.type === 'MoveToken') {
    if (combat) {
      if (!combatReady(combat)) return {error: 'Roll initiative before moving'}
      if (activeCombatant(combat)?.playerId !== actor.playerId) {
        return {error: 'Only the current combatant can move'}
      }
    }
    const destination = {x: command.x, y: command.y}
    const moveCheck = validateTokenMove(token, board, destination, {gm: actor.gm})
    if (!moveCheck.ok) return {error: moveCheck.reason}
    const x = clamp(command.x, 0, board.width)
    const y = clamp(command.y, 0, board.height)
    return {events: [{type: 'TokenMoved', playerId: actor.playerId, x, y}]}
  }

  if (command.type === 'SetName') {
    return {events: [{type: 'PlayerRenamed', playerId: actor.playerId, label: command.name.slice(0, 24)}]}
  }

  return {events: []}
}

const combatAfterPlayerLeft = (combat: CombatState | null, playerId: PlayerId): CombatState | null => {
  if (!combat) return null
  const removedIndex = combat.combatants.findIndex((combatant) => combatant.playerId === playerId)
  if (removedIndex < 0) return combat

  let combatants = combat.combatants.filter((combatant) => combatant.playerId !== playerId)
  if (combatants.length === 0) return null

  let turnIndex = combat.turnIndex
  if (turnIndex != null) {
    if (removedIndex < turnIndex) turnIndex -= 1
    else if (removedIndex === turnIndex && turnIndex >= combatants.length) turnIndex = 0
  }
  if (turnIndex == null && combatants.every((combatant) => combatant.initiative != null)) {
    combatants = orderCombatantsByInitiative(combatants)
    turnIndex = 0
  }
  return {...combat, combatants, turnIndex}
}

// Apply one event to the canonical state, returning the next state. Pure and
// total: an event decided against this state always folds. Mutates the passed
// state in place (the shell owns a single canonical value) but never the inputs
// to `decide`/`projectFor`.
export const fold = (state: TableState, event: DomainEvent): TableState => {
  switch (event.type) {
    case 'PlayerJoined':
      state.tokens.set(event.playerId, {
        id: `token-${event.playerId}`,
        ownerId: event.playerId,
        label: event.label,
        kind: event.kind,
        x: event.x,
        y: event.y
      })
      return state
    case 'PlayerLeft':
      state.tokens.delete(event.playerId)
      state.combat = combatAfterPlayerLeft(state.combat, event.playerId)
      return state
    case 'PlayerRenamed': {
      const token = state.tokens.get(event.playerId)
      if (token) token.label = event.label
      return state
    }
    case 'TokenMoved': {
      const token = state.tokens.get(event.playerId)
      if (token) {
        token.x = event.x
        token.y = event.y
      }
      return state
    }
    case 'TokenMoveMetersSet': {
      const token = state.tokens.get(event.playerId)
      if (token) token.moveMeters = event.moveMeters
      return state
    }
    case 'DoorToggled':
      state.board = {
        ...state.board,
        doorStates: {...state.board.doorStates, [event.doorId]: {open: event.open}}
      }
      return state
    case 'PlayerDoorControlSet':
      state.board = {...state.board, playerDoorControl: event.enabled}
      return state
    case 'BoardPublished':
      // The event carries the whole normalized board, so the fold is the single
      // place the board swaps in — for both the live publish path and a replay
      // rebuilding from the log. State after this fold holds the published board.
      state.board = event.board
      return state
    case 'Said':
      state.says = prunedSays(
        [
          ...state.says,
          {
            id: `say-${event.fromId}-${event.seq}`,
            fromId: event.fromId,
            label: event.label,
            text: event.text,
            at: event.at,
            fromGm: event.fromGm,
            sentAt: event.sentAt
          }
        ],
        event.sentAt
      )
      return state
    case 'CombatStarted':
      state.combat = {
        round: 1,
        turnIndex: null,
        combatants: [...state.tokens.values()].map(
          (token, order): Combatant => ({
            playerId: token.ownerId,
            tokenId: token.id,
            label: token.label,
            order,
            dexterityDm: 0,
            dice: null,
            initiative: null
          })
        )
      }
      return state
    case 'InitiativeRolled': {
      if (!state.combat) return state
      const combatants = state.combat.combatants.map((entry) =>
        entry.playerId === event.playerId ? {...entry, dice: event.dice, initiative: event.initiative} : entry
      )
      const ready = combatants.every((entry) => entry.initiative != null)
      state.combat = {
        round: state.combat.round,
        turnIndex: ready ? 0 : null,
        combatants: ready ? orderCombatantsByInitiative(combatants) : combatants
      }
      return state
    }
    case 'TurnAdvanced':
      if (state.combat) state.combat = {...state.combat, round: event.round, turnIndex: event.turnIndex}
      return state
    case 'CombatEnded':
      state.combat = null
      return state
  }
}

// Default board: a central wall with a DOOR in the middle, so two players on
// opposite sides start blocked and opening the door reveals them — the whole
// system is demonstrable with no map uploaded. A GM publish replaces this.
export const seedBoard = (): Board => ({
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

// A fresh canonical state on the seed board — the starting value every replay
// and every live table folds onto.
const seedState = (): TableState => ({
  board: seedBoard(),
  tokens: new Map<PlayerId, Token>(),
  says: [],
  combat: null
})

// Rebuild the canonical state from an ordered event log by folding from the seed.
// Pure and the inverse of `commit`'s logging: feeding the full log back through
// `replay` yields the same TableState the live shell held. This is the whole
// persistence story for the prototype — no snapshots, just full-log replay (see
// the constructor for the compaction note).
export const replay = (events: DomainEvent[]): TableState => {
  const state = seedState()
  for (const event of events) fold(state, event)
  return state
}

// boardSeq isn't stored on its own — it's derived from the last published board
// in the log, so a replay restores it for free. Defaults to 0 (seed board, never
// published).
const boardSeqFromLog = (events: DomainEvent[]): number => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'BoardPublished') return event.board.boardSeq ?? 0
  }
  return 0
}

// ── Imperative shell ──────────────────────────────────────────────────────────

// Event-log storage keys are `evt:` + the seq zero-padded to a fixed width, so
// DO storage `list()` (lexicographic key order) returns them already in seq
// order. 12 digits covers any seq a table will reach.
const EVT_PREFIX = 'evt:'
const EVT_KEY = (seq: number): string => EVT_PREFIX + String(seq).padStart(12, '0')

export class GameTable {
  // The canonical, projectable game state — the value the functional core folds
  // events into and projects from. Starts on the seed board; the constructor
  // replays any persisted log over it before the first request is served.
  private readonly state: TableState = seedState()
  private boardSeq = 0
  private readonly connections = new Map<PlayerId, Connection>()
  private readonly log: DomainEvent[] = []
  private seq = 0
  private ownerKeyHash: string | null = null
  private readonly rateBuckets = new Map<string, RateBucket>()
  // Per-table salt so the spawn-point shuffle is stable within a table but
  // differs between tables. Derived once from the (random) DO id name.
  private readonly spawnSalt = Math.floor(Math.random() * 1e9)
  private readonly storage: DurableObjectState['storage']

  constructor(state: DurableObjectState, _env: unknown) {
    this.storage = state.storage
    // Durability: the event log lives in DO storage; on construction we load it
    // and rebuild TableState by replaying it over the seed (the same fold the
    // live path uses), so a Worker/DO eviction or restart loses nothing.
    //
    // The constructor can't be async, and the DO must not serve a fetch before
    // state is rebuilt — `blockConcurrencyWhile` runs this async load to
    // completion and holds every incoming request until it resolves, so by the
    // time `fetch` runs the in-memory log, state, seq, and boardSeq are restored.
    void state.blockConcurrencyWhile(async () => {
      this.ownerKeyHash = (await this.storage.get<string>(OWNER_KEY_HASH)) ?? null
      const stored = await this.storage.list<DomainEvent>({prefix: EVT_PREFIX})
      // list() yields keys in lexicographic order; the zero-padded EVT_KEY makes
      // that seq order, so the values replay in the order they were committed.
      const events = [...stored.values()]
      for (const event of events) {
        this.log.push(event)
        fold(this.state, event)
      }
      this.seq = events.length > 0 ? events[events.length - 1].seq : 0
      this.boardSeq = boardSeqFromLog(events)
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/stream')) return this.openStream(request)
    if (url.pathname.endsWith('/commands')) return this.handleCommand(request)
    if (url.pathname.endsWith('/board')) return this.publishBoard(request)
    if (url.pathname.endsWith('/auth')) return this.handleAuth(request)
    return new Response('Not found', {status: 404})
  }

  // Assign and log an event, then fold it into the canonical state. Returns the
  // logged event (with its seq) so callers that need the seq (chat say id) can use
  // it. Single I/O point for advancing state.
  //
  // The persist is fire-and-forget by design: the in-memory log + state are the
  // source of truth a live table reads, and DO storage writes are durable on the
  // same single-threaded actor — we don't await it on the command's critical
  // path. Compaction is intentionally omitted for the prototype: we keep the full
  // log and replay all of it on restart. A later phase can snapshot TableState
  // and truncate `evt:` keys below the snapshot seq; nothing here forecloses that.
  private commit(event: EventInput): DomainEvent {
    this.seq += 1
    const logged = {...event, seq: this.seq} as DomainEvent
    this.log.push(logged)
    fold(this.state, logged)
    void this.storage.put(EVT_KEY(logged.seq), logged)
    return logged
  }

  // The actor for a connection: its playerId + gm bit. The pure core reads only
  // these from a connection.
  private actor(playerId: PlayerId): Actor {
    return {playerId, gm: this.connections.get(playerId)?.gm === true}
  }

  private rateLimit(subject: string, limit: RateLimit): Response | null {
    const now = Date.now()
    const bucket = this.rateBuckets.get(subject)
    if (!bucket || bucket.resetAt <= now) {
      this.rateBuckets.set(subject, {count: 1, resetAt: now + limit.windowMs})
      return null
    }
    bucket.count += 1
    if (bucket.count <= limit.limit) return null
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    return Response.json({error: 'Rate limit exceeded'}, {status: 429, headers: {'retry-after': String(retryAfter)}})
  }

  private ownerKeyFromRequest(request: Request): string {
    const url = new URL(request.url)
    return request.headers.get(GM_KEY_HEADER) ?? url.searchParams.get('gmKey') ?? ''
  }

  private async requireOwner(request: Request, claim: boolean): Promise<Response | null> {
    const key = this.ownerKeyFromRequest(request)
    if (!isCredential(key)) return Response.json({error: 'GM key required'}, {status: 403})

    const keyHash = await hashSecret(key)
    const storedHash = this.ownerKeyHash ?? (await this.storage.get<string>(OWNER_KEY_HASH)) ?? null
    if (!storedHash) {
      if (!claim) return Response.json({error: 'Unknown table owner'}, {status: 403})
      this.ownerKeyHash = keyHash
      await this.storage.put(OWNER_KEY_HASH, keyHash)
      return null
    }

    this.ownerKeyHash = storedHash
    if (!constantTimeEqual(storedHash, keyHash)) {
      return Response.json({error: 'Invalid GM key'}, {status: 403})
    }
    return null
  }

  private authenticateConnection(playerId: PlayerId, authToken: string): boolean {
    const connection = this.connections.get(playerId)
    return !!connection && isCredential(authToken) && constantTimeEqual(connection.authToken, authToken)
  }

  private async handleAuth(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const purpose = url.searchParams.get('purpose')

    if (purpose === 'map-upload') {
      const ownerError = await this.requireOwner(request, true)
      if (ownerError) return ownerError
      const rateError = this.rateLimit(`map-upload:${this.ownerKeyHash ?? 'owner'}`, MAP_UPLOAD_RATE)
      if (rateError) return rateError
      return Response.json({ok: true})
    }

    if (purpose === 'map-read') {
      if (this.ownerKeyFromRequest(request)) {
        const ownerError = await this.requireOwner(request, false)
        if (ownerError) return ownerError
        const rateError = this.rateLimit(`map-read:gm:${this.ownerKeyHash ?? 'owner'}`, MAP_READ_RATE)
        if (rateError) return rateError
        return Response.json({ok: true})
      }

      const playerId = url.searchParams.get('playerId') ?? ''
      const authToken = url.searchParams.get('authToken') ?? ''
      if (!this.authenticateConnection(playerId, authToken)) {
        return Response.json({error: 'Map access requires a live table session'}, {status: 403})
      }
      const rateError = this.rateLimit(`map-read:${playerId}`, MAP_READ_RATE)
      if (rateError) return rateError
      return Response.json({ok: true})
    }

    return Response.json({error: 'Unknown auth purpose'}, {status: 400})
  }

  private spawn(): {x: number; y: number} {
    const board = this.state.board
    const index = this.state.tokens.size
    const points = board.spawnPoints
    if (points && points.length > 0) {
      // Generated decks supply room centers. Assign them in a seed-shuffled order
      // (stable per table) so successive joiners land in different rooms; wrap and
      // jitter within the cell once we exceed the room count.
      const order = shuffleIndices(points.length, this.spawnSalt)
      const point = points[order[index % points.length]]
      const jitter = index < points.length ? 0 : board.gridScale * 0.4
      const jx = jitter === 0 ? 0 : (hashFloat(this.spawnSalt + index * 2) - 0.5) * 2 * jitter
      const jy = jitter === 0 ? 0 : (hashFloat(this.spawnSalt + index * 2 + 1) - 0.5) * 2 * jitter
      return {
        x: clamp(point.x + jx, 0, board.width),
        y: clamp(point.y + jy, 0, board.height)
      }
    }
    // Legacy seed board: alternate sides of the central wall, aligned with the
    // door's y so opening it immediately reveals the player opposite.
    const x = index % 2 === 0 ? 250 : 750
    const y = 500 + Math.floor(index / 2) * 90
    return {x, y: Math.min(y, board.height - 80)}
  }

  // Pick a counter portrait for a joining player — distinct from those in use
  // while any remain free, then allow repeats.
  private pickKind(): CounterKind {
    const used = new Set([...this.state.tokens.values()].map((token) => token.kind))
    const free = COUNTER_KINDS.filter((kind) => !used.has(kind))
    const pool = free.length > 0 ? free : COUNTER_KINDS
    return pool[Math.floor(Math.random() * pool.length)]
  }

  private async openStream(request: Request): Promise<Response> {
    const gm = new URL(request.url).searchParams.get('gm') === '1'
    if (gm) {
      const ownerError = await this.requireOwner(request, true)
      if (ownerError) return ownerError
    }
    const playerId = crypto.randomUUID().slice(0, 8)
    const authToken = randomSecret()

    const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>()
    const heartbeat = setInterval(() => void this.write(playerId, STREAM_HEARTBEAT), STREAM_HEARTBEAT_MS)
    this.connections.set(playerId, {writer: writable.getWriter(), gm, authToken, heartbeat})

    // A GM is a spectator: no token, sees everything, manages doors.
    if (!gm) {
      const {x, y} = this.spawn()
      const label = `P${this.state.tokens.size + 1}`
      const kind = this.pickKind()
      this.commit({type: 'PlayerJoined', playerId, label, kind, x, y})
    }

    const view = projectFor(this.state, this.actor(playerId), Date.now())
    const snapshot: ViewMessage = {type: 'snapshot', you: playerId, authToken, ...view}
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
    if (!this.authenticateConnection(envelope.playerId, envelope.authToken)) {
      return Response.json({error: 'Invalid session token'}, {status: 403})
    }
    const rateError = this.rateLimit(`command:${envelope.playerId}`, COMMAND_RATE)
    if (rateError) return rateError

    const parseError = validateCommand(envelope.command)
    if (parseError) return Response.json({error: parseError}, {status: 400})

    const result = decide(this.state, this.actor(envelope.playerId), envelope.command, {
      now: Date.now(),
      rollD6
    })
    if ('error' in result) return Response.json({error: result.error}, {status: 403})
    for (const event of result.events) this.commit(event)
    this.projectAll()
    return Response.json({accepted: true, seq: this.seq})
  }

  // GM authoring: replace the board (new map assetRef + occluders) and push it
  // to everyone connected. Requires the per-table owner key; the editor and host
  // mint and retain that key locally.
  private async publishBoard(request: Request): Promise<Response> {
    const ownerError = await this.requireOwner(request, true)
    if (ownerError) {
      await discardRequestBody(request)
      return ownerError
    }
    const rateError = this.rateLimit(`board:${this.ownerKeyHash ?? 'owner'}`, BOARD_PUBLISH_RATE)
    if (rateError) {
      await discardRequestBody(request)
      return rateError
    }

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
    // Normalize the incoming board, stamp its boardSeq, and carry the whole value
    // in the event — `commit`'s fold swaps it into state and persists it, so the
    // published board survives a restart instead of living only in memory.
    const normalized: Board = {
      ...board,
      boardSeq: this.boardSeq,
      doorStates: board.doorStates ?? {},
      playerDoorControl: board.playerDoorControl ?? true,
      metersPerSquare: board.metersPerSquare ?? 1.5,
      defaultMoveMeters: board.defaultMoveMeters ?? 6
    }
    this.commit({type: 'BoardPublished', board: normalized})
    this.projectAll()
    return Response.json({ok: true, seq: this.seq})
  }

  private projectAll(): void {
    const now = Date.now()
    for (const playerId of this.connections.keys()) {
      const view = projectFor(this.state, this.actor(playerId), now)
      void this.send(playerId, {type: 'update', ...view})
    }
  }

  private async send(playerId: PlayerId, message: ViewMessage): Promise<void> {
    await this.write(playerId, encoder.encode(`data: ${JSON.stringify(message)}\n\n`))
  }

  private async write(playerId: PlayerId, payload: Uint8Array): Promise<void> {
    const connection = this.connections.get(playerId)
    if (!connection) return
    try {
      await connection.writer.write(payload)
    } catch {
      await this.dropPlayer(playerId)
    }
  }

  private async dropPlayer(playerId: PlayerId): Promise<void> {
    const connection = this.connections.get(playerId)
    this.connections.delete(playerId)
    if (connection) clearInterval(connection.heartbeat)
    if (this.state.tokens.has(playerId)) {
      this.commit({type: 'PlayerLeft', playerId})
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

// Edge guards on command inputs at the I/O boundary, before `decide`. Returns an
// error string for a malformed command, or null for a structurally valid one.
// The valid path is untouched — these only reject garbage (e.g. non-finite move
// coordinates) with a clear message instead of letting it through.
const validateCommand = (command: Command): string | null => {
  if (!command || typeof command.type !== 'string') return 'Invalid command'
  if (command.type === 'MoveToken') {
    if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
      return 'MoveToken requires finite x/y'
    }
  }
  if (command.type === 'SetTokenMoveMeters' && !Number.isFinite(command.moveMeters)) {
    return 'SetTokenMoveMeters requires a finite moveMeters'
  }
  return null
}

// Deterministic [0,1) hash for seeded jitter — keeps spawns reproducible per
// table without pulling in a PRNG dependency.
const hashFloat = (n: number): number => {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// A seed-stable shuffle of [0..count) via sort by hash — small n, so simplicity
// over Fisher-Yates. Same (count, salt) ⇒ same order.
const shuffleIndices = (count: number, salt: number): number[] =>
  Array.from({length: count}, (_, i) => i).sort((a, b) => hashFloat(salt + a * 7.13) - hashFloat(salt + b * 7.13))

const rollD6 = (): number => {
  const bytes = new Uint8Array(1)
  let value = 255
  while (value >= 252) {
    crypto.getRandomValues(bytes)
    value = bytes[0]
  }
  return (value % 6) + 1
}

const randomSecret = (): string => {
  const bytes = new Uint8Array(AUTH_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const isCredential = (value: string): boolean => /^[A-Za-z0-9_-]{32,128}$/.test(value)

const hashSecret = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const constantTimeEqual = (a: string, b: string): boolean => {
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i += 1) diff |= aBytes[i] ^ bBytes[i]
  return diff === 0
}

const discardRequestBody = async (request: Request): Promise<void> => {
  await request.arrayBuffer().catch(() => {})
}
