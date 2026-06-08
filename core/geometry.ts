// Low-level geometry shared by both halves of the line-of-sight core: the raster
// detection pipeline (./detect) and the visibility geometry (./visibility).
// Holds the public occluder/point types, the door-state lookup shapes, the
// internal segment type, and the segment-intersection primitive both halves need.

export type Point = {
  x: number
  y: number
}

export type WallOccluder = {
  type: 'wall'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export type DoorOccluder = {
  type: 'door'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  open: boolean
}

export type Occluder = WallOccluder | DoorOccluder

export type Segment = {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type DoorState = boolean | {open: boolean}
export type DoorStateLookup = Record<string, DoorState | undefined>

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export const segmentsIntersect = (first: Segment, second: Segment): boolean => {
  const p1 = {x: first.x1, y: first.y1}
  const q1 = {x: first.x2, y: first.y2}
  const p2 = {x: second.x1, y: second.y1}
  const q2 = {x: second.x2, y: second.y2}
  const o1 = orientation(p1, q1, p2)
  const o2 = orientation(p1, q1, q2)
  const o3 = orientation(p2, q2, p1)
  const o4 = orientation(p2, q2, q1)

  if (o1 !== o2 && o3 !== o4) return true
  return (
    (o1 === 0 && onSegment(p2, p1, q1)) ||
    (o2 === 0 && onSegment(q2, p1, q1)) ||
    (o3 === 0 && onSegment(p1, p2, q2)) ||
    (o4 === 0 && onSegment(q1, p2, q2))
  )
}

const orientation = (a: Point, b: Point, c: Point): -1 | 0 | 1 => {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
  if (Math.abs(value) < 0.000001) return 0
  return value > 0 ? 1 : -1
}

const onSegment = (point: Point, start: Point, end: Point): boolean =>
  point.x >= Math.min(start.x, end.x) - 0.000001 &&
  point.x <= Math.max(start.x, end.x) + 0.000001 &&
  point.y >= Math.min(start.y, end.y) - 0.000001 &&
  point.y <= Math.max(start.y, end.y) + 0.000001
