import type {DoorOccluder} from '../../core/los'
import {drawReachableDoorAffordance} from './door-affordance'
import {
  ctx,
  hoveredOccluderId,
  occluders,
  screenPixels,
  selectedOccluderId,
  showWalls
} from './state'
import {getPovToken, isDoorOpen, isDoorReachable} from './visibility'

export const drawDoorMarkers = (): void => {
  ctx.save()
  ctx.lineCap = 'round'
  for (const occluder of occluders.value) {
    if (occluder.type === 'door') {
      drawDoorStateMarker(occluder, isDoorOpen(occluder))
    }
  }
  ctx.restore()
}

export const drawReachableDoorMarkers = (): void => {
  const pov = getPovToken()
  ctx.save()
  for (const occluder of occluders.value) {
    if (occluder.type === 'door' && isDoorReachable(occluder)) {
      drawReachableDoorAffordance(ctx, occluder, screenPixels, pov)
    }
  }
  ctx.restore()
}

export const drawDebugWalls = (): void => {
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

export const drawEditOverlay = (): void => {
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
