// Render a GeneratedMap to a 2D canvas in the TRE aesthetic. Pure draw code: it
// reads the layout, never mutates it (model/render split — see SYNTHETIC_MAPS.md).
// Furniture is drawn but is decorative only; walls/doors are the LOS truth.
import type {DoorOccluder, Occluder} from '../los-core'
import type {Decoration, GeneratedMap} from './types'

const INK = '#0c0e0d'
const CORRIDOR_FILL = '#161a18'
const WALL = '#e7e9e6'
const HULL = '#f4f6f3'
const DOOR = '#ff9f1c'
const AIRLOCK = '#ffd24a'
const FURNITURE = 'rgba(180, 196, 188, 0.6)'
const GRID = 'rgba(255, 255, 255, 0.05)'
const LABEL = 'rgba(231, 233, 230, 0.45)'

const isHull = (o: Occluder): boolean => o.id.startsWith('hull') || o.id.startsWith('stub')
const isAirlock = (o: Occluder): boolean => o.id.startsWith('airlock')

export const renderMap = (ctx: CanvasRenderingContext2D, map: GeneratedMap): void => {
  const {width, height, gridScale: g} = map
  ctx.clearRect(0, 0, width, height)

  // Floor.
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, width, height)

  // Corridors: a slightly lighter floor so circulation reads at a glance.
  ctx.fillStyle = CORRIDOR_FILL
  for (const c of map.corridors) ctx.fillRect(c.x * g, c.y * g, c.w * g, c.h * g)

  // Grid.
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  for (let x = 0; x <= width; x += g) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = 0; y <= height; y += g) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }

  // Furniture (under the walls so wall strokes read on top).
  for (const item of map.decorations) drawFurniture(ctx, item)

  // Room labels, centered.
  ctx.fillStyle = LABEL
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const room of map.rooms) {
    const size = Math.max(8, Math.min(15, Math.min(room.w, room.h) * g * 0.18))
    ctx.font = `600 ${size}px "JetBrains Mono", monospace`
    ctx.fillText(room.label, (room.x + room.w / 2) * g, (room.y + room.h / 2) * g)
  }

  // Interior walls.
  ctx.strokeStyle = WALL
  ctx.lineWidth = Math.max(3, g * 0.12)
  ctx.lineCap = 'square'
  for (const o of map.occluders) {
    if (o.type !== 'wall' || isHull(o)) continue
    stroke(ctx, o)
  }

  // Hull skin: thicker and brighter (the outer shell + airlock stubs).
  ctx.strokeStyle = HULL
  ctx.lineWidth = Math.max(5, g * 0.22)
  ctx.lineCap = 'round'
  for (const o of map.occluders) {
    if (o.type === 'wall' && isHull(o)) stroke(ctx, o)
  }

  // Doors and airlocks (with jamb ticks, the geomorph convention).
  for (const o of map.occluders) {
    if (o.type === 'door') drawDoor(ctx, o, g, isAirlock(o))
  }
}

const stroke = (ctx: CanvasRenderingContext2D, o: Occluder): void => {
  ctx.beginPath()
  ctx.moveTo(o.x1, o.y1)
  ctx.lineTo(o.x2, o.y2)
  ctx.stroke()
}

const drawDoor = (ctx: CanvasRenderingContext2D, door: DoorOccluder, g: number, airlock: boolean): void => {
  const dx = door.x2 - door.x1
  const dy = door.y2 - door.y1
  const len = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / len
  const uy = dy / len
  const px = -uy
  const py = ux
  const cap = g * (airlock ? 0.22 : 0.18)

  ctx.save()
  ctx.strokeStyle = airlock ? AIRLOCK : DOOR
  ctx.lineCap = 'round'
  // Threshold line across the opening.
  ctx.lineWidth = Math.max(3, g * (airlock ? 0.14 : 0.1))
  stroke(ctx, door)
  // Jamb ticks at each end (perpendicular).
  ctx.lineWidth = Math.max(2, g * 0.06)
  for (const [ex, ey] of [
    [door.x1, door.y1],
    [door.x2, door.y2]
  ]) {
    ctx.beginPath()
    ctx.moveTo(ex - px * cap, ey - py * cap)
    ctx.lineTo(ex + px * cap, ey + py * cap)
    ctx.stroke()
  }
  ctx.restore()
}

const drawFurniture = (ctx: CanvasRenderingContext2D, item: Decoration): void => {
  ctx.save()
  ctx.strokeStyle = FURNITURE
  ctx.fillStyle = 'rgba(120, 140, 132, 0.25)'
  ctx.lineWidth = 1.5
  const cx = item.x + item.w / 2
  const cy = item.y + item.h / 2
  const round = (r: number): void => {
    ctx.beginPath()
    ctx.roundRect(item.x, item.y, item.w, item.h, r)
    ctx.fill()
    ctx.stroke()
  }
  const circle = (r: number, fill = true): void => {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    if (fill) ctx.fill()
    ctx.stroke()
  }
  switch (item.kind) {
    case 'bunk':
    case 'bed': {
      round(Math.min(item.w, item.h) * 0.18)
      // pillow line across the short axis at the head
      ctx.beginPath()
      if (item.w >= item.h) {
        ctx.moveTo(item.x + item.w * 0.7, item.y)
        ctx.lineTo(item.x + item.w * 0.7, item.y + item.h)
      } else {
        ctx.moveTo(item.x, item.y + item.h * 0.7)
        ctx.lineTo(item.x + item.w, item.y + item.h * 0.7)
      }
      ctx.stroke()
      break
    }
    case 'console':
      round(Math.min(item.w, item.h) * 0.35)
      break
    case 'reactor':
      circle(item.w / 2)
      circle(item.w * 0.3)
      circle(item.w * 0.12)
      break
    case 'table-round': {
      // Round table ringed by chair dots.
      circle(item.w / 2)
      const seats = 6
      const rr = item.w * 0.5 + Math.max(2, item.w * 0.16)
      const cr = Math.max(1.5, item.w * 0.12)
      for (let i = 0; i < seats; i += 1) {
        const a = (i / seats) * Math.PI * 2
        ctx.beginPath()
        ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, cr, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      break
    }
    case 'chair':
      circle(Math.min(item.w, item.h) / 2)
      break
    case 'machine':
      round(2)
      // cross-hatch tick to read as machinery
      ctx.beginPath()
      ctx.moveTo(item.x, item.y)
      ctx.lineTo(item.x + item.w, item.y + item.h)
      ctx.stroke()
      break
    case 'crate':
      round(1.5)
      break
    case 'shelf':
    case 'cabinet':
    case 'locker':
    case 'fixture':
    default:
      round(Math.min(item.w, item.h) * 0.16)
      break
  }
  ctx.restore()
}
