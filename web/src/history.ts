import type {Occluder} from '../../core/los'
import type {EditorSnapshot, Token} from './types'
import {
  boardSize,
  doorStates,
  dragStart,
  editDrag,
  exploredCtx,
  historyLimit,
  hoveredOccluderId,
  hoveredTokenId,
  occluders,
  previewPoint,
  redoStack,
  requestCanvasRender,
  selectedOccluderId,
  selectedTokenId,
  setStatus,
  tokenDrag,
  tokens,
  undoStack,
  povTokenId
} from './state'
import {markExplored} from './visibility'
import {notifyTableBoardChanged} from './publish'

const cloneOccluders = (items: Occluder[]): Occluder[] =>
  items.map((occluder) => ({...occluder}))

const cloneTokens = (items: Token[]): Token[] => items.map((token) => ({...token}))

const cloneDoorStates = (
  states: Record<string, {open: boolean}>
): Record<string, {open: boolean}> =>
  Object.fromEntries(Object.entries(states).map(([id, state]) => [id, {...state}]))

const editorSnapshot = (): EditorSnapshot => ({
  occluders: cloneOccluders(occluders.value),
  doorStates: cloneDoorStates(doorStates.value),
  tokens: cloneTokens(tokens.value),
  selectedOccluderId: selectedOccluderId.value,
  selectedTokenId: selectedTokenId.value,
  povTokenId: povTokenId.value
})

export const pushUndoHistory = (): void => {
  undoStack.value = [...undoStack.value.slice(1 - historyLimit), editorSnapshot()]
  redoStack.value = []
}

export const resetHistory = (): void => {
  undoStack.value = []
  redoStack.value = []
}

const restoreEditorSnapshot = (snapshot: EditorSnapshot): void => {
  occluders.value = cloneOccluders(snapshot.occluders)
  doorStates.value = cloneDoorStates(snapshot.doorStates)
  tokens.value = cloneTokens(snapshot.tokens)
  selectedOccluderId.value = occluders.value.some(
    (occluder) => occluder.id === snapshot.selectedOccluderId
  )
    ? snapshot.selectedOccluderId
    : null
  selectedTokenId.value = tokens.value.some((token) => token.id === snapshot.selectedTokenId)
    ? snapshot.selectedTokenId
    : null
  povTokenId.value = tokens.value.some((token) => token.id === snapshot.povTokenId)
    ? snapshot.povTokenId
    : (tokens.value[0]?.id ?? null)
  hoveredOccluderId.value = null
  hoveredTokenId.value = null
  editDrag.value = null
  tokenDrag.value = null
  dragStart.value = null
  previewPoint.value = null
  exploredCtx.clearRect(0, 0, boardSize.value.width, boardSize.value.height)
  markExplored()
  requestCanvasRender()
  notifyTableBoardChanged()
}

export const undoEditorChange = (): void => {
  const previous = undoStack.value.at(-1)
  if (!previous) return
  undoStack.value = undoStack.value.slice(0, -1)
  redoStack.value = [...redoStack.value.slice(1 - historyLimit), editorSnapshot()]
  restoreEditorSnapshot(previous)
  setStatus('Undid map correction.')
}

export const redoEditorChange = (): void => {
  const next = redoStack.value.at(-1)
  if (!next) return
  redoStack.value = redoStack.value.slice(0, -1)
  undoStack.value = [...undoStack.value.slice(1 - historyLimit), editorSnapshot()]
  restoreEditorSnapshot(next)
  setStatus('Redid map correction.')
}
