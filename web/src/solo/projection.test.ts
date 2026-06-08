import {describe, expect, it} from 'vitest'
import {makeRng} from '../synth/rng'
import {canSeePoint} from './model'
import {projectController} from './projection'
import {createSoloGame} from './setup'

describe('projectController — per-character line of sight', () => {
  it('lists only the monsters this character can personally see (no aimbot through walls)', () => {
    const state = createSoloGame(1234, makeRng(1234))
    const pc = state.entities.find((e) => e.faction === 'pc')
    if (!pc) throw new Error('expected a PC')
    const view = projectController(state, pc.id)

    // Every listed foe is genuinely visible to THIS character.
    for (const row of view.foes) {
      const foe = state.entities.find((e) => e.id === row.id)
      if (!foe) throw new Error('foe row references a missing entity')
      expect(canSeePoint(state, pc, foe.x, foe.y)).toBe(true)
    }

    // Monsters spawn at far airlocks, so some are hidden from this PC — and those
    // are ABSENT from the list, not merely flagged.
    const monsters = state.entities.filter((e) => e.faction === 'monster')
    const hidden = monsters.filter((m) => !canSeePoint(state, pc, m.x, m.y))
    expect(hidden.length).toBeGreaterThan(0)
    const listed = new Set(view.foes.map((f) => f.id))
    for (const h of hidden) expect(listed.has(h.id)).toBe(false)
  })

  it('gates per character, not per squad: two PCs can see different foe sets', () => {
    const state = createSoloGame(1234, makeRng(1234))
    const pcs = state.entities.filter((e) => e.faction === 'pc')
    const sets = pcs.map((pc) => new Set(projectController(state, pc.id).foes.map((f) => f.id)))
    // Each PC's list is exactly its own LOS — never the union — so for every PC,
    // every foe it lists is one IT can see (already covered) and no PC's list
    // includes a foe only a teammate sees.
    for (let i = 0; i < pcs.length; i += 1) {
      for (const id of sets[i]) {
        const foe = state.entities.find((e) => e.id === id)
        if (!foe) throw new Error('missing foe')
        expect(canSeePoint(state, pcs[i], foe.x, foe.y)).toBe(true)
      }
    }
  })

  it('surfaces the character HUD (own data, no LOS gate)', () => {
    const state = createSoloGame(99, makeRng(99))
    const pc = state.entities.find((e) => e.faction === 'pc')
    if (!pc) throw new Error('expected a PC')
    const me = projectController(state, pc.id).me
    expect(me?.id).toBe(pc.id)
    expect(me?.end).toBe(pc.stats.end)
    expect(me?.weapon).toBeTruthy()
  })
})
