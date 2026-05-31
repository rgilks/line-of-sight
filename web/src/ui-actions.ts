import type {JSX} from 'preact'
import type {Occluder} from './los-core'
import type {Token} from './types'
import {
  boardSize,
  boardViewport,
  doorStates,
  dropDepth,
  occluders,
  requestCanvasRender,
  reviewCursor,
  reviewMode,
  selectedOccluderId,
  selectedTokenId,
  setStatus,
  showWalls,
  tokens,
  tool,
  zoom
} from './state'
import {carveDoorGaps, loadMapFiles} from './board'
import {pushUndoHistory} from './history'
import {doorOccluders, getPovToken, isDoorOpen, markExplored} from './visibility'

export const handleDragEnter = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dropDepth.value += 1
}

export const handleDragOver = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

export const handleDragLeave = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer?.types.includes('Files')) return
  dropDepth.value = Math.max(0, dropDepth.value - 1)
}

export const handleDrop = (event: JSX.TargetedDragEvent<HTMLDivElement>): void => {
  if (!event.dataTransfer) return
  event.preventDefault()
  dropDepth.value = 0
  void loadMapFiles(event.dataTransfer.files)
}

export const getBoardStat = (): string =>
  `${Math.round(boardSize.value.width)} x ${Math.round(boardSize.value.height)}`

export const getDoorStat = (): string => {
  const doors = doorOccluders()
  const openCount = doors.filter(isDoorOpen).length
  return doors.length === 0 ? '0' : `${doors.length} (${openCount} open)`
}

export const getPovStat = (): string => getPovToken()?.label ?? 'None'

export const getSelectedOccluder = (): Occluder | null => {
  const id = selectedOccluderId.value
  return id ? (occluders.value.find((occluder) => occluder.id === id) ?? null) : null
}

export const getSelectedToken = (): Token | null => {
  const id = selectedTokenId.value
  return id ? (tokens.value.find((token) => token.id === id) ?? null) : null
}

export const reviewableOccluders = (): Occluder[] =>
  occluders.value.filter((occluder) => !occluder.id.startsWith('manual-'))

export const getReviewStat = (): string => {
  const candidates = reviewableOccluders()
  if (candidates.length === 0) return '0'
  const selectedIndex = candidates.findIndex((occluder) => occluder.id === selectedOccluderId.value)
  return selectedIndex >= 0 ? `${selectedIndex + 1} / ${candidates.length}` : `${candidates.length}`
}

const centerOccluderInView = (occluder: Occluder): void => {
  if (!boardViewport) return
  const midX = (occluder.x1 + occluder.x2) / 2
  const midY = (occluder.y1 + occluder.y2) / 2
  boardViewport.scrollLeft = Math.max(0, midX * zoom.value - boardViewport.clientWidth / 2)
  boardViewport.scrollTop = Math.max(0, midY * zoom.value - boardViewport.clientHeight / 2)
}

const selectReviewCandidate = (index: number): void => {
  const candidates = reviewableOccluders()
  if (candidates.length === 0) {
    reviewMode.value = false
    selectedOccluderId.value = null
    setStatus('No detected wall or door candidates to review.')
    requestCanvasRender()
    return
  }

  const nextIndex = ((index % candidates.length) + candidates.length) % candidates.length
  const candidate = candidates[nextIndex]
  reviewMode.value = true
  reviewCursor.value = nextIndex
  showWalls.value = true
  selectedOccluderId.value = candidate.id
  selectedTokenId.value = null
  tool.value = candidate.type
  centerOccluderInView(candidate)
  setStatus(`Reviewing ${candidate.type} ${nextIndex + 1} of ${candidates.length}.`)
  requestCanvasRender()
}

export const startReview = (): void => {
  selectReviewCandidate(0)
}

export const stopReview = (): void => {
  reviewMode.value = false
  setStatus('Review paused. Corrections remain on the board.')
  requestCanvasRender()
}

export const selectAdjacentReviewCandidate = (direction: -1 | 1): void => {
  const candidates = reviewableOccluders()
  if (candidates.length === 0) {
    startReview()
    return
  }
  const selectedIndex = candidates.findIndex((occluder) => occluder.id === selectedOccluderId.value)
  const baseIndex = selectedIndex >= 0 ? selectedIndex : reviewCursor.value
  selectReviewCandidate(baseIndex + direction)
}

export const keepReviewCandidate = (): void => {
  selectAdjacentReviewCandidate(1)
}

export const deleteReviewCandidate = (): void => {
  const selected = getSelectedOccluder()
  if (!selected) return
  const candidates = reviewableOccluders()
  const selectedIndex = candidates.findIndex((occluder) => occluder.id === selected.id)
  pushUndoHistory()
  occluders.value = occluders.value.filter((occluder) => occluder.id !== selected.id)
  const nextDoorStates = {...doorStates.value}
  delete nextDoorStates[selected.id]
  doorStates.value = nextDoorStates
  selectedOccluderId.value = null
  markExplored()

  const remaining = reviewableOccluders()
  if (remaining.length > 0) {
    selectReviewCandidate(Math.min(Math.max(0, selectedIndex), remaining.length - 1))
  } else {
    reviewMode.value = false
    setStatus('Review complete. No detected candidates remain.')
    requestCanvasRender()
  }
}

export const convertSelectedOccluder = (targetType: 'wall' | 'door'): void => {
  const selected = getSelectedOccluder()
  if (!selected || selected.type === targetType) return

  pushUndoHistory()
  const converted: Occluder =
    targetType === 'door'
      ? {
          type: 'door',
          id: selected.id,
          x1: selected.x1,
          y1: selected.y1,
          x2: selected.x2,
          y2: selected.y2,
          open: false
        }
      : {
          type: 'wall',
          id: selected.id,
          x1: selected.x1,
          y1: selected.y1,
          x2: selected.x2,
          y2: selected.y2
        }

  occluders.value = carveDoorGaps(
    occluders.value.map((occluder) => (occluder.id === selected.id ? converted : occluder))
  )
  const nextDoorStates = {...doorStates.value}
  if (converted.type === 'door') {
    nextDoorStates[converted.id] = {open: false}
  } else {
    delete nextDoorStates[converted.id]
  }
  doorStates.value = nextDoorStates
  selectedOccluderId.value = converted.id
  markExplored()
  requestCanvasRender()
}
