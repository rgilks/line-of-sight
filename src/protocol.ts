// Shared multiplayer protocol: command/event/view shapes plus the pure
// per-viewer visibility gate. No Cloudflare or DOM dependencies — it reuses the
// deterministic core, so the gate is identical to what the single-player UI draws.
import {
  distanceToOccluder,
  hasLineOfSight,
  visibilityPolygon,
  type Occluder,
  type Point
} from '../web/src/los-core'

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
  /** Per-turn movement budget in feet; GM override. Falls back to board default. */
  moveFeet?: number
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
   * Map squares are this many feet on a side (D&D 5e SRD: 5 ft per square).
   * Used with `gridScale` to convert movement feet to board pixels.
   */
  feetPerSquare?: number
  /**
   * Default per-turn walking speed in feet (D&D 5e SRD: 30 ft for most
   * humanoids). Individual tokens may override via `moveFeet`.
   */
  defaultMoveFeet?: number
  /**
   * Suggested join positions in board pixels (e.g. room centers of a generated
   * deck). The table assigns joining players to these; absent ⇒ legacy spawn.
   */
  spawnPoints?: Point[]
}

// Client -> server intent. The caller's playerId travels in the POST envelope,
// so a command never needs to name its own token.
export type Command =
  | {type: 'SetName'; name: string}
  | {type: 'MoveToken'; x: number; y: number}
  | {type: 'ToggleDoor'; doorId: string; open: boolean}
  | {type: 'SetPlayerDoorControl'; enabled: boolean}
  | {type: 'SetTokenMoveFeet'; playerId: PlayerId; moveFeet: number}

export type CommandEnvelope = {playerId: PlayerId; command: Command}

// Server-internal facts; state is a fold over these. seq is monotonic per table.
export type DomainEvent = {seq: number} & (
  | {type: 'PlayerJoined'; playerId: PlayerId; label: string; kind: CounterKind; x: number; y: number}
  | {type: 'PlayerLeft'; playerId: PlayerId}
  | {type: 'PlayerRenamed'; playerId: PlayerId; label: string}
  | {type: 'TokenMoved'; playerId: PlayerId; x: number; y: number}
  | {type: 'DoorToggled'; doorId: string; open: boolean}
  | {type: 'PlayerDoorControlSet'; enabled: boolean}
  | {type: 'TokenMoveFeetSet'; playerId: PlayerId; moveFeet: number}
  | {type: 'BoardPublished'; assetRef: string}
)

// Server -> client read model. `tokens` is ALREADY fog-gated for the recipient,
// and `board` is included so a freshly published board (new map + occluders)
// reaches already-connected clients without a reconnect.
export type ViewMessage =
  | {type: 'snapshot'; you: PlayerId; board: Board; tokens: Token[]}
  | {type: 'update'; board: Board; tokens: Token[]}

/** D&D 5e SRD: one grid square on the battle map is 5 feet. */
export const SRD_FEET_PER_SQUARE = 5

/** D&D 5e SRD: default walking speed per turn for most humanoids (feet). */
export const SRD_DEFAULT_MOVE_FEET = 30

const isDoorOpen = (board: Board, doorId: string, fallback: boolean): boolean =>
  board.doorStates[doorId]?.open ?? fallback

export const feetPerSquare = (board: Board): number =>
  board.feetPerSquare && board.feetPerSquare > 0 ? board.feetPerSquare : SRD_FEET_PER_SQUARE

export const tokenMoveFeet = (token: Token, board: Board): number => {
  const feet = token.moveFeet ?? board.defaultMoveFeet ?? SRD_DEFAULT_MOVE_FEET
  return Math.max(0, feet)
}

/** Maximum distance a token may travel in one turn, in board pixels. */
export const moveRadiusPixels = (token: Token, board: Board): number => {
  const squares = tokenMoveFeet(token, board) / feetPerSquare(board)
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
    const feet = tokenMoveFeet(viewer, board)
    return {
      ok: false,
      reason: `You can move up to ${feet} ft this turn (about ${feet / feetPerSquare(board)} squares).`
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
export const doorReach = (board: Board): number => 1.5 * board.gridScale

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
