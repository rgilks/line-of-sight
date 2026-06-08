import {analyzeImageRgba, type DoorOccluder, type Occluder, type WallOccluder} from '../../core/los'
import type {Placement, Tile} from './types'
import {
  boardSize,
  boardViewport,
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
  maxZoom,
  minCarvedWallLength,
  minZoom,
  nextId,
  occluders,
  placements,
  povTokenId,
  roomLabels,
  selectedOccluderId,
  selectedTokenId,
  setStatus,
  showWalls,
  tiles,
  tokens,
  zoom,
  requestCanvasRender
} from './state'
import {resetHistory, pushUndoHistory} from './history'
import {notifyTableBoardChanged} from './publish'
import {markExplored} from './visibility'

const imageFilesFrom = (files: Iterable<File>): File[] =>
  Array.from(files).filter(
    (file) => file.type.startsWith('image/') || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name)
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
  roomLabels.value = [] // imported maps have no generated room labels
  selectedOccluderId.value = null
  hoveredOccluderId.value = null
  selectedTokenId.value = null
  hoveredTokenId.value = null
  povTokenId.value = null
  resetHistory()
  arrangeTiles()
  setStatus(`Loaded ${tiles.value.length} image(s). Analyzing walls and doors…`)
  // Auto-analyze on load; analyzeTiles sets the final status, fog, and render.
  await analyzeTiles()
}

const tileIdFromOccluderId = (id: string): string | null => {
  const colon = id.indexOf(':')
  return colon > 0 ? id.slice(0, colon) : null
}

const relocateBoardContentForLayout = (before: Placement[], after: Placement[]): void => {
  const deltas = new Map<string, {dx: number; dy: number}>()
  for (const placement of after) {
    const previous = before.find((entry) => entry.tile.id === placement.tile.id)
    if (!previous) continue
    const dx = placement.x - previous.x
    const dy = placement.y - previous.y
    if (dx !== 0 || dy !== 0) deltas.set(placement.tile.id, {dx, dy})
  }
  if (deltas.size === 0) return

  occluders.value = occluders.value.map((occluder) => {
    const tileId = tileIdFromOccluderId(occluder.id)
    const delta = tileId ? deltas.get(tileId) : undefined
    if (!delta) return occluder
    return {
      ...occluder,
      x1: occluder.x1 + delta.dx,
      y1: occluder.y1 + delta.dy,
      x2: occluder.x2 + delta.dx,
      y2: occluder.y2 + delta.dy
    }
  })
  markExplored()
}

export const arrangeTiles = (): void => {
  const previousPlacements = placements.value.map((placement) => ({
    tile: placement.tile,
    x: placement.x,
    y: placement.y
  }))

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
  if (previousPlacements.length > 0) {
    relocateBoardContentForLayout(previousPlacements, placements.value)
  }
  scheduleFitBoardToViewport()
  notifyTableBoardChanged()
  requestCanvasRender()
}

export const reorderTile = (fromIndex: number, toIndex: number): void => {
  const count = tiles.value.length
  if (count < 2 || fromIndex < 0 || fromIndex >= count || toIndex < 0 || toIndex >= count) return
  if (fromIndex === toIndex) return

  pushUndoHistory()
  const nextTiles = [...tiles.value]
  const [moved] = nextTiles.splice(fromIndex, 1)
  nextTiles.splice(toIndex, 0, moved)
  tiles.value = nextTiles
  arrangeTiles()
  setStatus('Map order updated on the board.')
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

const fitPaddingPx = 12

let fitFrame = 0

/** Scale and center the board so the full map fits in the viewport. */
export const fitBoardToViewport = (): void => {
  if (!boardViewport || placements.value.length === 0) return

  const {width, height} = boardSize.value
  if (width <= 0 || height <= 0) return

  const availWidth = boardViewport.clientWidth - fitPaddingPx * 2
  const availHeight = boardViewport.clientHeight - fitPaddingPx * 2
  if (availWidth <= 0 || availHeight <= 0) return

  const fitZoom = Math.min(availWidth / width, availHeight / height)
  zoom.value = Math.min(maxZoom, Math.max(minZoom, fitZoom))
  updateCanvasDisplaySize()
  boardViewport.scrollLeft = 0
  boardViewport.scrollTop = 0
}

/** Defer fit until the viewport has settled after layout. */
export const scheduleFitBoardToViewport = (): void => {
  if (typeof window === 'undefined') {
    fitBoardToViewport()
    return
  }

  if (fitFrame !== 0) cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => {
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0
      fitBoardToViewport()
    })
  })
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
  occluders.value = sealDoorWallJunctions(carveDoorGaps([...generated, ...manual]))
  doorStates.value = Object.fromEntries(
    Object.entries(doorStates.value).filter(([doorId]) =>
      occluders.value.some((occluder) => occluder.type === 'door' && occluder.id === doorId)
    )
  )
  selectedOccluderId.value = null
  hoveredOccluderId.value = null
  exploredCtx.clearRect(0, 0, boardSize.value.width, boardSize.value.height)
  markExplored()
  showWalls.value = true
  scheduleFitBoardToViewport()
  setStatus(
    `Analyzed ${placements.value.length} tile(s); walls shown on map — click to select, Erase or Del to remove.`
  )
  notifyTableBoardChanged()
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

  return occluder.type === 'door' ? {...base, type: 'door', open: occluder.open} : {...base, type: 'wall'}
}

type LineOccluder = WallOccluder | DoorOccluder

const occluderAxis = (occluder: LineOccluder): 'horizontal' | 'vertical' | null => {
  const dx = Math.abs(occluder.x2 - occluder.x1)
  const dy = Math.abs(occluder.y2 - occluder.y1)
  if (dx >= minCarvedWallLength && dy <= doorCarveTolerance) return 'horizontal'
  if (dy >= minCarvedWallLength && dx <= doorCarveTolerance) return 'vertical'
  return null
}

const lineCoordinate = (occluder: LineOccluder, axis: 'horizontal' | 'vertical'): number =>
  axis === 'horizontal' ? (occluder.y1 + occluder.y2) / 2 : (occluder.x1 + occluder.x2) / 2

const intervalFor = (occluder: LineOccluder, axis: 'horizontal' | 'vertical'): [number, number] => {
  const first = axis === 'horizontal' ? occluder.x1 : occluder.y1
  const second = axis === 'horizontal' ? occluder.x2 : occluder.y2
  return first <= second ? [first, second] : [second, first]
}

const mergeIntervals = (intervals: Array<[number, number]>): Array<[number, number]> => {
  const sorted = intervals.filter(([start, end]) => end - start >= minCarvedWallLength).sort(([a], [b]) => a - b)
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
        const carvePad = doorCarveTolerance
        const start = Math.max(wallStart, doorStart - carvePad)
        const end = Math.min(wallEnd, doorEnd + carvePad)
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

const junctionSealDistance = 14

/** Extend doors and wall segments so endpoints meet, closing sight-line cracks at jambs. */
export const sealDoorWallJunctions = (items: Occluder[]): Occluder[] => {
  const doors = items.filter((item): item is DoorOccluder => item.type === 'door')
  if (doors.length === 0) return items

  const wallPieces = items.filter((item): item is WallOccluder => item.type === 'wall')
  const adjustedWalls = new Map<string, WallOccluder>()
  const adjustedDoors = new Map<string, DoorOccluder>()

  for (const door of doors) {
    adjustedDoors.set(door.id, {...door})
  }
  for (const wall of wallPieces) {
    adjustedWalls.set(wall.id, {...wall})
  }

  for (const door of doors) {
    const doorAxis = occluderAxis(door)
    if (!doorAxis) continue

    const doorLine = lineCoordinate(door, doorAxis)
    let [doorStart, doorEnd] = intervalFor(door, doorAxis)

    for (const wall of wallPieces) {
      const wallAxis = occluderAxis(wall)
      if (wallAxis !== doorAxis) continue
      const wallLine = lineCoordinate(wall, doorAxis)
      if (Math.abs(wallLine - doorLine) > doorCarveTolerance) continue

      const [wallStart, wallEnd] = intervalFor(wall, doorAxis)
      if (Math.abs(wallEnd - doorStart) <= junctionSealDistance) {
        doorStart = Math.min(doorStart, wallEnd)
      }
      if (Math.abs(wallStart - doorEnd) <= junctionSealDistance) {
        doorEnd = Math.max(doorEnd, wallStart)
      }
      if (Math.abs(wallStart - doorStart) <= junctionSealDistance) {
        doorStart = Math.min(doorStart, wallStart)
      }
      if (Math.abs(wallEnd - doorEnd) <= junctionSealDistance) {
        doorEnd = Math.max(doorEnd, wallEnd)
      }
    }

    adjustedDoors.set(door.id, {
      ...door,
      x1: doorAxis === 'horizontal' ? doorStart : doorLine,
      y1: doorAxis === 'vertical' ? doorStart : doorLine,
      x2: doorAxis === 'horizontal' ? doorEnd : doorLine,
      y2: doorAxis === 'vertical' ? doorEnd : doorLine
    })
  }

  for (const wall of wallPieces) {
    const wallAxis = occluderAxis(wall)
    if (!wallAxis) continue

    const wallLine = lineCoordinate(wall, wallAxis)
    let [wallStart, wallEnd] = intervalFor(wall, wallAxis)

    for (const door of doors) {
      const doorAxis = occluderAxis(door)
      if (doorAxis !== wallAxis) continue
      const doorLine = lineCoordinate(door, wallAxis)
      if (Math.abs(doorLine - wallLine) > doorCarveTolerance) continue

      const [doorStart, doorEnd] = intervalFor(adjustedDoors.get(door.id) ?? door, wallAxis)

      if (wallEnd <= doorStart && doorStart - wallEnd <= junctionSealDistance) {
        wallEnd = doorStart
      }
      if (wallStart >= doorEnd && wallStart - doorEnd <= junctionSealDistance) {
        wallStart = doorEnd
      }
    }

    adjustedWalls.set(wall.id, {
      ...wall,
      x1: wallAxis === 'horizontal' ? wallStart : wallLine,
      y1: wallAxis === 'vertical' ? wallStart : wallLine,
      x2: wallAxis === 'horizontal' ? wallEnd : wallLine,
      y2: wallAxis === 'vertical' ? wallEnd : wallLine
    })
  }

  return items.map((item) => {
    if (item.type === 'door') return adjustedDoors.get(item.id) ?? item
    if (item.type === 'wall') return adjustedWalls.get(item.id) ?? item
    return item
  })
}
