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

type Tool = 'viewer' | 'wall' | 'door' | 'erase' | 'token'

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

type EditHandle = 'start' | 'end' | 'body'

type EditDrag = {
  id: string
  handle: EditHandle
  pointerStart: Point
  original: Occluder
}

type CounterKind =
  | 'amphibian'
  | 'engineer'
  | 'insectoid'
  | 'marine'
  | 'medic'
  | 'officer'
  | 'psion'
  | 'reptilian'
  | 'scout'
  | 'security'
  | 'scientist'
  | 'trader'

type CounterDefinition = {
  kind: CounterKind
  name: string
  portrait: string
}

type CounterGroupId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'

type Token = Point & {
  id: string
  kind: CounterKind
  group: CounterGroupId
  member: number
  label: string
}

type TokenDrag = {
  id: string
  pointerStart: Point
  original: Token
}

type EditorSnapshot = {
  occluders: Occluder[]
  doorStates: Record<string, {open: boolean}>
  tokens: Token[]
  selectedOccluderId: string | null
  selectedTokenId: string | null
  povTokenId: string | null
}

const tool = signal<Tool>('viewer')
const tiles = signal<Tile[]>([])
const placements = signal<Placement[]>([])
const occluders = signal<Occluder[]>([])
const doorStates = signal<Record<string, {open: boolean}>>({})
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
const editDrag = signal<EditDrag | null>(null)
const selectedOccluderId = signal<string | null>(null)
const hoveredOccluderId = signal<string | null>(null)
const tokens = signal<Token[]>([])
const activeCounterKind = signal<CounterKind>('officer')
const activeCounterGroup = signal<CounterGroupId>('A')
const tokenDrag = signal<TokenDrag | null>(null)
const selectedTokenId = signal<string | null>(null)
const hoveredTokenId = signal<string | null>(null)
const povTokenId = signal<string | null>(null)
const undoStack = signal<EditorSnapshot[]>([])
const redoStack = signal<EditorSnapshot[]>([])
const dropDepth = signal(0)
const renderTick = signal(0)

let canvas: HTMLCanvasElement
let boardViewport: HTMLDivElement
let ctx: CanvasRenderingContext2D

const minZoom = 0.35
const maxZoom = 4
const doorCarveTolerance = 8
const minCarvedWallLength = 8
const historyLimit = 60
const counterDefinitions: CounterDefinition[] = [
  {kind: 'officer', name: 'Officer', portrait: '/token-portraits/officer.webp'},
  {kind: 'marine', name: 'Marine', portrait: '/token-portraits/marine.webp'},
  {kind: 'scout', name: 'Scout', portrait: '/token-portraits/scout.webp'},
  {kind: 'engineer', name: 'Engineer', portrait: '/token-portraits/engineer.webp'},
  {kind: 'medic', name: 'Medic', portrait: '/token-portraits/medic.webp'},
  {kind: 'scientist', name: 'Scientist', portrait: '/token-portraits/scientist.webp'},
  {kind: 'trader', name: 'Trader', portrait: '/token-portraits/trader.webp'},
  {kind: 'security', name: 'Security', portrait: '/token-portraits/security.webp'},
  {kind: 'reptilian', name: 'Reptilian', portrait: '/token-portraits/reptilian.webp'},
  {kind: 'amphibian', name: 'Amphibian', portrait: '/token-portraits/amphibian.webp'},
  {kind: 'insectoid', name: 'Insectoid', portrait: '/token-portraits/insectoid.webp'},
  {kind: 'psion', name: 'Psion', portrait: '/token-portraits/psion.webp'}
]
const counterGroupLetters: CounterGroupId[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const counterPortraits = new Map<CounterKind, HTMLImageElement>()

const exploredCanvas = document.createElement('canvas')
const exploredCtx = exploredCanvas.getContext('2d')
if (!exploredCtx) throw new Error('Offscreen canvas is required.')

const fogCanvas = document.createElement('canvas')
const fogCtx = fogCanvas.getContext('2d')
if (!fogCtx) throw new Error('Offscreen fog canvas is required.')

const gridScale = (): number => Math.max(10, gridValue.value || 50)
const sightRadius = (): number => Math.max(50, sightValue.value || 700)
const columns = (): number => Math.max(1, columnsValue.value || 1)
const hasMap = (): boolean => placements.value.length > 0
const screenPixels = (pixels: number): number => Math.max(0.5, pixels / zoom.value)

const nextId = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().slice(0, 8)}`

const setStatus = (message: string): void => {
  runtimeStatus.value = message
}

const requestCanvasRender = (): void => {
  renderTick.value += 1
}

const preloadCounterPortraits = (): void => {
  if (counterPortraits.size > 0) return
  for (const definition of counterDefinitions) {
    const image = new Image()
    image.decoding = 'async'
    image.onload = requestCanvasRender
    image.src = definition.portrait
    counterPortraits.set(definition.kind, image)
  }
}

preloadCounterPortraits()

const cloneOccluders = (items: Occluder[]): Occluder[] =>
  items.map((occluder) => ({...occluder}))

const cloneTokens = (items: Token[]): Token[] =>
  items.map((token) => ({...token}))

const cloneDoorStates = (
  states: Record<string, {open: boolean}>
): Record<string, {open: boolean}> =>
  Object.fromEntries(Object.entries(states).map(([id, state]) => [id, {...state}]))

const editorSnapshot = (): EditorSnapshot => ({
  occluders: cloneOccluders(occluders.value),
  doorStates: cloneDoorStates(doorStates.value),
  tokens: cloneTokens(tokens.value),
  selectedOccluderId: selectedOccluderId.value,
  selectedTokenId: selectedTokenId.value,
  povTokenId: povTokenId.value
})

const pushUndoHistory = (): void => {
  undoStack.value = [...undoStack.value.slice(1 - historyLimit), editorSnapshot()]
  redoStack.value = []
}

const resetHistory = (): void => {
  undoStack.value = []
  redoStack.value = []
}

const restoreEditorSnapshot = (snapshot: EditorSnapshot): void => {
  occluders.value = cloneOccluders(snapshot.occluders)
  doorStates.value = cloneDoorStates(snapshot.doorStates)
  tokens.value = cloneTokens(snapshot.tokens)
  selectedOccluderId.value = occluders.value.some(
    (occluder) => occluder.id === snapshot.selectedOccluderId
  )
    ? snapshot.selectedOccluderId
    : null
  selectedTokenId.value = tokens.value.some((token) => token.id === snapshot.selectedTokenId)
    ? snapshot.selectedTokenId
    : null
  povTokenId.value = tokens.value.some((token) => token.id === snapshot.povTokenId)
    ? snapshot.povTokenId
    : (tokens.value[0]?.id ?? null)
  hoveredOccluderId.value = null
  hoveredTokenId.value = null
  editDrag.value = null
  tokenDrag.value = null
  dragStart.value = null
  previewPoint.value = null
  exploredCtx.clearRect(0, 0, boardSize.value.width, boardSize.value.height)
  markExplored()
  requestCanvasRender()
}

const undoEditorChange = (): void => {
  const previous = undoStack.value.at(-1)
  if (!previous) return
  undoStack.value = undoStack.value.slice(0, -1)
  redoStack.value = [...redoStack.value.slice(1 - historyLimit), editorSnapshot()]
  restoreEditorSnapshot(previous)
  setStatus('Undid map correction.')
}

const redoEditorChange = (): void => {
  const next = redoStack.value.at(-1)
  if (!next) return
  redoStack.value = redoStack.value.slice(0, -1)
  undoStack.value = [...undoStack.value.slice(1 - historyLimit), editorSnapshot()]
  restoreEditorSnapshot(next)
  setStatus('Redid map correction.')
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
  tokens.value = []
  selectedOccluderId.value = null
  hoveredOccluderId.value = null
  selectedTokenId.value = null
  hoveredTokenId.value = null
  povTokenId.value = null
  resetHistory()
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
  if (fogCanvas.width !== width) fogCanvas.width = width
  if (fogCanvas.height !== height) fogCanvas.height = height
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
  if (isDoorOpen(door) === open) return
  pushUndoHistory()
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

  pushUndoHistory()
  occluders.value = carveDoorGaps([...generated, ...manual])
  doorStates.value = Object.fromEntries(
    Object.entries(doorStates.value).filter(([doorId]) =>
      occluders.value.some((occluder) => occluder.type === 'door' && occluder.id === doorId)
    )
  )
  selectedOccluderId.value = null
  hoveredOccluderId.value = null
  exploredCtx.clearRect(0, 0, boardSize.value.width, boardSize.value.height)
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

const getPovToken = (): Token | null => {
  const explicit = povTokenId.value
    ? (tokens.value.find((token) => token.id === povTokenId.value) ?? null)
    : null
  return explicit ?? tokens.value[0] ?? null
}

const isPovToken = (id: string): boolean => getPovToken()?.id === id

const setPovToken = (id: string): void => {
  const token = tokens.value.find((item) => item.id === id)
  if (!token) return
  povTokenId.value = token.id
  selectedTokenId.value = token.id
  selectedOccluderId.value = null
  markExplored()
  setStatus(`Line of sight now follows ${token.label}.`)
  requestCanvasRender()
}

const getVisiblePolygon = (): Point[] => {
  const pov = getPovToken()
  if (!pov) return []
  return visibilityPolygon(
    pov.x,
    pov.y,
    boardSize.value.width,
    boardSize.value.height,
    sightRadius(),
    occluders.value,
    doorStates.value
  )
}

const markExplored = (): void => {
  if (!hasMap()) return

  const polygon = getVisiblePolygon()
  if (polygon.length < 3) return
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
  syncCanvasCursor()

  const {width, height} = boardSize.value
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = hasMap() ? '#151719' : '#050505'
  ctx.fillRect(0, 0, width, height)

  if (!hasMap()) {
    return
  }

  drawMapTiles()
  drawGrid()
  drawDoorMarkers()
  drawFog()
  drawPovRange()
  drawTokens()
  drawDebugWalls()
  drawEditOverlay()
  drawPreview()
}

const syncCanvasCursor = (): void => {
  if (!canvas) return
  if (!hasMap()) {
    canvas.style.cursor = 'default'
  } else if (editDrag.value) {
    canvas.style.cursor = 'grabbing'
  } else if (tokenDrag.value) {
    canvas.style.cursor = 'grabbing'
  } else if (hoveredTokenId.value && (tool.value === 'token' || tool.value === 'viewer')) {
    canvas.style.cursor = tool.value === 'viewer' ? 'pointer' : 'grab'
  } else if (hoveredOccluderId.value) {
    canvas.style.cursor = tool.value === 'erase' ? 'not-allowed' : 'grab'
  } else {
    canvas.style.cursor = tool.value === 'viewer' ? 'pointer' : 'cell'
  }
}

const drawMapTiles = (): void => {
  ctx.save()
  ctx.filter = 'contrast(1.08) brightness(1.025)'
  for (const placement of placements.value) {
    ctx.drawImage(placement.tile.image, placement.x, placement.y)
  }
  ctx.restore()
}

const drawGrid = (): void => {
  const scale = gridScale()
  ctx.save()
  ctx.strokeStyle =
    placements.value.length === 0 ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.055)'
  ctx.lineWidth = screenPixels(1)
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
  if (!getPovToken()) return
  const polygon = getVisiblePolygon()
  if (hideUnseen.value) {
    drawNeverExploredFog()
    drawOutsideVisibleFog(polygon, 'rgba(218, 221, 219, 0.52)')
  } else {
    drawOutsideVisibleFog(polygon, 'rgba(226, 229, 226, 0.58)')
  }
}

const drawOutsideVisibleFog = (polygon: Point[], fillStyle: string): void => {
  ctx.save()
  ctx.fillStyle = fillStyle
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

const drawNeverExploredFog = (): void => {
  fogCtx.clearRect(0, 0, boardSize.value.width, boardSize.value.height)
  fogCtx.save()
  fogCtx.fillStyle = '#e7e9e6'
  fogCtx.fillRect(0, 0, boardSize.value.width, boardSize.value.height)
  fogCtx.globalCompositeOperation = 'destination-out'
  fogCtx.drawImage(exploredCanvas, 0, 0)
  fogCtx.restore()
  ctx.drawImage(fogCanvas, 0, 0)
}

const drawTokens = (): void => {
  const polygon = getVisiblePolygon()
  const pov = getPovToken()
  for (const token of tokens.value) {
    const isPov = pov?.id === token.id
    const visible = isPov || (polygon.length > 2 && pointInPolygon(token, polygon))
    if (!visible && !showWalls.value) continue
    drawCounterToken(token, visible, isPov)
  }
}

const pointInPolygon = (point: Point, polygon: Point[]): boolean => {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]
    const previousPoint = polygon[previous]
    const crosses =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y) +
          currentPoint.x
    if (crosses) inside = !inside
  }
  return inside
}

const tokenSize = (): number => Math.min(64, Math.max(38, gridScale() * 0.84))

const counterDefinitionFor = (kind: CounterKind): CounterDefinition =>
  counterDefinitions.find((definition) => definition.kind === kind) ?? counterDefinitions[0]

const drawCounterToken = (token: Token, visible: boolean, isPov: boolean): void => {
  const size = tokenSize()
  const half = size / 2
  const selected = selectedTokenId.value === token.id
  const hovered = hoveredTokenId.value === token.id
  const inset = Math.max(2, size * 0.045)

  ctx.save()
  ctx.globalAlpha = visible ? 1 : 0.28
  ctx.translate(token.x, token.y)

  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = screenPixels(7)
  ctx.shadowOffsetY = screenPixels(2)
  roundedRect(-half, -half, size, size, size * 0.055)
  ctx.fillStyle = '#050505'
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.save()
  roundedRect(
    -half + inset,
    -half + inset,
    size - inset * 2,
    size - inset * 2,
    size * 0.035
  )
  ctx.clip()
  drawCounterPortrait(
    token.kind,
    -half + inset,
    -half + inset,
    size - inset * 2,
    size - inset * 2
  )
  ctx.restore()

  const highlight = ctx.createLinearGradient(0, -half + inset, 0, half - inset)
  highlight.addColorStop(0, 'rgba(255, 255, 255, 0.18)')
  highlight.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)')
  highlight.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
  roundedRect(
    -half + inset,
    -half + inset,
    size - inset * 2,
    size - inset * 2,
    size * 0.035
  )
  ctx.fillStyle = highlight
  ctx.fill()

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
  ctx.lineWidth = screenPixels(1)
  ctx.stroke()

  ctx.font = `900 ${Math.max(11, size * 0.24)}px "JetBrains Mono", monospace`
  const labelMetrics = ctx.measureText(token.label)
  const labelWidth = Math.max(size * 0.36, labelMetrics.width + size * 0.16)
  const labelHeight = Math.max(14, size * 0.3)
  const labelX = -half + inset
  const labelY = half - inset - labelHeight
  roundedRect(labelX, labelY, labelWidth, labelHeight, size * 0.045)
  ctx.fillStyle = '#050505'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.lineWidth = screenPixels(1)
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(token.label, labelX + labelWidth / 2, labelY + labelHeight / 2 + screenPixels(0.4))

  if (selected || hovered) {
    ctx.strokeStyle = selected ? '#39ff14' : 'rgba(57, 255, 20, 0.55)'
    ctx.lineWidth = selected ? screenPixels(2.25) : screenPixels(1.5)
    const outlineInset = screenPixels(2.5)
    roundedRect(
      -half - outlineInset,
      -half - outlineInset,
      size + outlineInset * 2,
      size + outlineInset * 2,
      size * 0.13
    )
    ctx.stroke()
  }

  if (isPov) {
    ctx.strokeStyle = 'rgba(74, 163, 255, 0.96)'
    ctx.lineWidth = screenPixels(2.25)
    const povInset = screenPixels(5)
    roundedRect(
      -half - povInset,
      -half - povInset,
      size + povInset * 2,
      size + povInset * 2,
      size * 0.16
    )
    ctx.stroke()
  }

  ctx.restore()
}

const drawCounterPortrait = (
  kind: CounterKind,
  x: number,
  y: number,
  width: number,
  height: number
): void => {
  const image = counterPortraits.get(kind)
  if (image?.complete && image.naturalWidth > 0) {
    drawImageCover(image, x, y, width, height)
    return
  }

  const fallback = ctx.createLinearGradient(x, y, x + width, y + height)
  fallback.addColorStop(0, '#1f2937')
  fallback.addColorStop(1, '#050505')
  ctx.fillStyle = fallback
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)'
  ctx.font = `900 ${Math.max(16, width * 0.38)}px "JetBrains Mono", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(counterDefinitionFor(kind).name[0] ?? '?', x + width / 2, y + height / 2)
}

const drawImageCover = (
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
): void => {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  )
}

const roundedRect = (
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void => {
  const limitedRadius = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + limitedRadius, y)
  ctx.lineTo(x + width - limitedRadius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + limitedRadius)
  ctx.lineTo(x + width, y + height - limitedRadius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - limitedRadius, y + height)
  ctx.lineTo(x + limitedRadius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - limitedRadius)
  ctx.lineTo(x, y + limitedRadius)
  ctx.quadraticCurveTo(x, y, x + limitedRadius, y)
  ctx.closePath()
}

const drawDoorMarkers = (): void => {
  ctx.save()
  ctx.lineCap = 'round'
  for (const occluder of occluders.value) {
    if (occluder.type === 'door') {
      drawDoorStateMarker(occluder, isDoorOpen(occluder))
    }
  }
  ctx.restore()
}

const drawDebugWalls = (): void => {
  if (!showWalls.value) return

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const occluder of occluders.value) {
    if (occluder.type !== 'wall') continue
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.lineWidth = screenPixels(5)
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(occluder.x1, occluder.y1)
    ctx.lineTo(occluder.x2, occluder.y2)
    ctx.stroke()
    ctx.strokeStyle = '#d72638'
    ctx.lineWidth = screenPixels(2.5)
    ctx.beginPath()
    ctx.moveTo(occluder.x1, occluder.y1)
    ctx.lineTo(occluder.x2, occluder.y2)
    ctx.stroke()
  }
  ctx.restore()
}

const drawEditOverlay = (): void => {
  const ids = new Set([hoveredOccluderId.value, selectedOccluderId.value].filter(Boolean))
  if (ids.size === 0) return

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const occluder of occluders.value) {
    if (!ids.has(occluder.id)) continue
    const selected = selectedOccluderId.value === occluder.id
    const color = occluder.type === 'door' ? 'rgba(249, 115, 22, 0.98)' : 'rgba(215, 38, 56, 0.98)'
    const handleRadius = selected ? screenPixels(5.5) : screenPixels(4)

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)'
    ctx.lineWidth = selected ? screenPixels(7) : screenPixels(5)
    ctx.beginPath()
    ctx.moveTo(occluder.x1, occluder.y1)
    ctx.lineTo(occluder.x2, occluder.y2)
    ctx.stroke()

    ctx.strokeStyle = color
    ctx.lineWidth = selected ? screenPixels(3) : screenPixels(2)
    ctx.beginPath()
    ctx.moveTo(occluder.x1, occluder.y1)
    ctx.lineTo(occluder.x2, occluder.y2)
    ctx.stroke()

    for (const point of [
      {x: occluder.x1, y: occluder.y1},
      {x: occluder.x2, y: occluder.y2}
    ]) {
      ctx.fillStyle = '#050505'
      ctx.strokeStyle = color
      ctx.lineWidth = screenPixels(2)
      ctx.beginPath()
      ctx.arc(point.x, point.y, handleRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
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
  const cap = Math.min(screenPixels(7), Math.max(screenPixels(4), length * 0.18))

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
    strokeSegment(door.x1, door.y1, door.x2, door.y2, screenPixels(6), 'rgba(0, 0, 0, 0.38)')
    strokeSegment(door.x1, door.y1, door.x2, door.y2, screenPixels(3.2), 'rgba(249, 115, 22, 0.92)')
    strokeSegment(
      door.x1 - px * cap,
      door.y1 - py * cap,
      door.x1 + px * cap,
      door.y1 + py * cap,
      screenPixels(2.6),
      'rgba(249, 115, 22, 0.92)'
    )
    strokeSegment(
      door.x2 - px * cap,
      door.y2 - py * cap,
      door.x2 + px * cap,
      door.y2 + py * cap,
      screenPixels(2.6),
      'rgba(249, 115, 22, 0.92)'
    )
    ctx.restore()
    return
  }

  ctx.setLineDash([screenPixels(3), screenPixels(7)])
  strokeSegment(door.x1, door.y1, door.x2, door.y2, screenPixels(5), 'rgba(0, 0, 0, 0.32)')
  strokeSegment(door.x1, door.y1, door.x2, door.y2, screenPixels(2.2), 'rgba(22, 163, 74, 0.88)')
  ctx.setLineDash([])

  const swingRadius = Math.min(screenPixels(26), Math.max(screenPixels(12), length * 0.68))
  const closedAngle = Math.atan2(uy, ux)
  const openAngle = closedAngle + Math.PI / 2
  const leafX = door.x1 + Math.cos(openAngle) * swingRadius
  const leafY = door.y1 + Math.sin(openAngle) * swingRadius

  strokeSegment(door.x1, door.y1, leafX, leafY, screenPixels(4.8), 'rgba(0, 0, 0, 0.32)')
  strokeSegment(door.x1, door.y1, leafX, leafY, screenPixels(2.2), 'rgba(22, 163, 74, 0.88)')
  ctx.strokeStyle = 'rgba(22, 163, 74, 0.58)'
  ctx.lineWidth = screenPixels(1.6)
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
  ctx.lineWidth = tool.value === 'door' ? screenPixels(5) : screenPixels(3)
  ctx.setLineDash([screenPixels(8), screenPixels(8)])
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  ctx.lineTo(point.x, point.y)
  ctx.stroke()
  ctx.restore()
}

const drawPovRange = (): void => {
  const pov = getPovToken()
  if (!pov) return
  ctx.save()
  ctx.strokeStyle = 'rgba(74, 163, 255, 0.42)'
  ctx.lineWidth = screenPixels(2)
  ctx.beginPath()
  ctx.arc(pov.x, pov.y, sightRadius(), 0, Math.PI * 2)
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

const nextTokenMember = (group: CounterGroupId): number => {
  const used = new Set(
    tokens.value.filter((token) => token.group === group).map((token) => token.member)
  )
  for (let member = 1; member <= 99; member += 1) {
    if (!used.has(member)) return member
  }
  return 1
}

const nextTokenLabel = (group: CounterGroupId): string => {
  return `${group}${nextTokenMember(group)}`
}

const makeToken = (point: Point): Token => {
  const group = activeCounterGroup.value
  const member = nextTokenMember(group)
  return {
    id: nextId('token'),
    kind: activeCounterKind.value,
    group,
    member,
    label: `${group}${member}`,
    x: point.x,
    y: point.y
  }
}

const nearestToken = (point: Point, screenRadius = 24): Token | null => {
  let nearest: Token | null = null
  let nearestDistance = screenRadius / zoom.value
  for (const token of tokens.value) {
    const distance = Math.hypot(point.x - token.x, point.y - token.y)
    if (distance < nearestDistance) {
      nearest = token
      nearestDistance = distance
    }
  }
  return nearest
}

const updateToken = (id: string, next: Token): void => {
  tokens.value = tokens.value.map((token) => (token.id === id ? next : token))
}

const removeToken = (id: string, recordHistory = true): void => {
  if (!tokens.value.some((token) => token.id === id)) return
  if (recordHistory) pushUndoHistory()
  const wasPov = isPovToken(id)
  const nextTokens = tokens.value.filter((token) => token.id !== id)
  tokens.value = nextTokens
  if (selectedTokenId.value === id) selectedTokenId.value = null
  if (hoveredTokenId.value === id) hoveredTokenId.value = null
  if (povTokenId.value === id) povTokenId.value = nextTokens[0]?.id ?? null
  if (wasPov) markExplored()
}

const editableFilterForTool = (): ((occluder: Occluder) => boolean) | null => {
  if (tool.value === 'wall') return (occluder) => occluder.type === 'wall'
  if (tool.value === 'door') return (occluder) => occluder.type === 'door'
  if (tool.value === 'erase') return () => true
  return null
}

const nearestEditTarget = (
  point: Point,
  filter: (occluder: Occluder) => boolean
): {occluder: Occluder; handle: EditHandle} | null => {
  const endpointRadius = screenPixels(13)
  const segmentRadius = screenPixels(9)
  let nearestEndpoint: {occluder: Occluder; handle: EditHandle; distance: number} | null = null
  let nearestBody: {occluder: Occluder; handle: EditHandle; distance: number} | null = null

  for (const occluder of occluders.value) {
    if (!filter(occluder)) continue

    const startDistance = Math.hypot(point.x - occluder.x1, point.y - occluder.y1)
    if (startDistance <= endpointRadius && (!nearestEndpoint || startDistance < nearestEndpoint.distance)) {
      nearestEndpoint = {occluder, handle: 'start', distance: startDistance}
    }

    const endDistance = Math.hypot(point.x - occluder.x2, point.y - occluder.y2)
    if (endDistance <= endpointRadius && (!nearestEndpoint || endDistance < nearestEndpoint.distance)) {
      nearestEndpoint = {occluder, handle: 'end', distance: endDistance}
    }

    const segmentDistance = distanceToSegment(point, occluder)
    if (segmentDistance <= segmentRadius && (!nearestBody || segmentDistance < nearestBody.distance)) {
      nearestBody = {occluder, handle: 'body', distance: segmentDistance}
    }
  }

  return nearestEndpoint ?? nearestBody
}

const updateOccluder = (id: string, next: Occluder): void => {
  occluders.value = occluders.value.map((occluder) => (occluder.id === id ? next : occluder))
}

const applyEditDrag = (drag: EditDrag, point: Point): void => {
  const dx = point.x - drag.pointerStart.x
  const dy = point.y - drag.pointerStart.y
  const original = drag.original
  const next =
    drag.handle === 'body'
      ? {
          ...original,
          x1: original.x1 + dx,
          y1: original.y1 + dy,
          x2: original.x2 + dx,
          y2: original.y2 + dy
        }
      : drag.handle === 'start'
        ? {...original, x1: point.x, y1: point.y}
        : {...original, x2: point.x, y2: point.y}

  updateOccluder(drag.id, next)
}

const removeOccluder = (id: string, recordHistory = true): void => {
  if (!occluders.value.some((occluder) => occluder.id === id)) return
  if (recordHistory) pushUndoHistory()
  occluders.value = occluders.value.filter((occluder) => occluder.id !== id)
  const nextDoorStates = {...doorStates.value}
  delete nextDoorStates[id]
  doorStates.value = nextDoorStates
  if (selectedOccluderId.value === id) selectedOccluderId.value = null
  if (hoveredOccluderId.value === id) hoveredOccluderId.value = null
}

const targetAcceptsMapShortcuts = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement

const handleMapKeyDown = (event: KeyboardEvent): void => {
  if (targetAcceptsMapShortcuts(event.target)) return

  const shortcutKey = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && shortcutKey === 'z') {
    event.preventDefault()
    if (event.shiftKey) {
      redoEditorChange()
    } else {
      undoEditorChange()
    }
    return
  }

  if ((event.metaKey || event.ctrlKey) && shortcutKey === 'y') {
    event.preventDefault()
    redoEditorChange()
    return
  }

  if (event.key === 'Escape') {
    selectedOccluderId.value = null
    selectedTokenId.value = null
    hoveredOccluderId.value = null
    hoveredTokenId.value = null
    editDrag.value = null
    tokenDrag.value = null
    dragStart.value = null
    previewPoint.value = null
    requestCanvasRender()
    return
  }

  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedTokenId.value) {
    event.preventDefault()
    removeToken(selectedTokenId.value)
    markExplored()
    requestCanvasRender()
    return
  }

  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedOccluderId.value) {
    event.preventDefault()
    removeOccluder(selectedOccluderId.value)
    markExplored()
    requestCanvasRender()
  }
}

const handlePointerDown = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
  if (!hasMap()) return

  const rawPoint = positionFromEvent(event)
  const point = snapPoint(rawPoint, event)

  if (tool.value === 'token') {
    const token = nearestToken(rawPoint)
    selectedOccluderId.value = null
    hoveredOccluderId.value = null
    if (token) {
      pushUndoHistory()
      selectedTokenId.value = token.id
      hoveredTokenId.value = token.id
      tokenDrag.value = {
        id: token.id,
        pointerStart: point,
        original: token
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      requestCanvasRender()
      return
    }

    pushUndoHistory()
    const shouldUseAsPov = !getPovToken()
    const nextToken = makeToken(point)
    tokens.value = [...tokens.value, nextToken]
    if (shouldUseAsPov) {
      povTokenId.value = nextToken.id
      setStatus(`Line of sight now follows ${nextToken.label}.`)
      markExplored()
    }
    selectedTokenId.value = nextToken.id
    hoveredTokenId.value = nextToken.id
    requestCanvasRender()
    return
  }

  if (tool.value === 'viewer') {
    const token = nearestToken(rawPoint)
    if (token) {
      setPovToken(token.id)
      return
    }

    const door = nearestOccluder(rawPoint, (occluder) => occluder.type === 'door', 18)
    if (door && door.type === 'door') {
      setDoorOpen(door.id, !isDoorOpen(door))
      return
    }
    selectedOccluderId.value = null
    selectedTokenId.value = null
    setStatus('Select a counter to use as the point of view.')
    requestCanvasRender()
    return
  }

  if (tool.value === 'erase') {
    const token = nearestToken(rawPoint)
    if (token) {
      removeToken(token.id)
      markExplored()
      requestCanvasRender()
      return
    }

    const target = nearestEditTarget(rawPoint, () => true)
    if (target) {
      removeOccluder(target.occluder.id)
      markExplored()
      requestCanvasRender()
    }
    return
  }

  const editableFilter = editableFilterForTool()
  if (editableFilter) {
    const editTarget = nearestEditTarget(rawPoint, editableFilter)
    if (editTarget) {
      pushUndoHistory()
      selectedOccluderId.value = editTarget.occluder.id
      selectedTokenId.value = null
      hoveredOccluderId.value = editTarget.occluder.id
      editDrag.value = {
        id: editTarget.occluder.id,
        handle: editTarget.handle,
        pointerStart: point,
        original: editTarget.occluder
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      requestCanvasRender()
      return
    }
  }

  selectedOccluderId.value = null
  selectedTokenId.value = null

  dragStart.value = point
  previewPoint.value = point
  event.currentTarget.setPointerCapture(event.pointerId)
  requestCanvasRender()
}

const handlePointerMove = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
  const rawPoint = positionFromEvent(event)
  const point = snapPoint(rawPoint, event)
  const tokenMove = tokenDrag.value
  if (tokenMove) {
    const dx = point.x - tokenMove.pointerStart.x
    const dy = point.y - tokenMove.pointerStart.y
    updateToken(tokenMove.id, {
      ...tokenMove.original,
      x: tokenMove.original.x + dx,
      y: tokenMove.original.y + dy
    })
    if (isPovToken(tokenMove.id)) markExplored()
    requestCanvasRender()
    return
  }

  const drag = editDrag.value
  if (drag) {
    applyEditDrag(drag, point)
    markExplored()
    requestCanvasRender()
    return
  }

  if (!dragStart.value) {
    if (tool.value === 'token' || tool.value === 'viewer') {
      hoveredTokenId.value = nearestToken(rawPoint)?.id ?? null
      hoveredOccluderId.value = null
      requestCanvasRender()
      return
    }

    const editableFilter = editableFilterForTool()
    hoveredTokenId.value = null
    hoveredOccluderId.value = editableFilter
      ? (nearestEditTarget(rawPoint, editableFilter)?.occluder.id ?? null)
      : null
    requestCanvasRender()
    return
  }
  previewPoint.value = point
  requestCanvasRender()
}

const handlePointerUp = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
  const point = snapPoint(positionFromEvent(event), event)
  if (tokenDrag.value) {
    const drag = tokenDrag.value
    const dx = point.x - drag.pointerStart.x
    const dy = point.y - drag.pointerStart.y
    updateToken(drag.id, {
      ...drag.original,
      x: drag.original.x + dx,
      y: drag.original.y + dy
    })
    if (isPovToken(drag.id)) markExplored()
    tokenDrag.value = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    requestCanvasRender()
    return
  }

  if (editDrag.value) {
    const drag = editDrag.value
    applyEditDrag(drag, point)
    editDrag.value = null
    occluders.value = carveDoorGaps(occluders.value)
    if (!occluders.value.some((occluder) => occluder.id === drag.id)) {
      selectedOccluderId.value = null
    }
    event.currentTarget.releasePointerCapture(event.pointerId)
    markExplored()
    requestCanvasRender()
    return
  }

  const start = dragStart.value
  if (!start || (tool.value !== 'wall' && tool.value !== 'door')) return

  const length = Math.hypot(point.x - start.x, point.y - start.y)
  if (length > 6) {
    pushUndoHistory()
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
    selectedOccluderId.value = id
    hoveredOccluderId.value = id
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
  editDrag.value = null
  tokenDrag.value = null
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
    ),
    tokens: tokens.value
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

const getPovStat = (): string => getPovToken()?.label ?? 'None'

const getSelectedOccluder = (): Occluder | null => {
  const id = selectedOccluderId.value
  return id ? (occluders.value.find((occluder) => occluder.id === id) ?? null) : null
}

const getSelectedToken = (): Token | null => {
  const id = selectedTokenId.value
  return id ? (tokens.value.find((token) => token.id === id) ?? null) : null
}

const convertSelectedOccluder = (targetType: 'wall' | 'door'): void => {
  const selected = getSelectedOccluder()
  if (!selected || selected.type === targetType) return

  pushUndoHistory()
  const converted: Occluder =
    targetType === 'door'
      ? {
          type: 'door',
          id: selected.id,
          x1: selected.x1,
          y1: selected.y1,
          x2: selected.x2,
          y2: selected.y2,
          open: false
        }
      : {
          type: 'wall',
          id: selected.id,
          x1: selected.x1,
          y1: selected.y1,
          x2: selected.x2,
          y2: selected.y2
        }

  occluders.value = carveDoorGaps(
    occluders.value.map((occluder) => (occluder.id === selected.id ? converted : occluder))
  )
  const nextDoorStates = {...doorStates.value}
  if (converted.type === 'door') {
    nextDoorStates[converted.id] = {open: false}
  } else {
    delete nextDoorStates[converted.id]
  }
  doorStates.value = nextDoorStates
  selectedOccluderId.value = converted.id
  markExplored()
  requestCanvasRender()
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
    window.addEventListener('keydown', handleMapKeyDown)
    void detectWebGpu().then((status) => {
      gpuStatus.value = status
    })
    setStatus('Ready. Select local map images to start.')

    return () => {
      dispose()
      window.removeEventListener('keydown', handleMapKeyDown)
      for (const tile of tiles.value) URL.revokeObjectURL(tile.url)
    }
  }, [])

  const activeTileCount = tiles.value.length
  const selectedOccluder = getSelectedOccluder()
  const selectedToken = getSelectedToken()
  const povToken = getPovToken()
  const nextCounterLabel = nextTokenLabel(activeCounterGroup.value)

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
          <button
            id="undoButton"
            type="button"
            disabled={undoStack.value.length === 0}
            title="Undo map correction"
            onClick={undoEditorChange}
          >
            <Icon>
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
            </Icon>
            <span>Undo</span>
          </button>
          <button
            id="redoButton"
            type="button"
            disabled={redoStack.value.length === 0}
            title="Redo map correction"
            onClick={redoEditorChange}
          >
            <Icon>
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H10a6 6 0 0 0 0 12h1" />
            </Icon>
            <span>Redo</span>
          </button>
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
            title="Toggle whether never-seen areas hide the map"
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
            <span>{hideUnseen.value ? 'Unknown hidden' : 'Known map'}</span>
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
                POV
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
                value="token"
                icon={
                  <>
                    <rect x="5" y="4" width="14" height="14" rx="2" />
                    <circle cx="12" cy="9" r="2" />
                    <path d="M9 16c.7-1.5 1.7-2.2 3-2.2s2.3.7 3 2.2" />
                    <path d="M16 20h3" />
                  </>
                }
              >
                Counter
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
            {selectedOccluder ? (
              <div className="selection-actions" aria-label="Selected map line actions">
                <span>{selectedOccluder.type === 'door' ? 'Door selected' : 'Wall selected'}</span>
                <div className="selection-action-row">
                  <button
                    type="button"
                    aria-pressed={selectedOccluder.type === 'wall'}
                    onClick={() => {
                      convertSelectedOccluder('wall')
                    }}
                  >
                    Wall
                  </button>
                  <button
                    type="button"
                    aria-pressed={selectedOccluder.type === 'door'}
                    onClick={() => {
                      convertSelectedOccluder('door')
                    }}
                  >
                    Door
                  </button>
                </div>
                <div className="selection-action-row">
                  {selectedOccluder.type === 'door' ? (
                    <button
                      type="button"
                      onClick={() => {
                        setDoorOpen(selectedOccluder.id, !isDoorOpen(selectedOccluder))
                      }}
                    >
                      {isDoorOpen(selectedOccluder) ? 'Close' : 'Open'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      removeOccluder(selectedOccluder.id)
                      markExplored()
                      requestCanvasRender()
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <h2>Counters</h2>
            <div className="counter-toolbar" aria-label="Counter identifier">
              <div className="counter-group-picker" role="group" aria-label="Counter letter group">
                {counterGroupLetters.map((group) => (
                  <button
                    className={`counter-letter-button${
                      activeCounterGroup.value === group ? ' active' : ''
                    }`}
                    key={group}
                    type="button"
                    aria-label={`Group ${group}`}
                    aria-pressed={activeCounterGroup.value === group}
                    onClick={() => {
                      activeCounterGroup.value = group
                      tool.value = 'token'
                    }}
                  >
                    {group}
                  </button>
                ))}
              </div>
              <span className="counter-next" aria-label={`Next counter ${nextCounterLabel}`}>
                {nextCounterLabel}
              </span>
            </div>
            <div className="counter-grid" role="group" aria-label="Counter types">
              {counterDefinitions.map((definition) => (
                <button
                  className={`counter-option${
                    activeCounterKind.value === definition.kind ? ' active' : ''
                  }`}
                  key={definition.kind}
                  type="button"
                  aria-pressed={activeCounterKind.value === definition.kind}
                  onClick={() => {
                    activeCounterKind.value = definition.kind
                    tool.value = 'token'
                  }}
                >
                  <span className="counter-swatch" aria-hidden="true">
                    <img
                      className="counter-portrait-thumb"
                      src={definition.portrait}
                      alt=""
                      loading="lazy"
                    />
                  </span>
                  <span>{definition.name}</span>
                </button>
              ))}
            </div>
            {selectedToken ? (
              <div className="selection-actions" aria-label="Selected counter actions">
                <span>
                  {`${counterDefinitionFor(selectedToken.kind).name} ${selectedToken.label}${
                    povToken?.id === selectedToken.id ? ' POV' : ''
                  }`}
                </span>
                <div className="selection-action-row">
                  <button
                    type="button"
                    aria-pressed={povToken?.id === selectedToken.id}
                    disabled={povToken?.id === selectedToken.id}
                    onClick={() => {
                      setPovToken(selectedToken.id)
                    }}
                  >
                    {povToken?.id === selectedToken.id ? 'Current POV' : 'Use as POV'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeToken(selectedToken.id)
                      requestCanvasRender()
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : null}
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
                <dt>POV</dt>
                <dd id="povStat">{getPovStat()}</dd>
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
