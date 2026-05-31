// Spec + data model for the synthetic deck generator. These types are the
// contract between the (future) LLM steering layer, the generator, and the
// renderer — keep them plain data so they serialise straight to JSON.
import type {Occluder} from '../los-core'

// A room's function. Drives furniture and labelling; the LLM can target these
// when steering a layout from a natural-language brief.
export type RoomType =
  | 'bridge'
  | 'quarters'
  | 'cargo'
  | 'medbay'
  | 'engineering'
  | 'common'
  | 'fresher'
  | 'storage'
  | 'airlock'

// Visual/structural theme. Influences palette and room mix.
export type Theme = 'civilian' | 'military' | 'industrial' | 'derelict'

export type MapSpec = {
  seed: number
  cols: number
  rows: number
  gridScale: number
  theme: Theme
  minRoom: number
  maxRoom: number
  required: RoomType[]
  furnitureDensity: number
  // Corridor band width in cells (the connective tissue between rooms).
  corridorWidth: number
  // Hull margin in cells: the gap between the room block and the outer skin,
  // matching the geomorph convention (fuel/conduit space lives here).
  hullMargin: number
}

// A cell-space rectangle (grid units, not pixels). Rooms and corridor segments
// are both rectangles of cells; the renderer scales by gridScale.
export type Rect = {x: number; y: number; w: number; h: number}

// A placed room: grid position + size, plus its function and display label.
export type Room = Rect & {
  id: string
  type: RoomType
  label: string
}

// A decorative item inside a room. NOT an occluder — furniture never blocks
// line of sight (matches the geomorph convention). Pure pixel-space rectangle.
export type Decoration = {
  kind: string
  x: number
  y: number
  w: number
  h: number
}

// The generated map: rooms + corridors + decorations + the line-of-sight
// occluders (walls and doors) the existing pipeline already understands.
// `occluders` includes the hull skin (ids prefixed `hull`) and airlock doors
// (ids prefixed `airlock`); the renderer keys off those prefixes.
export type GeneratedMap = {
  spec: MapSpec
  width: number
  height: number
  gridScale: number
  rooms: Room[]
  corridors: Rect[]
  decorations: Decoration[]
  occluders: Occluder[]
}

// Re-export the occluder shape from the core so the generator and the existing
// sidecar/LOS pipeline share one definition.
export type {Occluder} from '../los-core'

// A sensible default deck: a ~28x28 cell grid at 36px/cell (~1000px square, the
// geomorph tile size), civilian, with a 2-cell corridor cross and 2-cell hull
// margin. The LLM steering layer will emit specs like this from a brief.
export const defaultSpec = (seed: number): MapSpec => ({
  seed,
  cols: 28,
  rows: 28,
  gridScale: 36,
  theme: 'civilian',
  minRoom: 3,
  maxRoom: 8,
  required: [],
  furnitureDensity: 0.7,
  corridorWidth: 2,
  hullMargin: 2
})
