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

export type AnalysisResult = {
  width: number
  height: number
  grid_scale: number
  occluders: Occluder[]
  stats: {
    dark_pixels: number
    horizontal_candidates: number
    vertical_candidates: number
    door_candidates: number
  }
}

type Segment = {
  x1: number
  y1: number
  x2: number
  y2: number
}

type Candidate = Segment & {
  horizontal: boolean
  length: number
}

type DoorState = boolean | {open: boolean}
type DoorStateLookup = Record<string, DoorState | undefined>

export const analyzeImageRgba = (
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  gridScale: number
): AnalysisResult => {
  if (width <= 0 || height <= 0) {
    throw new Error('Image dimensions must be positive.')
  }

  const expectedLength = width * height * 4
  if (rgba.length !== expectedLength) {
    throw new Error('RGBA buffer length does not match image dimensions.')
  }

  const effectiveGrid = Number.isFinite(gridScale) && gridScale > 0 ? gridScale : 50
  const mask = buildDarkMask(width, height, rgba)
  const darkPixels = mask.reduce((count, dark) => count + dark, 0)
  const minRun = Math.floor(Math.max(effectiveGrid * 0.45, 18))
  const snap = Math.max(effectiveGrid / 4, 4)

  let horizontal = scanHorizontal(width, height, mask, minRun, snap)
  let vertical = scanVertical(width, height, mask, minRun, snap)
  horizontal = collapseCandidates(horizontal, snap)
  vertical = collapseCandidates(vertical, snap)

  const doorCandidates = detectDoorCandidates(
    horizontal,
    vertical,
    width,
    height,
    mask,
    effectiveGrid,
    snap
  )

  const walls = [...horizontal, ...vertical]
    .sort((first, second) => second.length - first.length)
    .slice(0, 500)
    .map<WallOccluder>((candidate, index) => ({
      type: 'wall',
      id: `wall-${String(index + 1).padStart(4, '0')}`,
      x1: clamp(candidate.x1, 0, width),
      y1: clamp(candidate.y1, 0, height),
      x2: clamp(candidate.x2, 0, width),
      y2: clamp(candidate.y2, 0, height)
    }))

  const doors = doorCandidates.map<DoorOccluder>((candidate, index) => ({
    type: 'door',
    id: `door-${String(index + 1).padStart(4, '0')}`,
    x1: clamp(candidate.x1, 0, width),
    y1: clamp(candidate.y1, 0, height),
    x2: clamp(candidate.x2, 0, width),
    y2: clamp(candidate.y2, 0, height),
    open: false
  }))

  return {
    width,
    height,
    grid_scale: effectiveGrid,
    occluders: [...walls, ...doors],
    stats: {
      dark_pixels: darkPixels,
      horizontal_candidates: horizontal.length,
      vertical_candidates: vertical.length,
      door_candidates: doorCandidates.length
    }
  }
}

export const hasLineOfSight = (
  from: Point,
  to: Point,
  occluders: Occluder[],
  doorStates: DoorStateLookup
): boolean => {
  const sight = {x1: from.x, y1: from.y, x2: to.x, y2: to.y}
  return !occluders
    .filter((occluder) => isBlocking(occluder, doorStates))
    .some((occluder) => segmentsIntersect(sight, segmentFor(occluder)))
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
  const segments = [
    ...occluders.filter((occluder) => isBlocking(occluder, doorStates)).map(segmentFor),
    ...boardSegments(width, height)
  ]
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

const buildDarkMask = (
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray
): Uint8Array => {
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const r = rgba[index]
      const g = rgba[index + 1]
      const b = rgba[index + 2]
      const a = rgba[index + 3]
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
      mask[y * width + x] = a > 32 && luminance < 58 ? 1 : 0
    }
  }
  return mask
}

const scanHorizontal = (
  width: number,
  height: number,
  mask: Uint8Array,
  minRun: number,
  snap: number
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let y = 0; y < height; y += 1) {
    let x = 0
    while (x < width) {
      while (x < width && mask[y * width + x] === 0) x += 1
      const start = x
      while (x < width && mask[y * width + x] === 1) x += 1
      const end = x
      if (end > start && end - start >= minRun) {
        const x1 = snapValue(start, snap)
        const x2 = snapValue(end, snap)
        const y1 = snapValue(y, snap)
        candidates.push({
          horizontal: true,
          x1,
          y1,
          x2,
          y2: y1,
          length: Math.abs(x2 - x1)
        })
      }
    }
  }
  return candidates
}

const scanVertical = (
  width: number,
  height: number,
  mask: Uint8Array,
  minRun: number,
  snap: number
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let x = 0; x < width; x += 1) {
    let y = 0
    while (y < height) {
      while (y < height && mask[y * width + x] === 0) y += 1
      const start = y
      while (y < height && mask[y * width + x] === 1) y += 1
      const end = y
      if (end > start && end - start >= minRun) {
        const y1 = snapValue(start, snap)
        const y2 = snapValue(end, snap)
        const x1 = snapValue(x, snap)
        candidates.push({
          horizontal: false,
          x1,
          y1,
          x2: x1,
          y2,
          length: Math.abs(y2 - y1)
        })
      }
    }
  }
  return candidates
}

const collapseCandidates = (candidates: Candidate[], snap: number): Candidate[] => {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = [
      candidate.horizontal,
      quantize(candidate.x1, snap),
      quantize(candidate.y1, snap),
      quantize(candidate.x2, snap),
      quantize(candidate.y2, snap)
    ].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const dedupeOverlappingDoors = (doors: Candidate[], snap: number): Candidate[] => {
  const kept: Candidate[] = []
  for (const door of doors) {
    if (!kept.some((existing) => candidatesOverlap(existing, door, snap))) {
      kept.push(door)
    }
  }
  return kept
}

const candidatesOverlap = (first: Candidate, second: Candidate, snap: number): boolean => {
  if (first.horizontal !== second.horizontal) return false

  const firstLine = first.horizontal ? first.y1 : first.x1
  const secondLine = second.horizontal ? second.y1 : second.x1
  if (Math.abs(firstLine - secondLine) > snap) return false

  const [firstStart, firstEnd] = candidateInterval(first)
  const [secondStart, secondEnd] = candidateInterval(second)
  const overlap = Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart)
  if (overlap <= 0) return false

  const shorter = Math.min(firstEnd - firstStart, secondEnd - secondStart)
  return overlap >= shorter * 0.6
}

const candidateInterval = (candidate: Candidate): [number, number] => {
  const first = candidate.horizontal ? candidate.x1 : candidate.y1
  const second = candidate.horizontal ? candidate.x2 : candidate.y2
  return first <= second ? [first, second] : [second, first]
}

const detectDoorCandidates = (
  horizontal: Candidate[],
  vertical: Candidate[],
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number,
  snap: number
): Candidate[] => {
  const doors = [
    ...detectAxisGapDoorCandidates(horizontal, true, gridScale, snap),
    ...detectAxisGapDoorCandidates(vertical, false, gridScale, snap),
    ...detectSlidingDoorCandidates(width, height, mask, horizontal, vertical, gridScale, snap)
  ]
  return dedupeOverlappingDoors(
    collapseCandidates(doors, snap).sort((first, second) => second.length - first.length),
    snap
  ).slice(0, 200)
}

const detectAxisGapDoorCandidates = (
  candidates: Candidate[],
  horizontal: boolean,
  gridScale: number,
  snap: number
): Candidate[] => {
  const minGap = Math.max(gridScale * 0.3, 14)
  const maxGap = Math.max(gridScale * 1.15, minGap + 1)
  const minSupport = Math.max(gridScale * 0.7, 32)
  const gridTolerance = Math.max(gridScale * 0.18, snap)
  const byLine = new Map<number, Candidate[]>()

  for (const candidate of candidates) {
    if (candidate.horizontal !== horizontal || candidate.length < minSupport) continue
    const lineCoord = horizontal ? candidate.y1 : candidate.x1
    if (!nearGridLine(lineCoord, gridScale, gridTolerance)) continue
    const key = quantize(lineCoord, snap)
    byLine.set(key, [...(byLine.get(key) ?? []), candidate])
  }

  const doors: Candidate[] = []
  for (const lineCandidates of byLine.values()) {
    lineCandidates.sort((first, second) => axisStart(first) - axisStart(second))
    for (let index = 0; index < lineCandidates.length - 1; index += 1) {
      const left = lineCandidates[index]
      const right = lineCandidates[index + 1]
      const leftEnd = axisEnd(left)
      const rightStart = axisStart(right)
      const gap = rightStart - leftEnd
      if (gap < minGap || gap > maxGap) continue

      const lineCoord = horizontal ? average(left.y1, right.y1) : average(left.x1, right.x1)
      doors.push(
        horizontal
          ? {
              horizontal: true,
              x1: leftEnd,
              y1: lineCoord,
              x2: rightStart,
              y2: lineCoord,
              length: gap
            }
          : {
              horizontal: false,
              x1: lineCoord,
              y1: leftEnd,
              x2: lineCoord,
              y2: rightStart,
              length: gap
            }
      )
    }
  }

  return doors
}

const detectSlidingDoorCandidates = (
  width: number,
  height: number,
  mask: Uint8Array,
  horizontalWalls: Candidate[],
  verticalWalls: Candidate[],
  gridScale: number,
  snap: number
): Candidate[] => {
  const minLength = Math.max(gridScale * 0.28, 12)
  const maxLength = Math.max(gridScale * 1.25, minLength + 1)
  const doors = [
    ...detectHorizontalSlidingDoors(
      scanShortHorizontal(width, height, mask, minLength, maxLength),
      width,
      height,
      mask,
      horizontalWalls,
      gridScale,
      snap
    ),
    ...detectVerticalSlidingDoors(
      scanShortVertical(width, height, mask, minLength, maxLength),
      width,
      height,
      mask,
      verticalWalls,
      gridScale,
      snap
    )
  ]
  return collapseCandidates(doors, snap)
}

const detectHorizontalSlidingDoors = (
  runs: Candidate[],
  width: number,
  height: number,
  mask: Uint8Array,
  walls: Candidate[],
  gridScale: number,
  snap: number
): Candidate[] => {
  const minThickness = 3
  const maxThickness = Math.max(gridScale * 0.18, 8)
  const spanTolerance = Math.max(gridScale * 0.12, 5)
  const gridTolerance = Math.max(gridScale * 0.2, snap)
  const minSnappedLength = Math.max(gridScale * 0.35, 18)
  const doors: Candidate[] = []

  for (let index = 0; index < runs.length; index += 1) {
    const top = runs[index]
    for (let next = index + 1; next < runs.length; next += 1) {
      const bottom = runs[next]
      const thickness = bottom.y1 - top.y1
      if (thickness < minThickness) continue
      if (thickness > maxThickness) break
      if (Math.abs(top.x1 - bottom.x1) > spanTolerance) continue
      if (Math.abs(top.x2 - bottom.x2) > spanTolerance) continue

      const x1 = average(top.x1, bottom.x1)
      const x2 = average(top.x2, bottom.x2)
      const y = average(top.y1, bottom.y1)
      const length = Math.abs(x2 - x1)

      if (!nearGridLine(y, gridScale, gridTolerance)) continue
      if (!hasSlidingEndCaps(width, height, mask, true, x1, top.y1, x2, bottom.y1)) continue
      if (!slidingInteriorClear(width, height, mask, x1, top.y1, x2, bottom.y1)) continue
      if (!hasCollinearWallSupport(walls, true, x1, x2, y, gridScale)) continue

      const snappedX1 = snapValue(x1, snap)
      const snappedX2 = snapValue(x2, snap)
      const snappedY = snapValue(y, snap)
      if (Math.abs(snappedX2 - snappedX1) < minSnappedLength) continue
      doors.push({
        horizontal: true,
        x1: snappedX1,
        y1: snappedY,
        x2: snappedX2,
        y2: snappedY,
        length
      })
    }
  }

  return doors
}

const detectVerticalSlidingDoors = (
  runs: Candidate[],
  width: number,
  height: number,
  mask: Uint8Array,
  walls: Candidate[],
  gridScale: number,
  snap: number
): Candidate[] => {
  const minThickness = 3
  const maxThickness = Math.max(gridScale * 0.18, 8)
  const spanTolerance = Math.max(gridScale * 0.12, 5)
  const gridTolerance = Math.max(gridScale * 0.2, snap)
  const minSnappedLength = Math.max(gridScale * 0.35, 18)
  const doors: Candidate[] = []

  for (let index = 0; index < runs.length; index += 1) {
    const left = runs[index]
    for (let next = index + 1; next < runs.length; next += 1) {
      const right = runs[next]
      const thickness = right.x1 - left.x1
      if (thickness < minThickness) continue
      if (thickness > maxThickness) break
      if (Math.abs(left.y1 - right.y1) > spanTolerance) continue
      if (Math.abs(left.y2 - right.y2) > spanTolerance) continue

      const x = average(left.x1, right.x1)
      const y1 = average(left.y1, right.y1)
      const y2 = average(left.y2, right.y2)
      const length = Math.abs(y2 - y1)

      if (!nearGridLine(x, gridScale, gridTolerance)) continue
      if (!hasSlidingEndCaps(width, height, mask, false, left.x1, y1, right.x1, y2)) continue
      if (!slidingInteriorClear(width, height, mask, left.x1, y1, right.x1, y2)) continue
      if (!hasCollinearWallSupport(walls, false, y1, y2, x, gridScale)) continue

      const snappedX = snapValue(x, snap)
      const snappedY1 = snapValue(y1, snap)
      const snappedY2 = snapValue(y2, snap)
      if (Math.abs(snappedY2 - snappedY1) < minSnappedLength) continue
      doors.push({
        horizontal: false,
        x1: snappedX,
        y1: snappedY1,
        x2: snappedX,
        y2: snappedY2,
        length
      })
    }
  }

  return doors
}

const scanShortHorizontal = (
  width: number,
  height: number,
  mask: Uint8Array,
  minLength: number,
  maxLength: number
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let y = 0; y < height; y += 1) {
    let x = 0
    while (x < width) {
      while (x < width && mask[y * width + x] === 0) x += 1
      const start = x
      while (x < width && mask[y * width + x] === 1) x += 1
      const end = x
      const length = end - start
      if (length >= minLength && length <= maxLength) {
        candidates.push({
          horizontal: true,
          x1: start,
          y1: y,
          x2: end,
          y2: y,
          length
        })
      }
    }
  }
  return candidates
}

const scanShortVertical = (
  width: number,
  height: number,
  mask: Uint8Array,
  minLength: number,
  maxLength: number
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let x = 0; x < width; x += 1) {
    let y = 0
    while (y < height) {
      while (y < height && mask[y * width + x] === 0) y += 1
      const start = y
      while (y < height && mask[y * width + x] === 1) y += 1
      const end = y
      const length = end - start
      if (length >= minLength && length <= maxLength) {
        candidates.push({
          horizontal: false,
          x1: x,
          y1: start,
          x2: x,
          y2: end,
          length
        })
      }
    }
  }
  return candidates
}

const hasSlidingEndCaps = (
  width: number,
  height: number,
  mask: Uint8Array,
  horizontal: boolean,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean =>
  horizontal
    ? hasDarkSpan(width, height, mask, false, x1, y1, y2) &&
      hasDarkSpan(width, height, mask, false, x2, y1, y2)
    : hasDarkSpan(width, height, mask, true, y1, x1, x2) &&
      hasDarkSpan(width, height, mask, true, y2, x1, x2)

const hasDarkSpan = (
  width: number,
  height: number,
  mask: Uint8Array,
  horizontal: boolean,
  lineCoord: number,
  start: number,
  end: number
): boolean => {
  const radius = 2
  let dark = 0
  if (horizontal) {
    const [yStart, yEnd] = boundedRange(lineCoord - radius, lineCoord + radius, height)
    const [xStart, xEnd] = boundedRange(start, end, width)
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        dark += mask[y * width + x]
      }
    }
  } else {
    const [yStart, yEnd] = boundedRange(start, end, height)
    const [xStart, xEnd] = boundedRange(lineCoord - radius, lineCoord + radius, width)
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        dark += mask[y * width + x]
      }
    }
  }

  return dark >= 2
}

const slidingInteriorClear = (
  width: number,
  height: number,
  mask: Uint8Array,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean => {
  const inset = 2
  let dark = 0
  let samples = 0
  const [yStart, yEnd] = boundedRange(y1 + inset, y2 - inset, height)
  const [xStart, xEnd] = boundedRange(x1 + inset, x2 - inset, width)
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      samples += 1
      dark += mask[y * width + x]
    }
  }

  return samples === 0 || dark / samples <= 0.12
}

const hasCollinearWallSupport = (
  walls: Candidate[],
  horizontal: boolean,
  start: number,
  end: number,
  lineCoord: number,
  gridScale: number
): boolean => {
  const lineTolerance = Math.max(gridScale * 0.18, 8)
  const endpointTolerance = Math.max(gridScale * 0.45, 16)
  const minSupport = Math.max(gridScale * 0.7, 32)

  return walls.some((wall) => {
    if (wall.horizontal !== horizontal || wall.length < minSupport) return false
    const wallLine = horizontal ? wall.y1 : wall.x1
    if (Math.abs(wallLine - lineCoord) > lineTolerance) return false

    const wallStart = axisStart(wall)
    const wallEnd = axisEnd(wall)
    return (
      Math.abs(wallEnd - start) <= endpointTolerance ||
      Math.abs(wallStart - end) <= endpointTolerance
    )
  })
}

const boundedRange = (start: number, end: number, limit: number): [number, number] => [
  Math.floor(clamp(start, 0, limit)),
  Math.ceil(clamp(end, 0, limit))
]

const axisStart = (candidate: Candidate): number =>
  candidate.horizontal
    ? Math.min(candidate.x1, candidate.x2)
    : Math.min(candidate.y1, candidate.y2)

const axisEnd = (candidate: Candidate): number =>
  candidate.horizontal
    ? Math.max(candidate.x1, candidate.x2)
    : Math.max(candidate.y1, candidate.y2)

const nearGridLine = (value: number, gridScale: number, tolerance: number): boolean => {
  if (!Number.isFinite(value) || !Number.isFinite(gridScale) || gridScale <= 0) return true
  const offset = ((value % gridScale) + gridScale) % gridScale
  return Math.min(offset, gridScale - offset) <= tolerance
}

const average = (first: number, second: number): number => (first + second) / 2

const snapValue = (value: number, snap: number): number => Math.round(value / snap) * snap

const quantize = (value: number, snap: number): number => Math.round(value / snap)

const segmentFor = (occluder: Occluder): Segment => ({
  x1: occluder.x1,
  y1: occluder.y1,
  x2: occluder.x2,
  y2: occluder.y2
})

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

const segmentsIntersect = (first: Segment, second: Segment): boolean => {
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

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))
