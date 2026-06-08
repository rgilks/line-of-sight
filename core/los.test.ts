import {describe, expect, it} from 'vitest'
import {analyzeImageRgba, hasLineOfSight, visibilityPolygon, type Occluder, type Point} from './los'

const blankRgba = (width: number, height: number): Uint8ClampedArray => new Uint8ClampedArray(width * height * 4)

const setDark = (rgba: Uint8ClampedArray, width: number, x: number, y: number): void => {
  const index = (y * width + x) * 4
  rgba[index] = 0
  rgba[index + 1] = 0
  rgba[index + 2] = 0
  rgba[index + 3] = 255
}

const fillBand = (
  rgba: Uint8ClampedArray,
  width: number,
  yStart: number,
  yEnd: number,
  xStart: number,
  xEnd: number
): void => {
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      setDark(rgba, width, x, y)
    }
  }
}

const fillRect = (
  rgba: Uint8ClampedArray,
  width: number,
  xStart: number,
  yStart: number,
  xEnd: number,
  yEnd: number
): void => {
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      setDark(rgba, width, x, y)
    }
  }
}

const polygonArea = (points: Point[]): number => {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area) / 2
}

// A 200x200 image with one full-width 5px dark band on the y=100 grid line.
const horizontalWallImage = (): Uint8ClampedArray => {
  const rgba = blankRgba(200, 200)
  fillBand(rgba, 200, 98, 103, 0, 200)
  return rgba
}

describe('analyzeImageRgba', () => {
  it('rejects non-positive dimensions', () => {
    expect(() => analyzeImageRgba(0, 10, blankRgba(1, 10), 50)).toThrow()
  })

  it('rejects a buffer whose length does not match the dimensions', () => {
    expect(() => analyzeImageRgba(10, 10, blankRgba(10, 9), 50)).toThrow()
  })

  it('finds no occluders in a blank image', () => {
    expect(analyzeImageRgba(200, 200, blankRgba(200, 200), 50)).toEqual([])
  })

  it('is deterministic for identical pixels', () => {
    const rgba = horizontalWallImage()
    expect(analyzeImageRgba(200, 200, rgba, 50)).toEqual(analyzeImageRgba(200, 200, rgba, 50))
  })

  it('detects a horizontal wall from a dark band on a grid line', () => {
    const walls = analyzeImageRgba(200, 200, horizontalWallImage(), 50).filter((occluder) => occluder.type === 'wall')

    expect(walls.length).toBeGreaterThan(0)
    expect(walls.some((wall) => Math.abs(wall.y1 - wall.y2) < 1 && Math.abs(wall.y1 - 100) <= 25)).toBe(true)
  })

  it('assigns stable, zero-padded, position-ordered wall ids', () => {
    const walls = analyzeImageRgba(200, 200, horizontalWallImage(), 50).filter((occluder) => occluder.type === 'wall')

    expect(walls[0]?.id).toBe('wall-0001')
  })

  it('detects a closed door in a grid-aligned gap between two collinear walls', () => {
    const width = 300
    const height = 200
    const rgba = blankRgba(width, height)
    // Two wall runs on the y=100 grid line with a ~one-cell gap (150–200) between them.
    fillBand(rgba, width, 98, 103, 0, 150)
    fillBand(rgba, width, 98, 103, 200, width)

    const doors = analyzeImageRgba(width, height, rgba, 50).filter((occluder) => occluder.type === 'door')

    expect(doors.length).toBeGreaterThan(0)
    // Doors are emitted closed with zero-padded ids.
    expect(doors[0]?.id).toBe('door-0001')
    expect(doors[0]?.open).toBe(false)
  })

  it('detects an isolated rectangular cargo obstacle outline', () => {
    const width = 220
    const height = 220
    const rgba = blankRgba(width, height)
    fillRect(rgba, width, 63, 63, 157, 67)
    fillRect(rgba, width, 63, 153, 157, 157)
    fillRect(rgba, width, 63, 63, 67, 157)
    fillRect(rgba, width, 153, 63, 157, 157)

    const walls = analyzeImageRgba(width, height, rgba, 50).filter((occluder) => occluder.type === 'wall')

    expect(walls.length).toBeGreaterThanOrEqual(4)
    expect(walls.some((wall) => Math.abs(wall.y1 - 62.5) <= 1)).toBe(true)
    expect(walls.some((wall) => Math.abs(wall.x1 - 62.5) <= 1)).toBe(true)
  })

  it('detects compact thick ink as wall segments', () => {
    const width = 220
    const height = 220
    const rgba = blankRgba(width, height)
    fillRect(rgba, width, 92, 92, 128, 128)

    const walls = analyzeImageRgba(width, height, rgba, 50).filter((occluder) => occluder.type === 'wall')

    expect(walls.length).toBeGreaterThan(0)
  })

  it('detects thick stroke clusters as wall segments', () => {
    const width = 220
    const height = 220
    const rgba = blankRgba(width, height)
    fillBand(rgba, width, 96, 104, 70, 150)
    fillBand(rgba, width, 70, 150, 96, 104)

    const walls = analyzeImageRgba(width, height, rgba, 50).filter((occluder) => occluder.type === 'wall')

    expect(walls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('hasLineOfSight', () => {
  const wall: Occluder = {type: 'wall', id: 'wall-0001', x1: 100, y1: 0, x2: 100, y2: 200}

  it('is blocked when a wall crosses the sight line', () => {
    expect(hasLineOfSight({x: 50, y: 100}, {x: 150, y: 100}, [wall], {})).toBe(false)
  })

  it('is clear when no occluder crosses the sight line', () => {
    expect(hasLineOfSight({x: 50, y: 50}, {x: 50, y: 150}, [wall], {})).toBe(true)
  })

  it('treats a closed door as blocking and an open door as clear', () => {
    const door: Occluder = {
      type: 'door',
      id: 'door-0001',
      x1: 100,
      y1: 0,
      x2: 100,
      y2: 200,
      open: false
    }
    const from = {x: 50, y: 100}
    const to = {x: 150, y: 100}

    expect(hasLineOfSight(from, to, [door], {})).toBe(false)
    // Both the {open} object and bare boolean lookup shapes are accepted.
    expect(hasLineOfSight(from, to, [door], {'door-0001': {open: true}})).toBe(true)
    expect(hasLineOfSight(from, to, [door], {'door-0001': true})).toBe(true)
  })
})

describe('visibilityPolygon', () => {
  it('rejects non-positive board dimensions', () => {
    expect(() => visibilityPolygon(50, 50, 0, 100, 500, [], {})).toThrow()
  })

  it('returns a polygon bounded by the board for an empty room', () => {
    const width = 200
    const height = 200
    const polygon = visibilityPolygon(100, 100, width, height, 1000, [], {})

    // Polygon vertices are intersections with the board edges, so they may land
    // a floating-point hair outside the exact bounds.
    const epsilon = 1e-6
    expect(polygon.length).toBeGreaterThanOrEqual(4)
    for (const point of polygon) {
      expect(point.x).toBeGreaterThanOrEqual(-epsilon)
      expect(point.x).toBeLessThanOrEqual(width + epsilon)
      expect(point.y).toBeGreaterThanOrEqual(-epsilon)
      expect(point.y).toBeLessThanOrEqual(height + epsilon)
    }
  })

  it('reduces the visible area when a wall casts a shadow', () => {
    const width = 200
    const height = 200
    const wall: Occluder = {type: 'wall', id: 'wall-0001', x1: 120, y1: 60, x2: 120, y2: 140}

    const openArea = polygonArea(visibilityPolygon(100, 100, width, height, 1000, [], {}))
    const blockedArea = polygonArea(visibilityPolygon(100, 100, width, height, 1000, [wall], {}))

    expect(blockedArea).toBeLessThan(openArea)
  })
})
