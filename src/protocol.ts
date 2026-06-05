// Shared multiplayer protocol: command/event/view shapes plus the pure
// per-viewer visibility gate. No Cloudflare or DOM dependencies — it reuses the
// deterministic core, so the gate is identical to what the single-player UI draws.
import {
  doorReachForGrid,
  distanceToOccluder,
  hasLineOfSight,
  visibilityPolygon,
  type Occluder,
  type Point
} from '../web/src/los-core'

// Re-exported so the table DO imports the LOS gate from one place (this module).
export {hasLineOfSight}

export type PlayerId = string

// The counter portraits available at /token-portraits/<kind>.webp (shared with
// the single-player tool). Players are assigned one at random on join.
export type CounterKind =
  | 'amphibian'
  | 'engineer'
  | 'insectoid'
  | 'marine'
  | 'medic'
  | 'officer'
  | 'psion'
  | 'reptilian'
  | 'scientist'
  | 'scout'
  | 'security'
  | 'trader'

export const COUNTER_KINDS: CounterKind[] = [
  'amphibian',
  'engineer',
  'insectoid',
  'marine',
  'medic',
  'officer',
  'psion',
  'reptilian',
  'scientist',
  'scout',
  'security',
  'trader'
]

export type Token = {
  id: string
  ownerId: PlayerId
  label: string
  kind: CounterKind
  x: number
  y: number
  /** Per-turn movement budget in metres; GM override. Falls back to board default. */
  moveMeters?: number
}

export type Board = {
  assetRef: string
  /** Bumped on each GM publish so clients reload map art and geometry. */
  boardSeq?: number
  width: number
  height: number
  gridScale: number
  sightRadius: number
  occluders: Occluder[]
  doorStates: Record<string, {open: boolean}>
  /** When false, only the GM connection may toggle doors. Defaults to true. */
  playerDoorControl?: boolean
  /**
   * Map squares are this many metres on a side (Cepheus Engine: 1.5 m per
   * square). Used with `gridScale` to convert movement metres to board pixels.
   */
  metersPerSquare?: number
  /**
   * Default per-turn movement in metres (Cepheus Engine: 6 m ≈ 4 squares).
   * Individual tokens may override via `moveMeters`.
   */
  defaultMoveMeters?: number
  /**
   * Suggested join positions in board pixels (e.g. room centers of a generated
   * deck). The table assigns joining players to these; absent ⇒ legacy spawn.
   */
  spawnPoints?: Point[]
  /**
   * GM-only room labels (function + bounds, in board pixels). Drawn as an overlay
   * the GM sees and players never do — the map image itself carries no labels.
   */
  rooms?: RoomLabel[]
}

/** A GM-only room label: its text and bounds in board pixels. */
export type RoomLabel = {label: string; x: number; y: number; w: number; h: number}

// Client -> server intent. The caller's playerId travels in the POST envelope,
// so a command never needs to name its own token.
export type Command =
  | {type: 'SetName'; name: string}
  | {type: 'MoveToken'; x: number; y: number}
  | {type: 'ToggleDoor'; doorId: string; open: boolean}
  | {type: 'SetPlayerDoorControl'; enabled: boolean}
  | {type: 'SetTokenMoveMeters'; playerId: PlayerId; moveMeters: number}
  | {type: 'Say'; text: string}

// A chat message, shown as a speech bubble. A player's bubble attaches to their
// token; the GM (no token) speaks via `fromGm`, shown as a board banner. `at` is
// the speaker's board position when sent (so a bubble has somewhere to point even
// if its token later moves out of the recipient's sight). Visibility-gated like
// tokens: a recipient only receives a say from someone they can currently see.
export type ChatSay = {
  id: string
  fromId: PlayerId
  label: string
  text: string
  at: Point
  fromGm: boolean
  sentAt: number
}

export type CommandEnvelope = {playerId: PlayerId; command: Command}

// Server-internal facts; state is a fold over these. seq is monotonic per table.
export type DomainEvent = {seq: number} & (
  | {type: 'PlayerJoined'; playerId: PlayerId; label: string; kind: CounterKind; x: number; y: number}
  | {type: 'PlayerLeft'; playerId: PlayerId}
  | {type: 'PlayerRenamed'; playerId: PlayerId; label: string}
  | {type: 'TokenMoved'; playerId: PlayerId; x: number; y: number}
  | {type: 'DoorToggled'; doorId: string; open: boolean}
  | {type: 'PlayerDoorControlSet'; enabled: boolean}
  | {type: 'TokenMoveMetersSet'; playerId: PlayerId; moveMeters: number}
  | {type: 'BoardPublished'; assetRef: string}
)

// Server -> client read model. `tokens` and `says` are ALREADY visibility-gated
// for the recipient, and `board` is included so a freshly published board (new
// map + occluders) reaches already-connected clients without a reconnect.
export type ViewMessage =
  | {type: 'snapshot'; you: PlayerId; board: Board; tokens: Token[]; says: ChatSay[]}
  | {type: 'update'; board: Board; tokens: Token[]; says: ChatSay[]}

/** Cepheus Engine: one tactical grid square is 1.5 metres. */
export const CEPHEUS_METERS_PER_SQUARE = 1.5

/** Cepheus Engine: default per-round movement is 6 metres (≈ 4 squares). */
export const CEPHEUS_DEFAULT_MOVE_METERS = 6

const isDoorOpen = (board: Board, doorId: string, fallback: boolean): boolean =>
  board.doorStates[doorId]?.open ?? fallback

export const metersPerSquare = (board: Board): number =>
  board.metersPerSquare && board.metersPerSquare > 0
    ? board.metersPerSquare
    : CEPHEUS_METERS_PER_SQUARE

export const tokenMoveMeters = (token: Token, board: Board): number => {
  const meters = token.moveMeters ?? board.defaultMoveMeters ?? CEPHEUS_DEFAULT_MOVE_METERS
  return Math.max(0, meters)
}

/** How many whole squares a token may move in one turn (for UI hints). */
export const tokenMoveSquares = (token: Token, board: Board): number =>
  Math.round(tokenMoveMeters(token, board) / metersPerSquare(board))

/** Maximum distance a token may travel in one turn, in board pixels. */
export const moveRadiusPixels = (token: Token, board: Board): number => {
  const squares = tokenMoveMeters(token, board) / metersPerSquare(board)
  return squares * board.gridScale
}

const pointInPolygon = (point: Point, polygon: Point[]): boolean => {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]
    const previousPoint = polygon[previous]
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x
    if (crosses) inside = !inside
  }
  return inside
}

export type MoveValidation = {ok: true} | {ok: false; reason: string}

/** Whether a player may place their token at `destination` from their current position. */
export const validateTokenMove = (
  viewer: Token,
  board: Board,
  destination: Point,
  options?: {gm?: boolean}
): MoveValidation => {
  if (options?.gm) return {ok: true}

  const polygon = visibilityPolygon(
    viewer.x,
    viewer.y,
    board.width,
    board.height,
    board.sightRadius,
    board.occluders,
    board.doorStates
  )
  if (polygon.length < 3 || !pointInPolygon(destination, polygon)) {
    return {ok: false, reason: 'You can only move into areas you can see.'}
  }

  const maxMove = moveRadiusPixels(viewer, board)
  const distance = Math.hypot(destination.x - viewer.x, destination.y - viewer.y)
  if (distance > maxMove + 0.5) {
    const meters = tokenMoveMeters(viewer, board)
    return {
      ok: false,
      reason: `You can move up to ${meters} m this turn (about ${tokenMoveSquares(viewer, board)} squares).`
    }
  }

  return {ok: true}
}

export const canMoveTokenTo = (
  viewer: Token,
  board: Board,
  destination: Point,
  options?: {gm?: boolean}
): boolean => validateTokenMove(viewer, board, destination, options).ok

/** How close (in board pixels) a player's token must be to a door to toggle it. */
export const doorReach = (board: Board): number => doorReachForGrid(board.gridScale)

/**
 * Whether a player may open/close a door from where their token stands. The GM
 * always may. A player must be within `doorReach` of the door segment — the same
 * rule the client uses for its hint, so UX and the server gate never disagree.
 */
export const canToggleDoorFrom = (
  token: Token | null,
  board: Board,
  door: Occluder,
  options?: {gm?: boolean}
): boolean => {
  if (options?.gm) return true
  if (!token || door.type !== 'door') return false
  return distanceToOccluder({x: token.x, y: token.y}, door) <= doorReach(board)
}

// Tokens a given viewer is allowed to see: always their own, plus others within
// sight radius and not blocked by a wall or closed door. This is the entire
// security boundary — see docs/MULTIPLAYER.md.
export const visibleTokensFor = (viewerId: PlayerId, tokens: Token[], board: Board): Token[] => {
  const viewer = tokens.find((token) => token.ownerId === viewerId)
  if (!viewer) return tokens.filter((token) => token.ownerId === viewerId)

  return tokens.filter((token) => {
    if (token.ownerId === viewerId) return true
    const from: Point = {x: viewer.x, y: viewer.y}
    const to: Point = {x: token.x, y: token.y}
    if (Math.hypot(to.x - from.x, to.y - from.y) > board.sightRadius) return false
    return hasLineOfSight(from, to, board.occluders, board.doorStates)
  })
}

// Re-exported so callers (e.g. a future GM "see all" path) can reuse the door rule.
export {isDoorOpen}
