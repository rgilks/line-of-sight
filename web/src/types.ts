import type {Occluder, Point} from './los-core'

export type Tool = 'viewer' | 'wall' | 'door' | 'erase' | 'token'

export type Tile = {
  id: string
  name: string
  image: HTMLImageElement
  url: string
  width: number
  height: number
}

export type Placement = {
  tile: Tile
  x: number
  y: number
}

// A GM-only room label for a generated deck, in board pixels. Drawn as a
// toggleable overlay on the board — never baked into the map image, so players
// (and the published map) never see it.
export type RoomLabel = {
  label: string
  x: number
  y: number
  w: number
  h: number
}

export type BoardSize = {
  width: number
  height: number
}

export type EditHandle = 'start' | 'end' | 'body'

export type EditDrag = {
  id: string
  handle: EditHandle
  pointerStart: Point
  original: Occluder
}

export type CounterKind =
  | 'amphibian'
  | 'engineer'
  | 'insectoid'
  | 'marine'
  | 'medic'
  | 'officer'
  | 'psion'
  | 'reptilian'
  | 'scout'
  | 'security'
  | 'scientist'
  | 'trader'

export type CounterDefinition = {
  kind: CounterKind
  name: string
  portrait: string
}

export type CounterGroupId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'

export type Token = Point & {
  id: string
  kind: CounterKind
  group: CounterGroupId
  member: number
  label: string
}

export type TokenDrag = {
  id: string
  pointerStart: Point
  original: Token
}

export type EditorSnapshot = {
  occluders: Occluder[]
  doorStates: Record<string, {open: boolean}>
  tokens: Token[]
  selectedOccluderId: string | null
  selectedTokenId: string | null
  povTokenId: string | null
}
