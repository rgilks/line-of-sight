// Synthetic map generation — shared types. Pure data, no DOM/Cloudflare.
//
// MapSpec is the "brief": the structured description an LLM would emit from a
// natural-language adventure idea ("a derelict mining vessel with a flooded
// cargo deck and a sealed bridge"), or that a human sets directly. The generator
// is a deterministic function of (spec) — same spec ⇒ same map — so the LLM
// steers WHAT to make while the generator owns HOW, and works with the LLM off.
import type {Occluder} from '../los-core'

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

export type Theme = 'civilian' | 'military' | 'industrial' | 'derelict'

export type MapSpec = {
  seed: number
  cols: number // deck width in grid cells
  rows: number // deck height in grid cells
  gridScale: number // pixels per cell
  theme: Theme
  minRoom: number // smallest room edge, in cells
  maxRoom: number // BSP stops subdividing around this size, in cells
  required: RoomType[] // room types the author specifically wants present
  furnitureDensity: number // 0..1, how full rooms are
}

export type Room = {
  id: string
  type: RoomType
  x: number // cell coordinates (origin top-left)
  y: number
  w: number
  h: number
  label: string
}

// A furniture/fixture item — decorative only (NOT an occluder), matching the
// geomorph convention that furniture does not block line of sight. All in pixels.
export type Decoration = {
  kind: string // renderer switch: 'bunk' | 'console' | 'crate' | 'bed' | ...
  x: number
  y: number
  w: number
  h: number
}

export type GeneratedMap = {
  spec: MapSpec
  width: number // pixels
  height: number
  gridScale: number
  rooms: Room[]
  decorations: Decoration[]
  occluders: Occluder[] // walls + doors — the line-of-sight source of truth
}

export const defaultSpec = (seed: number): MapSpec => ({
  seed,
  cols: 20,
  rows: 20,
  gridScale: 50,
  theme: 'civilian',
  minRoom: 3,
  maxRoom: 7,
  required: [],
  furnitureDensity: 0.7
})
