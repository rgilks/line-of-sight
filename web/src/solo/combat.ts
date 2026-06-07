// Cepheus SRD personal combat, as pure functions. The attack throw is
// 2D6 + skill + DEX DM + the weapon's range-band DM, against 8+. Effect =
// roll − 8 and adds to weapon damage; armour subtracts; an Effect of 6+ always
// inflicts at least 1. Damage falls on END first, then STR or DEX; STR/DEX at 0
// downs a character, all three at 0 kills. First aid (a medkit) restores 2× the
// Effect of a Medicine check.
//
// rng is injectable so combat is deterministic in tests; it defaults to
// Math.random in play (single-player needs no fairness guarantee).
import {rollD6, roll2D6, type Rng} from '../../../core/dice'
import {characteristicDm} from './model'
import {armorRating, weaponById, type RangeBand} from './gear'
import type {Entity} from './model'

const METERS_PER_SQUARE = 1.5

/** Parse a ccg-style damage string ("3d6", "3d6-3", "2d6+4") into dice + modifier. */
export const parseDamage = (damage: string): {count: number; mod: number} => {
  const match = /^(\d+)d6([+-]\d+)?$/.exec(damage.trim())
  if (!match) return {count: 1, mod: 0}
  return {count: Number(match[1]), mod: match[2] ? Number(match[2]) : 0}
}

export const rollDamageDice = (damage: string, rng?: Rng): number => {
  const {count, mod} = parseDamage(damage)
  let total = mod
  for (let index = 0; index < count; index += 1) total += rollD6(rng)
  return total
}

/** Distance in board pixels → Cepheus range band. */
export const rangeBandFor = (distancePx: number, gridScale: number): RangeBand => {
  const meters = (distancePx / gridScale) * METERS_PER_SQUARE
  if (meters < 1.5) return 'personal'
  if (meters <= 3) return 'close'
  if (meters <= 12) return 'short'
  if (meters <= 50) return 'medium'
  return 'long'
}

const distancePx = (a: Entity, b: Entity): number => Math.hypot(a.x - b.x, a.y - b.y)

// Skill DM for a weapon: the named skill's level, or the SRD unskilled −3.
const skillFor = (entity: Entity, skill: string): number => entity.skills[skill] ?? -3

/** Ranged attack DM from the target's stance (Cepheus SRD attack modifiers table). */
export const stanceAttackDm = (target: Entity, band: RangeBand): number => {
  if (target.stance !== 'prone') return 0
  if (band === 'personal') return 2
  if (band === 'close') return 0
  return -2
}

/** Prone characters cannot make melee attacks. */
export const blockedByStance = (attacker: Entity, weaponSkill: string): boolean =>
  attacker.stance === 'prone' && weaponSkill === 'Melee Combat'

export type AttackResult = {
  outOfRange: boolean
  hit: boolean
  roll: number // total of the 2D6 attack throw with all DMs
  effect: number // roll − 8
  band: RangeBand
  damage: number // applied to the target after armour + Effect-6 floor (0 on a miss)
}

/**
 * Resolve `attacker` shooting/striking `target` with the attacker's equipped
 * weapon. Pure: returns the outcome; it does not mutate either entity (apply the
 * damage with applyDamage).
 */
export const resolveAttack = (attacker: Entity, target: Entity, rng?: Rng, gridScale = 36): AttackResult => {
  const weapon = weaponById(attacker.weaponId)
  const band = rangeBandFor(distancePx(attacker, target), gridScale)
  const rangeDm = weapon.rangeDm[band]
  if (rangeDm === undefined) {
    return {outOfRange: true, hit: false, roll: 0, effect: 0, band, damage: 0}
  }
  if (blockedByStance(attacker, weapon.skill)) {
    return {outOfRange: true, hit: false, roll: 0, effect: 0, band, damage: 0}
  }

  const [d1, d2] = roll2D6(rng)
  const roll =
    d1 +
    d2 +
    skillFor(attacker, weapon.skill) +
    characteristicDm(attacker.stats.dex) +
    rangeDm +
    stanceAttackDm(target, band)
  const effect = roll - 8
  if (effect < 0) return {outOfRange: false, hit: false, roll, effect, band, damage: 0}

  const raw = rollDamageDice(weapon.damage, rng) + effect
  let damage = raw - armorRating(target.armorId)
  damage = effect >= 6 ? Math.max(1, damage) : Math.max(0, damage)
  return {outOfRange: false, hit: true, roll, effect, band, damage}
}

/**
 * Apply `amount` damage to an entity's characteristics, END first then the larger
 * of STR/DEX, then the other (Cepheus SRD). Returns a new entity; never mutates.
 */
export const applyDamage = (entity: Entity, amount: number): Entity => {
  if (amount <= 0) return entity
  let {str, dex, end} = entity.stats
  let remaining = amount

  const fromEnd = Math.min(end, remaining)
  end -= fromEnd
  remaining -= fromEnd

  if (remaining > 0) {
    // Deplete the larger physical first, overflow into the other.
    const [hi, lo]: ['str' | 'dex', 'str' | 'dex'] = str >= dex ? ['str', 'dex'] : ['dex', 'str']
    const pool = {str, dex}
    const fromHi = Math.min(pool[hi], remaining)
    pool[hi] -= fromHi
    remaining -= fromHi
    if (remaining > 0) pool[lo] = Math.max(0, pool[lo] - remaining)
    str = pool.str
    dex = pool.dex
  }

  return {...entity, stats: {str: Math.max(0, str), dex: Math.max(0, dex), end: Math.max(0, end)}}
}

export type FirstAidResult = {roll: number; effect: number; heal: number}

/** A Medicine check; on success restores 2 × Effect characteristic points. */
export const resolveFirstAid = (medic: Entity, rng?: Rng): FirstAidResult => {
  const [d1, d2] = roll2D6(rng)
  const roll = d1 + d2 + skillFor(medic, 'Medicine') + characteristicDm(medic.stats.dex)
  const effect = roll - 8
  return {roll, effect, heal: effect > 0 ? effect * 2 : 0}
}

/** Restore `amount` points, END first then STR then DEX, each capped at its max. */
export const applyHeal = (entity: Entity, amount: number): Entity => {
  if (amount <= 0) return entity
  let {str, dex, end} = entity.stats
  const max = entity.statsMax
  let remaining = amount
  const give = (current: number, ceiling: number): number => {
    const room = Math.min(ceiling - current, remaining)
    remaining -= Math.max(0, room)
    return current + Math.max(0, room)
  }
  end = give(end, max.end)
  str = give(str, max.str)
  dex = give(dex, max.dex)
  return {...entity, stats: {str, dex, end}}
}

/** END as the headline "health" number (the buffer that soaks damage first). */
export const healthBar = (entity: Entity): {value: number; max: number} => ({
  value: entity.stats.end,
  max: entity.statsMax.end
})
