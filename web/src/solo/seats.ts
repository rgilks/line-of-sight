// Pure seat → piece ownership for multiplayer companion play. The PCs redistribute
// evenly across the present seats as players join and leave: 1 seat owns all 4, 2
// seats own 2 each, 3 → 2/1/1, 4 → 1/1/1/1; seats beyond the piece count spectate
// (own nothing). Earlier-joined seats (the host first) take any remainder.
//
// Redistribution is STICKY: each seat keeps the pieces it already owns up to its new
// quota — prioritising the currently-active piece, so the player whose turn it is is
// never handed someone else's character or has their own taken mid-turn — and only
// the minimum pieces move. A piece whose owner has left, or that is surplus to an
// over-quota seat (the host shedding pieces as players join), goes into a pool that
// fills the seats still under quota. The result is the FULL new ownership map, which
// the reducer folds wholesale (no recompute in fold → deterministic replay).
import type {Entity, Seat} from './model'

export type SeatAssignment = {pcId: string; owner: string | null}

// Distribute `pieces` as evenly as possible across `seatCount` seats; earlier seats
// get the larger share (e.g. 4 pieces over 3 seats → [2, 1, 1]).
const targetCounts = (seatCount: number, pieces: number): number[] => {
  if (seatCount <= 0) return []
  const base = Math.floor(pieces / seatCount)
  const extra = pieces % seatCount
  return Array.from({length: seatCount}, (_, i) => base + (i < extra ? 1 : 0))
}

export const redistribute = (seats: Seat[], pcs: Entity[], activeId?: string): SeatAssignment[] => {
  const pieces = [...pcs].sort((a, b) => a.order - b.order)
  const ordered = [...seats].sort((a, b) => a.joinedAt - b.joinedAt)
  // No seats (offline / pre-promotion) → everything unowned.
  if (ordered.length === 0) return pieces.map((p) => ({pcId: p.id, owner: null}))

  const seatIds = new Set(ordered.map((s) => s.id))
  // Only the earliest `pieces.length` seats own pieces; the rest spectate.
  const owners = ordered.slice(0, pieces.length)
  const counts = targetCounts(owners.length, pieces.length)
  const quota = new Map(owners.map((seat, i) => [seat.id, counts[i]]))

  const assigned = new Map<string, string>() // pcId -> owner seat id
  // Pass 1 — each owner keeps the pieces it already holds, up to quota, active first
  // (so the active piece's owner always retains it).
  for (const seat of owners) {
    const held = pieces
      .filter((p) => p.owner === seat.id && seatIds.has(seat.id))
      .sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : a.order - b.order))
    for (const p of held.slice(0, quota.get(seat.id) ?? 0)) assigned.set(p.id, seat.id)
  }
  // Pass 2 — pieces not kept (surplus, or whose owner has left/none) fill the seats
  // still under quota, earliest first.
  const pool = pieces.filter((p) => !assigned.has(p.id))
  let next = 0
  for (const seat of owners) {
    const have = [...assigned.values()].filter((id) => id === seat.id).length
    for (let need = (quota.get(seat.id) ?? 0) - have; need > 0 && next < pool.length; need -= 1, next += 1) {
      assigned.set(pool[next].id, seat.id)
    }
  }
  return pieces.map((p) => ({pcId: p.id, owner: assigned.get(p.id) ?? null}))
}
