// Multiplayer transport: the command/event/view wire shapes for the table's
// SSE + command-POST protocol. The pure game rules and domain model live in
// `core/rules.ts` (shared with the single-player game); this module re-exports
// them so existing server/client imports of `../../src/protocol` keep working,
// and adds the network-only shapes on top.
//
// The single-player game imports `core/rules` directly and never touches this
// file, so it drags in none of the SSE/command types below.
import type {Board, CombatState, CounterKind, PlayerId, Token} from '../core/rules'

export * from '../core/rules'

// Client -> server intent. The caller's playerId travels in the POST envelope,
// so a command never needs to name its own token.
export type Command =
  | {type: 'SetName'; name: string}
  | {type: 'MoveToken'; x: number; y: number}
  | {type: 'ToggleDoor'; doorId: string; open: boolean}
  | {type: 'SetPlayerDoorControl'; enabled: boolean}
  | {type: 'SetTokenMoveMeters'; playerId: PlayerId; moveMeters: number}
  | {type: 'Say'; text: string}
  | {type: 'StartCombat'}
  | {type: 'RollInitiative'}
  | {type: 'AdvanceTurn'}
  | {type: 'EndCombat'}

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
  at: {x: number; y: number}
  fromGm: boolean
  sentAt: number
}

export type CommandEnvelope = {playerId: PlayerId; authToken: string; command: Command}

// Server-internal facts; state is a fold over these. seq is monotonic per table.
export type DomainEvent = {seq: number} & (
  | {type: 'PlayerJoined'; playerId: PlayerId; label: string; kind: CounterKind; x: number; y: number}
  | {type: 'PlayerLeft'; playerId: PlayerId}
  | {type: 'PlayerRenamed'; playerId: PlayerId; label: string}
  | {type: 'TokenMoved'; playerId: PlayerId; x: number; y: number}
  | {type: 'DoorToggled'; doorId: string; open: boolean}
  | {type: 'PlayerDoorControlSet'; enabled: boolean}
  | {type: 'TokenMoveMetersSet'; playerId: PlayerId; moveMeters: number}
  // Carries the whole normalized board (already stamped with its boardSeq), not
  // just the assetRef, so a replay of the log alone reconstructs the published
  // board — the fold swaps `board` straight in. Without this the board value
  // would live only in memory and be lost on restart.
  | {type: 'BoardPublished'; board: Board}
  | {type: 'CombatStarted'; playerIds: PlayerId[]}
  | {
      type: 'InitiativeRolled'
      playerId: PlayerId
      dice: [number, number]
      dexterityDm: number
      initiative: number
    }
  | {type: 'TurnAdvanced'; round: number; turnIndex: number}
  | {type: 'CombatEnded'}
  | {
      // A chat say. Not a fold over board/token/combat state, but logged like the
      // rest so the command path is one decide → fold pipeline. `at`/`label`/`fromGm`
      // are resolved at decide time; `sentAt` is the wall clock then (see ChatSay).
      type: 'Said'
      fromId: PlayerId
      label: string
      text: string
      at: {x: number; y: number}
      fromGm: boolean
      sentAt: number
    }
)

// Server -> client read model. `tokens` and `says` are ALREADY visibility-gated
// for the recipient, and `board` is included so a freshly published board (new
// map + occluders) reaches already-connected clients without a reconnect.
export type ViewMessage =
  | {
      type: 'snapshot'
      you: PlayerId
      authToken: string
      board: Board
      tokens: Token[]
      says: ChatSay[]
      combat: CombatState | null
    }
  | {type: 'update'; board: Board; tokens: Token[]; says: ChatSay[]; combat: CombatState | null}
