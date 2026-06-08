import {describe, expect, it} from 'vitest'
import type {Rng} from '../../../core/dice'
import {buildWave, createSoloGame} from './setup'

// A fixed rng so initiative (and thus tie-break order) is reproducible in tests.
const fixedRng = (): Rng => () => 0.5

describe('createSoloGame', () => {
  it('builds a playable game from a seed: 4 PCs, a first wave, loot, and a player turn', () => {
    const game = createSoloGame(1234, fixedRng())
    const pcs = game.entities.filter((e) => e.faction === 'pc')
    const monsters = game.entities.filter((e) => e.faction === 'monster')
    expect(pcs).toHaveLength(4)
    expect(monsters.length).toBeGreaterThan(0)
    expect(game.wave).toBe(1)
    expect(game.phase).toEqual({t: 'playerTurn'})
    expect(game.ground.length).toBeGreaterThan(0)
    expect(game.entities.every((e) => e.initiative !== null)).toBe(true)
  })

  it('is deterministic for a fixed seed and rng (server replay)', () => {
    const a = createSoloGame(99, fixedRng())
    const b = createSoloGame(99, fixedRng())
    const fingerprint = (s: typeof a): string[] => s.entities.map((e) => `${e.id}@${e.x},${e.y}#${e.initiative}`)
    expect(fingerprint(a)).toEqual(fingerprint(b))
    expect(Object.keys(a.locks)).toEqual(Object.keys(b.locks))
  })

  it('gives later waves unique monster ids (no hidden shared counter)', () => {
    const game = createSoloGame(7, fixedRng())
    const wave1 = game.entities.filter((e) => e.faction === 'monster')
    const wave2 = buildWave(game.map, game.grid, 2)
    const ids = new Set([...wave1, ...wave2].map((e) => e.id))
    expect(ids.size).toBe(wave1.length + wave2.length) // all unique across waves
  })
})
