import {analyzeImageRgba, type DoorOccluder, type Occluder} from './los-core'
import type {Placement, Tile} from './types'
import {
  boardSize,
  canvas,
  columns,
  doorCarveTolerance,
  doorStates,
  exploredCanvas,
  exploredCtx,
  fogCanvas,
  gridScale,
  hoveredOccluderId,
  hoveredTokenId,
  minCarvedWallLength,
  nextId,
  occluders,
  placements,
  povTokenId,
  selectedOccluderId,
  selectedTokenId,
  setStatus,
  tiles,
  tokens,
  zoom,
  requestCanvasRender
} from './state'
import {resetHistory, pushUndoHistory} from './history'
import {markExplored} from './visibility'

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

export const loadMapFiles = async (files: Iterable<File>): Promise<void> => {
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

export const arrangeTiles = (): void => {
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

export const resizeBoard = (width: number, height: number): void => {
  boardSize.value = {width, height}
  syncCanvasSize(true)
}

export const syncCanvasSize = (clearExplored = false): void => {
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

export const updateCanvasDisplaySize = (): void => {
  if (!canvas) return
  canvas.style.width = `${boardSize.value.width * zoom.value}px`
  canvas.style.height = `${boardSize.value.height * zoom.value}px`
}

export const analyzeTiles = async (): Promise<void> => {
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
    const detected = analyzeImageRgba(scratch.width, scratch.height, imageData.data, gridScale())

    for (const occluder of detected) {
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

const lineCoordinate = (occluder: Occluder, axis: 'horizontal' | 'vertical'): number =>
  axis === 'horizontal' ? (occluder.y1 + occluder.y2) / 2 : (occluder.x1 + occluder.x2) / 2

const intervalFor = (occluder: Occluder, axis: 'horizontal' | 'vertical'): [number, number] => {
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

export const carveDoorGaps = (items: Occluder[]): Occluder[] => {
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
