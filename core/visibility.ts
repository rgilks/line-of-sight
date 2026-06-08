// Visibility geometry: line-of-sight gating and the viewer visibility polygon.
// Pure 2D segment maths over occluders plus the board edges — no raster/image
// work lives here (that is ./detect). Shared types and the segment-intersection
// primitive come from ./geometry.

import {
  clamp,
  segmentsIntersect,
  type DoorOccluder,
  type DoorStateLookup,
  type Occluder,
  type Point,
  type Segment
} from './geometry'

export const hasLineOfSight = (
  from: Point,
  to: Point,
  occluders: Occluder[],
  doorStates: DoorStateLookup
): boolean => {
  const sight = {x1: from.x, y1: from.y, x2: to.x, y2: to.y}
  return !blockingSegments(occluders, doorStates).some((segment) => segmentsIntersect(sight, segment))
}

export const visibilityPolygon = (
  viewerX: number,
  viewerY: number,
  width: number,
  height: number,
  radius: number,
  occluders: Occluder[],
  doorStates: DoorStateLookup
): Point[] => {
  if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('Board dimensions must be positive finite numbers.')
  }

  const viewer = {
    x: clamp(viewerX, 0, width),
    y: clamp(viewerY, 0, height)
  }
  const maxRadius = Number.isFinite(radius) && radius > 0 ? radius : Math.hypot(width, height)
  const segments = [...blockingSegments(occluders, doorStates), ...boardSegments(width, height)]
  const angles: number[] = []

  for (let step = 0; step < 128; step += 1) {
    angles.push((step / 128) * Math.PI * 2)
  }

  for (const segment of segments) {
    for (const point of [
      {x: segment.x1, y: segment.y1},
      {x: segment.x2, y: segment.y2}
    ]) {
      const angle = Math.atan2(point.y - viewer.y, point.x - viewer.x)
      angles.push(normalizeAngle(angle - 0.0008))
      angles.push(normalizeAngle(angle))
      angles.push(normalizeAngle(angle + 0.0008))
    }
  }

  const uniqueAngles = [...angles]
    .sort((first, second) => first - second)
    .filter((angle, index, sorted) => index === 0 || Math.abs(angle - sorted[index - 1]) >= 0.000001)

  const points = uniqueAngles
    .map((angle) => [angle, castRay(viewer, angle, maxRadius, segments)] as const)
    .sort(([first], [second]) => first - second)
    .map(([, point]) => point)

  return dedupePolygon(points)
}

const segmentFor = (occluder: Occluder): Segment => ({
  x1: occluder.x1,
  y1: occluder.y1,
  x2: occluder.x2,
  y2: occluder.y2
})

const blockingSegments = (occluders: Occluder[], doorStates: DoorStateLookup): Segment[] =>
  occluders.flatMap((occluder) => (isBlocking(occluder, doorStates) ? [segmentFor(occluder)] : []))

export const distanceToOccluder = (point: Point, occluder: Occluder): number => {
  const ax = occluder.x1
  const ay = occluder.y1
  const bx = occluder.x2
  const by = occluder.y2
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - ax, point.y - ay)
  const t = Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / lengthSquared))
  return Math.hypot(point.x - (ax + t * dx), point.y - (ay + t * dy))
}

/** How close a token must be to a door segment to operate it. */
export const doorReachForGrid = (gridScale: number): number => 1.5 * gridScale

const isOpenDoor = (door: DoorOccluder, doorStates: DoorStateLookup): boolean => {
  const state = doorStates[door.id]
  if (typeof state === 'boolean') return state
  return state?.open ?? door.open
}

const isBlocking = (occluder: Occluder, doorStates: DoorStateLookup): boolean =>
  occluder.type === 'wall' || !isOpenDoor(occluder, doorStates)

const boardSegments = (width: number, height: number): Segment[] => [
  {x1: 0, y1: 0, x2: width, y2: 0},
  {x1: width, y1: 0, x2: width, y2: height},
  {x1: width, y1: height, x2: 0, y2: height},
  {x1: 0, y1: height, x2: 0, y2: 0}
]

const castRay = (origin: Point, angle: number, radius: number, segments: Segment[]): Point => {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  let closest = {
    x: origin.x + dx * radius,
    y: origin.y + dy * radius
  }
  let closestDistance = radius

  for (const segment of segments) {
    const hit = raySegmentIntersection(origin, dx, dy, segment)
    if (hit && hit.distance >= 0 && hit.distance < closestDistance) {
      closestDistance = hit.distance
      closest = hit.point
    }
  }

  return closest
}

const normalizeAngle = (angle: number): number => {
  const normalized = angle % (Math.PI * 2)
  return normalized < 0 ? normalized + Math.PI * 2 : normalized
}

const raySegmentIntersection = (
  origin: Point,
  dx: number,
  dy: number,
  segment: Segment
): {distance: number; point: Point} | null => {
  const sx = segment.x2 - segment.x1
  const sy = segment.y2 - segment.y1
  const denominator = cross(dx, dy, sx, sy)
  if (Math.abs(denominator) < 0.000001) return null

  const qpx = segment.x1 - origin.x
  const qpy = segment.y1 - origin.y
  const rayDistance = cross(qpx, qpy, sx, sy) / denominator
  const segmentPosition = cross(qpx, qpy, dx, dy) / denominator

  if (rayDistance >= 0 && segmentPosition >= 0 && segmentPosition <= 1) {
    return {
      distance: rayDistance,
      point: {
        x: origin.x + dx * rayDistance,
        y: origin.y + dy * rayDistance
      }
    }
  }

  return null
}

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx

const dedupePolygon = (points: Point[]): Point[] => {
  const deduped: Point[] = []
  for (const point of points) {
    const last = deduped.at(-1)
    if (!last || Math.abs(last.x - point.x) >= 0.5 || Math.abs(last.y - point.y) >= 0.5) {
      deduped.push(point)
    }
  }
  return deduped
}
