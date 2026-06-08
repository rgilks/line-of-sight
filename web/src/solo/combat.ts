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

/** The individual DMs that make up the to-hit throw, for a transparent log. */
export type AttackDm = {skill: number; dex: number; range: number; stance: number; aim: number}

export type AttackResult = {
  outOfRange: boolean
  hit: boolean
  roll: number // total of the 2D6 attack throw with all DMs
  effect: number // roll − 8
  band: RangeBand
  damage: number // applied to the target after armour + Effect-6 floor (0 on a miss)
  // Breakdown, so the log can show the full maths:
  dice: [number, number] // the raw 2D6 to-hit
  dm: AttackDm // the to-hit modifiers
  damageDice: number[] // the weapon's damage dice rolled (empty on a miss)
  weaponMod: number // the weapon's flat damage modifier (e.g. −3 for an autopistol)
  armour: number // target's armour subtracted from damage
}

const ZERO_DM: AttackDm = {skill: 0, dex: 0, range: 0, stance: 0, aim: 0}

/**
 * The to-hit outcome for a specific 2D6 result — pure, no rng. The throw is
 * 2D6 + combat skill + DEX DM + range-band DM + target-stance DM + the attacker's
 * accumulated Aim DM, against 8+. Used by resolveAttack and by the UI to decide
 * whether to roll (and show) the damage dice.
 */
export const predictAttack = (
  attacker: Entity,
  target: Entity,
  gridScale: number,
  d1: number,
  d2: number
): {outOfRange: boolean; hit: boolean; roll: number; effect: number; band: RangeBand; dm: AttackDm} => {
  const weapon = weaponById(attacker.weaponId)
  const band = rangeBandFor(distancePx(attacker, target), gridScale)
  const rangeDm = weapon.rangeDm[band]
  if (rangeDm === undefined || blockedByStance(attacker, weapon.skill)) {
    return {outOfRange: true, hit: false, roll: 0, effect: 0, band, dm: ZERO_DM}
  }
  const dm: AttackDm = {
    skill: skillFor(attacker, weapon.skill),
    dex: characteristicDm(attacker.stats.dex),
    range: rangeDm,
    stance: stanceAttackDm(target, band),
    aim: attacker.aim ?? 0
  }
  const roll = d1 + d2 + dm.skill + dm.dex + dm.range + dm.stance + dm.aim
  const effect = roll - 8
  return {outOfRange: false, hit: effect >= 0, roll, effect, band, dm}
}

/**
 * Resolve `attacker` shooting/striking `target` with the attacker's equipped
 * weapon. Pure: returns the outcome + a full breakdown; it does not mutate either
 * entity (apply the damage with applyDamage). Damage = weapon dice + flat modifier
 * + Effect, less armour, with the SRD Effect-6 floor of ≥1.
 */
export const resolveAttack = (attacker: Entity, target: Entity, rng?: Rng, gridScale = 36): AttackResult => {
  const weapon = weaponById(attacker.weaponId)
  const {count, mod: weaponMod} = parseDamage(weapon.damage)
  const armour = armorRating(target.armorId)
  // Range/stance are checked before rolling, so an illegal shot consumes no dice.
  const band = rangeBandFor(distancePx(attacker, target), gridScale)
  if (weapon.rangeDm[band] === undefined || blockedByStance(attacker, weapon.skill)) {
    return {
      outOfRange: true,
      hit: false,
      roll: 0,
      effect: 0,
      band,
      damage: 0,
      dice: [0, 0],
      dm: ZERO_DM,
      damageDice: [],
      weaponMod,
      armour
    }
  }
  const [d1, d2] = roll2D6(rng)
  const p = predictAttack(attacker, target, gridScale, d1, d2)
  if (!p.hit) {
    return {
      outOfRange: false,
      hit: false,
      roll: p.roll,
      effect: p.effect,
      band: p.band,
      damage: 0,
      dice: [d1, d2],
      dm: p.dm,
      damageDice: [],
      weaponMod,
      armour
    }
  }
  const damageDice: number[] = []
  for (let i = 0; i < count; i += 1) damageDice.push(rollD6(rng))
  const raw = damageDice.reduce((sum, die) => sum + die, 0) + weaponMod + p.effect
  let damage = raw - armour
  damage = p.effect >= 6 ? Math.max(1, damage) : Math.max(0, damage)
  return {
    outOfRange: false,
    hit: true,
    roll: p.roll,
    effect: p.effect,
    band: p.band,
    damage,
    dice: [d1, d2],
    dm: p.dm,
    damageDice,
    weaponMod,
    armour
  }
}

/** Human-readable log lines for a resolved attack — the full to-hit and damage maths. */
export const attackLog = (attacker: Entity, target: Entity, r: AttackResult): string[] => {
  const weapon = weaponById(attacker.weaponId)
  const skillName = weapon.skill === 'Gun Combat' ? 'Gun' : weapon.skill === 'Melee Combat' ? 'Melee' : weapon.skill
  const sgn = (n: number): string => (n >= 0 ? `+${n}` : `${n}`)
  const mods = [`${sgn(r.dm.skill)} ${skillName}`, `${sgn(r.dm.dex)} DEX`, `${sgn(r.dm.range)} ${r.band}`]
  if (r.dm.stance) mods.push(`${sgn(r.dm.stance)} stance`)
  if (r.dm.aim) mods.push(`${sgn(r.dm.aim)} aim`)
  const hitLine = `${attacker.label} → ${weapon.name}: 2D6 ${r.dice[0]}+${r.dice[1]} ${mods.join(' ')} = ${r.roll} vs 8 → ${r.hit ? 'HIT' : 'miss'} (Effect ${r.effect})`
  if (!r.hit) return [hitLine]
  const sum = r.damageDice.reduce((a, b) => a + b, 0)
  const dmg = [`${r.damageDice.join('+')}=${sum}`]
  if (r.weaponMod) dmg.push(`${sgn(r.weaponMod)} wpn`)
  dmg.push(`+${r.effect} Effect`)
  if (r.armour) dmg.push(`−${r.armour} armour`)
  return [hitLine, `  ${weapon.damage} damage: ${dmg.join(' ')} = ${r.damage} → ${target.label}`]
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

  // Taking a wound breaks concentration — any accumulated Aim is lost.
  return {...entity, aim: 0, stats: {str: Math.max(0, str), dex: Math.max(0, dex), end: Math.max(0, end)}}
}

/** Difficulty of a door-hack throw (Cepheus Average, 8+). */
export const HACK_TARGET = 8
/** The skill a door-hack throw keys off (engineers carry it; scouts a little). */
export const HACK_SKILL = 'Electronics'
export type HackResult = {roll: number; dice: [number, number]; skill: number; success: boolean}

/**
 * Attempt to hack a sealed door's lock: 2D6 + Electronics skill vs 8+. We model
 * only physical characteristics, so there is no INT/EDU DM — the skill carries the
 * throw, and the SRD unskilled −3 means it effectively takes the engineer.
 */
export const resolveHack = (hacker: Entity, rng?: Rng): HackResult => {
  const [d1, d2] = roll2D6(rng)
  const skill = hacker.skills[HACK_SKILL] ?? -3
  const roll = d1 + d2 + skill
  return {roll, dice: [d1, d2], skill, success: roll >= HACK_TARGET}
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
