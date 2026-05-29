import {effect, signal} from '@preact/signals'
import {render as renderPreact, type ComponentChildren, type JSX} from 'preact'
import {useEffect, useRef} from 'preact/hooks'
import {detectWebGpu} from './gpu'
import {
  analyzeImageRgba,
  visibilityPolygon,
  type AnalysisResult,
  type DoorOccluder,
  type Occluder,
  type Point
} from './los-core'
import './styles.css'

type Tool = 'viewer' | 'wall' | 'door' | 'erase'

type Tile = {
  id: string
  name: string
  image: HTMLImageElement
  url: string
  width: number
  height: number
}

type Placement = {
  tile: Tile
  x: number
  y: number
}

type BoardSize = {
  width: number
  height: number
}

const tool = signal<Tool>('viewer')
const tiles = signal<Tile[]>([])
const placements = signal<Placement[]>([])
const occluders = signal<Occluder[]>([])
const doorStates = signal<Record<string, {open: boolean}>>({})
const viewer = signal<Point>({x: 250, y: 250})
const boardSize = signal<BoardSize>({width: 1000, height: 1000})
const zoom = signal(1)
const showWalls = signal(false)
const hideUnseen = signal(false)
const gridValue = signal(50)
const sightValue = signal(700)
const columnsValue = signal(2)
const runtimeStatus = signal('Loading line-of-sight tools...')
const gpuStatus = signal('Checking...')
const dragStart = signal<Point | null>(null)
const previewPoint = signal<Point | null>(null)
const isMovingViewer = signal(false)
const dropDepth = signal(0)
const renderTick = signal(0)

let canvas: HTMLCanvasElement
let boardViewport: HTMLDivElement
let ctx: CanvasRenderingContext2D

const minZoom = 0.35
const maxZoom = 4
const doorCarveTolerance = 8
const minCarvedWallLength = 8

const exploredCanvas = document.createElement('canvas')
const exploredCtx = exploredCanvas.getContext('2d')
if (!exploredCtx) throw new Error('Offscreen canvas is required.')

const gridScale = (): number => Math.max(10, gridValue.value || 50)
const sightRadius = (): number => Math.max(50, sightValue.value || 700)
const columns = (): number => Math.max(1, columnsValue.value || 1)
const hasMap = (): boolean => placements.value.length > 0

const nextId = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`

const setStatus = (message: string): void => {
  runtimeStatus.value = message
}

const requestCanvasRender = (): void => {
  renderTick.value += 1
}

const imageFilesFrom = (files: Iterable<File>): File[] =>
  Array.from(files).filter(
    (file) =>
      file.type.startsWith('image/') ||
      /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name)
  )

const loadImage = async (file: File): Promise<Tile> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      resolve({
        id: nextId('tile'),
        name: file.webkitRelativePath || file.name,
        image,
        url,
        width: image.naturalWidth,
        height: image.naturalHeight
      })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`Could not load image ${file.name}.`))
    }
    image.src = url
  })

const loadMapFiles = async (files: Iterable<File>): Promise<void> => {
  const imageFiles = imageFilesFrom(files)
  if (imageFiles.length === 0) {
    setStatus('Select or drop one or more image map files.')
    return
  }

  setStatus(`Loading ${imageFiles.length} image(s)...`)
  const loadedTiles: Tile[] = []
  try {
    for (const file of imageFiles) {
      loadedTiles.push(await loadImage(file))
    }
  } catch (error) {
    for (const tile of loadedTiles) URL.revokeObjectURL(tile.url)
    setStatus(error instanceof Error ? error.message : 'Could not load map images.')
    return
  }

  for (const tile of tiles.value) URL.revokeObjectURL(tile.url)
  tiles.value = loadedTiles
  occluders.value = []
  doorStates.value = {}
  arrangeTiles()
  markExplored()
  setStatus(`Loaded ${tiles.value.length} image(s). Run analysis, then review walls and doors.`)
  requestCanvasRender()
}

const arrangeTiles = (): void => {
  if (tiles.value.length === 0) {
    placements.value = []
    resizeBoard(1000, 1000)
    requestCanvasRender()
    return
  }

  const colCount = columns()
  const cellWidth = Math.max(...tiles.value.map((tile) => tile.width))
  const cellHeight = Math.max(...tiles.value.map((tile) => tile.height))
  const usedColumns = Math.min(colCount, tiles.value.length)
  placements.value = tiles.value.map((tile, index) => ({
    tile,
    x: (index % colCount) * cellWidth,
    y: Math.floor(index / colCount) * cellHeight
  }))
  resizeBoard(usedColumns * cellWidth, Math.ceil(tiles.value.length / colCount) * cellHeight)
  viewer.value = {
    x: Math.min(viewer.value.x, boardSize.value.width),
    y: Math.min(viewer.value.y, boardSize.value.height)
  }
  requestCanvasRender()
}

const resizeBoard = (width: number, height: number): void => {
  boardSize.value = {width, height}
  syncCanvasSize(true)
}

const syncCanvasSize = (clearExplored = false): void => {
  if (!canvas) return

  const {width, height} = boardSize.value
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  if (exploredCanvas.width !== width) {
    exploredCanvas.width = width
    clearExplored = true
  }
  if (exploredCanvas.height !== height) {
    exploredCanvas.height = height
    clearExplored = true
  }
  if (clearExplored) exploredCtx.clearRect(0, 0, width, height)
  updateCanvasDisplaySize()
}

const updateCanvasDisplaySize = (): void => {
  if (!canvas) return
  canvas.style.width = `${boardSize.value.width * zoom.value}px`
  canvas.style.height = `${boardSize.value.height * zoom.value}px`
}

const doorOccluders = (): DoorOccluder[] =>
  occluders.value.filter((occluder): occluder is DoorOccluder => occluder.type === 'door')

const isDoorOpen = (door: DoorOccluder): boolean =>
  doorStates.value[door.id]?.open ?? door.open

const setDoorOpen = (doorId: string, open: boolean): void => {
  const door = doorOccluders().find((candidate) => candidate.id === doorId)
  if (!door) return
  doorStates.value = {...doorStates.value, [door.id]: {open}}
  markExplored()
  requestCanvasRender()
}

const analyzeTiles = async (): Promise<void> => {
  if (placements.value.length === 0) {
    setStatus('Select one or more map images first.')
    return
  }

  setStatus('Analyzing wall candidates...')
  const manual = occluders.value.filter((occluder) => occluder.id.startsWith('manual-'))
  const generated: Occluder[] = []
  const scratch = document.createElement('canvas')
  const scratchCtx = scratch.getContext('2d', {willReadFrequently: true})
  if (!scratchCtx) throw new Error('Canvas image analysis is unavailable.')

  for (const placement of placements.value) {
    scratch.width = placement.tile.width
    scratch.height = placement.tile.height
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height)
    scratchCtx.drawImage(placement.tile.image, 0, 0)
    const imageData = scratchCtx.getImageData(0, 0, scratch.width, scratch.height)
    const result = analyzeImageRgba(
      scratch.width,
      scratch.height,
      imageData.data,
      gridScale()
    ) satisfies AnalysisResult

    for (const occluder of result.occluders) {
      generated.push(transformOccluder(occluder, placement))
    }
  }

  occluders.value = carveDoorGaps([...generated, ...manual])
  doorStates.value = Object.fromEntries(
    Object.entries(doorStates.value).filter(([doorId]) =>
      occluders.value.some((occluder) => occluder.type === 'door' && occluder.id === doorId)
    )
  )
  markExplored()
  setStatus(`Analyzed ${placements.value.length} tile(s); review the overlay before export.`)
  requestCanvasRender()
}

const transformOccluder = (occluder: Occluder, placement: Placement): Occluder => {
  const base = {
    id: `${placement.tile.id}:${occluder.id}`,
    x1: occluder.x1 + placement.x,
    y1: occluder.y1 + placement.y,
    x2: occluder.x2 + placement.x,
    y2: occluder.y2 + placement.y
  }

  return occluder.type === 'door'
    ? {...base, type: 'door', open: occluder.open}
    : {...base, type: 'wall'}
}

const occluderAxis = (occluder: Occluder): 'horizontal' | 'vertical' | null => {
  const dx = Math.abs(occluder.x2 - occluder.x1)
  const dy = Math.abs(occluder.y2 - occluder.y1)
  if (dx >= minCarvedWallLength && dy <= doorCarveTolerance) return 'horizontal'
  if (dy >= minCarvedWallLength && dx <= doorCarveTolerance) return 'vertical'
  return null
}

const lineCoordinate = (
  occluder: Occluder,
  axis: 'horizontal' | 'vertical'
): number =>
  axis === 'horizontal'
    ? (occluder.y1 + occluder.y2) / 2
    : (occluder.x1 + occluder.x2) / 2

const intervalFor = (
  occluder: Occluder,
  axis: 'horizontal' | 'vertical'
): [number, number] => {
  const first = axis === 'horizontal' ? occluder.x1 : occluder.y1
  const second = axis === 'horizontal' ? occluder.x2 : occluder.y2
  return first <= second ? [first, second] : [second, first]
}

const mergeIntervals = (intervals: Array<[number, number]>): Array<[number, number]> => {
  const sorted = intervals
    .filter(([start, end]) => end - start >= minCarvedWallLength)
    .sort(([a], [b]) => a - b)
  const merged: Array<[number, number]> = []

  for (const [start, end] of sorted) {
    const previous = merged.at(-1)
    if (!previous || start > previous[1]) {
      merged.push([start, end])
    } else {
      previous[1] = Math.max(previous[1], end)
    }
  }

  return merged
}

const carveDoorGaps = (items: Occluder[]): Occluder[] => {
  const doors = items.filter((item): item is DoorOccluder => item.type === 'door')
  if (doors.length === 0) return items

  const carved: Occluder[] = []
  for (const item of items) {
    if (item.type === 'door') {
      carved.push(item)
      continue
    }

    const axis = occluderAxis(item)
    if (!axis) {
      carved.push(item)
      continue
    }

    const wallLine = lineCoordinate(item, axis)
    const [wallStart, wallEnd] = intervalFor(item, axis)
    const exclusions = mergeIntervals(
      doors.flatMap((door): Array<[number, number]> => {
        const doorAxis = occluderAxis(door)
        if (doorAxis !== axis) return []
        if (Math.abs(lineCoordinate(door, axis) - wallLine) > doorCarveTolerance) {
          return []
        }

        const [doorStart, doorEnd] = intervalFor(door, axis)
        const start = Math.max(wallStart, doorStart - doorCarveTolerance / 2)
        const end = Math.min(wallEnd, doorEnd + doorCarveTolerance / 2)
        return end - start >= minCarvedWallLength ? [[start, end]] : []
      })
    )

    if (exclusions.length === 0) {
      carved.push(item)
      continue
    }

    const pieces: Array<[number, number]> = []
    let cursor = wallStart
    for (const [start, end] of exclusions) {
      if (start - cursor >= minCarvedWallLength) pieces.push([cursor, start])
      cursor = Math.max(cursor, end)
    }
    if (wallEnd - cursor >= minCarvedWallLength) pieces.push([cursor, wallEnd])

    for (const [index, [start, end]] of pieces.entries()) {
      carved.push({
        ...item,
        id: `${item.id}:part-${index + 1}`,
        x1: axis === 'horizontal' ? start : item.x1,
        y1: axis === 'vertical' ? start : item.y1,
        x2: axis === 'horizontal' ? end : item.x2,
        y2: axis === 'vertical' ? end : item.y2
      })
    }
  }

  return carved
}

const drawPolygonPath = (
  target: CanvasRenderingContext2D,
  polygon: Point[]
): void => {
  if (polygon.length === 0) return
  target.beginPath()
  target.moveTo(polygon[0].x, polygon[0].y)
  for (const point of polygon.slice(1)) {
    target.lineTo(point.x, point.y)
  }
  target.closePath()
}

const getVisiblePolygon = (): Point[] =>
  visibilityPolygon(
    viewer.value.x,
    viewer.value.y,
    boardSize.value.width,
    boardSize.value.height,
    sightRadius(),
    occluders.value,
    doorStates.value
  )

const markExplored = (): void => {
  if (!hasMap()) return

  const polygon = getVisiblePolygon()
  exploredCtx.save()
  exploredCtx.fillStyle = '#fff'
  drawPolygonPath(exploredCtx, polygon)
  exploredCtx.fill()
  exploredCtx.restore()
}

const renderBoard = (): void => {
  renderTick.value
  if (!ctx || !canvas) return
  syncCanvasSize()

  const {width, height} = boardSize.value
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = hasMap() ? '#151719' : '#050505'
  ctx.fillRect(0, 0, width, height)

  if (!hasMap()) {
    return
  }

  for (const placement of placements.value) {
    ctx.drawImage(placement.tile.image, placement.x, placement.y)
  }

  drawGrid()
  drawOccluders()
  drawFog()
  drawPreview()
  drawViewer()
}

const drawGrid = (): void => {
  const scale = gridScale()
  ctx.save()
  ctx.strokeStyle =
    placements.value.length === 0 ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.055)'
  ctx.lineWidth = 1
  for (let x = 0; x <= boardSize.value.width; x += scale) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, boardSize.value.height)
    ctx.stroke()
  }
  for (let y = 0; y <= boardSize.value.height; y += scale) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(boardSize.value.width, y)
    ctx.stroke()
  }
  ctx.restore()
}

const drawFog = (): void => {
  const polygon = getVisiblePolygon()
  ctx.save()
  ctx.fillStyle = hideUnseen.value ? '#eeeeee' : 'rgba(238, 238, 238, 0.64)'
  ctx.beginPath()
  ctx.rect(0, 0, boardSize.value.width, boardSize.value.height)
  if (polygon.length > 2) {
    ctx.moveTo(polygon[0].x, polygon[0].y)
    for (const point of polygon.slice(1)) {
      ctx.lineTo(point.x, point.y)
    }
    ctx.closePath()
    ctx.fill('evenodd')
  } else {
    ctx.fill()
  }
  ctx.restore()
}

const drawOccluders = (): void => {
  ctx.save()
  ctx.lineCap = 'round'
  for (const occluder of occluders.value) {
    const isDoor = occluder.type === 'door'
    if (!isDoor && !showWalls.value) continue

    if (isDoor) {
      drawDoorStateMarker(occluder, isDoorOpen(occluder))
      continue
    }

    ctx.strokeStyle = '#d72638'
    ctx.lineWidth = 4
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(occluder.x1, occluder.y1)
    ctx.lineTo(occluder.x2, occluder.y2)
    ctx.stroke()
  }
  ctx.restore()
}

const drawDoorStateMarker = (door: DoorOccluder, open: boolean): void => {
  const dx = door.x2 - door.x1
  const dy = door.y2 - door.y1
  const length = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / length
  const uy = dy / length
  const px = -uy
  const py = ux
  const cap = Math.min(8, Math.max(5, length * 0.22))

  const strokeSegment = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    color: string
  ): void => {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])

  if (!open) {
    strokeSegment(door.x1, door.y1, door.x2, door.y2, 9, 'rgba(0, 0, 0, 0.72)')
    strokeSegment(door.x1, door.y1, door.x2, door.y2, 5, '#f97316')
    strokeSegment(
      door.x1 - px * cap,
      door.y1 - py * cap,
      door.x1 + px * cap,
      door.y1 + py * cap,
      4,
      '#f97316'
    )
    strokeSegment(
      door.x2 - px * cap,
      door.y2 - py * cap,
      door.x2 + px * cap,
      door.y2 + py * cap,
      4,
      '#f97316'
    )
    ctx.restore()
    return
  }

  ctx.setLineDash([3, 8])
  strokeSegment(door.x1, door.y1, door.x2, door.y2, 7, 'rgba(0, 0, 0, 0.62)')
  strokeSegment(door.x1, door.y1, door.x2, door.y2, 3, '#24a148')
  ctx.setLineDash([])

  const swingRadius = Math.min(28, Math.max(12, length * 0.72))
  const closedAngle = Math.atan2(uy, ux)
  const openAngle = closedAngle + Math.PI / 2
  const leafX = door.x1 + Math.cos(openAngle) * swingRadius
  const leafY = door.y1 + Math.sin(openAngle) * swingRadius

  strokeSegment(door.x1, door.y1, leafX, leafY, 6, 'rgba(0, 0, 0, 0.62)')
  strokeSegment(door.x1, door.y1, leafX, leafY, 3, '#24a148')
  ctx.strokeStyle = '#24a148'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(door.x1, door.y1, swingRadius, closedAngle, openAngle)
  ctx.stroke()
  ctx.restore()
}

const drawPreview = (): void => {
  const start = dragStart.value
  const point = previewPoint.value
  if (!start || !point || (tool.value !== 'wall' && tool.value !== 'door')) return
  ctx.save()
  ctx.strokeStyle = tool.value === 'door' ? '#f97316' : '#d72638'
  ctx.lineWidth = tool.value === 'door' ? 7 : 4
  ctx.setLineDash([8, 8])
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(point.x, point.y)
  ctx.stroke()
  ctx.restore()
}

const drawViewer = (): void => {
  ctx.save()
  ctx.fillStyle = '#2f80ed'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(viewer.value.x, viewer.value.y, 13, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(47, 128, 237, 0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(viewer.value.x, viewer.value.y, sightRadius(), 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

const positionFromEvent = (
  event: JSX.TargetedPointerEvent<HTMLCanvasElement>
): Point => {
  const rect = event.currentTarget.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * boardSize.value.width,
    y: ((event.clientY - rect.top) / rect.height) * boardSize.value.height
  }
}

const setZoom = (
  nextZoom: number,
  anchor?: {boardX: number; boardY: number; viewportX: number; viewportY: number}
): void => {
  zoom.value = Math.min(maxZoom, Math.max(minZoom, nextZoom))
  updateCanvasDisplaySize()

  if (anchor && boardViewport) {
    boardViewport.scrollLeft = anchor.boardX * zoom.value - anchor.viewportX
    boardViewport.scrollTop = anchor.boardY * zoom.value - anchor.viewportY
  }
  requestCanvasRender()
}

const handleWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>): void => {
  if (!canvas) return
  event.preventDefault()
  const rect = canvas.getBoundingClientRect()
  const viewportRect = event.currentTarget.getBoundingClientRect()
  const boardX = ((event.clientX - rect.left) / rect.width) * boardSize.value.width
  const boardY = ((event.clientY - rect.top) / rect.height) * boardSize.value.height
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12

  setZoom(zoom.value * factor, {
    boardX,
    boardY,
    viewportX: event.clientX - viewportRect.left,
    viewportY: event.clientY - viewportRect.top
  })
}

const snapPoint = (
  point: Point,
  event: JSX.TargetedPointerEvent<HTMLCanvasElement>
): Point => {
  if (event.shiftKey) return point
  const scale = gridScale() / 4
  return {
    x: Math.round(point.x / scale) * scale,
    y: Math.round(point.y / scale) * scale
  }
}

const distanceToSegment = (point: Point, segment: Occluder): number => {
  const ax = segment.x1
  const ay = segment.y1
  const bx = segment.x2
  const by = segment.y2
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - ax, point.y - ay)
  const t = Math.max(
    0,
    Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / lengthSquared)
  )
  return Math.hypot(point.x - (ax + t * dx), point.y - (ay + t * dy))
}

const nearestOccluder = (
  point: Point,
  filter?: (occluder: Occluder) => boolean,
  screenRadius = 14
): Occluder | null => {
  let nearest: Occluder | null = null
  let nearestDistance = screenRadius / zoom.value
  for (const occluder of occluders.value) {
    if (filter && !filter(occluder)) continue
    const distance = distanceToSegment(point, occluder)
    if (distance < nearestDistance) {
      nearest = occluder
      nearestDistance = distance
    }
  }
  return nearest
}

const handlePointerDown = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
  if (!hasMap()) return

  const rawPoint = positionFromEvent(event)
  const point = snapPoint(rawPoint, event)

  if (tool.value !== 'erase') {
    const door = nearestOccluder(rawPoint, (occluder) => occluder.type === 'door', 18)
    if (door && door.type === 'door') {
      setDoorOpen(door.id, !isDoorOpen(door))
      return
    }
  }

  if (tool.value === 'viewer') {
    viewer.value = point
    isMovingViewer.value = true
    event.currentTarget.setPointerCapture(event.pointerId)
    markExplored()
    requestCanvasRender()
    return
  }

  if (tool.value === 'erase') {
    const target = nearestOccluder(rawPoint)
    if (target) {
      occluders.value = occluders.value.filter((occluder) => occluder.id !== target.id)
      const nextDoorStates = {...doorStates.value}
      delete nextDoorStates[target.id]
      doorStates.value = nextDoorStates
      markExplored()
      requestCanvasRender()
    }
    return
  }

  dragStart.value = point
  previewPoint.value = point
  event.currentTarget.setPointerCapture(event.pointerId)
  requestCanvasRender()
}

const handlePointerMove = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
  const point = snapPoint(positionFromEvent(event), event)
  if (isMovingViewer.value) {
    viewer.value = point
    markExplored()
    requestCanvasRender()
    return
  }

  if (!dragStart.value) return
  previewPoint.value = point
  requestCanvasRender()
}

const handlePointerUp = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
  const point = snapPoint(positionFromEvent(event), event)
  if (isMovingViewer.value) {
    isMovingViewer.value = false
    event.currentTarget.releasePointerCapture(event.pointerId)
    return
  }

  const start = dragStart.value
  if (!start || (tool.value !== 'wall' && tool.value !== 'door')) return

  const length = Math.hypot(point.x - start.x, point.y - start.y)
  if (length > 6) {
    const id = nextId(tool.value === 'door' ? 'manual-door' : 'manual-wall')
    const nextOccluders: Occluder[] = [...occluders.value]
    if (tool.value === 'door') {
      nextOccluders.push({
        type: 'door',
        id,
        x1: start.x,
        y1: start.y,
        x2: point.x,
        y2: point.y,
        open: false
      })
      doorStates.value = {...doorStates.value, [id]: {open: false}}
    } else {
      nextOccluders.push({
        type: 'wall',
        id,
        x1: start.x,
        y1: start.y,
        x2: point.x,
        y2: point.y
      })
    }
    occluders.value = carveDoorGaps(nextOccluders)
  }

  dragStart.value = null
  previewPoint.value = null
  event.currentTarget.releasePointerCapture(event.pointerId)
  markExplored()
  requestCanvasRender()
}

const handlePointerCancel = (): void => {
  dragStart.value = null
  previewPoint.value = null
  isMovingViewer.value = false
  requestCanvasRender()
}

const exportSidecar = async (): Promise<void> => {
  const sidecar = {
    assetRef: 'composed-board',
    width: boardSize.value.width,
    height: boardSize.value.height,
    gridScale: gridScale(),
    occluders: occluders.value.map((occluder) =>
      occluder.type === 'door'
        ? {
            ...occluder,
            open: isDoorOpen(occluder)
          }
        : occluder
    )
  }
  const json = `${JSON.stringify(sidecar, null, 2)}\n`
  try {
    await navigator.clipboard.writeText(json)
    setStatus('Exported sidecar JSON and copied it to the clipboard.')
  } catch {
    const blob = new Blob([json], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'line-of-sight-sidecar.json'
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setStatus('Exported sidecar JSON as a download.')
  }
}

const handleDragEnter = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dropDepth.value += 1
}

const handleDragOver = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

const handleDragLeave = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer?.types.includes('Files')) return
  dropDepth.value = Math.max(0, dropDepth.value - 1)
}

const handleDrop = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer) return
  event.preventDefault()
  dropDepth.value = 0
  void loadMapFiles(event.dataTransfer.files)
}

const getBoardStat = (): string =>
  `${Math.round(boardSize.value.width)} x ${Math.round(boardSize.value.height)}`

const getDoorStat = (): string => {
  const doors = doorOccluders()
  const openCount = doors.filter(isDoorOpen).length
  return doors.length === 0 ? '0' : `${doors.length} (${openCount} open)`
}

const Icon = ({children}: {children: ComponentChildren}): JSX.Element => (
  <svg className="button-icon" viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
)

const ToolIcon = ({children}: {children: ComponentChildren}): JSX.Element => (
  <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
)

const ToolButton = ({
  value,
  children,
  icon
}: {
  value: Tool
  children: ComponentChildren
  icon: ComponentChildren
}): JSX.Element => (
  <button
    className={`tool-button${tool.value === value ? ' active' : ''}`}
    type="button"
    data-tool={value}
    onClick={() => {
      tool.value = value
    }}
  >
    <ToolIcon>{icon}</ToolIcon>
    <span>{children}</span>
  </button>
)

const App = (): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!canvasRef.current || !viewportRef.current) {
      throw new Error('Line of Sight UI failed to mount.')
    }

    canvas = canvasRef.current
    boardViewport = viewportRef.current
    const canvasContext = canvas.getContext('2d')
    if (!canvasContext) throw new Error('Canvas 2D is required.')
    ctx = canvasContext
    syncCanvasSize(true)

    const dispose = effect(renderBoard)
    void detectWebGpu().then((status) => {
      gpuStatus.value = status
    })
    setStatus('Ready. Select local map images to start.')

    return () => {
      dispose()
      for (const tile of tiles.value) URL.revokeObjectURL(tile.url)
    }
  }, [])

  const activeTileCount = tiles.value.length

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="https://tre.systems/" aria-label="Total Reality Engineering">
          <svg
            className="brand-logo"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 512 512"
            aria-hidden="true"
          >
            <g>
              <rect
                x="214"
                y="288"
                width="80"
                height="206"
                fill="#19C15E"
                transform="rotate(22, 262, 295)"
              />
              <path
                d="M256 36 L72 476 L440 476 Z"
                fill="none"
                stroke="#F5F5F5"
                strokeWidth="30"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle cx="256" cy="288" r="40" fill="#F5F5F5" />
            </g>
          </svg>
          <div className="brand-copy">
            <span>Total Reality Engineering</span>
            <h1>Line of Sight</h1>
            <p id="runtimeStatus">{runtimeStatus.value}</p>
          </div>
        </a>
        <div className="toolbar">
          <label className="file-button primary-action">
            <input
              id="fileInput"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                void loadMapFiles(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
              }}
            />
            <Icon>
              <path d="M12 3v12" />
              <path d="m7 8 5-5 5 5" />
              <path d="M5 15v3a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-3" />
            </Icon>
            <span>Select maps</span>
          </label>
          <label className="number-control">
            <span>Columns</span>
            <input
              id="columnsInput"
              type="number"
              min="1"
              max="12"
              value={columnsValue.value}
              onInput={(event) => {
                columnsValue.value = Math.max(1, Number(event.currentTarget.value) || 1)
                arrangeTiles()
              }}
            />
          </label>
          <label className="number-control">
            <span>Grid</span>
            <input
              id="gridInput"
              type="number"
              min="10"
              max="200"
              value={gridValue.value}
              onInput={(event) => {
                gridValue.value = Math.max(10, Number(event.currentTarget.value) || 50)
                markExplored()
                requestCanvasRender()
              }}
            />
          </label>
          <label className="sight-control">
            <span>
              <Icon>
                <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                <circle cx="12" cy="12" r="2.5" />
              </Icon>
              Sight
            </span>
            <input
              id="radiusInput"
              type="range"
              min="50"
              max="5000"
              step="50"
              value={sightValue.value}
              onInput={(event) => {
                sightValue.value = Math.max(50, Number(event.currentTarget.value) || 700)
                markExplored()
                requestCanvasRender()
              }}
            />
            <output id="radiusValue" htmlFor="radiusInput">
              {sightValue.value}
            </output>
          </label>
          <button
            id="showWallsButton"
            type="button"
            aria-pressed={showWalls.value}
            onClick={() => {
              showWalls.value = !showWalls.value
            }}
          >
            <Icon>
              <path d="M4 7h16" />
              <path d="M4 12h16" />
              <path d="M4 17h16" />
            </Icon>
            <span>{showWalls.value ? 'Hide walls' : 'Show walls'}</span>
          </button>
          <button id="analyzeButton" type="button" onClick={() => void analyzeTiles()}>
            <Icon>
              <path d="M14 4h6v6" />
              <path d="M20 4 13 11" />
              <path d="M4 20 10.5 13.5" />
              <path d="m8 4 1.5 3L13 8.5 9.5 10 8 13 6.5 10 3 8.5 6.5 7 8 4Z" />
            </Icon>
            <span>Analyze</span>
          </button>
          <button
            id="resetFogButton"
            type="button"
            onClick={() => {
              exploredCtx.clearRect(0, 0, boardSize.value.width, boardSize.value.height)
              markExplored()
              requestCanvasRender()
            }}
          >
            <Icon>
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 4v6h6" />
            </Icon>
            <span>Reset fog</span>
          </button>
          <button
            id="fogModeButton"
            type="button"
            aria-pressed={hideUnseen.value}
            title="Toggle opaque unseen areas"
            onClick={() => {
              hideUnseen.value = !hideUnseen.value
            }}
          >
            <Icon>
              <path d="M3 3l18 18" />
              <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
              <path d="M9.9 4.2A9.8 9.8 0 0 1 12 4c6 0 9.5 8 9.5 8a17.4 17.4 0 0 1-2.2 3.3" />
              <path d="M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 8 9.5 8a9.7 9.7 0 0 0 4.7-1.2" />
            </Icon>
            <span>Hide unseen</span>
          </button>
          <button id="exportButton" type="button" onClick={() => void exportSidecar()}>
            <Icon>
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 21h14" />
            </Icon>
            <span>Export</span>
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="panel">
            <h2>Tools</h2>
            <div className="tool-grid" role="group" aria-label="Map editing tools">
              <ToolButton
                value="viewer"
                icon={
                  <>
                    <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </>
                }
              >
                Viewer
              </ToolButton>
              <ToolButton
                value="wall"
                icon={
                  <>
                    <path d="M4 8h16" />
                    <path d="M4 16h16" />
                    <path d="M8 8v8" />
                    <path d="M16 8v8" />
                  </>
                }
              >
                Wall
              </ToolButton>
              <ToolButton
                value="door"
                icon={
                  <>
                    <path d="M5 21V4h10v17" />
                    <path d="M15 8h4v13" />
                    <path d="M11 13h.01" />
                  </>
                }
              >
                Door
              </ToolButton>
              <ToolButton
                value="erase"
                icon={
                  <>
                    <path d="m16 3 5 5-11 11H5l-3-3L16 3Z" />
                    <path d="M10 19h11" />
                  </>
                }
              >
                Erase
              </ToolButton>
            </div>
          </div>

          <div className="panel">
            <h2>Tiles</h2>
            <div id="tileList" className="tile-list">
              {tiles.value.map((tile) => (
                <div className="tile-item" key={tile.id}>
                  <img src={tile.url} alt="" />
                  <span>{`${tile.name} (${tile.width}x${tile.height})`}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2>State</h2>
            <dl className="stats">
              <div>
                <dt>Board</dt>
                <dd id="boardStat">{getBoardStat()}</dd>
              </div>
              <div>
                <dt>Occluders</dt>
                <dd id="occluderStat">{occluders.value.length}</dd>
              </div>
              <div>
                <dt>Doors</dt>
                <dd id="doorStat">{getDoorStat()}</dd>
              </div>
              <div>
                <dt>GPU</dt>
                <dd id="gpuStat">{gpuStatus.value}</dd>
              </div>
            </dl>
          </div>
        </aside>

        <section className="board-panel">
          <div
            id="boardViewport"
            ref={viewportRef}
            className={`board-viewport${dropDepth.value > 0 ? ' drag-over' : ''}`}
            onWheel={handleWheel}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <canvas
              id="boardCanvas"
              ref={canvasRef}
              width="1000"
              height="1000"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            />
          </div>
        </section>
      </section>
      {activeTileCount === 0 ? null : <span className="sr-only">{activeTileCount} map tiles loaded</span>}
    </main>
  )
}

const root = document.querySelector('#app')
if (!root) throw new Error('Line of Sight root element is missing.')

renderPreact(<App />, root)
