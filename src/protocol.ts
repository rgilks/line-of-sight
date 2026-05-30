// Shared multiplayer protocol: command/event/view shapes plus the pure
// per-viewer visibility gate. No Cloudflare or DOM dependencies — it reuses the
// deterministic core, so the gate is identical to what the single-player UI draws.
import {hasLineOfSight, type Occluder, type Point} from '../web/src/los-core'

export type PlayerId = string

export type Token = {
  id: string
  ownerId: PlayerId
  label: string
  x: number
  y: number
}

export type Board = {
  assetRef: string
  width: number
  height: number
  gridScale: number
  sightRadius: number
  occluders: Occluder[]
  doorStates: Record<string, {open: boolean}>
}

// Client -> server intent. The caller's playerId travels in the POST envelope,
// so a command never needs to name its own token.
export type Command =
  | {type: 'SetName'; name: string}
  | {type: 'MoveToken'; x: number; y: number}
  | {type: 'ToggleDoor'; doorId: string; open: boolean}

export type CommandEnvelope = {playerId: PlayerId; command: Command}

// Server-internal facts; state is a fold over these. seq is monotonic per table.
export type DomainEvent = {seq: number} & (
  | {type: 'PlayerJoined'; playerId: PlayerId; label: string; x: number; y: number}
  | {type: 'PlayerLeft'; playerId: PlayerId}
  | {type: 'PlayerRenamed'; playerId: PlayerId; label: string}
  | {type: 'TokenMoved'; playerId: PlayerId; x: number; y: number}
  | {type: 'DoorToggled'; doorId: string; open: boolean}
)

// Server -> client read model. `tokens` is ALREADY fog-gated for the recipient.
export type ViewMessage =
  | {type: 'snapshot'; you: PlayerId; board: Board; tokens: Token[]}
  | {type: 'update'; doorStates: Record<string, {open: boolean}>; tokens: Token[]}

const isDoorOpen = (board: Board, doorId: string, fallback: boolean): boolean =>
  board.doorStates[doorId]?.open ?? fallback

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
