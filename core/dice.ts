// Shared dice. Pure: an optional `rng` (a `() => number` in [0,1), e.g.
// `makeRng(seed)` from web/src/synth/rng) makes rolls deterministic for tests and
// the single-player game; it defaults to Math.random for casual use.
//
// Note: the multiplayer Durable Object keeps its own crypto-backed rollD6 for
// server-side fairness — `crypto.getRandomValues` is a platform concern that does
// not belong in a pure module. Same signature, two implementations, on purpose.

export type Rng = () => number

/** Roll a single six-sided die → 1..6. */
export const rollD6 = (rng: Rng = Math.random): number => 1 + Math.floor(rng() * 6)

/** Roll two six-sided dice → [a, b], each 1..6. */
export const roll2D6 = (rng: Rng = Math.random): [number, number] => [rollD6(rng), rollD6(rng)]

/** Sum of 2D6 (the common Cepheus task throw before DMs). */
export const sum2D6 = (rng: Rng = Math.random): number => {
  const [a, b] = roll2D6(rng)
  return a + b
}
