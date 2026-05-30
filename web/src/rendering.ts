import type {DoorOccluder, Point} from './los-core'
import type {CounterDefinition, CounterKind, Token} from './types'
import {
  boardSize,
  canvas,
  counterDefinitions,
  counterPortraits,
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
  tokenDrag,
  occluders,
  placements,
  previewPoint,
  renderTick,
  screenPixels,
  selectedOccluderId,
  selectedTokenId,
  showWalls,
  sightRadius,
  tokens,
  tool
} from './state'
import {syncCanvasSize} from './board'
import {getPovToken, getVisiblePolygon, isDoorOpen, pointInPolygon} from './visibility'

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
  roundedRect(-half + inset, -half + inset, size - inset * 2, size - inset * 2, size * 0.035)
  ctx.clip()
  drawCounterPortrait(token.kind, -half + inset, -half + inset, size - inset * 2, size - inset * 2)
  ctx.restore()

  const highlight = ctx.createLinearGradient(0, -half + inset, 0, half - inset)
  highlight.addColorStop(0, 'rgba(255, 255, 255, 0.18)')
  highlight.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)')
  highlight.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
  roundedRect(-half + inset, -half + inset, size - inset * 2, size - inset * 2, size * 0.035)
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
