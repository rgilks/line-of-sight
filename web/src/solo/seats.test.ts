import {describe, expect, it} from 'vitest'
import type {Entity, Seat} from './model'
import {redistribute} from './seats'

// redistribute only reads id/order/owner, so a partial cast is enough.
const pc = (id: string, order: number, owner?: string): Entity => ({id, order, owner}) as unknown as Entity
const seat = (id: string, joinedAt: number): Seat => ({id, joinedAt})
const ownerOf = (rows: {pcId: string; owner: string | null}[], id: string) => rows.find((r) => r.pcId === id)?.owner
const counts = (rows: {pcId: string; owner: string | null}[]): Record<string, number> => {
  const m: Record<string, number> = {}
  for (const r of rows) if (r.owner) m[r.owner] = (m[r.owner] ?? 0) + 1
  return m
}
const FOUR = (owner?: string): Entity[] => [pc('A', 0, owner), pc('B', 1, owner), pc('C', 2, owner), pc('D', 3, owner)]

describe('redistribute seats', () => {
  it('leaves every piece unowned when there are no seats (offline)', () => {
    expect(redistribute([], FOUR()).every((r) => r.owner === null)).toBe(true)
  })

  it('splits 4 pieces evenly: 1→[4], 2→[2,2], 3→[2,1,1], 4→[1,1,1,1]', () => {
    expect(counts(redistribute([seat('h', 1)], FOUR('h')))).toEqual({h: 4})
    expect(counts(redistribute([seat('h', 1), seat('p2', 2)], FOUR('h')))).toEqual({h: 2, p2: 2})
    expect(counts(redistribute([seat('h', 1), seat('p2', 2), seat('p3', 3)], FOUR('h')))).toEqual({h: 2, p2: 1, p3: 1})
    const four = redistribute([seat('h', 1), seat('p2', 2), seat('p3', 3), seat('p4', 4)], FOUR('h'))
    expect(counts(four)).toEqual({h: 1, p2: 1, p3: 1, p4: 1})
  })

  it('makes seats beyond the piece count spectators (own nothing)', () => {
    const seats = [seat('h', 1), seat('p2', 2), seat('p3', 3), seat('p4', 4), seat('p5', 5)]
    const rows = redistribute(seats, FOUR('h'))
    expect(counts(rows)).toEqual({h: 1, p2: 1, p3: 1, p4: 1}) // p5 owns nothing
  })

  it('is sticky: a joiner takes from the host, not from another human', () => {
    // Host owns A,B; p2 owns C,D. p3 joins → host 2, p2 keeps 1, p3 gets 1.
    const pcs = [pc('A', 0, 'h'), pc('B', 1, 'h'), pc('C', 2, 'p2'), pc('D', 3, 'p2')]
    const rows = redistribute([seat('h', 1), seat('p2', 2), seat('p3', 3)], pcs, 'A')
    expect(ownerOf(rows, 'A')).toBe('h')
    expect(ownerOf(rows, 'B')).toBe('h')
    expect(ownerOf(rows, 'C')).toBe('p2') // p2 keeps one
    expect(ownerOf(rows, 'D')).toBe('p3') // the surplus one goes to the joiner
  })

  it('never reassigns the currently-active piece away from its owner', () => {
    // All host-owned; C is active. Splitting to 2 seats must keep C with the host.
    const rows = redistribute([seat('h', 1), seat('p2', 2)], FOUR('h'), 'C')
    expect(ownerOf(rows, 'C')).toBe('h')
    expect(counts(rows)).toEqual({h: 2, p2: 2})
  })

  it('re-absorbs an orphaned piece when its owner leaves', () => {
    // p4 left: B is owned by the departed seat. With host,p2,p3 present the host
    // (under quota) re-absorbs B.
    const pcs = [pc('A', 0, 'h'), pc('B', 1, 'p4'), pc('C', 2, 'p2'), pc('D', 3, 'p3')]
    const rows = redistribute([seat('h', 1), seat('p2', 2), seat('p3', 3)], pcs, 'A')
    expect(counts(rows)).toEqual({h: 2, p2: 1, p3: 1})
    expect(ownerOf(rows, 'B')).toBe('h')
  })
})
