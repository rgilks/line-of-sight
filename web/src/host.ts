// Host bootstrap: turn a generated deck into a live multiplayer table. Generates
// a deck, renders it to a PNG, uploads the image, and publishes the board (with
// exact occluders + room-center spawn points) to the table's Durable Object —
// the same compose→upload→POST contract the authoring tool uses (web/src/publish.ts),
// but driven by the synthetic generator instead of an imported image.
import {generateMap} from './synth/generate-map'
import {renderMap} from './synth/render-map'
import {defaultSpec} from './synth/types'
import type {Board} from '../../src/protocol'

const SIGHT_RADIUS = 700
const METERS_PER_SQUARE = 1.5 // Cepheus Engine tactical square
const DEFAULT_MOVE_METERS = 6 // Cepheus Engine per-round movement (≈ 4 squares)

const renderDeckImage = (map: ReturnType<typeof generateMap>): Promise<Blob> => {
  const canvas = document.createElement('canvas')
  canvas.width = map.width
  canvas.height = map.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is required to render the deck.')
  renderMap(ctx, map)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Could not encode the deck image.'))
    }, 'image/png')
  })
}

export type PublishedDeck = {seed: number; rooms: number}

/**
 * Generate a deck for `seed`, upload its image, and publish the board to
 * `tableId`. Returns a small summary for status text. Throws on network failure.
 */
export const publishGeneratedDeck = async (
  tableId: string,
  seed: number
): Promise<PublishedDeck> => {
  const map = generateMap(defaultSpec(seed))
  const image = await renderDeckImage(map)

  const upload = await fetch(`/api/tables/${tableId}/map`, {
    method: 'POST',
    headers: {'content-type': 'image/png'},
    body: image
  })
  if (!upload.ok) throw new Error(`Map upload failed (${upload.status}).`)
  const {assetRef} = (await upload.json()) as {assetRef: string}

  const spawnPoints = map.rooms.map((room) => ({
    x: (room.x + room.w / 2) * map.gridScale,
    y: (room.y + room.h / 2) * map.gridScale
  }))
  // GM-only room labels, in board pixels — the published map image has none.
  const rooms = map.rooms.map((room) => ({
    label: room.label,
    x: room.x * map.gridScale,
    y: room.y * map.gridScale,
    w: room.w * map.gridScale,
    h: room.h * map.gridScale
  }))

  const board: Board = {
    assetRef,
    width: map.width,
    height: map.height,
    gridScale: map.gridScale,
    sightRadius: SIGHT_RADIUS,
    occluders: map.occluders,
    doorStates: {},
    playerDoorControl: true,
    metersPerSquare: METERS_PER_SQUARE,
    defaultMoveMeters: DEFAULT_MOVE_METERS,
    spawnPoints,
    rooms
  }

  const published = await fetch(`/api/tables/${tableId}/board`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(board)
  })
  if (!published.ok) throw new Error(`Publish failed (${published.status}).`)

  return {seed, rooms: map.rooms.length}
}

/** A fresh random map seed for "New map" and first-load decks. */
export const randomSeed = (): number => Math.floor(Math.random() * 100000)
