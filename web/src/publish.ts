// GM "publish board" — push the authored map + occluders from the single-player
// tool into a multiplayer table so /play runs on the real map. Composes the map
// tiles into one image (downscaled for upload; the client stretches it to board
// size), uploads it privately to R2, then POSTs the board to the table DO.
import {
  boardSize,
  doorStates,
  gridScale,
  hasMap,
  occluders,
  placements,
  publishTableId,
  setStatus,
  sightRadius,
  tablePublished
} from './state'
import {gmPlayUrl, playerPlayUrl} from './table-links'
import {isDoorOpen} from './visibility'

const MAX_DIMENSION = 2048
const LIVE_SYNC_DELAY_MS = 700

let liveSyncTimer = 0
let publishInFlight = false
let pendingLiveSync = false

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

const buildBoardPayload = (assetRef: string) => ({
  assetRef,
  width: boardSize.value.width,
  height: boardSize.value.height,
  gridScale: gridScale(),
  sightRadius: sightRadius(),
  feetPerSquare: 5,
  defaultMoveFeet: 30,
  occluders: occluders.value.map((occluder) =>
    occluder.type === 'door' ? {...occluder, open: isDoorOpen(occluder)} : occluder
  ),
  doorStates: doorStates.value
})

/** Debounced push to connected /play clients after GM edits walls, doors, or map layout. */
export const notifyTableBoardChanged = (): void => {
  if (!tablePublished.value || !hasMap()) return
  if (publishInFlight) {
    pendingLiveSync = true
    return
  }
  if (liveSyncTimer) window.clearTimeout(liveSyncTimer)
  liveSyncTimer = window.setTimeout(() => {
    liveSyncTimer = 0
    void publishToTable(publishTableId.value, {live: true})
  }, LIVE_SYNC_DELAY_MS)
}

export const publishToTable = async (rawTableId: string, options?: {live?: boolean}): Promise<void> => {
  const tableId = rawTableId.trim()
  if (!tableId) {
    if (!options?.live) setStatus('Enter a table name to publish to.')
    return
  }
  if (!hasMap()) {
    if (!options?.live) setStatus('Load and arrange a map before publishing.')
    return
  }
  if (publishInFlight) return
  publishInFlight = true

  if (!options?.live) {
    setStatus(`Publishing to table "${tableId}"…`)
  } else {
    setStatus(`Syncing map to table "${tableId}"…`)
  }

  try {
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

    const published = await fetch(`/api/tables/${tableId}/board`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(buildBoardPayload(assetRef))
    })
    if (published.ok) {
      tablePublished.value = true
      setStatus(
        options?.live
          ? `Table "${tableId}" updated for connected players.`
          : `Published to "${tableId}". Share the player invite link — then open GM view to run the table.`
      )
      return
    }
    setStatus(`Publish failed (${published.status}).`)
  } finally {
    publishInFlight = false
    if (pendingLiveSync) {
      pendingLiveSync = false
      notifyTableBoardChanged()
    }
  }
}

export const playLinksFor = (rawTableId: string): {player: string; gm: string} => ({
  player: playerPlayUrl(rawTableId),
  gm: gmPlayUrl(rawTableId)
})
