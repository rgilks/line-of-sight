// Single-player domain model. Pure data + tiny helpers; no DOM. The combat,
// inventory, and gear fields grow in later phases — Phase 1 needs only enough to
// place characters on the deck and roll initiative.
import type {CounterKind} from '../../../core/rules'

export type Faction = 'pc' | 'monster'

// The three Cepheus physical characteristics. They double as hit points: damage
// reduces END first, then STR or DEX; one at 0 ⇒ down, all three ⇒ dead.
export type Stats = {str: number; dex: number; end: number}

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
  // Combat bookkeeping.
  initiative: number | null
  order: number // stable join index; ties in initiative break by this
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

/** Down (unconscious) when any one physical characteristic has hit 0. */
export const isDown = (entity: Entity): boolean =>
  entity.stats.str <= 0 || entity.stats.dex <= 0 || entity.stats.end <= 0

/** Dead when all three physical characteristics are 0. */
export const isDead = (entity: Entity): boolean =>
  entity.stats.str <= 0 && entity.stats.dex <= 0 && entity.stats.end <= 0
