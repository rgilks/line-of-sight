// Shared 3D dice overlay. Owns a single pinned-to-viewport DOM layer plus the
// Rust/wgpu dice engine (vendored from the cepheus workspace as a wasm-bindgen
// pkg), and — crucially — only ever reaches the heavy engine through a dynamic
// `import()`. So the wasm glue sits in NO page's initial bundle: it code-splits
// into its own chunk that loads lazily the first time the dice actually roll.
// Both the single-player game and the multiplayer table consume this module.
//
// The roller is physics-driven: `roll(count)` drops `count` dice and resolves to
// whatever faces settle (it is not pre-decided). Callers that need authority over
// the result read the returned `.faces` and feed them onward (solo's to-hit /
// damage rolls drive the reducer this way), or simply use it as a flourish next to
// an already-authoritative number (the table's server-rolled initiative).
import {parseDiceContacts, playDiceContact, setDiceRolling, stopDiceRolling} from './dice-audio'
import type {DiceRoller as WasmDiceRoller} from '../vendor/dice-engine/dice_engine.js'

// The settled result of a physical throw. `faces` is authoritative for callers
// that feed it onward (solo's reducer); flourish-only callers ignore it.
export type RollOutcome = {faces: number[]}

const MAX_DICE = 6
// A roll that never settles (tab hidden mid-throw, context lost) must not hang
// its caller: resolve with engine-independent random faces after this long.
const FALLBACK_MS = 6500
// Cap clacks per frame so a pile-up of contacts reads as a few dice, not a rattle.
const MAX_CLACKS_PER_FRAME = 4

// The scrollable board container we overlay, and the overlay element + roller. The
// roller is created lazily (the first showDice), so the dynamic import — and with
// it the wasm engine — only happens once the dice are first needed.
let host: HTMLElement | null = null
let overlay: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null
let roller: WasmDiceRoller | null = null
// In-flight (or settled) dynamic import of the dice module, started on first use
// and reused thereafter so the wasm loads at most once.
let loading: Promise<WasmDiceRoller> | null = null
let rafId = 0
let pendingRoll: {
  count: number
  resolve: (outcome: RollOutcome) => void
  fallbackId: ReturnType<typeof setTimeout>
} | null = null

// Pin the overlay over the *visible* viewport. The board container is scrollable
// (zoom/pan), so a plain inset:0 layer would scroll away with the content; offset
// it by the current scroll so the dice always land centred on screen, same size,
// at any zoom/pan.
const positionOverlay = (): void => {
  if (!host || !overlay) return
  overlay.style.left = `${host.scrollLeft}px`
  overlay.style.top = `${host.scrollTop}px`
  overlay.style.width = `${host.clientWidth}px`
  overlay.style.height = `${host.clientHeight}px`
  resizeCanvas()
}

// Backing-store scale: the device ratio plus a 1.5x supersample (the dice are
// small on screen, so extra pixels per die visibly smooth pip and edge detail
// beyond what MSAA alone gives). Capped to keep the canvas cheap.
const backingScale = (): number => Math.min(3, Math.min(window.devicePixelRatio || 1, 2) * 1.5)

const resizeCanvas = (): void => {
  if (!overlay || !canvas) return
  const width = overlay.clientWidth || 1
  const height = overlay.clientHeight || 1
  const scale = backingScale()
  const nextWidth = Math.max(1, Math.floor(width * scale))
  const nextHeight = Math.max(1, Math.floor(height * scale))
  if (canvas.width === nextWidth && canvas.height === nextHeight) return
  canvas.width = nextWidth
  canvas.height = nextHeight
  roller?.resize(nextWidth, nextHeight)
}

// Create the overlay layer inside `container` once. Styled inline so the module is
// self-contained (no page CSS needed): an absolutely-positioned dark, slightly
// blurred panel that sits above the board canvas.
const ensureOverlay = (container: HTMLElement): HTMLDivElement => {
  if (overlay && host === container) return overlay
  // Re-targeting a different container (or first mount): drop any old layer.
  if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay)
  host = container
  overlay = document.createElement('div')
  overlay.className = 'dice-overlay'
  overlay.style.position = 'absolute'
  overlay.style.top = '0'
  overlay.style.left = '0'
  overlay.style.display = 'none'
  overlay.style.zIndex = '5'
  overlay.style.pointerEvents = 'none'
  overlay.style.background = 'rgba(0, 0, 0, 0.6)'
  overlay.style.backdropFilter = 'blur(1px)'
  if (canvas) overlay.appendChild(canvas)
  container.appendChild(overlay)
  return overlay
}

const randomFaces = (count: number): number[] => Array.from({length: count}, () => Math.floor(Math.random() * 6) + 1)

const finishRoll = (faces: number[]): void => {
  if (!pendingRoll) return
  clearTimeout(pendingRoll.fallbackId)
  const roll = pendingRoll
  pendingRoll = null
  roll.resolve({faces})
}

// Per-frame pump: advance the physics, voice the contacts, and resolve the
// pending roll once every die is at rest. Runs for the roller's lifetime — the
// engine steps nothing new when idle, so the idle cost is negligible.
const tick = (): void => {
  if (roller) {
    try {
      roller.render()
    } catch {
      // Canvas teardown or device loss should not keep the overlay alive.
    }

    if (pendingRoll && !roller.is_settled()) {
      const contacts = parseDiceContacts(roller.take_impacts())
      if (contacts.length > 0) {
        contacts.sort((a, b) => b.vel - a.vel)
        for (const contact of contacts.slice(0, MAX_CLACKS_PER_FRAME)) playDiceContact(contact)
      }
      setDiceRolling(roller.rolling_energy())
    } else {
      stopDiceRolling()
    }

    if (pendingRoll && roller.is_settled()) {
      const faces = Array.from(roller.values()).slice(0, pendingRoll.count)
      if (faces.length === pendingRoll.count && faces.every((face) => face >= 1)) {
        finishRoll(faces)
      }
    }
  }
  rafId = requestAnimationFrame(tick)
}

// Lazily import the dice module and build the roller into the overlay. The dynamic
// `import()` is the ONLY runtime reference to the wasm engine in the app, so
// bundlers split the engine into a chunk (plus the .wasm asset) fetched only here.
const ensureRoller = async (): Promise<WasmDiceRoller> => {
  if (roller) return roller
  if (!loading) {
    loading = import('../vendor/dice-engine/dice_engine.js')
      .then(async (engine) => {
        await engine.default()
        const target = overlay ?? ensureOverlay(host ?? document.body)
        canvas = document.createElement('canvas')
        canvas.style.width = '100%'
        canvas.style.height = '100%'
        canvas.style.display = 'block'
        target.appendChild(canvas)
        // Transparent canvas: the dice render spotlit over the dimmed board (the
        // overlay's own dark layer), keeping the old 'void' look.
        roller = await engine.create_dice_roller(canvas, MAX_DICE, 0, 0, 0, true)
        resizeCanvas()
        // Warm the audio graph: the AudioContext starts suspended, and a first
        // roll against a suspended context swallows its opening clacks.
        setDiceRolling(0)
        if (!rafId) rafId = requestAnimationFrame(tick)
        return roller
      })
      .catch((error) => {
        // A failed import (e.g. offline before the chunk cached) must not poison
        // future rolls — clear the cached promise so a later attempt retries.
        loading = null
        throw error
      })
  }
  return loading
}

// Show the dice layer pinned over `container`'s visible viewport and kick off the
// (idempotent) lazy load of the roller. Safe to call before the wasm has loaded —
// the layer appears immediately; rollDice awaits the roller.
export const showDice = (container: HTMLElement): void => {
  const layer = ensureOverlay(container)
  positionOverlay()
  layer.style.display = 'block'
  void ensureRoller().then(() => resizeCanvas())
}

// Hide the dice layer. The roller and its GPU context are kept for reuse, so a
// later roll is instant (no second wasm init, no context churn).
export const hideDice = (): void => {
  if (overlay) overlay.style.display = 'none'
  stopDiceRolling()
}

// True while the dice layer is shown — callers that hold a follow-camera still use
// this to freeze it so the dice don't drift.
export const diceVisible = (): boolean => overlay?.style.display === 'block'

// Roll `targetFaces.length` physical dice and resolve to the settled outcome. The
// simulation is not pre-decided, so the returned `.faces` are the authoritative
// result of the throw: solo feeds them into its reducer (the on-screen dice ARE
// the to-hit / damage that gets applied), while the table uses the throw purely as
// a flourish beside the server's already-rolled number. `targetFaces` therefore
// names how many dice to roll (one per face); its values are advisory only.
export const rollDice = async (targetFaces: number[]): Promise<RollOutcome> => {
  const r = await ensureRoller()
  positionOverlay()
  const count = Math.max(1, Math.min(MAX_DICE, targetFaces.length))
  // A stacked second roll supersedes the first: settle the old one randomly so
  // its caller resolves, then throw fresh.
  if (pendingRoll) finishRoll(randomFaces(pendingRoll.count))
  return new Promise((resolve) => {
    const fallbackId = setTimeout(() => finishRoll(randomFaces(count)), FALLBACK_MS)
    pendingRoll = {count, resolve, fallbackId}
    r.roll(count)
  })
}
