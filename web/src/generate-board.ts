// Bridge the synthetic deck generator (web/src/synth/) into the main authoring
// tool. A generated map carries its own exact line-of-sight occluders, so —
// unlike an imported image — it is loaded WITHOUT running detection: we render
// the deck to a PNG, inject it as the board tile, and set the occluders directly.
// Room labels are kept aside as a GM-only overlay (see state.roomLabels).
import {generateMap} from './synth/generate-map'
import {renderMap} from './synth/render-map'
import type {MapSpec, RoomType, Theme} from './synth/types'
import type {DoorOccluder} from '../../core/los'
import type {Tile} from './types'
import {
  doorStates,
  gridValue,
  hoveredOccluderId,
  hoveredTokenId,
  nextId,
  occluders,
  povTokenId,
  requestCanvasRender,
  roomLabels,
  selectedOccluderId,
  selectedTokenId,
  setStatus,
  showWalls,
  tiles,
  tokens
} from './state'
import {arrangeTiles} from './board'
import {resetHistory} from './history'
import {markExplored} from './visibility'
import {notifyTableBoardChanged} from './publish'

// Runtime lists for the Generate controls (the matching types are compile-time).
export const GEN_THEMES: Theme[] = ['civilian', 'military', 'industrial', 'derelict']
export const GEN_ROOM_TYPES: RoomType[] = [
  'bridge',
  'quarters',
  'cargo',
  'medbay',
  'engineering',
  'common',
  'fresher',
  'storage'
]

// A fresh spec with a random seed and theme — used for the first-load map and
// the 🎲 button, so each visit opens on a different deck.
export const randomizedSpec = (base: MapSpec): MapSpec => ({
  ...base,
  seed: Math.floor(Math.random() * 100000),
  theme: GEN_THEMES[Math.floor(Math.random() * GEN_THEMES.length)]
})

const canvasToImage = (canvas: HTMLCanvasElement): Promise<{image: HTMLImageElement; url: string}> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not render the generated map.'))
        return
      }
      const url = URL.createObjectURL(blob)
      const image = new Image()
      image.onload = () => resolve({image, url})
      image.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Generated map image failed to load.'))
      }
      image.src = url
    }, 'image/png')
  })

/**
 * Generate a deck from `spec`, render it to the board as a single tile, and
 * install its exact occluders + GM room labels. Replaces any current map.
 */
export const loadGeneratedMap = async (spec: MapSpec): Promise<void> => {
  setStatus(`Generating ${spec.theme} deck…`)
  const map = generateMap(spec)

  const scratch = document.createElement('canvas')
  scratch.width = map.width
  scratch.height = map.height
  const scratchCtx = scratch.getContext('2d')
  if (!scratchCtx) throw new Error('Canvas 2D is required to render generated maps.')
  renderMap(scratchCtx, map)
  const {image, url} = await canvasToImage(scratch)

  for (const tile of tiles.value) URL.revokeObjectURL(tile.url)
  const tile: Tile = {
    id: nextId('gen'),
    name: `Generated ${spec.theme} deck (seed ${spec.seed})`,
    image,
    url,
    width: map.width,
    height: map.height
  }

  // Reset board state, then lay out the single tile (sizes the board to the map
  // and places it at the origin, so synth pixels == board pixels).
  tiles.value = [tile]
  occluders.value = []
  doorStates.value = {}
  tokens.value = []
  selectedOccluderId.value = null
  hoveredOccluderId.value = null
  selectedTokenId.value = null
  hoveredTokenId.value = null
  povTokenId.value = null
  roomLabels.value = []
  resetHistory()
  gridValue.value = map.gridScale // align the board grid overlay to the deck cells
  arrangeTiles()

  // Install the generated truth directly — no detection needed.
  occluders.value = map.occluders
  doorStates.value = Object.fromEntries(
    map.occluders.filter((o): o is DoorOccluder => o.type === 'door').map((door) => [door.id, {open: door.open}])
  )
  roomLabels.value = map.rooms.map((room) => ({
    label: room.label,
    x: room.x * map.gridScale,
    y: room.y * map.gridScale,
    w: room.w * map.gridScale,
    h: room.h * map.gridScale
  }))
  // Walls are drawn into the deck image already, so leave the debug wall overlay
  // off; the occluders still drive line of sight.
  showWalls.value = false
  markExplored()
  setStatus(`Generated ${spec.theme} deck — ${map.rooms.length} rooms. Edit walls, drop counters, or publish.`)
  notifyTableBoardChanged()
  requestCanvasRender()
}
