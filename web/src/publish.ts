// GM "publish board" — push the authored map + occluders from the single-player
// tool into a multiplayer table so /play runs on the real map. Composes the map
// tiles into one image (downscaled for upload; the client stretches it to board
// size), uploads it privately to R2, then POSTs the board to the table DO.
import {boardSize, doorStates, gridScale, hasMap, occluders, placements, setStatus, sightRadius} from './state'
import {isDoorOpen} from './visibility'

const MAX_DIMENSION = 2048

const composeMapImage = async (): Promise<Blob | null> => {
  const {width, height} = boardSize.value
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  const scratch = document.createElement('canvas')
  scratch.width = Math.round(width * scale)
  scratch.height = Math.round(height * scale)
  const ctx = scratch.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)
  for (const placement of placements.value) {
    ctx.drawImage(placement.tile.image, placement.x, placement.y)
  }
  return new Promise((resolve) => scratch.toBlob(resolve, 'image/png'))
}

export const publishToTable = async (rawTableId: string): Promise<void> => {
  const tableId = rawTableId.trim()
  if (!tableId) {
    setStatus('Enter a table name to publish to.')
    return
  }
  if (!hasMap()) {
    setStatus('Load and arrange a map before publishing.')
    return
  }

  setStatus(`Publishing to table "${tableId}"…`)
  const image = await composeMapImage()
  if (!image) {
    setStatus('Could not compose the map image.')
    return
  }

  const upload = await fetch(`/api/tables/${tableId}/map`, {
    method: 'POST',
    headers: {'content-type': 'image/png'},
    body: image
  })
  if (!upload.ok) {
    setStatus(`Map upload failed (${upload.status}).`)
    return
  }
  const {assetRef} = (await upload.json()) as {assetRef: string}

  const board = {
    assetRef,
    width: boardSize.value.width,
    height: boardSize.value.height,
    gridScale: gridScale(),
    sightRadius: sightRadius(),
    occluders: occluders.value.map((occluder) =>
      occluder.type === 'door' ? {...occluder, open: isDoorOpen(occluder)} : occluder
    ),
    doorStates: doorStates.value
  }

  const published = await fetch(`/api/tables/${tableId}/board`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(board)
  })
  setStatus(
    published.ok
      ? `Published to table "${tableId}". Open /play.html?table=${tableId} to play.`
      : `Publish failed (${published.status}).`
  )
}
