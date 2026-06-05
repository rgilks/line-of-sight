import type {JSX} from 'preact'
import type {DoorOccluder, Occluder, Point} from './los-core'
import {distanceToOccluder} from './los-core'
import type {CounterGroupId, EditDrag, EditHandle, Token} from './types'
import {
  boardSize,
  boardViewport,
  canvas,
  doorStates,
  dragStart,
  editDrag,
  gridScale,
  hasMap,
  hoveredOccluderId,
  hoveredTokenId,
  maxZoom,
  minZoom,
  nextId,
  occluders,
  povTokenId,
  previewPoint,
  requestCanvasRender,
  screenPixels,
  selectedOccluderId,
  selectedTokenId,
  setStatus,
  tokenDrag,
  tokens,
  tool,
  zoom,
  activeCounterGroup,
  activeCounterKind
} from './state'
import {carveDoorGaps, sealDoorWallJunctions} from './board'
import {pushUndoHistory, redoEditorChange, undoEditorChange} from './history'
import {
  getPovToken,
  isDoorOpen,
  isDoorReachable,
  isPovToken,
  markExplored,
  setDoorOpen,
  setPovToken
} from './visibility'
import {updateCanvasDisplaySize} from './board'
import {notifyTableBoardChanged} from './publish'

export const positionFromEvent = (
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

export const handleWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>): void => {
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

const snapPoint = (point: Point, event: JSX.TargetedPointerEvent<HTMLCanvasElement>): Point => {
  if (event.shiftKey) return point
  const scale = gridScale() / 4
  return {
    x: Math.round(point.x / scale) * scale,
    y: Math.round(point.y / scale) * scale
  }
}

type LineSegment = {
  x1: number
  y1: number
  x2: number
  y2: number
}

const distanceToSegment = (point: Point, segment: LineSegment): number => {
  const ax = segment.x1
  const ay = segment.y1
  const bx = segment.x2
  const by = segment.y2
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - ax, point.y - ay)
  const t = Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / lengthSquared))
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
    const distance = distanceToOccluder(point, occluder)
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

export const nextTokenLabel = (group: CounterGroupId): string =>
  `${group}${nextTokenMember(group)}`

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

export const removeToken = (id: string, recordHistory = true): void => {
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

const doorOutOfReachStatus = (): string =>
  getPovToken()
    ? 'Move the POV counter adjacent to this door to operate it.'
    : 'Place a POV counter next to this door to operate it.'

const toggleDoorIfReachable = (door: DoorOccluder): boolean => {
  if (!isDoorReachable(door)) {
    setStatus(doorOutOfReachStatus())
    return false
  }

  const opening = !isDoorOpen(door)
  setDoorOpen(door.id, opening)
  setStatus(opening ? 'Door open.' : 'Door closed.')
  return true
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

export const removeOccluder = (id: string, recordHistory = true): void => {
  if (!occluders.value.some((occluder) => occluder.id === id)) return
  if (recordHistory) pushUndoHistory()
  occluders.value = occluders.value.filter((occluder) => occluder.id !== id)
  const nextDoorStates = {...doorStates.value}
  delete nextDoorStates[id]
  doorStates.value = nextDoorStates
  if (selectedOccluderId.value === id) selectedOccluderId.value = null
  if (hoveredOccluderId.value === id) hoveredOccluderId.value = null
  if (recordHistory) notifyTableBoardChanged()
}

const targetAcceptsMapShortcuts = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement

export const handleMapKeyDown = (event: KeyboardEvent): void => {
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

  if (
    (shortcutKey === 'o' || shortcutKey === 't') &&
    selectedOccluderId.value &&
    !selectedTokenId.value
  ) {
    const selected = occluders.value.find((occluder) => occluder.id === selectedOccluderId.value)
    if (selected?.type === 'door') {
      event.preventDefault()
      toggleDoorIfReachable(selected)
      requestCanvasRender()
      return
    }
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

export const handlePointerDown = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
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
      selectedOccluderId.value = null
      selectedTokenId.value = null
      hoveredOccluderId.value = null
      requestCanvasRender()
      return
    }

    const occluder = nearestOccluder(rawPoint, () => true, 18)
    if (occluder) {
      selectedOccluderId.value = occluder.id
      selectedTokenId.value = null
      hoveredOccluderId.value = occluder.id

      if (occluder.type === 'door') {
        toggleDoorIfReachable(occluder)
        requestCanvasRender()
        return
      }

      setStatus('Wall selected — Del to remove, or use Wall/Door tool to reshape.')
      requestCanvasRender()
      return
    }

    selectedOccluderId.value = null
    selectedTokenId.value = null
    hoveredOccluderId.value = null
    setStatus('Click a counter for POV, or a wall/door line to select it.')
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

export const handlePointerMove = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
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
      hoveredOccluderId.value =
        tool.value === 'viewer' ? (nearestOccluder(rawPoint, () => true, 18)?.id ?? null) : null
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

export const handlePointerUp = (event: JSX.TargetedPointerEvent<HTMLCanvasElement>): void => {
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
    occluders.value = sealDoorWallJunctions(carveDoorGaps(occluders.value))
    if (!occluders.value.some((occluder) => occluder.id === drag.id)) {
      selectedOccluderId.value = null
    }
    event.currentTarget.releasePointerCapture(event.pointerId)
    markExplored()
    notifyTableBoardChanged()
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
    occluders.value = sealDoorWallJunctions(carveDoorGaps(nextOccluders))
    selectedOccluderId.value = id
    hoveredOccluderId.value = id
    notifyTableBoardChanged()
  }

  dragStart.value = null
  previewPoint.value = null
  event.currentTarget.releasePointerCapture(event.pointerId)
  markExplored()
  requestCanvasRender()
}

export const handlePointerCancel = (): void => {
  dragStart.value = null
  previewPoint.value = null
  editDrag.value = null
  tokenDrag.value = null
  requestCanvasRender()
}
