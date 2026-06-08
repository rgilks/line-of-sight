// Shared 3D dice overlay. Owns a single pinned-to-viewport DOM layer plus the
// three.js dice roller, and — crucially — only ever reaches the heavy
// `@rgilks/cepheus-dice` (three.js + cannon-es) through a dynamic `import()`. So
// three.js sits in NO page's initial bundle: it code-splits into its own chunk
// that loads lazily the first time the dice actually roll. Both the single-player
// game and the multiplayer table consume this module.
//
// The roller is physics-driven: `roll(count)` drops `count` dice and resolves to
// whatever faces settle (it is not pre-decided). Callers that need authority over
// the result read the returned `.faces` and feed them onward (solo's to-hit /
// damage rolls drive the reducer this way), or simply use it as a flourish next to
// an already-authoritative number (the table's server-rolled initiative).
import type {DiceRoller, RollOutcome} from '@rgilks/cepheus-dice'

// Solo's established dice look, kept identical here: warm bone bodies with dark
// pips, the GLTF model, and the 'void' preset (dice spotlit out of a dimmed board
// rather than the green tray box). The overlay dims the board behind the dice.
const DICE_OPTIONS = {
  colors: {body: '#ecd5bb', pip: '#222222'},
  modelUrl: '/gltf/dice.gltf',
  // 'void': dice spotlit over the dimmed board, not the green tray box.
  lighting: 'void' as const
}

// The scrollable board container we overlay, and the overlay element + roller. The
// roller is created lazily (the first showDice), so the dynamic import — and with
// it three.js — only happens once the dice are first needed.
let host: HTMLElement | null = null
let overlay: HTMLDivElement | null = null
let roller: DiceRoller | null = null
// In-flight (or settled) dynamic import of the dice module, started on first use
// and reused thereafter so three.js loads at most once.
let loading: Promise<DiceRoller> | null = null

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
  container.appendChild(overlay)
  return overlay
}

// Lazily import the dice module and build the roller into the overlay. The dynamic
// `import()` is the ONLY runtime reference to '@rgilks/cepheus-dice' in the app, so
// bundlers split three.js into a chunk fetched only here.
const ensureRoller = async (): Promise<DiceRoller> => {
  if (roller) return roller
  if (!loading) {
    loading = import('@rgilks/cepheus-dice')
      .then(({createDiceRoller}) => {
        const target = overlay ?? ensureOverlay(host ?? document.body)
        roller = createDiceRoller(target, DICE_OPTIONS)
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
// (idempotent) lazy load of the roller. Safe to call before three.js has loaded —
// the layer appears immediately; rollDice awaits the roller.
export const showDice = (container: HTMLElement): void => {
  const layer = ensureOverlay(container)
  positionOverlay()
  layer.style.display = 'block'
  void ensureRoller().then((r) => r.resize())
}

// Hide the dice layer. The roller and its WebGL context are kept for reuse, so a
// later roll is instant (no second three.js parse, no context churn).
export const hideDice = (): void => {
  if (overlay) overlay.style.display = 'none'
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
  return r.roll(Math.max(1, targetFaces.length))
}
