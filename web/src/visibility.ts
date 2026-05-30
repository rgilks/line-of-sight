import {visibilityPolygon, type DoorOccluder, type Point} from './los-core'
import type {Token} from './types'
import {
  boardSize,
  doorStates,
  exploredCtx,
  hasMap,
  occluders,
  povTokenId,
  requestCanvasRender,
  selectedOccluderId,
  selectedTokenId,
  setStatus,
  sightRadius,
  tokens
} from './state'
import {pushUndoHistory} from './history'

export const doorOccluders = (): DoorOccluder[] =>
  occluders.value.filter((occluder): occluder is DoorOccluder => occluder.type === 'door')

export const isDoorOpen = (door: DoorOccluder): boolean =>
  doorStates.value[door.id]?.open ?? door.open

export const setDoorOpen = (doorId: string, open: boolean): void => {
  const door = doorOccluders().find((candidate) => candidate.id === doorId)
  if (!door) return
  if (isDoorOpen(door) === open) return
  pushUndoHistory()
  doorStates.value = {...doorStates.value, [door.id]: {open}}
  markExplored()
  requestCanvasRender()
}

export const drawPolygonPath = (target: CanvasRenderingContext2D, polygon: Point[]): void => {
  if (polygon.length === 0) return
  target.beginPath()
  target.moveTo(polygon[0].x, polygon[0].y)
  for (const point of polygon.slice(1)) {
    target.lineTo(point.x, point.y)
  }
  target.closePath()
}

export const getPovToken = (): Token | null => {
  const explicit = povTokenId.value
    ? (tokens.value.find((token) => token.id === povTokenId.value) ?? null)
    : null
  return explicit ?? tokens.value[0] ?? null
}

export const isPovToken = (id: string): boolean => getPovToken()?.id === id

export const setPovToken = (id: string): void => {
  const token = tokens.value.find((item) => item.id === id)
  if (!token) return
  povTokenId.value = token.id
  selectedTokenId.value = token.id
  selectedOccluderId.value = null
  markExplored()
  setStatus(`Line of sight now follows ${token.label}.`)
  requestCanvasRender()
}

export const getVisiblePolygon = (): Point[] => {
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

export const markExplored = (): void => {
  if (!hasMap()) return

  const polygon = getVisiblePolygon()
  if (polygon.length < 3) return
  exploredCtx.save()
  exploredCtx.fillStyle = '#fff'
  drawPolygonPath(exploredCtx, polygon)
  exploredCtx.fill()
  exploredCtx.restore()
}

export const pointInPolygon = (point: Point, polygon: Point[]): boolean => {
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
