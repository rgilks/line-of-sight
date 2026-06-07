// Single-player domain model. Pure data + tiny helpers; no DOM. The combat,
// inventory, and gear fields grow in later phases — Phase 1 needs only enough to
// place characters on the deck and roll initiative.
import {CEPHEUS_DEFAULT_MOVE_METERS, CEPHEUS_METERS_PER_SQUARE, type CounterKind} from '../../../core/rules'
import type {Point} from '../../../core/los'
import type {GeneratedMap} from '../synth/types'
import type {WalkGrid} from './grid'

export type Faction = 'pc' | 'monster'

// The three Cepheus physical characteristics. They double as hit points (Cepheus
// SRD): damage reduces END first, then STR or DEX. These mirror the lowercase
// names the character generator uses (ccg Characteristics.{str,dex,end}), so a
// generated character maps in directly.
export type Stats = {str: number; dex: number; end: number}

// Skills as a name → level map, parseable from ccg's `"Gun Combat-2"` strings via
// parseCcgSkills (see ccg.ts). Names match ccg's parent skills ("Gun Combat",
// "Melee Combat", "Medicine").
export type Skills = Record<string, number>

export type ItemKind = 'ammo' | 'medkit'
// A stack of carried consumables. `weaponId` ties ammo to the weapon it reloads.
export type ItemStack = {kind: ItemKind; weaponId?: string; count: number}
// Loot lying on the deck floor until a character picks it up (board pixels).
export type GroundItem = {id: string; x: number; y: number; stack: ItemStack}

export type Entity = {
  id: string
  faction: Faction
  kind: CounterKind // portrait (one of the 12 shared counter kinds)
  label: string
  // Board pixels (same space as the rendered deck and Token).
  x: number
  y: number
  stats: Stats
  statsMax: Stats
  skills: Skills
  weaponId: string
  armorId: string | null
  inventory: ItemStack[]
  loadedRounds: number // rounds currently in the equipped ranged weapon
  // Combat bookkeeping.
  initiative: number | null
  order: number // stable join index; ties in initiative break by this
  // monster-only behaviour hint (Phase 4 AI); PCs leave it undefined.
  behaviour?: 'hunter' | 'lurker'
}

// Cepheus characteristic DM table: the modifier a characteristic value confers.
//   0 ⇒ -3 · 1-2 ⇒ -2 · 3-5 ⇒ -1 · 6-8 ⇒ 0 · 9-11 ⇒ +1 · 12-14 ⇒ +2 · 15+ ⇒ +3
export const characteristicDm = (value: number): number => {
  if (value <= 0) return -3
  if (value <= 2) return -2
  if (value <= 5) return -1
  if (value <= 8) return 0
  if (value <= 11) return 1
  if (value <= 14) return 2
  return 3
}

/** A character's Dexterity DM — the initiative modifier (2D6 + DEX DM). */
export const dexDm = (entity: Entity): number => characteristicDm(entity.stats.dex)

/** Dead when all three physical characteristics are 0 (Cepheus SRD). */
export const isDead = (entity: Entity): boolean =>
  entity.stats.str <= 0 && entity.stats.dex <= 0 && entity.stats.end <= 0

// Unconscious when STR or DEX is reduced to 0 (but not yet dead). END reaching 0
// alone does NOT down a character — only STR/DEX do (Cepheus SRD).
export const isDown = (entity: Entity): boolean =>
  !isDead(entity) && (entity.stats.str <= 0 || entity.stats.dex <= 0)

/** A living entity is on the board and able to act (not dead, not downed). */
export const isActive = (entity: Entity): boolean => !isDead(entity) && !isDown(entity)

export type DoorStates = Record<string, {open: boolean}>

export type GamePhase = {t: 'playerTurn'} | {t: 'won'} | {t: 'lost'}

// The whole single-player game state. Pure data; the reducer maps
// (state, action) → state and the DOM shell renders it.
export type SoloState = {
  seed: number
  map: GeneratedMap
  grid: WalkGrid
  doorStates: DoorStates
  sightRadius: number
  entities: Entity[] // PCs + monsters, in initiative order
  ground: GroundItem[] // loot on the floor
  turnPtr: number
  round: number
  moveRemainingPx: number // movement budget left for the active entity this turn
  actionUsed: boolean // the active entity has spent its one significant action
  phase: GamePhase
  log: string[]
}

export type Action =
  | {t: 'Move'; to: Point}
  | {t: 'ToggleDoor'; doorId: string}
  | {t: 'Attack'; targetId: string}
  | {t: 'Reload'}
  | {t: 'UseMedkit'; targetId: string}
  | {t: 'PickUp'; groundItemId: string}
  | {t: 'Drop'; stackIndex: number}
  | {t: 'EndTurn'}

export const activeEntity = (state: SoloState): Entity | undefined => state.entities[state.turnPtr]

export const entityById = (state: SoloState, id: string): Entity | undefined =>
  state.entities.find((entity) => entity.id === id)

export const livingOf = (state: SoloState, faction: Faction): Entity[] =>
  state.entities.filter((entity) => entity.faction === faction && !isDead(entity))

/** Are two entities within `squares` cells of each other (Chebyshev-ish, by pixels)? */
export const withinReach = (a: Entity, b: Entity, gridScale: number, squares = 1.6): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) <= squares * gridScale

/** Per-turn movement budget in board pixels (Cepheus 6 m ÷ 1.5 m/square × gridScale). */
export const moveBudgetPx = (gridScale: number): number =>
  (CEPHEUS_DEFAULT_MOVE_METERS / CEPHEUS_METERS_PER_SQUARE) * gridScale
