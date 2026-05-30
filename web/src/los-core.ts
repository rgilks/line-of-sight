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

type Segment = {
  x1: number
  y1: number
  x2: number
  y2: number
}

type CandidateOrientation =
  | 'horizontal'
  | 'vertical'
  | 'diagonal-down'
  | 'diagonal-up'
  | 'slope-down-steep'
  | 'slope-up-steep'
  | 'slope-down-shallow'
  | 'slope-up-shallow'

type Candidate = Segment & {
  orientation: CandidateOrientation
  length: number
}

type DoorState = boolean | {open: boolean}
type DoorStateLookup = Record<string, DoorState | undefined>

export const analyzeImageRgba = (
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  gridScale: number
): Occluder[] => {
  if (width <= 0 || height <= 0) {
    throw new Error('Image dimensions must be positive.')
  }

  const expectedLength = width * height * 4
  if (rgba.length !== expectedLength) {
    throw new Error('RGBA buffer length does not match image dimensions.')
  }

  const effectiveGrid = Number.isFinite(gridScale) && gridScale > 0 ? gridScale : 50
  const mask = buildDarkMask(width, height, rgba)
  const minRun = Math.floor(Math.max(effectiveGrid * 0.45, 18))
  const snap = Math.max(effectiveGrid / 4, 4)

  let horizontal = scanHorizontal(width, height, mask, minRun, snap)
  let vertical = scanVertical(width, height, mask, minRun, snap)
  let diagonalDown = scanDiagonalDown(width, height, mask, minRun, snap)
  let diagonalUp = scanDiagonalUp(width, height, mask, minRun, snap)
  let slopeDownSteep = scanSlopedDown(
    width,
    height,
    mask,
    minRun,
    snap,
    1,
    2,
    'slope-down-steep'
  )
  let slopeUpSteep = scanSlopedUp(
    width,
    height,
    mask,
    minRun,
    snap,
    1,
    2,
    'slope-up-steep'
  )
  let slopeDownShallow = scanSlopedDown(
    width,
    height,
    mask,
    minRun,
    snap,
    2,
    1,
    'slope-down-shallow'
  )
  let slopeUpShallow = scanSlopedUp(
    width,
    height,
    mask,
    minRun,
    snap,
    2,
    1,
    'slope-up-shallow'
  )
  horizontal = collapseCandidates(horizontal, snap)
  vertical = collapseCandidates(vertical, snap)
  diagonalDown = collapseCandidates(diagonalDown, snap)
  diagonalUp = collapseCandidates(diagonalUp, snap)
  slopeDownSteep = collapseCandidates(slopeDownSteep, snap)
  slopeUpSteep = collapseCandidates(slopeUpSteep, snap)
  slopeDownShallow = collapseCandidates(slopeDownShallow, snap)
  slopeUpShallow = collapseCandidates(slopeUpShallow, snap)
  const baseHorizontal = horizontal.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )
  const baseVertical = vertical.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )
  const structuralHorizontal = promoteConnectedThinAxisCandidates(
    horizontal,
    baseHorizontal,
    vertical,
    true,
    width,
    height,
    mask,
    effectiveGrid,
    snap
  )
  const structuralVertical = promoteConnectedThinAxisCandidates(
    vertical,
    baseVertical,
    horizontal,
    false,
    width,
    height,
    mask,
    effectiveGrid,
    snap
  )
  const structuralDiagonalDown = diagonalDown.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )
  const structuralDiagonalUp = diagonalUp.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )
  const structuralSlopeDownSteep = slopeDownSteep.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )
  const structuralSlopeUpSteep = slopeUpSteep.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )
  const structuralSlopeDownShallow = slopeDownShallow.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )
  const structuralSlopeUpShallow = slopeUpShallow.filter((candidate) =>
    isStructuralWallCandidate(candidate, width, height, mask, effectiveGrid, snap)
  )

  const doorCandidates = detectDoorCandidates(
    structuralHorizontal,
    structuralVertical,
    width,
    height,
    mask,
    effectiveGrid,
    snap
  )

  const wallCandidates = refineWallCandidates(
    [
      ...structuralHorizontal,
      ...structuralVertical,
      ...structuralDiagonalDown,
      ...structuralDiagonalUp,
      ...structuralSlopeDownSteep,
      ...structuralSlopeUpSteep,
      ...structuralSlopeDownShallow,
      ...structuralSlopeUpShallow
    ],
    effectiveGrid,
    snap
  )

  const walls = wallCandidates
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

  return [...walls, ...doors]
}

const refineWallCandidates = (
  candidates: Candidate[],
  gridScale: number,
  snap: number
): Candidate[] => {
  const mergeGap = Math.max(snap * 0.8, gridScale * 0.12, 6)
  const axisCandidates = [
    ...mergeAxisCandidates(
      candidates.filter((candidate) => candidate.orientation === 'horizontal'),
      true,
      mergeGap,
      snap
    ),
    ...mergeAxisCandidates(
      candidates.filter((candidate) => candidate.orientation === 'vertical'),
      false,
      mergeGap,
      snap
    )
  ]

  const nonAxisCandidates = candidates.filter(
    (candidate) => candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical'
  )

  return removeRedundantCandidates([...axisCandidates, ...nonAxisCandidates], snap)
}

const mergeAxisCandidates = (
  candidates: Candidate[],
  horizontal: boolean,
  mergeGap: number,
  snap: number
): Candidate[] => {
  const byLine = new Map<number, Candidate[]>()
  for (const candidate of candidates) {
    const line = horizontal ? candidate.y1 : candidate.x1
    const key = quantize(line, snap)
    byLine.set(key, [...(byLine.get(key) ?? []), candidate])
  }

  const merged: Candidate[] = []
  for (const [lineKey, lineCandidates] of byLine.entries()) {
    const line = lineKey * snap
    const intervals = lineCandidates
      .map((candidate) => candidateInterval(candidate))
      .sort(([firstStart], [secondStart]) => firstStart - secondStart)

    let current: [number, number] | null = null
    for (const [start, end] of intervals) {
      if (!current) {
        current = [start, end]
        continue
      }

      if (start <= current[1] + mergeGap) {
        current[1] = Math.max(current[1], end)
        continue
      }

      merged.push(axisCandidate(horizontal, line, current[0], current[1]))
      current = [start, end]
    }

    if (current) merged.push(axisCandidate(horizontal, line, current[0], current[1]))
  }

  return merged
}

const axisCandidate = (
  horizontal: boolean,
  line: number,
  start: number,
  end: number
): Candidate => ({
  orientation: horizontal ? 'horizontal' : 'vertical',
  x1: horizontal ? start : line,
  y1: horizontal ? line : start,
  x2: horizontal ? end : line,
  y2: horizontal ? line : end,
  length: Math.abs(end - start)
})

const removeRedundantCandidates = (candidates: Candidate[], snap: number): Candidate[] => {
  const kept: Candidate[] = []
  for (const candidate of candidates.sort((first, second) => second.length - first.length)) {
    if (!kept.some((existing) => candidateMostlyCoveredBy(candidate, existing, snap))) {
      kept.push(candidate)
    }
  }
  return kept
}

const candidateMostlyCoveredBy = (
  candidate: Candidate,
  existing: Candidate,
  snap: number
): boolean => {
  if (candidate.orientation !== existing.orientation) return false
  if (candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical') return false

  const candidateLine = candidate.orientation === 'horizontal' ? candidate.y1 : candidate.x1
  const existingLine = existing.orientation === 'horizontal' ? existing.y1 : existing.x1
  if (Math.abs(candidateLine - existingLine) > snap * 0.75) return false

  const [candidateStart, candidateEnd] = candidateInterval(candidate)
  const [existingStart, existingEnd] = candidateInterval(existing)
  const overlap = Math.min(candidateEnd, existingEnd) - Math.max(candidateStart, existingStart)
  const candidateLength = candidateEnd - candidateStart
  return candidateLength > 0 && overlap >= candidateLength * 0.84
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
          orientation: 'horizontal',
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
          orientation: 'vertical',
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

const scanDiagonalDown = (
  width: number,
  height: number,
  mask: Uint8Array,
  minRun: number,
  snap: number
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let x = 0; x < width; x += 1) {
    scanDiagonalLine(width, height, mask, minRun, snap, x, 0, 1, 1, 'diagonal-down', candidates)
  }
  for (let y = 1; y < height; y += 1) {
    scanDiagonalLine(width, height, mask, minRun, snap, 0, y, 1, 1, 'diagonal-down', candidates)
  }
  return candidates
}

const scanDiagonalUp = (
  width: number,
  height: number,
  mask: Uint8Array,
  minRun: number,
  snap: number
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let y = 0; y < height; y += 1) {
    scanDiagonalLine(width, height, mask, minRun, snap, 0, y, 1, -1, 'diagonal-up', candidates)
  }
  for (let x = 1; x < width; x += 1) {
    scanDiagonalLine(
      width,
      height,
      mask,
      minRun,
      snap,
      x,
      height - 1,
      1,
      -1,
      'diagonal-up',
      candidates
    )
  }
  return candidates
}

const scanSlopedDown = (
  width: number,
  height: number,
  mask: Uint8Array,
  minRun: number,
  snap: number,
  stepX: 1 | 2,
  stepY: 1 | 2,
  orientation: CandidateOrientation
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let x = 0; x < width; x += 1) {
    scanDiagonalLine(width, height, mask, minRun, snap, x, 0, stepX, stepY, orientation, candidates)
  }
  for (let y = 1; y < height; y += 1) {
    scanDiagonalLine(width, height, mask, minRun, snap, 0, y, stepX, stepY, orientation, candidates)
  }
  return candidates
}

const scanSlopedUp = (
  width: number,
  height: number,
  mask: Uint8Array,
  minRun: number,
  snap: number,
  stepX: 1 | 2,
  stepY: 1 | 2,
  orientation: CandidateOrientation
): Candidate[] => {
  const candidates: Candidate[] = []
  for (let y = 0; y < height; y += 1) {
    scanDiagonalLine(width, height, mask, minRun, snap, 0, y, stepX, -stepY, orientation, candidates)
  }
  for (let x = 1; x < width; x += 1) {
    scanDiagonalLine(
      width,
      height,
      mask,
      minRun,
      snap,
      x,
      height - 1,
      stepX,
      -stepY,
      orientation,
      candidates
    )
  }
  return candidates
}

const scanDiagonalLine = (
  width: number,
  height: number,
  mask: Uint8Array,
  minRun: number,
  snap: number,
  startX: number,
  startY: number,
  stepX: number,
  stepY: number,
  orientation: CandidateOrientation,
  candidates: Candidate[]
): void => {
  let x = startX
  let y = startY
  while (x >= 0 && x < width && y >= 0 && y < height) {
    while (x >= 0 && x < width && y >= 0 && y < height && isDarkNear(width, height, mask, x, y) === 0) {
      x += stepX
      y += stepY
    }

    const runStartX = x
    const runStartY = y
    let runEndX = x
    let runEndY = y
    let length = 0
    while (x >= 0 && x < width && y >= 0 && y < height && isDarkNear(width, height, mask, x, y) === 1) {
      runEndX = x
      runEndY = y
      length += 1
      x += stepX
      y += stepY
    }

    if (length >= minRun) {
      const x1 = snapValue(runStartX, snap)
      const y1 = snapValue(runStartY, snap)
      const x2 = snapValue(runEndX, snap)
      const y2 = snapValue(runEndY, snap)
      const segmentLength = Math.hypot(x2 - x1, y2 - y1)
      if (segmentLength > 0) {
        candidates.push({orientation, x1, y1, x2, y2, length: segmentLength})
      }
    }
  }
}

const isDarkNear = (
  width: number,
  height: number,
  mask: Uint8Array,
  x: number,
  y: number
): 0 | 1 => {
  for (let dy = -1; dy <= 1; dy += 1) {
    const sampleY = y + dy
    if (sampleY < 0 || sampleY >= height) continue
    for (let dx = -1; dx <= 1; dx += 1) {
      const sampleX = x + dx
      if (sampleX >= 0 && sampleX < width && mask[sampleY * width + sampleX] === 1) return 1
    }
  }
  return 0
}

const collapseCandidates = (candidates: Candidate[], snap: number): Candidate[] => {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = candidateKey(candidate, snap)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const candidateKey = (candidate: Candidate, snap: number): string =>
  [
    candidate.orientation,
    quantize(candidate.x1, snap),
    quantize(candidate.y1, snap),
    quantize(candidate.x2, snap),
    quantize(candidate.y2, snap)
  ].join(':')

const isStructuralWallCandidate = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number,
  snap: number
): boolean => {
  if (candidate.orientation === 'horizontal' || candidate.orientation === 'vertical') {
    const lineCoord = candidate.orientation === 'horizontal' ? candidate.y1 : candidate.x1
    const gridTolerance = Math.max(gridScale * 0.5, snap)
    if (!nearGridLine(lineCoord, gridScale, gridTolerance)) return false

    const minStructuralLength = Math.max(gridScale * 0.45, 22)
    if (candidate.length < minStructuralLength) return false

    return candidateBandThickness(candidate, width, height, mask) >= 3
  }

  const minDiagonalLength = Math.max(gridScale * 0.85, 38)
  if (candidate.length < minDiagonalLength) return false
  return candidateBandThickness(candidate, width, height, mask) >= 3
}

const candidateBandThickness = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array
): number => {
  const radius = 4
  let support = 0
  const [start, end] = candidateInterval(candidate)

  if (candidate.orientation === 'horizontal') {
    const yCenter = Math.round(candidate.y1)
    const [xStart, xEnd] = boundedRange(start, end, width)
    for (let y = Math.max(0, yCenter - radius); y <= Math.min(height - 1, yCenter + radius); y += 1) {
      let dark = 0
      let samples = 0
      for (let x = xStart; x < xEnd; x += 1) {
        samples += 1
        dark += mask[y * width + x]
      }
      if (samples > 0 && dark / samples >= 0.45) support += 1
    }
    return support
  }

  if (candidate.orientation === 'vertical') {
    const xCenter = Math.round(candidate.x1)
    const [yStart, yEnd] = boundedRange(start, end, height)
    for (
      let x = Math.max(0, xCenter - radius);
      x <= Math.min(width - 1, xCenter + radius);
      x += 1
    ) {
      let dark = 0
      let samples = 0
      for (let y = yStart; y < yEnd; y += 1) {
        samples += 1
        dark += mask[y * width + x]
      }
      if (samples > 0 && dark / samples >= 0.45) support += 1
    }
    return support
  }

  return diagonalBandThickness(candidate, width, height, mask)
}

const diagonalBandThickness = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array
): number => {
  const radius = 4
  const dx = candidate.x2 - candidate.x1
  const dy = candidate.y2 - candidate.y1
  const length = Math.hypot(dx, dy)
  if (length <= 0) return 0

  const perpendicularX = -dy / length
  const perpendicularY = dx / length
  const steps = Math.max(8, Math.round(length))
  let support = 0

  for (let offset = -radius; offset <= radius; offset += 1) {
    let dark = 0
    let samples = 0
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      const x = Math.round(candidate.x1 + dx * t + perpendicularX * offset)
      const y = Math.round(candidate.y1 + dy * t + perpendicularY * offset)
      if (x < 0 || x >= width || y < 0 || y >= height) continue
      samples += 1
      dark += mask[y * width + x]
    }
    if (samples > 0 && dark / samples >= 0.35) support += 1
  }

  return support
}

const promoteConnectedThinAxisCandidates = (
  candidates: Candidate[],
  baseCandidates: Candidate[],
  perpendicularBase: Candidate[],
  horizontal: boolean,
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number,
  snap: number
): Candidate[] => {
  const baseKeys = new Set(baseCandidates.map((candidate) => candidateKey(candidate, snap)))
  const promoted = candidates.filter((candidate) => {
    if (baseKeys.has(candidateKey(candidate, snap))) return false
    return isConnectedThinAxisCandidate(
      candidate,
      perpendicularBase,
      horizontal,
      width,
      height,
      mask,
      gridScale,
      snap
    )
  })

  return collapseCandidates([...baseCandidates, ...promoted], snap)
}

const isConnectedThinAxisCandidate = (
  candidate: Candidate,
  perpendicularBase: Candidate[],
  horizontal: boolean,
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number,
  snap: number
): boolean => {
  if (!candidateHasAxis(candidate, horizontal)) return false

  const lineCoord = horizontal ? candidate.y1 : candidate.x1
  const gridTolerance = Math.max(gridScale * 0.5, snap)
  if (!nearGridLine(lineCoord, gridScale, gridTolerance)) return false

  const minLength = Math.max(gridScale * 0.65, 32)
  if (candidate.length < minLength) return false

  const thickness = candidateBandThickness(candidate, width, height, mask)
  if (thickness < 2 || thickness >= 3) return false

  if (candidate.length >= Math.max(gridScale * 3, 150)) return true

  const supports = axisEndpointSupportCount(
    candidate,
    perpendicularBase,
    horizontal,
    width,
    height,
    gridScale,
    snap
  )
  if (supports >= 2) return true

  return supports >= 1 && candidate.length >= Math.max(gridScale * 2.2, 100)
}

const axisEndpointSupportCount = (
  candidate: Candidate,
  perpendicularBase: Candidate[],
  horizontal: boolean,
  width: number,
  height: number,
  gridScale: number,
  snap: number
): number => {
  const tolerance = Math.max(gridScale * 0.18, snap)
  const lineCoord = horizontal ? candidate.y1 : candidate.x1
  const [start, end] = candidateInterval(candidate)
  const axisLimit = horizontal ? width : height

  return [start, end].reduce((count, endpoint) => {
    if (endpoint <= tolerance || endpoint >= axisLimit - tolerance) return count + 1
    const hasSupport = perpendicularBase.some((support) => {
      if (!candidateHasAxis(support, !horizontal)) return false
      if (support.length < Math.max(gridScale * 0.55, 28)) return false

      const supportLine = horizontal ? support.x1 : support.y1
      if (Math.abs(supportLine - endpoint) > tolerance) return false
      if (!nearGridLine(supportLine, gridScale, tolerance)) return false

      const [supportStart, supportEnd] = candidateInterval(support)
      return lineCoord >= supportStart - tolerance && lineCoord <= supportEnd + tolerance
    })
    return count + (hasSupport ? 1 : 0)
  }, 0)
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
  if (first.orientation !== second.orientation) return false
  if (first.orientation !== 'horizontal' && first.orientation !== 'vertical') return false

  const firstLine = first.orientation === 'horizontal' ? first.y1 : first.x1
  const secondLine = second.orientation === 'horizontal' ? second.y1 : second.x1
  if (Math.abs(firstLine - secondLine) > snap) return false

  const [firstStart, firstEnd] = candidateInterval(first)
  const [secondStart, secondEnd] = candidateInterval(second)
  const overlap = Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart)
  if (overlap <= 0) return false

  const shorter = Math.min(firstEnd - firstStart, secondEnd - secondStart)
  return overlap >= shorter * 0.6
}

const candidateInterval = (candidate: Candidate): [number, number] => {
  const first = candidate.orientation === 'horizontal' ? candidate.x1 : candidate.y1
  const second = candidate.orientation === 'horizontal' ? candidate.x2 : candidate.y2
  return first <= second ? [first, second] : [second, first]
}

const candidateHasAxis = (candidate: Candidate, horizontal: boolean): boolean =>
  candidate.orientation === (horizontal ? 'horizontal' : 'vertical')

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
    ...detectAxisGapDoorCandidates(horizontal, true, width, height, mask, gridScale, snap),
    ...detectAxisGapDoorCandidates(vertical, false, width, height, mask, gridScale, snap),
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
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number,
  snap: number
): Candidate[] => {
  const minGap = Math.max(gridScale * 0.3, 14)
  const normalMaxGap = Math.max(gridScale * 1.15, minGap + 1)
  const maxGap = Math.max(gridScale * 1.75, normalMaxGap)
  const minSupport = Math.max(gridScale * 0.7, 32)
  const gridTolerance = Math.max(gridScale * 0.5, snap)
  const byLine = new Map<number, Candidate[]>()

  for (const candidate of candidates) {
    if (!candidateHasAxis(candidate, horizontal) || candidate.length < minSupport) continue
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
      if (
        gap > normalMaxGap &&
        !gapContainsDoorMarker(width, height, mask, horizontal, leftEnd, rightStart, lineCoord, gridScale)
      ) {
        continue
      }
      doors.push(
        horizontal
          ? {
              orientation: 'horizontal',
              x1: leftEnd,
              y1: lineCoord,
              x2: rightStart,
              y2: lineCoord,
              length: gap
            }
          : {
              orientation: 'vertical',
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

const gapContainsDoorMarker = (
  width: number,
  height: number,
  mask: Uint8Array,
  horizontal: boolean,
  start: number,
  end: number,
  lineCoord: number,
  gridScale: number
): boolean => {
  const radius = Math.max(gridScale * 0.18, 7)
  let dark = 0
  let samples = 0
  const gap = Math.max(0, end - start)
  const inset = Math.min(gap * 0.25, gridScale * 0.35)

  if (horizontal) {
    const [xStart, xEnd] = boundedRange(start + inset, end - inset, width)
    const [yStart, yEnd] = boundedRange(lineCoord - radius, lineCoord + radius, height)
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        samples += 1
        dark += mask[y * width + x]
      }
    }
  } else {
    const [xStart, xEnd] = boundedRange(lineCoord - radius, lineCoord + radius, width)
    const [yStart, yEnd] = boundedRange(start + inset, end - inset, height)
    for (let y = yStart; y < yEnd; y += 1) {
      for (let x = xStart; x < xEnd; x += 1) {
        samples += 1
        dark += mask[y * width + x]
      }
    }
  }

  const density = samples === 0 ? 0 : dark / samples
  return dark >= Math.max(8, samples * 0.015) && density <= 0.22
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
        orientation: 'horizontal',
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
        orientation: 'vertical',
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
          orientation: 'horizontal',
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
          orientation: 'vertical',
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
    if (!candidateHasAxis(wall, horizontal) || wall.length < minSupport) return false
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
  candidate.orientation === 'horizontal'
    ? Math.min(candidate.x1, candidate.x2)
    : Math.min(candidate.y1, candidate.y2)

const axisEnd = (candidate: Candidate): number =>
  candidate.orientation === 'horizontal'
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
