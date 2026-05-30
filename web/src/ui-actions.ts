import type {JSX} from 'preact'
import type {Occluder} from './los-core'
import type {Token} from './types'
import {
  boardSize,
  doorStates,
  dropDepth,
  occluders,
  requestCanvasRender,
  selectedOccluderId,
  selectedTokenId,
  tokens
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
