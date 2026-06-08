// Seeded PRNG (mulberry32) + helpers. Deterministic: same seed ⇒ same stream.
// Keeps generation pure and reproducible (Math.random is non-deterministic and
// banned in the core).
export type Rng = () => number

export const makeRng = (seed: number): Rng => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Integer in [min, max] inclusive.
export const randInt = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1))

export const chance = (rng: Rng, p: number): boolean => rng() < p

export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]

export const shuffle = <T>(rng: Rng, items: readonly T[]): T[] => {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
