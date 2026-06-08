// Pure, framework-free server core for a "Survive the Horde" game. It runs the
// same engine as the local /solo page, but authoritatively: players issue
// commands (each naming its actor), the session validates them, applies the
// reducer, then runs the monster AI and wave upkeep to completion.
//
// The whole game is deterministic from (seed + the player-command log): a single
// seeded rng drives setup, player rolls, and AI rolls, and the monster AI is a
// pure function of state. So the SoloRoom Durable Object can persist just the
// seed and the player commands and replay() to recover — the AI turns are
// re-derived, never stored. No DOM, no Cloudflare; this is the layer the DO wraps.
import {makeRng} from '../synth/rng'
import {decideMonster} from './ai'
import {cellCenter} from './grid'
import {reduce} from './reducer'
import {buildWave, createSoloGame} from './setup'
import {activeEntity, isDead, type Action, type Entity, type SoloState} from './model'

// A player command: an action plus the id of the actor (character) issuing it.
// Only the active character's owner may act (enforced by the reducer's byActor
// gate); the transport additionally whitelists which actions a phone may send.
export type SoloCommand = {action: Action; byActor: string}

// A session bundles the authoritative state with its seeded rng and the persisted
// player-command log, so it can be replayed to recover after a restart.
export type SoloSession = {seed: number; state: SoloState; rng: () => number; log: SoloCommand[]}

const AI_GUARD = 400

// When the squad has cleared the deck, spawn the next wave at the airlocks — or,
// if the final wave is down, win. Idempotent while monsters are still alive.
const upkeep = (state: SoloState, rng: () => number): SoloState => {
  if (state.phase.t !== 'playerTurn') return state
  if (state.entities.some((e) => e.faction === 'monster' && !isDead(e))) return state
  if (state.wave >= state.wavesTotal) return {...state, phase: {t: 'won'}}
  return reduce(state, {t: 'AddWave', monsters: buildWave(state.map, state.grid, state.wave + 1)}, rng)
}

// Run monster turns (and wave upkeep) to completion: while it is a monster's
// turn, plan, move, attack, and end the turn — until control returns to a living
// PC or the game ends. Returns the new state plus the ordered AI actions, so a
// client can animate each monster's steps. Pure: the AI is a function of state.
export const runAi = (start: SoloState, rng: () => number): {state: SoloState; actions: Action[]} => {
  let state = upkeep(start, rng)
  const actions: Action[] = []
  let guard = 0
  while (state.phase.t === 'playerTurn' && activeEntity(state)?.faction === 'monster' && guard < AI_GUARD) {
    guard += 1
    const id = (activeEntity(state) as Entity).id
    const plan = decideMonster(state, id)
    for (const cell of plan.moves) {
      const move: Action = {t: 'Move', to: cellCenter(state.grid, cell.cx, cell.cy)}
      state = reduce(state, move, rng)
      actions.push(move)
    }
    if (state.phase.t === 'playerTurn' && plan.attackTargetId) {
      const attack: Action = {t: 'Attack', targetId: plan.attackTargetId}
      state = reduce(state, attack, rng)
      actions.push(attack)
    }
    state = reduce(state, {t: 'EndTurn'}, rng)
    actions.push({t: 'EndTurn'})
    state = upkeep(state, rng)
  }
  return {state, actions}
}

// Apply one player command, then run the monsters and wave upkeep out. Returns
// the new authoritative state plus the AI actions taken (for animation). A
// rejected command (not your turn) leaves the state unchanged and runs no AI.
export const step = (
  state: SoloState,
  command: SoloCommand,
  rng: () => number
): {state: SoloState; aiActions: Action[]} => {
  const afterPlayer = reduce(state, command.action, rng, command.byActor)
  if (afterPlayer === state) return {state, aiActions: []} // rejected by the authority gate
  const ai = runAi(afterPlayer, rng)
  return {state: ai.state, aiActions: ai.actions}
}

// Start a fresh authoritative game for `seed`.
export const createSession = (seed: number): SoloSession => {
  const rng = makeRng(seed)
  return {seed, state: createSoloGame(seed, rng), rng, log: []}
}

// Apply a command to a session, recording state-changing commands in the log for
// replay. Returns the updated session and the AI actions taken (for animation).
export const sessionStep = (
  session: SoloSession,
  command: SoloCommand
): {session: SoloSession; aiActions: Action[]} => {
  const {state, aiActions} = step(session.state, command, session.rng)
  if (state === session.state) return {session, aiActions: []}
  return {session: {...session, state, log: [...session.log, command]}, aiActions}
}

// Rebuild a session from its seed and persisted command log (DO restart). The AI
// turns are re-derived deterministically, so only player commands are persisted.
export const replay = (seed: number, log: SoloCommand[]): SoloSession => {
  const rng = makeRng(seed)
  let state = createSoloGame(seed, rng)
  for (const command of log) {
    state = step(state, command, rng).state
  }
  return {seed, state, rng, log: [...log]}
}
