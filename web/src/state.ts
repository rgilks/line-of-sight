import {signal} from '@preact/signals'
import type {Occluder, Point} from '../../core/los'
import type {
  BoardSize,
  CounterDefinition,
  CounterGroupId,
  CounterKind,
  EditDrag,
  EditorSnapshot,
  Placement,
  RoomLabel,
  Tile,
  Token,
  TokenDrag,
  Tool
} from './types'
import {defaultSpec, type MapSpec} from './synth/types'

export const tool = signal<Tool>('viewer')
export const tiles = signal<Tile[]>([])
export const placements = signal<Placement[]>([])
export const occluders = signal<Occluder[]>([])
export const doorStates = signal<Record<string, {open: boolean}>>({})
export const boardSize = signal<BoardSize>({width: 1000, height: 1000})
export const zoom = signal(1)
export const showWalls = signal(false)
export const hideUnseen = signal(false)
export const gridValue = signal(50)
export const sightValue = signal(700)
export const columnsValue = signal(2)
export const runtimeStatus = signal('Loading line-of-sight tools...')
export const gpuStatus = signal('Checking...')
export const dragStart = signal<Point | null>(null)
export const previewPoint = signal<Point | null>(null)
export const editDrag = signal<EditDrag | null>(null)
export const selectedOccluderId = signal<string | null>(null)
export const hoveredOccluderId = signal<string | null>(null)
export const tokens = signal<Token[]>([])
export const activeCounterKind = signal<CounterKind>('officer')
export const activeCounterGroup = signal<CounterGroupId>('A')
export const tokenDrag = signal<TokenDrag | null>(null)
export const selectedTokenId = signal<string | null>(null)
export const hoveredTokenId = signal<string | null>(null)
export const povTokenId = signal<string | null>(null)
export const undoStack = signal<EditorSnapshot[]>([])
export const redoStack = signal<EditorSnapshot[]>([])
export const dropDepth = signal(0)
export const renderTick = signal(0)
export const drawerOpen = signal(true)
export const publishTableId = signal('demo')
export const tablePublished = signal(false)

// Synthetic map generation: the current spec the Generate controls edit, the
// GM-only room labels for the active generated deck, and whether they show.
export const genSpec = signal<MapSpec>(defaultSpec(1))
export const roomLabels = signal<RoomLabel[]>([])
export const showRoomLabels = signal(true)

// Live bindings for the mounted canvas/viewport, set once from App via setView.
// Exported `let` so every module reads the current value after the UI mounts.
export let canvas: HTMLCanvasElement
export let boardViewport: HTMLDivElement
export let ctx: CanvasRenderingContext2D

export const setView = (
  nextCanvas: HTMLCanvasElement,
  nextViewport: HTMLDivElement,
  nextCtx: CanvasRenderingContext2D
): void => {
  canvas = nextCanvas
  boardViewport = nextViewport
  ctx = nextCtx
}

export const minZoom = 0.35
export const maxZoom = 4
export const doorCarveTolerance = 8
export const minCarvedWallLength = 8
export const historyLimit = 60
export const counterDefinitions: CounterDefinition[] = [
  {kind: 'officer', name: 'Officer', portrait: '/token-portraits/officer.webp'},
  {kind: 'marine', name: 'Marine', portrait: '/token-portraits/marine.webp'},
  {kind: 'scout', name: 'Scout', portrait: '/token-portraits/scout.webp'},
  {kind: 'engineer', name: 'Engineer', portrait: '/token-portraits/engineer.webp'},
  {kind: 'medic', name: 'Medic', portrait: '/token-portraits/medic.webp'},
  {kind: 'scientist', name: 'Scientist', portrait: '/token-portraits/scientist.webp'},
  {kind: 'trader', name: 'Trader', portrait: '/token-portraits/trader.webp'},
  {kind: 'security', name: 'Security', portrait: '/token-portraits/security.webp'},
  {kind: 'reptilian', name: 'Reptilian', portrait: '/token-portraits/reptilian.webp'},
  {kind: 'amphibian', name: 'Amphibian', portrait: '/token-portraits/amphibian.webp'},
  {kind: 'insectoid', name: 'Insectoid', portrait: '/token-portraits/insectoid.webp'},
  {kind: 'psion', name: 'Psion', portrait: '/token-portraits/psion.webp'}
]
export const counterGroupLetters: CounterGroupId[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
export const counterPortraits = new Map<CounterKind, HTMLImageElement>()

export const exploredCanvas = document.createElement('canvas')
const exploredContext = exploredCanvas.getContext('2d')
if (!exploredContext) throw new Error('Offscreen canvas is required.')
export const exploredCtx = exploredContext

export const fogCanvas = document.createElement('canvas')
const fogContext = fogCanvas.getContext('2d')
if (!fogContext) throw new Error('Offscreen fog canvas is required.')
export const fogCtx = fogContext

export const gridScale = (): number => Math.max(10, gridValue.value || 50)
export const sightRadius = (): number => Math.max(50, sightValue.value || 700)
export const columns = (): number => Math.max(1, columnsValue.value || 1)
export const hasMap = (): boolean => placements.value.length > 0
export const screenPixels = (pixels: number): number => Math.max(0.5, pixels / zoom.value)

export const nextId = (prefix: string): string => `${prefix}-${crypto.randomUUID().slice(0, 8)}`

export const setStatus = (message: string): void => {
  runtimeStatus.value = message
}

export const requestCanvasRender = (): void => {
  renderTick.value += 1
}

export const preloadCounterPortraits = (): void => {
  if (counterPortraits.size > 0) return
  for (const definition of counterDefinitions) {
    const image = new Image()
    image.decoding = 'async'
    image.onload = requestCanvasRender
    image.src = definition.portrait
    counterPortraits.set(definition.kind, image)
  }
}
