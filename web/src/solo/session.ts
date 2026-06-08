// Event-sourced server core for a "Survive the Horde" game — the same shape as
// the multiplayer GameTable. A player (or the monster AI) issues a command; the
// engine `decide`s it into SoloEvents (facts carrying resolved outcomes), which
// are `foldSolo`ed into state and appended to the event log. The SoloRoom Durable
// Object persists those events and `replay()`s them (over a seed-derived genesis)
// to recover, so a restart reproduces the exact game even across rule changes —
// the AI's events are stored facts, not re-derived. No DOM, no Cloudflare.
import {makeRng} from '../synth/rng'
import {decideMonster} from './ai'
import {cellCenter, cellOf} from './grid'
import {decide, foldSolo, type SoloEvent} from './reducer'
import {buildWave, createSoloGame} from './setup'
import {activeEntity, entityById, isDead, type Action, type Entity, type SoloState} from './model'

// A player command, naming the actor (character) issuing it: either an atomic
// action, or a d-pad step (a unit direction resolved to a one-cell Move).
export type SoloCommand = {byActor: string} & ({action: Action} | {step: {dx: number; dy: number}})

// A session bundles the authoritative state with its seeded rng and the persisted
// event log, so it can be replayed to recover after a restart.
export type SoloSession = {seed: number; state: SoloState; rng: () => number; events: SoloEvent[]}

const AI_GUARD = 400

// Decide a command and fold its events into state. Returns the new state and the
// events produced (empty if the command was rejected).
const advance = (
  state: SoloState,
  decideFn: () => ReturnType<typeof decide>
): {state: SoloState; events: SoloEvent[]} => {
  const result = decideFn()
  if ('rejected' in result) return {state, events: []}
  return {state: result.events.reduce(foldSolo, state), events: result.events}
}

// A d-pad step → a one-cell Move, after checking the issuer is active.
const stepCommand = (state: SoloState, dir: {dx: number; dy: number}, byActor: string, rng: () => number) => {
  if (activeEntity(state)?.id !== byActor) return advance(state, () => ({rejected: null}))
  const actor = entityById(state, byActor)
  if (!actor) return advance(state, () => ({rejected: null}))
  const c = cellOf(state.grid, actor.x, actor.y)
  const to = cellCenter(state.grid, c.cx + Math.sign(dir.dx), c.cy + Math.sign(dir.dy))
  return advance(state, () => decide(state, {t: 'Move', to}, rng))
}

// When the squad has cleared the deck, spawn the next wave at the airlocks — or,
// if the final wave is down, win. Emits events, idempotent while monsters live.
const upkeep = (state: SoloState, rng: () => number): {state: SoloState; events: SoloEvent[]} => {
  if (state.phase.t !== 'playerTurn') return {state, events: []}
  if (state.entities.some((e) => e.faction === 'monster' && !isDead(e))) return {state, events: []}
  if (state.wave >= state.wavesTotal) {
    const won: SoloEvent = {t: 'Won'}
    return {state: foldSolo(state, won), events: [won]}
  }
  return advance(state, () =>
    decide(state, {t: 'AddWave', monsters: buildWave(state.map, state.grid, state.wave + 1)}, rng)
  )
}

// Run monster turns (and wave upkeep) to completion: while it is a monster's
// turn, plan, move, attack, end the turn — until control returns to a living PC
// or the game ends. Returns the new state plus every event the monsters produced.
export const runAi = (start: SoloState, rng: () => number): {state: SoloState; events: SoloEvent[]} => {
  let {state, events} = upkeep(start, rng)
  let guard = 0
  const push = (step: {state: SoloState; events: SoloEvent[]}): void => {
    state = step.state
    if (step.events.length > 0) events = [...events, ...step.events]
  }
  while (state.phase.t === 'playerTurn' && activeEntity(state)?.faction === 'monster' && guard < AI_GUARD) {
    guard += 1
    const id = (activeEntity(state) as Entity).id
    const plan = decideMonster(state, id)
    for (const cell of plan.moves) {
      const to = cellCenter(state.grid, cell.cx, cell.cy)
      push(advance(state, () => decide(state, {t: 'Move', to}, rng)))
    }
    if (state.phase.t === 'playerTurn' && plan.attackTargetId) {
      const targetId = plan.attackTargetId
      push(advance(state, () => decide(state, {t: 'Attack', targetId}, rng)))
    }
    push(advance(state, () => decide(state, {t: 'EndTurn'}, rng)))
    push(upkeep(state, rng))
  }
  return {state, events}
}

// Apply one player command, then run the monsters and wave upkeep out. Returns
// the new state plus every event produced (player + AI). A rejected command (not
// your turn / illegal) yields no events and runs no AI.
export const step = (
  state: SoloState,
  command: SoloCommand,
  rng: () => number
): {state: SoloState; events: SoloEvent[]} => {
  const player =
    'step' in command
      ? stepCommand(state, command.step, command.byActor, rng)
      : advance(state, () => decide(state, command.action, rng, command.byActor))
  if (player.events.length === 0) return {state, events: []}
  const ai = runAi(player.state, rng)
  return {state: ai.state, events: [...player.events, ...ai.events]}
}

// Start a fresh authoritative game for `seed`.
export const createSession = (seed: number): SoloSession => {
  const rng = makeRng(seed)
  return {seed, state: createSoloGame(seed, rng), rng, events: []}
}

// Apply a command to a session, appending its events to the log for replay.
export const sessionStep = (
  session: SoloSession,
  command: SoloCommand
): {session: SoloSession; events: SoloEvent[]} => {
  const {state, events} = step(session.state, command, session.rng)
  if (events.length === 0) return {session, events: []}
  return {session: {...session, state, events: [...session.events, ...events]}, events}
}

// Rebuild a session from its seed and persisted event log (DO restart): fold the
// events over a seed-derived genesis. Pure and deterministic — no rng in fold.
export const replay = (seed: number, events: SoloEvent[]): SoloSession => {
  const rng = makeRng(seed)
  let state = createSoloGame(seed, rng)
  for (const event of events) state = foldSolo(state, event)
  return {seed, state, rng, events: [...events]}
}
