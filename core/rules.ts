// Shared Cepheus rules + domain model. Pure: imports only the geometry core
// (./los), no DOM/Cloudflare. Both the multiplayer table (src/, web/src/play.ts)
// and the single-player game (web/src/solo/) import these — the movement,
// visibility, door-reach, and initiative-order rules are identical everywhere.
//
// Network/transport shapes (Command, DomainEvent, ViewMessage, ChatSay) live in
// src/protocol.ts, which re-exports the domain types it embeds from here.
import {doorReachForGrid, distanceToOccluder, hasLineOfSight, visibilityPolygon, type Occluder, type Point} from './los'

// Re-exported so callers can import the LOS gate from one place (this module).
export {hasLineOfSight}

export type PlayerId = string

// The counter portraits available at /token-portraits/<kind>.webp. Players are
// assigned one at random on join; the solo game's pre-gens pick from these too.
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

export type Combatant = {
  playerId: PlayerId
  tokenId: string
  label: string
  /** Stable tie-breaker until character Dexterity is modelled. */
  order: number
  /** Future character-sheet hook. Initiative is currently 2D6 + this value. */
  dexterityDm: number
  dice: [number, number] | null
  initiative: number | null
}

export type CombatState = {
  round: number
  /** Null while waiting for initiative rolls. */
  turnIndex: number | null
  combatants: Combatant[]
}

export type ReadyCombatState = CombatState & {turnIndex: number}

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

/** Cepheus Engine: one tactical grid square is 1.5 metres. */
export const CEPHEUS_METERS_PER_SQUARE = 1.5

/** Cepheus Engine: default per-round movement is 6 metres (≈ 4 squares). */
export const CEPHEUS_DEFAULT_MOVE_METERS = 6

const isDoorOpen = (board: Board, doorId: string, fallback: boolean): boolean =>
  board.doorStates[doorId]?.open ?? fallback

export const metersPerSquare = (board: Board): number =>
  board.metersPerSquare && board.metersPerSquare > 0 ? board.metersPerSquare : CEPHEUS_METERS_PER_SQUARE

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

export const combatReady = (combat: CombatState | null): combat is ReadyCombatState =>
  combat != null &&
  combat.combatants.length > 0 &&
  combat.turnIndex != null &&
  combat.combatants.every((combatant) => combatant.initiative != null)

export const activeCombatant = (combat: CombatState | null): Combatant | null => {
  if (!combatReady(combat)) return null
  return combat.combatants[combat.turnIndex] ?? null
}

export const combatantForPlayer = (combat: CombatState | null, playerId: PlayerId | null): Combatant | null => {
  if (!combat || !playerId) return null
  return combat.combatants.find((combatant) => combatant.playerId === playerId) ?? null
}

export const isPlayersCombatTurn = (combat: CombatState | null, playerId: PlayerId | null): boolean =>
  activeCombatant(combat)?.playerId === playerId

// Sort by descending initiative, ties broken by stable join `order`. Generic over
// any combatant-like shape so the multiplayer Combatant AND the single-player
// entities both order through this one function.
export type InitiativeOrdered = {order: number; initiative: number | null}

export const orderByInitiative = <T extends InitiativeOrdered>(combatants: T[]): T[] =>
  [...combatants].sort((left, right) => {
    const leftInitiative = left.initiative ?? Number.NEGATIVE_INFINITY
    const rightInitiative = right.initiative ?? Number.NEGATIVE_INFINITY
    if (leftInitiative !== rightInitiative) return rightInitiative - leftInitiative
    return left.order - right.order
  })

/** Back-compat alias: the multiplayer code calls this name. */
export const orderCombatantsByInitiative = (combatants: Combatant[]): Combatant[] => orderByInitiative(combatants)

export const pointInPolygon = (point: Point, polygon: Point[]): boolean => {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]
    const previousPoint = polygon[previous]
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) +
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

export const canMoveTokenTo = (viewer: Token, board: Board, destination: Point, options?: {gm?: boolean}): boolean =>
  validateTokenMove(viewer, board, destination, options).ok

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
