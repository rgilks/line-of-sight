import type {Point} from './los-core'
import {
  boardSize,
  canvas,
  ctx,
  dragStart,
  editDrag,
  exploredCanvas,
  fogCanvas,
  fogCtx,
  gridScale,
  hasMap,
  hideUnseen,
  hoveredOccluderId,
  hoveredTokenId,
  placements,
  previewPoint,
  renderTick,
  screenPixels,
  selectedOccluderId,
  sightRadius,
  tokenDrag,
  tool
} from './state'
import {syncCanvasSize} from './board'
import {getPovToken, getVisiblePolygon} from './visibility'
import {drawTokens} from './rendering-tokens'
import {drawDebugWalls, drawDoorMarkers, drawEditOverlay} from './rendering-occluders'

export const renderBoard = (): void => {
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
