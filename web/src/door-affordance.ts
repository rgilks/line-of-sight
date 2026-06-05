import type {DoorOccluder, Point} from './los-core'

type PixelScaler = (pixels: number) => number

export const drawReachableDoorAffordance = (
  ctx: CanvasRenderingContext2D,
  door: DoorOccluder,
  screenPixels: PixelScaler,
  actor?: Point | null
): void => {
  const dx = door.x2 - door.x1
  const dy = door.y2 - door.y1
  const length = Math.max(1, Math.hypot(dx, dy))
  const px = -dy / length
  const py = dx / length
  const midX = (door.x1 + door.x2) / 2
  const midY = (door.y1 + door.y2) / 2
  const side = actor && (actor.x - midX) * px + (actor.y - midY) * py > 0 ? -1 : 1
  const pipX = midX + px * side * screenPixels(11)
  const pipY = midY + py * side * screenPixels(11)
  const haloRadius = screenPixels(6.5)
  const ringRadius = screenPixels(4.2)
  const dotRadius = screenPixels(1.6)

  ctx.save()
  ctx.setLineDash([])
  ctx.shadowColor = 'rgba(57, 255, 20, 0.72)'
  ctx.shadowBlur = screenPixels(7)

  ctx.fillStyle = 'rgba(5, 5, 5, 0.82)'
  ctx.beginPath()
  ctx.arc(pipX, pipY, haloRadius, 0, Math.PI * 2)
  ctx.fill()

  ctx.shadowBlur = 0
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.95)'
  ctx.lineWidth = screenPixels(1.6)
  ctx.beginPath()
  ctx.arc(pipX, pipY, ringRadius, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = 'rgba(57, 255, 20, 0.95)'
  ctx.beginPath()
  ctx.arc(pipX, pipY, dotRadius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}
