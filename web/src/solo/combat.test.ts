import {describe, expect, it} from 'vitest'
import type {Rng} from '../../../core/dice'
import type {Entity} from './model'
import {isDead, isDown} from './model'
import {applyDamage, applyHeal, predictAttack, resolveAttack, resolveFirstAid, stanceAttackDm} from './combat'

// Deterministic dice: each call yields the next face (1..6) mapped to mid-bucket
// so rollD6 returns exactly that face. Attack throws consume 2 faces, then weapon
// damage consumes one per die.
const seqRng = (faces: number[]): Rng => {
  let i = 0
  return () => {
    const face = faces[i % faces.length]
    i += 1
    return (face - 0.5) / 6
  }
}

const ent = (over: Partial<Entity>): Entity => ({
  id: 'e',
  faction: 'pc',
  kind: 'marine',
  label: 'E',
  x: 0,
  y: 0,
  stats: {str: 7, dex: 7, end: 7},
  statsMax: {str: 7, dex: 7, end: 7},
  skills: {},
  weaponId: 'blade',
  armorId: null,
  inventory: [],
  loadedRounds: 0,
  stance: 'standing',
  aim: 0,
  initiative: null,
  order: 0,
  ...over
})

describe('resolveAttack', () => {
  it('lands a hit and subtracts armour from damage', () => {
    const attacker = ent({skills: {'Gun Combat': 2}, stats: {str: 9, dex: 8, end: 10}, weaponId: 'autorifle'})
    const target = ent({armorId: 'cloth', x: 120, y: 0}) // ~5 m → short
    // attack 2D6 = 5,5 → 10 +2(skill) +0(dexDm 8) +1(autorifle short) = 13, effect 5
    // damage 3D6 = 4,4,4 = 12 +5(effect) = 17 − 5(cloth) = 12
    const result = resolveAttack(attacker, target, seqRng([5, 5, 4, 4, 4]), 36)
    expect(result).toMatchObject({hit: true, effect: 5, band: 'short', outOfRange: false})
    expect(result.damage).toBe(12)
  })

  it('misses when the throw falls short of 8+', () => {
    const attacker = ent({skills: {'Gun Combat': 2}, stats: {str: 9, dex: 8, end: 10}, weaponId: 'autorifle'})
    const target = ent({armorId: 'cloth', x: 120, y: 0})
    const result = resolveAttack(attacker, target, seqRng([1, 1]), 36) // 2+2+0+1 = 5 → effect −3
    expect(result.hit).toBe(false)
    expect(result.damage).toBe(0)
  })

  it('still inflicts ≥1 on an Effect of 6+ even through heavy armour', () => {
    const attacker = ent({skills: {'Gun Combat': 3}, stats: {str: 7, dex: 12, end: 7}, weaponId: 'autopistol'})
    const target = ent({armorId: 'combat', x: 48, y: 0}) // ~2 m → close
    // 2D6 = 6,5 → 11 +3 +2(dexDm 12) +0(close) = 16, effect 8
    // damage 3D6−3 = (1+1+1)−3 = 0 +8 = 8 − 8(combat) = 0 → floored to 1
    const result = resolveAttack(attacker, target, seqRng([6, 5, 1, 1, 1]), 36)
    expect(result.effect).toBe(8)
    expect(result.damage).toBe(1)
  })

  it('Aim adds its DM to the to-hit throw', () => {
    const attacker = ent({skills: {'Gun Combat': 0}, stats: {str: 7, dex: 7, end: 7}, weaponId: 'autopistol'})
    const target = ent({x: 48, y: 0}) // ~2 m → close
    const noAim = predictAttack(attacker, target, 36, 3, 4) // 7 → effect −1, miss
    expect(noAim.hit).toBe(false)
    const aimed = predictAttack({...attacker, aim: 2}, target, 36, 3, 4) // 7 + 2 → effect 1, hit
    expect(aimed.hit).toBe(true)
    expect(aimed.effect).toBe(noAim.effect + 2)
  })

  it('applies prone stance DMs to ranged attacks', () => {
    const prone = ent({stance: 'prone'})
    expect(stanceAttackDm(prone, 'personal')).toBe(2)
    expect(stanceAttackDm(prone, 'close')).toBe(0)
    expect(stanceAttackDm(prone, 'short')).toBe(-2)
    expect(stanceAttackDm(ent({stance: 'standing'}), 'medium')).toBe(0)
  })

  it('blocks melee attacks while prone', () => {
    const attacker = ent({stance: 'prone', weaponId: 'blade', skills: {'Melee Combat': 2}})
    const target = ent({x: 20, y: 0})
    const result = resolveAttack(attacker, target, seqRng([6, 6]), 36)
    expect(result.outOfRange).toBe(true)
    expect(result.hit).toBe(false)
  })

  it('reports out of range when the band is beyond the weapon', () => {
    const attacker = ent({weaponId: 'blade', skills: {'Melee Combat': 1}})
    const target = ent({x: 120, y: 0}) // short — a blade only reaches personal
    const result = resolveAttack(attacker, target, seqRng([6, 6]), 36)
    expect(result.outOfRange).toBe(true)
    expect(result.hit).toBe(false)
  })
})

describe('applyDamage — END then STR/DEX cascade', () => {
  it('spends END first, then the larger physical', () => {
    const after = applyDamage(ent({stats: {str: 7, dex: 7, end: 7}}), 10)
    expect(after.stats).toEqual({str: 4, dex: 7, end: 0}) // 7 to END, 3 to STR (≥ DEX)
    expect(isDown(after)).toBe(false)
  })

  it('downs a character when STR or DEX reaches 0 (END at 0 alone does not)', () => {
    const endGone = applyDamage(ent({stats: {str: 7, dex: 7, end: 7}}), 7)
    expect(endGone.stats.end).toBe(0)
    expect(isDown(endGone)).toBe(false) // END 0 only — still up

    const downed = applyDamage(ent({stats: {str: 7, dex: 7, end: 7}}), 20)
    expect(downed.stats.str).toBe(0)
    expect(isDown(downed)).toBe(true)
    expect(isDead(downed)).toBe(false)
  })

  it('kills when all three physicals reach 0', () => {
    const dead = applyDamage(ent({stats: {str: 7, dex: 7, end: 7}}), 30)
    expect(dead.stats).toEqual({str: 0, dex: 0, end: 0})
    expect(isDead(dead)).toBe(true)
  })
})

describe('first aid', () => {
  it('restores 2 × Effect, capped at max, END first', () => {
    const medic = ent({skills: {Medicine: 2}, stats: {str: 6, dex: 7, end: 8}})
    const aid = resolveFirstAid(medic, seqRng([5, 5])) // 10 +2 +0 = 12, effect 4 → heal 8
    expect(aid.heal).toBe(8)
    const patient = ent({stats: {str: 7, dex: 5, end: 1}, statsMax: {str: 7, dex: 7, end: 8}})
    const healed = applyHeal(patient, aid.heal) // +7 END (to 8), +1 DEX… STR is full
    expect(healed.stats.end).toBe(8)
    expect(healed.stats.dex).toBe(6)
  })
})
