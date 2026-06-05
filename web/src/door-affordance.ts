import type {DoorOccluder} from './los-core'

type PixelScaler = (pixels: number) => number

const strokeSegment = (
  ctx: CanvasRenderingContext2D,
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

export const drawReachableDoorAffordance = (
  ctx: CanvasRenderingContext2D,
  door: DoorOccluder,
  screenPixels: PixelScaler
): void => {
  const dx = door.x2 - door.x1
  const dy = door.y2 - door.y1
  const length = Math.max(1, Math.hypot(dx, dy))
  const px = -dy / length
  const py = dx / length
  const cap = Math.min(screenPixels(8), Math.max(screenPixels(4), length * 0.18))

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  ctx.shadowColor = 'rgba(57, 255, 20, 0.72)'
  ctx.shadowBlur = screenPixels(11)

  strokeSegment(
    ctx,
    door.x1,
    door.y1,
    door.x2,
    door.y2,
    screenPixels(7),
    'rgba(57, 255, 20, 0.24)'
  )

  ctx.shadowBlur = 0
  strokeSegment(
    ctx,
    door.x1,
    door.y1,
    door.x2,
    door.y2,
    screenPixels(2.8),
    'rgba(57, 255, 20, 0.96)'
  )
  strokeSegment(
    ctx,
    door.x1 - px * cap,
    door.y1 - py * cap,
    door.x1 + px * cap,
    door.y1 + py * cap,
    screenPixels(2.2),
    'rgba(57, 255, 20, 0.9)'
  )
  strokeSegment(
    ctx,
    door.x2 - px * cap,
    door.y2 - py * cap,
    door.x2 + px * cap,
    door.y2 + py * cap,
    screenPixels(2.2),
    'rgba(57, 255, 20, 0.9)'
  )
  ctx.restore()
}
