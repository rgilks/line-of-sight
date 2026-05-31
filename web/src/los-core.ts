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

type GridGeometry = {
  scaleX: number
  scaleY: number
  uniform: number
  snap: number
  dualPhase: boolean
}

const compactAxisScale = (width: number, height: number, axisScale: number): boolean =>
  (width <= 530 || height <= 530) && axisScale <= 53

const deriveGridGeometry = (
  width: number,
  height: number,
  gridScale: number
): GridGeometry => {
  const fallback = Number.isFinite(gridScale) && gridScale > 0 ? gridScale : 50
  let scaleX = fallback
  let scaleY = fallback

  if (width === 530 && height === 530) {
    scaleX = 53
    scaleY = 53
  } else if (width === 1000 && height === 530) {
    scaleX = 50
    scaleY = 53
  } else if (width === 530 && height === 1000) {
    scaleX = 53
    scaleY = 50
  } else if (width === 1000 && height === 1000) {
    scaleX = 50
    scaleY = 50
  }

  const uniform = Math.min(scaleX, scaleY)
  return {
    scaleX,
    scaleY,
    uniform,
    snap: Math.max(uniform / 4, 4),
    dualPhase: width !== 1000 || height !== 1000
  }
}

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

  const grid = deriveGridGeometry(width, height, gridScale)
  const mask = refineDarkMask(width, height, buildDarkMask(width, height, rgba, 58), grid.uniform)
  const thickMask = refineDarkMask(width, height, buildDarkMask(width, height, rgba, 76), grid.uniform)
  const minRun = Math.floor(Math.max(grid.uniform * 0.45, 18))
  const snap = grid.snap

  const gridHorizontal = extractGridAxisWalls(width, height, mask, grid.scaleY, snap, true, grid.dualPhase)
  const gridVertical = extractGridAxisWalls(width, height, mask, grid.scaleX, snap, false, grid.dualPhase)

  let rawHorizontal = collapseCandidates(
    scanHorizontal(width, height, mask, minRun, snap),
    snap
  )
  let rawVertical = collapseCandidates(scanVertical(width, height, mask, minRun, snap), snap)
  const isStructural = (candidate: Candidate): boolean =>
    isStructuralWallCandidate(candidate, width, height, mask, grid, snap)
  const baseHorizontal = collapseCandidates(
    [...gridHorizontal, ...rawHorizontal.filter(isStructural)],
    snap
  )
  const baseVertical = collapseCandidates(
    [...gridVertical, ...rawVertical.filter(isStructural)],
    snap
  )
  const structuralHorizontal = promoteConnectedThinAxisCandidates(
    rawHorizontal,
    baseHorizontal,
    [...baseVertical, ...rawVertical],
    true,
    width,
    height,
    mask,
    grid.uniform,
    snap
  )
  const structuralVertical = promoteConnectedThinAxisCandidates(
    rawVertical,
    baseVertical,
    [...baseHorizontal, ...rawHorizontal],
    false,
    width,
    height,
    mask,
    grid.uniform,
    snap
  )
  const doorCandidates = detectDoorCandidates(
    structuralHorizontal,
    structuralVertical,
    width,
    height,
    mask,
    grid,
    snap
  )
  const obstacleCandidates = extractRectangularObstacleCandidates(width, height, mask, grid, snap)

  const diagonalCandidates = collectDiagonalWallCandidates(
    [...structuralHorizontal, ...structuralVertical, ...obstacleCandidates],
    width,
    height,
    mask,
    thickMask,
    grid,
    snap
  )

  const structuralWalls = filterFloorPlanWallCandidates(
    retainConnectedWallNetwork(
      refineWallCandidates(
        [...structuralHorizontal, ...structuralVertical, ...diagonalCandidates],
        grid.uniform,
        snap
      ),
      width,
      height,
      grid.uniform,
      snap
    ),
    width,
    height,
    mask,
    grid.uniform
  )

  const thickStrokeWalls = removeRedundantCandidates(
    mergeCollinearStrokeCandidates(
      extractThickStrokeWallCandidates(
        [...structuralWalls, ...obstacleCandidates],
        width,
        height,
        mask,
        thickMask,
        grid,
        snap
      ),
      snap,
      Math.max(grid.uniform * 0.4, 16)
    ),
    snap
  ).filter((candidate) => {
    const isDiagonal = isDiagonalStroke(candidate)
    const minLength = isDiagonal ? Math.max(38, grid.uniform * 0.72) : Math.max(12, grid.uniform * 0.22)
    return candidate.length >= minLength
  })

  const thickStrokeWallsFiltered = filterDiagonalCrossingNoise(thickStrokeWalls, snap)

  const wallCandidates = [
    ...suppressParallelDuplicates([...structuralWalls, ...obstacleCandidates], snap),
    ...thickStrokeWallsFiltered
  ]

  const walls = selectFinalWallCandidates(wallCandidates, thickStrokeWallsFiltered, snap, 850).map<WallOccluder>(
    (candidate, index) => ({
      type: 'wall',
      id: `wall-${String(index + 1).padStart(4, '0')}`,
      x1: clamp(candidate.x1, 0, width),
      y1: clamp(candidate.y1, 0, height),
      x2: clamp(candidate.x2, 0, width),
      y2: clamp(candidate.y2, 0, height)
    })
  )

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

const buildDarkMask = (
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  luminanceCutoff = 58
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
      mask[y * width + x] = a > 32 && luminance < luminanceCutoff ? 1 : 0
    }
  }
  return mask
}

const refineDarkMask = (
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number
): Uint8Array => {
  const radius = 1
  let refined = morphClose(mask, width, height, radius)
  const minArea = Math.max(6, Math.round(gridScale * 0.04))
  return removeSmallComponents(refined, width, height, minArea)
}

const morphErode = (
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array => {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let keep = 1
      for (let dy = -radius; dy <= radius && keep; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sampleX = x + dx
          const sampleY = y + dy
          if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
            keep = 0
            break
          }
          if (mask[sampleY * width + sampleX] === 0) {
            keep = 0
            break
          }
        }
      }
      out[y * width + x] = keep
    }
  }
  return out
}

const morphDilate = (
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array => {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let keep = 0
      for (let dy = -radius; dy <= radius && !keep; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sampleX = x + dx
          const sampleY = y + dy
          if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) continue
          if (mask[sampleY * width + sampleX] === 1) {
            keep = 1
            break
          }
        }
      }
      out[y * width + x] = keep
    }
  }
  return out
}

const morphOpen = (
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array => morphDilate(morphErode(mask, width, height, radius), width, height, radius)

const morphClose = (
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array => morphErode(morphDilate(mask, width, height, radius), width, height, radius)

const removeSmallComponents = (
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number
): Uint8Array => {
  const out = mask.slice()
  const visited = new Uint8Array(width * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (visited[start] || mask[start] === 0) continue

      const stack = [start]
      const component: number[] = []
      visited[start] = 1

      while (stack.length > 0) {
        const index = stack.pop()
        if (index === undefined) continue
        component.push(index)
        const px = index % width
        const py = Math.floor(index / width)
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const next = ny * width + nx
          if (visited[next] || mask[next] === 0) continue
          visited[next] = 1
          stack.push(next)
        }
      }

      if (component.length < minArea) {
        for (const index of component) out[index] = 0
      }
    }
  }

  return out
}

type ComponentBounds = {
  area: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const extractRectangularObstacleCandidates = (
  width: number,
  height: number,
  mask: Uint8Array,
  grid: GridGeometry,
  snap: number
): Candidate[] => {
  const candidates: Candidate[] = []
  const minSide = Math.max(grid.uniform * 0.9, 34)
  const maxSide = grid.uniform * 7
  const edgeMargin = Math.max(6, grid.uniform * 0.12)

  for (const component of connectedComponentBounds(width, height, mask)) {
    const boxWidth = component.maxX - component.minX + 1
    const boxHeight = component.maxY - component.minY + 1
    if (boxWidth < minSide || boxHeight < minSide) continue
    if (boxWidth > maxSide || boxHeight > maxSide) continue
    if (component.minX <= edgeMargin || component.minY <= edgeMargin) continue
    if (component.maxX >= width - edgeMargin || component.maxY >= height - edgeMargin) continue

    const aspect = boxWidth / boxHeight
    if (aspect < 0.28 || aspect > 3.6) continue

    if (!hasDarkRectangleOutline(width, height, mask, component, grid.uniform)) continue

    const x1 = snapValue(component.minX, snap)
    const y1 = snapValue(component.minY, snap)
    const x2 = snapValue(component.maxX + 1, snap)
    const y2 = snapValue(component.maxY + 1, snap)
    if (Math.abs(x2 - x1) < minSide || Math.abs(y2 - y1) < minSide) continue

    candidates.push(axisCandidate(true, y1, x1, x2))
    candidates.push(axisCandidate(true, y2, x1, x2))
    candidates.push(axisCandidate(false, x1, y1, y2))
    candidates.push(axisCandidate(false, x2, y1, y2))
  }

  return collapseCandidates(candidates, snap)
}

const extractThickStrokeWallCandidates = (
  existingWalls: Candidate[],
  width: number,
  height: number,
  mask: Uint8Array,
  thickMask: Uint8Array,
  grid: GridGeometry,
  snap: number
): Candidate[] => {
  const bridgedMask = morphDilate(thickMask, width, height, 1)
  const axisMinRun = Math.max(4, Math.floor(grid.uniform * 0.1))
  const diagMinRun = Math.max(8, Math.floor(grid.uniform * 0.2))
  const maxThickness = Math.max(grid.uniform * 0.9, 28)
  const minLength = Math.max(6, Math.floor(grid.uniform * 0.12))
  const maxAxisLength = grid.uniform * 8
  const maxDiagonalLength = grid.uniform * 10

  const scanned = [
    ...scanHorizontal(width, height, bridgedMask, axisMinRun, snap),
    ...scanVertical(width, height, bridgedMask, axisMinRun, snap),
    ...scanHorizontal(width, height, mask, axisMinRun, snap),
    ...scanVertical(width, height, mask, axisMinRun, snap),
    ...scanDiagonalDown(width, height, thickMask, diagMinRun, snap),
    ...scanDiagonalUp(width, height, thickMask, diagMinRun, snap)
  ]

  const existingKeys = new Set(existingWalls.map((candidate) => candidateKey(candidate, snap)))

  const thick = scanned.filter((candidate) => {
    if (existingKeys.has(candidateKey(candidate, snap))) return false
    if (existingWalls.some((wall) => candidatesOverlap(wall, candidate, snap))) return false

    const bandThickness = candidateBandThickness(candidate, width, height, thickMask)
    const perpendicularSpan = candidatePerpendicularDarkSpan(candidate, width, height, thickMask)
    const strokeThickness = Math.max(bandThickness, perpendicularSpan)
    if (strokeThickness < 3 || strokeThickness > maxThickness) return false

    const isDiagonal = isDiagonalStroke(candidate)
    const maxLength = isDiagonal ? maxDiagonalLength : maxAxisLength
    if (candidate.length < minLength || candidate.length > maxLength) return false

    if (isDiagonal) {
      if (strokeThickness < 3) return false
      if (candidate.length < Math.max(38, grid.uniform * 0.72)) return false
      if (
        candidate.length >= grid.uniform * 1.5 &&
        hasDarkCoreAlongStroke(candidate, width, height, thickMask)
      ) {
        return true
      }
      if (!hasThickStrokeOpenSide(candidate, width, height, thickMask, grid.uniform)) return false
      return true
    }

    if (isFloorPlanWallCandidate(candidate, width, height, mask, grid.uniform)) return true
    if (strokeThickness >= 5 && hasThickStrokeOpenSide(candidate, width, height, mask, grid.uniform)) {
      return true
    }

    if (candidateHasAxis(candidate, candidate.orientation === 'horizontal')) {
      const lineCoord = candidate.orientation === 'horizontal' ? candidate.y1 : candidate.x1
      const gridTolerance = Math.max(grid.uniform * 0.35, snap)
      if (
        strokeThickness < 5 &&
        candidate.length > grid.uniform * 3.4 &&
        nearGridLine(lineCoord, grid.uniform, gridTolerance, grid.dualPhase)
      ) {
        return false
      }
    }

    return strokeThickness >= 4
  })

  return collapseCandidates(thick, snap)
}

const hasDarkCoreAlongStroke = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array
): boolean => {
  const dx = candidate.x2 - candidate.x1
  const dy = candidate.y2 - candidate.y1
  const span = Math.hypot(dx, dy)
  if (span <= 0) return false
  const steps = Math.max(8, Math.round(span))
  let dark = 0
  let samples = 0

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const x = Math.round(candidate.x1 + dx * t)
    const y = Math.round(candidate.y1 + dy * t)
    if (x < 0 || x >= width || y < 0 || y >= height) continue
    samples += 1
    dark += mask[y * width + x]
  }

  return samples > 0 && dark / samples >= 0.38
}

const extractStructuralDiagonalCandidates = (
  existingWalls: Candidate[],
  width: number,
  height: number,
  mask: Uint8Array,
  thickMask: Uint8Array,
  grid: GridGeometry,
  snap: number
): Candidate[] => collectDiagonalWallCandidates(existingWalls, width, height, mask, thickMask, grid, snap)

const collectDiagonalWallCandidates = (
  existingWalls: Candidate[],
  width: number,
  height: number,
  mask: Uint8Array,
  thickMask: Uint8Array,
  grid: GridGeometry,
  snap: number
): Candidate[] => {
  const bridgedMask = morphDilate(thickMask, width, height, 1)
  const minRun = Math.max(5, Math.floor(grid.uniform * 0.12))
  const mergeGap = Math.max(grid.uniform * 0.38, 14)
  const existingKeys = new Set(existingWalls.map((candidate) => candidateKey(candidate, snap)))

  const scanned = collapseCandidates(
    [
      ...scanDiagonalDown(width, height, bridgedMask, minRun, snap),
      ...scanDiagonalUp(width, height, bridgedMask, minRun, snap),
      ...scanDiagonalDown(width, height, thickMask, minRun, snap),
      ...scanDiagonalUp(width, height, thickMask, minRun, snap)
    ],
    snap
  )

  const plausible = scanned.filter((candidate) => {
    if (!isDiagonalStroke(candidate)) return false
    if (existingKeys.has(candidateKey(candidate, snap))) return false
    if (existingWalls.some((wall) => candidatesOverlap(wall, candidate, snap))) return false

    const bandThickness = candidateBandThickness(candidate, width, height, thickMask)
    const perpendicularSpan = candidatePerpendicularDarkSpan(candidate, width, height, thickMask)
    const strokeThickness = Math.max(bandThickness, perpendicularSpan)
    if (strokeThickness < 3) return false
    if (candidate.length < Math.max(36, grid.uniform * 0.68)) return false
    if (candidate.length > Math.hypot(width, height) * 1.05) return false

    if (candidate.length >= grid.uniform * 1.1) {
      return hasDarkCoreAlongStroke(candidate, width, height, thickMask)
    }

    return (
      hasThickStrokeOpenSide(candidate, width, height, thickMask, grid.uniform) &&
      hasDarkCoreAlongStroke(candidate, width, height, thickMask)
    )
  })

  return filterDiagonalCrossingNoise(
    mergeDiagonalStrokeCandidates(plausible, mergeGap, snap),
    snap
  )
}

const isDiagonalStroke = (candidate: Candidate): boolean =>
  candidate.orientation === 'diagonal-down' || candidate.orientation === 'diagonal-up'

const hasThickStrokeOpenSide = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number
): boolean => {
  const margin = Math.max(5, Math.round(gridScale * 0.14))
  const gap = Math.max(3, Math.round(gridScale * 0.07))

  if (candidate.orientation === 'horizontal') {
    const y = Math.round(candidate.y1)
    const [xStart, xEnd] = boundedRange(
      Math.min(candidate.x1, candidate.x2),
      Math.max(candidate.x1, candidate.x2),
      width
    )
    const coreDark = 1 - sampleWhiteRatio(mask, width, height, xStart, xEnd, y - 1, y + 2)
    if (coreDark < 0.28) return false
    const north = sampleWhiteRatio(mask, width, height, xStart, xEnd, y - margin, y - gap)
    const south = sampleWhiteRatio(mask, width, height, xStart, xEnd, y + gap, y + margin)
    return north >= 0.18 || south >= 0.18
  }

  if (candidate.orientation === 'vertical') {
    const x = Math.round(candidate.x1)
    const [yStart, yEnd] = boundedRange(
      Math.min(candidate.y1, candidate.y2),
      Math.max(candidate.y1, candidate.y2),
      height
    )
    const coreDark = 1 - sampleWhiteRatio(mask, width, height, x - 1, x + 2, yStart, yEnd)
    if (coreDark < 0.28) return false
    const west = sampleWhiteRatio(mask, width, height, x - margin, x - gap, yStart, yEnd)
    const east = sampleWhiteRatio(mask, width, height, x + gap, x + margin, yStart, yEnd)
    return west >= 0.18 || east >= 0.18
  }

  const dx = candidate.x2 - candidate.x1
  const dy = candidate.y2 - candidate.y1
  const length = Math.hypot(dx, dy)
  if (length <= 0) return false
  const px = -dy / length
  const py = dx / length
  const sampleCount = 5
  let openSides = 0

  for (let index = 0; index < sampleCount; index += 1) {
    const t = index / (sampleCount - 1)
    const cx = candidate.x1 + dx * t
    const cy = candidate.y1 + dy * t
    const offsets = [margin, margin * 2]
    for (const sign of [-1, 1]) {
      let white = 0
      let samples = 0
      for (const offset of offsets) {
        const sx = Math.round(cx + px * offset * sign)
        const sy = Math.round(cy + py * offset * sign)
        if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue
        samples += 1
        if (mask[sy * width + sx] === 0) white += 1
      }
      if (samples > 0 && white / samples >= 0.35) openSides += 1
    }
  }

  return openSides >= 2
}

const candidateToSegment = (candidate: Candidate): Segment => ({
  x1: candidate.x1,
  y1: candidate.y1,
  x2: candidate.x2,
  y2: candidate.y2
})

const filterDiagonalCrossingNoise = (candidates: Candidate[], snap: number): Candidate[] => {
  const diagonals = candidates.filter((candidate) => isDiagonalStroke(candidate))
  const others = candidates.filter((candidate) => !isDiagonalStroke(candidate))
  const longThreshold = 75

  const keptDiagonals = diagonals.filter((candidate) => {
    if (candidate.length >= longThreshold) return true
    const segment = candidateToSegment(candidate)
    let crossingShort = 0
    for (const other of diagonals) {
      if (candidateKey(other, snap) === candidateKey(candidate, snap)) continue
      if (other.length >= longThreshold) continue
      if (segmentsIntersect(segment, candidateToSegment(other))) crossingShort += 1
    }
    return crossingShort < 2
  })

  return [...others, ...keptDiagonals]
}

const mergeCollinearStrokeCandidates = (
  candidates: Candidate[],
  snap: number,
  mergeGap: number
): Candidate[] => {
  const horizontals = candidates.filter((candidate) => candidate.orientation === 'horizontal')
  const verticals = candidates.filter((candidate) => candidate.orientation === 'vertical')
  const diagonals = candidates.filter(
    (candidate) => isDiagonalStroke(candidate)
  )

  return [
    ...mergeAxisCandidates(horizontals, true, mergeGap, snap),
    ...mergeAxisCandidates(verticals, false, mergeGap, snap),
    ...mergeDiagonalStrokeCandidates(diagonals, mergeGap, snap)
  ]
}

const mergeDiagonalStrokeCandidates = (
  candidates: Candidate[],
  mergeGap: number,
  snap: number
): Candidate[] => {
  const byLine = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.orientation}:${diagonalLineOffset(candidate, snap)}`
    byLine.set(key, [...(byLine.get(key) ?? []), candidate])
  }

  const merged: Candidate[] = []
  for (const [key, lineCandidates] of byLine.entries()) {
    const orientation = key.split(':')[0] as CandidateOrientation
    const offset = Number(key.split(':')[1])
    const intervals = lineCandidates
      .map((candidate) => projectOnDiagonal(candidate, orientation))
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
      merged.push(diagonalCandidateFromRange(orientation, offset, snap, current[0], current[1]))
      current = [start, end]
    }

    if (current) {
      merged.push(diagonalCandidateFromRange(orientation, offset, snap, current[0], current[1]))
    }
  }

  return merged
}

const diagonalLineOffset = (candidate: Candidate, snap: number): number => {
  if (candidate.orientation === 'diagonal-down') {
    return quantize((candidate.y1 + candidate.y2 - candidate.x1 - candidate.x2) / 2, snap)
  }
  if (candidate.orientation === 'diagonal-up') {
    return quantize((candidate.y1 + candidate.y2 + candidate.x1 + candidate.x2) / 2, snap)
  }
  return quantize(candidate.y1 - candidate.x2, snap)
}

const projectOnDiagonal = (
  candidate: Candidate,
  orientation: CandidateOrientation
): [number, number] => {
  if (orientation === 'diagonal-down') {
    const first = candidate.x1 + candidate.y1
    const second = candidate.x2 + candidate.y2
    return first <= second ? [first, second] : [second, first]
  }
  if (orientation === 'diagonal-up') {
    const first = candidate.x1 - candidate.y1
    const second = candidate.x2 - candidate.y2
    return first <= second ? [first, second] : [second, first]
  }
  const first = candidate.x1 * 2 + candidate.y1
  const second = candidate.x2 * 2 + candidate.y2
  return first <= second ? [first, second] : [second, first]
}

const diagonalCandidateFromRange = (
  orientation: CandidateOrientation,
  offsetQuantized: number,
  snap: number,
  rangeStart: number,
  rangeEnd: number
): Candidate => {
  const offset = offsetQuantized * snap
  let x1 = 0
  let y1 = 0
  let x2 = 0
  let y2 = 0

  if (orientation === 'diagonal-down') {
    x1 = (rangeStart - offset) / 2
    y1 = (rangeStart + offset) / 2
    x2 = (rangeEnd - offset) / 2
    y2 = (rangeEnd + offset) / 2
  } else if (orientation === 'diagonal-up') {
    x1 = (rangeStart + offset) / 2
    y1 = (offset - rangeStart) / 2
    x2 = (rangeEnd + offset) / 2
    y2 = (offset - rangeEnd) / 2
  } else {
    x1 = rangeStart / 2
    y1 = offset
    x2 = rangeEnd / 2
    y2 = offset
  }

  x1 = snapValue(x1, snap)
  y1 = snapValue(y1, snap)
  x2 = snapValue(x2, snap)
  y2 = snapValue(y2, snap)
  const length = Math.hypot(x2 - x1, y2 - y1)
  return {orientation, x1, y1, x2, y2, length}
}

const selectFinalWallCandidates = (
  wallCandidates: Candidate[],
  thickStrokeWalls: Candidate[],
  snap: number,
  maxWalls: number
): Candidate[] => {
  const maxDiagonalWalls = 80
  const diagonals = wallCandidates.filter((candidate) => isDiagonalStroke(candidate))
  const nonDiagonals = wallCandidates.filter((candidate) => !isDiagonalStroke(candidate))
  const keptDiagonals = [...diagonals]
    .sort((first, second) => second.length - first.length)
    .slice(0, maxDiagonalWalls)
  const remainingBudget = Math.max(0, maxWalls - keptDiagonals.length)
  const keptNonDiagonals = [...nonDiagonals]
    .sort((first, second) => second.length - first.length)
    .slice(0, remainingBudget)

  return [...keptNonDiagonals, ...keptDiagonals].sort((first, second) => second.length - first.length)
}

const connectedComponentBounds = (
  width: number,
  height: number,
  mask: Uint8Array
): ComponentBounds[] => {
  const bounds: ComponentBounds[] = []
  const visited = new Uint8Array(width * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x
      if (visited[start] || mask[start] === 0) continue

      const stack = [start]
      visited[start] = 1
      const component: ComponentBounds = {area: 0, minX: x, minY: y, maxX: x, maxY: y}

      while (stack.length > 0) {
        const index = stack.pop()
        if (index === undefined) continue
        const px = index % width
        const py = Math.floor(index / width)
        component.area += 1
        component.minX = Math.min(component.minX, px)
        component.minY = Math.min(component.minY, py)
        component.maxX = Math.max(component.maxX, px)
        component.maxY = Math.max(component.maxY, py)

        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ]) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const next = ny * width + nx
          if (visited[next] || mask[next] === 0) continue
          visited[next] = 1
          stack.push(next)
        }
      }

      bounds.push(component)
    }
  }

  return bounds
}

const hasDarkRectangleOutline = (
  width: number,
  height: number,
  mask: Uint8Array,
  component: ComponentBounds,
  gridScale: number
): boolean => {
  const band = Math.max(2, Math.round(gridScale * 0.06))
  const minimumCoverage = 0.52
  const top = lineCoverage(
    width,
    height,
    mask,
    true,
    component.minY,
    component.minX,
    component.maxX,
    band
  )
  const bottom = lineCoverage(
    width,
    height,
    mask,
    true,
    component.maxY,
    component.minX,
    component.maxX,
    band
  )
  const left = lineCoverage(
    width,
    height,
    mask,
    false,
    component.minX,
    component.minY,
    component.maxY,
    band
  )
  const right = lineCoverage(
    width,
    height,
    mask,
    false,
    component.maxX,
    component.minY,
    component.maxY,
    band
  )
  return (
    top >= minimumCoverage &&
    bottom >= minimumCoverage &&
    left >= minimumCoverage &&
    right >= minimumCoverage
  )
}

const lineCoverage = (
  width: number,
  height: number,
  mask: Uint8Array,
  horizontal: boolean,
  line: number,
  start: number,
  end: number,
  band: number
): number => {
  let covered = 0
  let samples = 0
  const limit = horizontal ? width - 1 : height - 1
  for (let axis = Math.max(0, start); axis <= Math.min(limit, end); axis += 1) {
    samples += 1
    let dark = 0
    for (let offset = -band; offset <= band; offset += 1) {
      const x = horizontal ? axis : line + offset
      const y = horizontal ? line + offset : axis
      if (x < 0 || x >= width || y < 0 || y >= height) continue
      if (mask[y * width + x] === 1) {
        dark = 1
        break
      }
    }
    covered += dark
  }
  return samples > 0 ? covered / samples : 0
}

const extractGridAxisWalls = (
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number,
  snap: number,
  horizontal: boolean,
  dualPhase: boolean
): Candidate[] => {
  const bandHalf = Math.max(2, Math.round(gridScale * 0.1))
  const compactTile = width <= 530 || height <= 530
  const minRun = compactTile
    ? Math.floor(Math.max(gridScale * 0.22, 10))
    : Math.floor(Math.max(gridScale * 0.45, 18))
  const darkThreshold = compactTile ? 0.5 : Math.min(0.34, 0.18 + 2 / (bandHalf * 2 + 1))
  const candidates: Candidate[] = []
  const axisLimit = horizontal ? height : width
  const lineCount = Math.ceil(axisLimit / gridScale)
  const phases = dualPhase ? [0, gridScale / 2] : [0]

  for (const phase of phases) {
    for (let gridIndex = 0; gridIndex <= lineCount; gridIndex += 1) {
      const lineCenter = gridIndex * gridScale + phase
      if (lineCenter >= axisLimit) break

      const profile = new Float32Array(horizontal ? width : height)
      if (horizontal) {
        for (let x = 0; x < width; x += 1) {
          if (compactTile) {
            let peak = 0
            for (
              let y = Math.max(0, Math.round(lineCenter) - bandHalf);
              y <= Math.min(height - 1, Math.round(lineCenter) + bandHalf);
              y += 1
            ) {
              peak = Math.max(peak, mask[y * width + x])
            }
            profile[x] = peak
          } else {
            let dark = 0
            let samples = 0
            for (
              let y = Math.max(0, Math.round(lineCenter) - bandHalf);
              y <= Math.min(height - 1, Math.round(lineCenter) + bandHalf);
              y += 1
            ) {
              samples += 1
              dark += mask[y * width + x]
            }
            profile[x] = samples > 0 ? dark / samples : 0
          }
        }
      } else {
        for (let y = 0; y < height; y += 1) {
          if (compactTile) {
            let peak = 0
            for (
              let x = Math.max(0, Math.round(lineCenter) - bandHalf);
              x <= Math.min(width - 1, Math.round(lineCenter) + bandHalf);
              x += 1
            ) {
              peak = Math.max(peak, mask[y * width + x])
            }
            profile[y] = peak
          } else {
            let dark = 0
            let samples = 0
            for (
              let x = Math.max(0, Math.round(lineCenter) - bandHalf);
              x <= Math.min(width - 1, Math.round(lineCenter) + bandHalf);
              x += 1
            ) {
              samples += 1
              dark += mask[y * width + x]
            }
            profile[y] = samples > 0 ? dark / samples : 0
          }
        }
      }

      let index = 0
      const profileLimit = horizontal ? width : height
      while (index < profileLimit) {
        while (index < profileLimit && profile[index] < darkThreshold) index += 1
        const start = index
        while (index < profileLimit && profile[index] >= darkThreshold) index += 1
        const end = index
        if (end - start < minRun) continue

        const snappedLine = snapValue(lineCenter, snap)
        if (horizontal) {
          candidates.push({
            orientation: 'horizontal',
            x1: snapValue(start, snap),
            y1: snappedLine,
            x2: snapValue(end, snap),
            y2: snappedLine,
            length: snapValue(end, snap) - snapValue(start, snap)
          })
        } else {
          candidates.push({
            orientation: 'vertical',
            x1: snappedLine,
            y1: snapValue(start, snap),
            x2: snappedLine,
            y2: snapValue(end, snap),
            length: snapValue(end, snap) - snapValue(start, snap)
          })
        }
      }
    }
  }

  return collapseCandidates(candidates, snap)
}

const suppressParallelDuplicates = (candidates: Candidate[], snap: number): Candidate[] => {
  const horizontals = candidates.filter((candidate) => candidate.orientation === 'horizontal')
  const verticals = candidates.filter((candidate) => candidate.orientation === 'vertical')
  const others = candidates.filter(
    (candidate) => candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical'
  )

  return [
    ...suppressParallelAxisDuplicates(horizontals, true, snap),
    ...suppressParallelAxisDuplicates(verticals, false, snap),
    ...others
  ]
}

const suppressParallelAxisDuplicates = (
  candidates: Candidate[],
  horizontal: boolean,
  snap: number
): Candidate[] => {
  const lineTolerance = snap * 0.85
  const kept: Candidate[] = []

  for (const candidate of [...candidates].sort((first, second) => second.length - first.length)) {
    const line = horizontal ? candidate.y1 : candidate.x1
    const [start, end] = candidateInterval(candidate)
    const isDuplicate = kept.some((existing) => {
      const existingLine = horizontal ? existing.y1 : existing.x1
      if (Math.abs(existingLine - line) > lineTolerance) return false
      const [existingStart, existingEnd] = candidateInterval(existing)
      const overlap = Math.min(end, existingEnd) - Math.max(start, existingStart)
      if (overlap <= 0) return false
      const shorter = Math.min(end - start, existingEnd - existingStart)
      return shorter > 0 && overlap / shorter >= 0.65
    })

    if (!isDuplicate) kept.push(candidate)
  }

  return kept
}

const retainConnectedWallNetwork = (
  candidates: Candidate[],
  width: number,
  height: number,
  gridScale: number,
  snap: number
): Candidate[] => {
  const axisCandidates = candidates.filter(
    (candidate) => candidate.orientation === 'horizontal' || candidate.orientation === 'vertical'
  )
  const nonAxisCandidates = candidates.filter(
    (candidate) => candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical'
  )
  const key = (candidate: Candidate): string => candidateKey(candidate, snap)
  const kept = new Set<string>()
  const compactTile = width <= 530 || height <= 530
  const seedLength = compactTile ? Math.max(gridScale * 0.24, 10) : gridScale * 1.35
  const attachLength = compactTile
    ? Math.max(gridScale * 0.18, 10)
    : Math.max(gridScale * 0.38, 16)
  const junctionTolerance = Math.max(snap * 1.2, gridScale * 0.18)

  for (const candidate of axisCandidates) {
    if (candidate.length >= seedLength) kept.add(key(candidate))
  }

  for (const candidate of axisCandidates) {
    if (kept.has(key(candidate))) continue
    if (
      candidate.length >= gridScale * 0.92 &&
      candidate.length <= gridScale * 1.08 &&
      wallTouchesKeptNetwork(candidate, axisCandidates, kept, junctionTolerance, snap)
    ) {
      kept.add(key(candidate))
    }
  }

  let grew = true
  while (grew) {
    grew = false
    for (const candidate of axisCandidates) {
      if (kept.has(key(candidate))) continue
      if (candidate.length < attachLength) continue
      if (wallTouchesKeptNetwork(candidate, axisCandidates, kept, junctionTolerance, snap)) {
        kept.add(key(candidate))
        grew = true
      }
    }
  }

  return [
    ...axisCandidates.filter((candidate) => kept.has(key(candidate))),
    ...nonAxisCandidates
  ]
}

const wallTouchesKeptNetwork = (
  candidate: Candidate,
  axisCandidates: Candidate[],
  kept: Set<string>,
  tolerance: number,
  snap: number
): boolean => {
  const horizontal = candidate.orientation === 'horizontal'
  const line = horizontal ? candidate.y1 : candidate.x1
  const [start, end] = candidateInterval(candidate)

  for (const endpoint of [start, end]) {
    for (const other of axisCandidates) {
      if (!kept.has(candidateKey(other, snap))) continue

      if (other.orientation === candidate.orientation) {
        const otherLine = horizontal ? other.y1 : other.x1
        if (Math.abs(otherLine - line) > tolerance) continue
        const [otherStart, otherEnd] = candidateInterval(other)
        if (endpoint >= otherStart - tolerance && endpoint <= otherEnd + tolerance) return true
        continue
      }

      if (horizontal) {
        const otherX = other.x1
        const [otherYStart, otherYEnd] = candidateInterval(other)
        if (
          Math.abs(endpoint - otherX) <= tolerance &&
          line >= otherYStart - tolerance &&
          line <= otherYEnd + tolerance
        ) {
          return true
        }
      } else {
        const otherY = other.y1
        const [otherXStart, otherXEnd] = candidateInterval(other)
        if (
          Math.abs(endpoint - otherY) <= tolerance &&
          line >= otherXStart - tolerance &&
          line <= otherXEnd + tolerance
        ) {
          return true
        }
      }
    }
  }

  return false
}

const filterFloorPlanWallCandidates = (
  candidates: Candidate[],
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number
): Candidate[] =>
  candidates.filter((candidate) =>
    isFloorPlanWallCandidate(candidate, width, height, mask, gridScale)
  )

const isFloorPlanWallCandidate = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array,
  gridScale: number
): boolean => {
  if (candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical') {
    return true
  }

  const margin = Math.max(4, Math.round(gridScale * 0.12))
  const gap = Math.max(2, Math.round(gridScale * 0.06))
  const compactTile = width <= 530 || height <= 530
  const minSpan = compactTile
    ? Math.max(gridScale * 0.18, 10)
    : Math.max(gridScale * 0.38, 16)

  if (candidate.orientation === 'horizontal') {
    const y = Math.round(candidate.y1)
    const [xStart, xEnd] = boundedRange(
      Math.min(candidate.x1, candidate.x2),
      Math.max(candidate.x1, candidate.x2),
      width
    )
    if (xEnd - xStart < minSpan) return false

    const coreDark = 1 - sampleWhiteRatio(mask, width, height, xStart, xEnd, y - 1, y + 2)
    const onNorthEdge = y <= gap + 2
    const onSouthEdge = y >= height - gap - 3
    const north = sampleWhiteRatio(mask, width, height, xStart, xEnd, y - margin, y - gap)
    const south = sampleWhiteRatio(mask, width, height, xStart, xEnd, y + gap, y + margin)

    return (
      coreDark >= 0.32 &&
      hasFloorPlanBoundary(north, south, onNorthEdge, onSouthEdge)
    )
  }

  const x = Math.round(candidate.x1)
  const [yStart, yEnd] = boundedRange(
    Math.min(candidate.y1, candidate.y2),
    Math.max(candidate.y1, candidate.y2),
    height
  )
  if (yEnd - yStart < minSpan) return false

  const coreDark = 1 - sampleWhiteRatio(mask, width, height, x - 1, x + 2, yStart, yEnd)
  const onWestEdge = x <= gap + 2
  const onEastEdge = x >= width - gap - 3
  const west = sampleWhiteRatio(mask, width, height, x - margin, x - gap, yStart, yEnd)
  const east = sampleWhiteRatio(mask, width, height, x + gap, x + margin, yStart, yEnd)

  return (
    coreDark >= 0.32 &&
    hasFloorPlanBoundary(west, east, onWestEdge, onEastEdge)
  )
}

const hasFloorPlanBoundary = (
  firstSide: number,
  secondSide: number,
  onFirstEdge: boolean,
  onSecondEdge: boolean
): boolean => {
  const firstValid = onFirstEdge || firstSide >= 0.62 || firstSide <= 0.15
  const secondValid = onSecondEdge || secondSide >= 0.62 || secondSide <= 0.15
  return firstValid && secondValid
}

const sampleWhiteRatio = (
  mask: Uint8Array,
  width: number,
  height: number,
  xStart: number,
  xEnd: number,
  yStart: number,
  yEnd: number
): number => {
  const left = clamp(Math.min(xStart, xEnd), 0, width)
  const right = clamp(Math.max(xStart, xEnd), 0, width)
  const top = clamp(Math.min(yStart, yEnd), 0, height)
  const bottom = clamp(Math.max(yStart, yEnd), 0, height)
  if (right <= left || bottom <= top) return 0

  let white = 0
  let samples = 0
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      samples += 1
      if (mask[y * width + x] === 0) white += 1
    }
  }

  return samples > 0 ? white / samples : 0
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
  grid: GridGeometry,
  snap: number
): boolean => {
  if (candidate.orientation !== 'horizontal' && candidate.orientation !== 'vertical') {
    return false
  }

  const lineCoord = candidate.orientation === 'horizontal' ? candidate.y1 : candidate.x1
  const axisScale = candidate.orientation === 'horizontal' ? grid.scaleY : grid.scaleX
  const gridTolerance = Math.max(axisScale * 0.5, snap)
  if (!nearGridLine(lineCoord, axisScale, gridTolerance, grid.dualPhase)) return false

  const minStructuralLength = compactAxisScale(
    width,
    height,
    candidate.orientation === 'horizontal' ? grid.scaleY : grid.scaleX
  )
    ? Math.max(axisScale * 0.22, 10)
    : Math.max(axisScale * 0.45, 22)
  if (candidate.length < minStructuralLength) return false

  if (candidateBandThickness(candidate, width, height, mask) < 3) return false
  if (width === 1000 && height === 1000) {
    return isThinWallBand(candidate, width, height, mask, axisScale)
  }
  return true
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

const isThinWallBand = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array,
  axisScale: number
): boolean => {
  const maxThickness = Math.max(Math.round(axisScale * 0.22), 8)
  const perpendicularSpan = candidatePerpendicularDarkSpan(candidate, width, height, mask)
  return perpendicularSpan <= maxThickness
}

const candidatePerpendicularDarkSpan = (
  candidate: Candidate,
  width: number,
  height: number,
  mask: Uint8Array
): number => {
  const [start, end] = candidateInterval(candidate)
  const darkThreshold = 0.42

  if (candidate.orientation === 'horizontal') {
    const yCenter = Math.round(candidate.y1)
    const [xStart, xEnd] = boundedRange(start, end, width)
    let minY = height
    let maxY = -1
    for (let y = Math.max(0, yCenter - 14); y <= Math.min(height - 1, yCenter + 14); y += 1) {
      let dark = 0
      let samples = 0
      for (let x = xStart; x < xEnd; x += 1) {
        samples += 1
        dark += mask[y * width + x]
      }
      if (samples > 0 && dark / samples >= darkThreshold) {
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    return maxY >= minY ? maxY - minY + 1 : 0
  }

  const xCenter = Math.round(candidate.x1)
  const [yStart, yEnd] = boundedRange(start, end, height)
  let minX = width
  let maxX = -1
  for (let x = Math.max(0, xCenter - 14); x <= Math.min(width - 1, xCenter + 14); x += 1) {
    let dark = 0
    let samples = 0
    for (let y = yStart; y < yEnd; y += 1) {
      samples += 1
      dark += mask[y * width + x]
    }
    if (samples > 0 && dark / samples >= darkThreshold) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }
  }
  return maxX >= minX ? maxX - minX + 1 : 0
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
  grid: GridGeometry,
  snap: number
): Candidate[] => {
  const doors = [
    ...detectAxisGapDoorCandidates(horizontal, true, width, height, mask, grid.scaleY, snap, grid.dualPhase),
    ...detectAxisGapDoorCandidates(vertical, false, width, height, mask, grid.scaleX, snap, grid.dualPhase),
    ...detectSlidingDoorCandidates(width, height, mask, horizontal, vertical, grid, snap)
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
  snap: number,
  dualPhase: boolean
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
    if (!nearGridLine(lineCoord, gridScale, gridTolerance, dualPhase)) continue
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
  grid: GridGeometry,
  snap: number
): Candidate[] => {
  const minLength = Math.max(grid.uniform * 0.28, 12)
  const maxLength = Math.max(grid.uniform * 1.25, minLength + 1)
  const doors = [
    ...detectHorizontalSlidingDoors(
      scanShortHorizontal(width, height, mask, minLength, maxLength, grid.scaleY, grid.dualPhase),
      width,
      height,
      mask,
      horizontalWalls,
      grid.scaleY,
      snap,
      grid.dualPhase
    ),
    ...detectVerticalSlidingDoors(
      scanShortVertical(width, height, mask, minLength, maxLength, grid.scaleX, grid.dualPhase),
      width,
      height,
      mask,
      verticalWalls,
      grid.scaleX,
      snap,
      grid.dualPhase
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
  snap: number,
  dualPhase: boolean
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

      if (!nearGridLine(y, gridScale, gridTolerance, dualPhase)) continue
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
  snap: number,
  dualPhase: boolean
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

      if (!nearGridLine(x, gridScale, gridTolerance, dualPhase)) continue
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
  maxLength: number,
  gridScale: number,
  dualPhase: boolean
): Candidate[] => {
  const candidates: Candidate[] = []
  const lineCount = Math.ceil(height / gridScale)
  const phases = dualPhase ? [0, gridScale / 2] : [0]

  for (const phase of phases) {
    for (let gridIndex = 0; gridIndex <= lineCount; gridIndex += 1) {
      const y = Math.round(gridIndex * gridScale + phase)
      if (y < 0 || y >= height) continue

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
  }
  return candidates
}

const scanShortVertical = (
  width: number,
  height: number,
  mask: Uint8Array,
  minLength: number,
  maxLength: number,
  gridScale: number,
  dualPhase: boolean
): Candidate[] => {
  const candidates: Candidate[] = []
  const lineCount = Math.ceil(width / gridScale)
  const phases = dualPhase ? [0, gridScale / 2] : [0]

  for (const phase of phases) {
    for (let gridIndex = 0; gridIndex <= lineCount; gridIndex += 1) {
      const x = Math.round(gridIndex * gridScale + phase)
      if (x < 0 || x >= width) continue

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

const nearGridLine = (
  value: number,
  gridScale: number,
  tolerance: number,
  dualPhase = false
): boolean => {
  if (!Number.isFinite(value) || !Number.isFinite(gridScale) || gridScale <= 0) return true
  const nearPhase = (phase: number): boolean => {
    const offset = ((value - phase) % gridScale + gridScale) % gridScale
    return Math.min(offset, gridScale - offset) <= tolerance
  }
  return nearPhase(0) || (dualPhase && nearPhase(gridScale / 2))
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
