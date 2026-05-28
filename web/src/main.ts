import initWasm, {
  analyze_image_rgba,
  visibility_polygon
} from '../../crates/los-core/pkg/los_core.js'
import {detectWebGpu} from './gpu'
import './styles.css'

type Tool = 'viewer' | 'wall' | 'door' | 'erase'

type Point = {
  x: number
  y: number
}

type WallOccluder = {
  type: 'wall'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
}

type DoorOccluder = {
  type: 'door'
  id: string
  x1: number
  y1: number
  x2: number
  y2: number
  open: boolean
}

type Occluder = WallOccluder | DoorOccluder

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

type AnalysisResult = {
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

const canvas = document.querySelector<HTMLCanvasElement>('#boardCanvas')
const fileInput = document.querySelector<HTMLInputElement>('#fileInput')
const columnsInput = document.querySelector<HTMLInputElement>('#columnsInput')
const gridInput = document.querySelector<HTMLInputElement>('#gridInput')
const radiusInput = document.querySelector<HTMLInputElement>('#radiusInput')
const analyzeButton = document.querySelector<HTMLButtonElement>('#analyzeButton')
const resetFogButton = document.querySelector<HTMLButtonElement>('#resetFogButton')
const exportButton = document.querySelector<HTMLButtonElement>('#exportButton')
const runtimeStatus = document.querySelector<HTMLElement>('#runtimeStatus')
const tileList = document.querySelector<HTMLElement>('#tileList')
const boardStat = document.querySelector<HTMLElement>('#boardStat')
const occluderStat = document.querySelector<HTMLElement>('#occluderStat')
const doorStat = document.querySelector<HTMLElement>('#doorStat')
const gpuStat = document.querySelector<HTMLElement>('#gpuStat')
const exportOutput = document.querySelector<HTMLTextAreaElement>('#exportOutput')
const toolButtons = document.querySelectorAll<HTMLButtonElement>('.tool-button')

if (
  !canvas ||
  !fileInput ||
  !columnsInput ||
  !gridInput ||
  !radiusInput ||
  !analyzeButton ||
  !resetFogButton ||
  !exportButton ||
  !runtimeStatus ||
  !tileList ||
  !boardStat ||
  !occluderStat ||
  !doorStat ||
  !gpuStat ||
  !exportOutput
) {
  throw new Error('Line of Sight UI failed to mount.')
}

const ctx = canvas.getContext('2d')
if (!ctx) throw new Error('Canvas 2D is required.')

let tool: Tool = 'viewer'
let tiles: Tile[] = []
let placements: Placement[] = []
let occluders: Occluder[] = []
let doorStates: Record<string, {open: boolean}> = {}
let viewer: Point = {x: 250, y: 250}
let boardWidth = 1000
let boardHeight = 1000
let dragStart: Point | null = null
let previewPoint: Point | null = null
let isMovingViewer = false

const exploredCanvas = document.createElement('canvas')
const exploredCtx = exploredCanvas.getContext('2d')
if (!exploredCtx) throw new Error('Offscreen canvas is required.')

const gridScale = (): number => Math.max(10, Number(gridInput.value) || 50)
const sightRadius = (): number => Math.max(50, Number(radiusInput.value) || 700)
const columns = (): number => Math.max(1, Number(columnsInput.value) || 1)

const nextId = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`

const setStatus = (message: string): void => {
  runtimeStatus.textContent = message
}

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

const arrangeTiles = (): void => {
  if (tiles.length === 0) {
    placements = []
    boardWidth = 1000
    boardHeight = 1000
    resizeBoard()
    render()
    return
  }

  const colCount = columns()
  const cellWidth = Math.max(...tiles.map((tile) => tile.width))
  const cellHeight = Math.max(...tiles.map((tile) => tile.height))
  placements = tiles.map((tile, index) => ({
    tile,
    x: (index % colCount) * cellWidth,
    y: Math.floor(index / colCount) * cellHeight
  }))
  boardWidth = colCount * cellWidth
  boardHeight = Math.ceil(tiles.length / colCount) * cellHeight
  viewer = {
    x: Math.min(viewer.x, boardWidth),
    y: Math.min(viewer.y, boardHeight)
  }
  resizeBoard()
  renderTileList()
  render()
}

const resizeBoard = (): void => {
  canvas.width = boardWidth
  canvas.height = boardHeight
  exploredCanvas.width = boardWidth
  exploredCanvas.height = boardHeight
  exploredCtx.clearRect(0, 0, boardWidth, boardHeight)
}

const renderTileList = (): void => {
  tileList.replaceChildren(
    ...tiles.map((tile) => {
      const item = document.createElement('div')
      item.className = 'tile-item'
      const img = document.createElement('img')
      img.src = tile.url
      img.alt = ''
      const label = document.createElement('span')
      label.textContent = `${tile.name} (${tile.width}x${tile.height})`
      item.append(img, label)
      return item
    })
  )
}

const analyzeTiles = async (): Promise<void> => {
  if (placements.length === 0) {
    setStatus('Select one or more map images first.')
    return
  }

  setStatus('Analyzing wall candidates...')
  const manual = occluders.filter((occluder) => occluder.id.startsWith('manual-'))
  const generated: Occluder[] = []
  const scratch = document.createElement('canvas')
  const scratchCtx = scratch.getContext('2d', {willReadFrequently: true})
  if (!scratchCtx) throw new Error('Canvas image analysis is unavailable.')

  for (const placement of placements) {
    scratch.width = placement.tile.width
    scratch.height = placement.tile.height
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height)
    scratchCtx.drawImage(placement.tile.image, 0, 0)
    const imageData = scratchCtx.getImageData(0, 0, scratch.width, scratch.height)
    const result = analyze_image_rgba(
      scratch.width,
      scratch.height,
      new Uint8Array(imageData.data.buffer),
      gridScale()
    ) as AnalysisResult

    for (const occluder of result.occluders) {
      generated.push(transformOccluder(occluder, placement))
    }
  }

  occluders = [...generated, ...manual]
  doorStates = Object.fromEntries(
    Object.entries(doorStates).filter(([doorId]) =>
      occluders.some((occluder) => occluder.type === 'door' && occluder.id === doorId)
    )
  )
  markExplored()
  setStatus(`Analyzed ${placements.length} tile(s); review the overlay before export.`)
  render()
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
  visibility_polygon(
    viewer.x,
    viewer.y,
    boardWidth,
    boardHeight,
    sightRadius(),
    occluders,
    doorStates
  ) as Point[]

const markExplored = (): void => {
  const polygon = getVisiblePolygon()
  exploredCtx.save()
  exploredCtx.fillStyle = '#fff'
  drawPolygonPath(exploredCtx, polygon)
  exploredCtx.fill()
  exploredCtx.restore()
}

const render = (): void => {
  ctx.clearRect(0, 0, boardWidth, boardHeight)
  ctx.fillStyle = '#151719'
  ctx.fillRect(0, 0, boardWidth, boardHeight)

  for (const placement of placements) {
    ctx.drawImage(placement.tile.image, placement.x, placement.y)
  }

  drawGrid()
  drawFog()
  drawOccluders()
  drawPreview()
  drawViewer()
  renderStats()
}

const drawGrid = (): void => {
  const scale = gridScale()
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
  ctx.lineWidth = 1
  for (let x = 0; x <= boardWidth; x += scale) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, boardHeight)
    ctx.stroke()
  }
  for (let y = 0; y <= boardHeight; y += scale) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(boardWidth, y)
    ctx.stroke()
  }
  ctx.restore()
}

const drawFog = (): void => {
  const polygon = getVisiblePolygon()
  ctx.save()
  ctx.fillStyle = 'rgba(7, 11, 16, 0.82)'
  ctx.fillRect(0, 0, boardWidth, boardHeight)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.globalAlpha = 0.55
  ctx.drawImage(exploredCanvas, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = '#fff'
  drawPolygonPath(ctx, polygon)
  ctx.fill()
  ctx.restore()
}

const drawOccluders = (): void => {
  ctx.save()
  ctx.lineCap = 'round'
  for (const occluder of occluders) {
    const isDoor = occluder.type === 'door'
    const open = isDoor ? (doorStates[occluder.id]?.open ?? occluder.open) : false
    ctx.strokeStyle = isDoor
      ? open
        ? '#24a148'
        : '#f97316'
      : '#d72638'
    ctx.lineWidth = isDoor ? 7 : 4
    ctx.setLineDash(isDoor && open ? [12, 10] : [])
    ctx.beginPath()
    ctx.moveTo(occluder.x1, occluder.y1)
    ctx.lineTo(occluder.x2, occluder.y2)
    ctx.stroke()
  }
  ctx.restore()
}

const drawPreview = (): void => {
  if (!dragStart || !previewPoint || (tool !== 'wall' && tool !== 'door')) return
  ctx.save()
  ctx.strokeStyle = tool === 'door' ? '#f97316' : '#d72638'
  ctx.lineWidth = tool === 'door' ? 7 : 4
  ctx.setLineDash([8, 8])
  ctx.beginPath()
  ctx.moveTo(dragStart.x, dragStart.y)
  ctx.lineTo(previewPoint.x, previewPoint.y)
  ctx.stroke()
  ctx.restore()
}

const drawViewer = (): void => {
  ctx.save()
  ctx.fillStyle = '#2f80ed'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(viewer.x, viewer.y, 13, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(47, 128, 237, 0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(viewer.x, viewer.y, sightRadius(), 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

const renderStats = (): void => {
  boardStat.textContent = `${Math.round(boardWidth)} x ${Math.round(boardHeight)}`
  occluderStat.textContent = String(occluders.length)
  doorStat.textContent = String(occluders.filter((occluder) => occluder.type === 'door').length)
}

const positionFromEvent = (event: PointerEvent): Point => {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * boardWidth,
    y: ((event.clientY - rect.top) / rect.height) * boardHeight
  }
}

const snapPoint = (point: Point, event: PointerEvent): Point => {
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

const nearestOccluder = (point: Point, filter?: (occluder: Occluder) => boolean): Occluder | null => {
  let nearest: Occluder | null = null
  let nearestDistance = 14
  for (const occluder of occluders) {
    if (filter && !filter(occluder)) continue
    const distance = distanceToSegment(point, occluder)
    if (distance < nearestDistance) {
      nearest = occluder
      nearestDistance = distance
    }
  }
  return nearest
}

const handlePointerDown = (event: PointerEvent): void => {
  const point = snapPoint(positionFromEvent(event), event)
  if (tool === 'viewer') {
    const door = nearestOccluder(point, (occluder) => occluder.type === 'door')
    if (door && door.type === 'door') {
      const open = !(doorStates[door.id]?.open ?? door.open)
      doorStates[door.id] = {open}
      markExplored()
      render()
      return
    }
    viewer = point
    isMovingViewer = true
    canvas.setPointerCapture(event.pointerId)
    markExplored()
    render()
    return
  }

  if (tool === 'erase') {
    const target = nearestOccluder(point)
    if (target) {
      occluders = occluders.filter((occluder) => occluder.id !== target.id)
      delete doorStates[target.id]
      markExplored()
      render()
    }
    return
  }

  dragStart = point
  previewPoint = point
  canvas.setPointerCapture(event.pointerId)
  render()
}

const handlePointerMove = (event: PointerEvent): void => {
  const point = snapPoint(positionFromEvent(event), event)
  if (isMovingViewer) {
    viewer = point
    markExplored()
    render()
    return
  }

  if (!dragStart) return
  previewPoint = point
  render()
}

const handlePointerUp = (event: PointerEvent): void => {
  const point = snapPoint(positionFromEvent(event), event)
  if (isMovingViewer) {
    isMovingViewer = false
    canvas.releasePointerCapture(event.pointerId)
    return
  }

  if (!dragStart || (tool !== 'wall' && tool !== 'door')) return

  const length = Math.hypot(point.x - dragStart.x, point.y - dragStart.y)
  if (length > 6) {
    const id = nextId(tool === 'door' ? 'manual-door' : 'manual-wall')
    if (tool === 'door') {
      occluders.push({
        type: 'door',
        id,
        x1: dragStart.x,
        y1: dragStart.y,
        x2: point.x,
        y2: point.y,
        open: false
      })
      doorStates[id] = {open: false}
    } else {
      occluders.push({
        type: 'wall',
        id,
        x1: dragStart.x,
        y1: dragStart.y,
        x2: point.x,
        y2: point.y
      })
    }
  }

  dragStart = null
  previewPoint = null
  canvas.releasePointerCapture(event.pointerId)
  markExplored()
  render()
}

const exportSidecar = async (): Promise<void> => {
  const sidecar = {
    assetRef: 'composed-board',
    width: boardWidth,
    height: boardHeight,
    gridScale: gridScale(),
    occluders: occluders.map((occluder) =>
      occluder.type === 'door'
        ? {
            ...occluder,
            open: doorStates[occluder.id]?.open ?? occluder.open
          }
        : occluder
    )
  }
  const json = `${JSON.stringify(sidecar, null, 2)}\n`
  exportOutput.value = json
  try {
    await navigator.clipboard.writeText(json)
    setStatus('Exported sidecar JSON and copied it to the clipboard.')
  } catch {
    setStatus('Exported sidecar JSON.')
  }
}

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files ?? []).filter((file) =>
    file.type.startsWith('image/')
  )
  if (files.length === 0) return

  setStatus(`Loading ${files.length} image(s)...`)
  for (const tile of tiles) URL.revokeObjectURL(tile.url)
  tiles = await Promise.all(files.map(loadImage))
  occluders = []
  doorStates = {}
  arrangeTiles()
  markExplored()
  setStatus(`Loaded ${tiles.length} image(s). Run analysis, then review walls and doors.`)
})

columnsInput.addEventListener('change', arrangeTiles)
gridInput.addEventListener('change', () => {
  markExplored()
  render()
})
radiusInput.addEventListener('change', () => {
  markExplored()
  render()
})
analyzeButton.addEventListener('click', () => void analyzeTiles())
resetFogButton.addEventListener('click', () => {
  exploredCtx.clearRect(0, 0, boardWidth, boardHeight)
  markExplored()
  render()
})
exportButton.addEventListener('click', () => void exportSidecar())
canvas.addEventListener('pointerdown', handlePointerDown)
canvas.addEventListener('pointermove', handlePointerMove)
canvas.addEventListener('pointerup', handlePointerUp)
canvas.addEventListener('pointercancel', () => {
  dragStart = null
  previewPoint = null
  isMovingViewer = false
  render()
})

for (const button of toolButtons) {
  button.addEventListener('click', () => {
    tool = button.dataset.tool as Tool
    for (const other of toolButtons) other.classList.toggle('active', other === button)
  })
}

await initWasm()
gpuStat.textContent = await detectWebGpu()
setStatus('Ready. Select local map images to start.')
markExplored()
render()
