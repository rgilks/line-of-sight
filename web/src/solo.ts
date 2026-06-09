import './sentry'
import {renderMap} from './synth/render-map'
import {counterTokenSize, drawCounterToken} from './counter-render'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import {
  distanceToOccluder,
  doorReachForGrid,
  hasLineOfSight,
  visibilityPolygon,
  type DoorOccluder,
  type Point
} from '../../core/los'
import {pointInPolygon} from '../../core/rules'
import {ARMORS, weaponById} from './solo/gear'
import {parseDamage, predictAttack, rangeBandFor} from './solo/combat'
import {decideMonster} from './solo/ai'
import {buildWave} from './solo/setup'
// The 3D dice live in a shared module that dynamic-import()s three.js on first
// roll, so it is NOT in this page's initial bundle (the solo chunk stays light).
import {diceVisible, hideDice, rollDice, showDice} from './dice-overlay'
import {
  activeEntity,
  canSeePoint,
  entityById,
  isActive,
  isDead,
  isDown,
  AIM_MAX,
  MINOR_ACTIONS_PER_ROUND,
  moveBudgetPx,
  SIGNIFICANT_ACTION_COST,
  STANCES,
  stanceLabel,
  keyLabel,
  withinReach,
  type CombatStance,
  type Container,
  type DoorLock,
  type Entity,
  type GroundItem,
  type SoloState
} from './solo/model'
import {cellCenter, cellOf, isFloor} from './solo/grid'
import {foldSolo, reduce, type SoloEvent} from './solo/reducer'
import {LocalRoom} from './room/local-room'
import {RemoteRoom} from './room/remote-room'
import type {Room, SubmitResult} from './room/room'
import {
  clearEffects,
  drawEffects,
  effectsActive,
  playUi,
  primeAudio,
  setFxTimeScale,
  spawnAttackFx,
  spawnDenied,
  spawnHint
} from './solo/fx'
import type {AttackFx} from './solo/model'
import {createTweenLoop} from './viewport'
import {installErrorReporting} from './error-reporting'
import {registerServiceWorker} from './register-sw'
import './solo.css'

// Surface uncaught errors / rejections in the console (see error-reporting.ts).
installErrorReporting('solo')
// Install as an offline PWA: the SW precaches the shell + the 3D-dice chunk, so
// after a first online visit the whole game loads and plays with no network.
registerServiceWorker()

// ---- movement animation (tween) ------------------------------------------
// Mirrors the multiplayer client's ease so glides feel identical. The shared
// tween/rAF core lives in viewport.ts; here we wire in solo's per-frame work
// (follow-camera + dice-overlay hold + draw).
const MOVE_EASE_MS = 320
let busy = false // true while the monster AI is taking its turns (locks player input)

// Per-frame work for the rAF loop. Returns whether to keep ticking beyond the
// tween: while the camera is gliding or effects are still animating.
const onFrame = (t: number, moving: boolean): boolean => {
  // Follow the active token as it glides (the camera keeps it framed with the
  // nearest enemy). Skip while the dice overlay is up so it doesn't drift.
  if (moving && state && !diceVisible()) {
    const actor = activeEntity(state)
    if (actor && anim.has(actor.id)) focusOnActive()
  }
  const camMoving = stepCamera()
  draw()
  return effectsActive(t) || camMoving
}

const {renderPos, anim, startEase, waitTween, ensureRaf, requestDraw} = createTweenLoop({
  easeMs: MOVE_EASE_MS,
  onFrame
})

const positionOf = (entity: Entity): Point => renderPos.get(entity.id) ?? {x: entity.x, y: entity.y}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

preloadCounterPortraits()
for (const image of counterPortraits.values()) image.addEventListener('load', requestDraw)

let state: SoloState | null = null
let showGrid = false
let logExpanded = false // combat log: two lines by default, expandable
let selectedId: string | null = null // the entity the player has tapped (target / patient)
// Desired scroll the camera eases toward (null = at rest / user-controlled). Set by
// focusOnActive; stepped in the rAF loop so switching characters pans, not snaps.
let camAnim: {left: number; top: number} | null = null
// A tap on open floor is held briefly so a quick second tap reads as a double-tap
// (→ end turn) instead of a move. null = nothing pending.
let pendingMove: {to: Point; timer: ReturnType<typeof setTimeout>} | null = null
const cancelPendingMove = (): void => {
  if (pendingMove) {
    clearTimeout(pendingMove.timer)
    pendingMove = null
  }
}
let reachable: Array<{cx: number; cy: number}> = [] // cells the active PC can move to (recomputed per action)

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let panel: HTMLDivElement
let boardViewport: HTMLDivElement
let endFab: HTMLButtonElement | null = null // floating End-Turn button over the board

// An rng that yields the given die faces first (mapped to rollD6 buckets), then
// falls back to Math.random — so a visual roll's faces drive the to-hit throw.
const queuedFaces =
  (faces: number[]): (() => number) =>
  () => {
    const next = faces.shift()
    return next === undefined ? Math.random() : (next - 0.5) / 6
  }

// Camera: the canvas backing store stays at map resolution; we zoom by sizing its
// display box (map × zoom) inside a scrollable viewport and pan via scroll. Click
// mapping reads the rendered rect, so it stays correct at any zoom.
let zoom = 1
const MIN_ZOOM = 0.15
const MAX_ZOOM = 5
// A trackpad/mouse press on the board. A plain left press is a tentative tap
// (acts on release) until it moves past TAP_SLOP, at which point it becomes a pan
// — so a macOS three-finger drag (which the OS delivers as a left-button drag)
// pans the view. Middle/right or ⌘/Ctrl-left pan from the start.
let boardDrag: {
  id: number
  startX: number
  startY: number
  scrollLeft: number
  scrollTop: number
  panning: boolean
  tap: boolean
} | null = null
let touchPan: {x: number; y: number; scrollLeft: number; scrollTop: number} | null = null
let pinch: {startDist: number; startZoom: number; boardX: number; boardY: number} | null = null
let touchMoved = false

// ---- offscreen fog layers (sized per map) --------------------------------
const explored = document.createElement('canvas')
const exploredCtx = explored.getContext('2d') as CanvasRenderingContext2D
const cur = document.createElement('canvas')
const curCtx = cur.getContext('2d') as CanvasRenderingContext2D
const scratch = document.createElement('canvas')
const scratchCtx = scratch.getContext('2d') as CanvasRenderingContext2D

const sizeFogLayers = (w: number, h: number): void => {
  for (const layer of [explored, cur, scratch]) {
    layer.width = w
    layer.height = h
  }
  exploredCtx.clearRect(0, 0, w, h)
}

// ---- new game + offline persistence ---------------------------------------
// The in-memory event log (the same SoloEvents the server stores), persisted to
// IndexedDB so closing the tab and reopening resumes the exact game. There is one
// solo game per browser, so a single fixed id suffices.
// ---- the Room: one engine backing this view (offline now, server later) ----
// solo.ts is a view over a Room. A LocalRoom runs the event-sourced engine in the
// browser and persists to IndexedDB; the SAME interface becomes a RemoteRoom (the
// server) later. `state` here is the DISPLAY state — folded from the Room's event
// batches one event at a time so the monster glide animates — and it catches up to
// the Room's authoritative state at the end of each batch (input is locked then).
const GAME_ID = 'current'
let room: Room | null = null

// Multiplayer helpers. Offline solo has no seat (mySeat undefined) and the local
// player commands whichever piece is active — so every multiplayer guard below is a
// provable no-op offline and the solo path is unchanged.
const mySeat = (): string | undefined => room?.mySeat()
// Is it my turn to act — the active entity a living PC that I own (or any PC offline)?
const myTurn = (): boolean => {
  const active = state ? activeEntity(state) : undefined
  if (!active || active.faction !== 'pc') return false
  const seat = mySeat()
  return seat === undefined || active.owner === seat
}

// A friendly label for a seat: "You" for mine, "P1"/"P2"/… (by join order) for the
// others. Empty when there is no seat (offline). Drives the ownership chips + the
// "whose turn" banner so it is clear which pieces are yours.
const seatLabel = (seatId: string | undefined): string => {
  if (!seatId || !state) return ''
  if (seatId === mySeat()) return 'You'
  const order = [...state.seats].sort((a, b) => a.joinedAt - b.joinedAt).findIndex((s) => s.id === seatId)
  return order >= 0 ? `P${order + 1}` : 'P?'
}

// Install an authoritative state into the view: reset selection/animation, size
// the canvas + fog, and frame the squad.
const installState = (next: SoloState): void => {
  selectedId = null
  busy = false
  state = next
  renderPos.clear()
  anim.clear()
  clearEffects()
  for (const entity of next.entities) renderPos.set(entity.id, {x: entity.x, y: entity.y})
  canvas.width = next.map.width
  canvas.height = next.map.height
  sizeFogLayers(next.map.width, next.map.height)
  focusOnSquad()
  focusOnActive(false) // initial framing snaps; turn changes pan
  renderPanel()
  requestDraw()
}

// Fold + animate one batch of engine events into the display state, preserving the
// per-move monster glide and weapon effects. Player attacks own their dice + fx
// sequence in onAttack, so this fires the auto-fx only for monster attackers.
const playEvents = async (batch: SoloEvent[]): Promise<void> => {
  // Online, batches arrive asynchronously over the wire (not from an awaited
  // submit), so the pump itself locks input while it animates and unlocks only when
  // control returns to me. Offline (no seat) busy is managed by the call sites, as
  // before — so this is a no-op for solo.
  const remote = mySeat() !== undefined
  if (remote) {
    busy = true
    renderPanel()
  }
  try {
    // The first TurnAdvanced in a batch is the player's own end-of-turn handoff —
    // ease the camera to the next character (busy is true here, so focusOnActive's
    // default would snap). Subsequent advances are the monsters' turns: snap those
    // to keep the horde fast, matching the old runMonsters feel.
    let firstAdvance = true
    for (const event of batch) {
      if (!state) return
      const before = new Map(state.entities.map((entity) => [entity.id, {x: entity.x, y: entity.y}]))
      const wasLost = state.phase.t === 'lost'
      const prevFx = state.lastAttack
      state = foldSolo(state, event)
      for (const entity of state.entities) {
        const old = before.get(entity.id)
        if (old && (old.x !== entity.x || old.y !== entity.y)) {
          startEase(entity.id, renderPos.get(entity.id) ?? old, {x: entity.x, y: entity.y})
        }
      }
      if (!wasLost && state.phase.t === 'lost') playUi('lose')
      if (event.t === 'TurnAdvanced') {
        focusOnActive(firstAdvance)
        firstAdvance = false
      } else if (event.t === 'WaveAdded') {
        focusOnActive(false)
        playUi('wave')
      } else if (event.t === 'Won') {
        playUi('win')
      }
      renderPanel()
      requestDraw()
      // Pace by event type, matching the old runMonsters/onAttack feel: glide each
      // monster move, and play a monster attack's effect with its impact delay.
      if (event.t === 'Moved') {
        if (entityById(state, event.actorId)?.faction === 'monster') await waitTween(event.actorId)
      } else if (event.t === 'Attacked') {
        if (entityById(state, event.attackerId)?.faction === 'monster') {
          await delay(fireAttackFx(prevFx) ? 560 : 220)
        } else if (remote) {
          // Online, a PC attack's own fx plays here (onAttack skipped it server-side).
          await delay(fireAttackFx(prevFx) ? 720 : 0)
        }
      }
    }
  } finally {
    if (remote) {
      busy = !myTurn() // unlock only when it's my piece's turn again
      renderPanel()
      requestDraw()
    }
  }
}

// Issue a player command for the active character through the Room. byActor is the
// active PC (the local player owns every piece), so the engine's authority gate
// always passes; the optional rng carries solo's on-screen 3D-dice faces. Returns
// the submit result so callers can show denial feedback on a rejected command.
const submitCommand = (action: Parameters<typeof reduce>[1], rng?: () => number): Promise<SubmitResult> => {
  if (!room || !state) return Promise.resolve({events: [], rejected: null})
  const active = activeEntity(state)
  if (!active) return Promise.resolve({events: [], rejected: null})
  // Online, lock input optimistically until the server's events arrive (the pump
  // unlocks). The Room stamps byPlayer (the seat) itself, so the view stays
  // seat-agnostic. Offline this is a no-op.
  if (mySeat() !== undefined) {
    busy = true
    renderPanel()
  }
  return room.submit({byActor: active.id, action}, rng)
}

// Point the view at a Room: subscribe the animation pump, show its current state,
// and — if it resumed mid-horde-turn — finish the monster turns.
const useRoom = async (next: Room): Promise<void> => {
  room?.close()
  room = next
  room.subscribe(playEvents)
  installState(room.getState())
  if (next instanceof LocalRoom && activeEntity(next.getState())?.faction === 'monster') {
    busy = true
    renderPanel()
    try {
      await next.resumeIdleAi()
    } finally {
      busy = false
      renderPanel()
      requestDraw()
    }
  }
}

// Start a brand-new game ("New deck"), discarding saved progress.
const newGame = async (): Promise<void> => {
  await useRoom(await LocalRoom.fresh(GAME_ID))
}

// Boot: resume a saved game when it matches the requested seed (or none was asked
// for), else start fresh. Async because IndexedDB is async — the canvas is already
// mounted, so there is at most a brief blank before first paint.
const bootGame = async (requestedSeed?: number): Promise<void> => {
  await useRoom(await LocalRoom.open(GAME_ID, requestedSeed))
}

// Join a live multiplayer room over a RemoteRoom (claims a seat, pieces
// redistribute). On failure (room gone / offline) fall back to a solo game.
const joinRoom = async (roomId: string, seed?: number): Promise<void> => {
  try {
    await useRoom(await RemoteRoom.open(roomId, seed))
    void showInvite(roomId)
  } catch {
    await bootGame(seed)
  }
}

// "Play with friends": promote the offline game online — hand the local
// (seed + event log) to a fresh server room, reconnect as a player (claiming the
// first seat, so we still own every piece), and show the invite link/QR.
const promote = async (): Promise<void> => {
  if (busy || !(room instanceof LocalRoom)) return
  const roomId = crypto.randomUUID().slice(0, 8)
  const {seed, events} = room.exportLog()
  try {
    const res = await fetch(`/api/solo/${roomId}/import`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({seed, events})
    })
    if (!res.ok && res.status !== 409) return // import failed; stay offline
  } catch {
    return
  }
  history.replaceState(null, '', `?table=${encodeURIComponent(roomId)}`)
  await useRoom(await RemoteRoom.open(roomId))
  void showInvite(roomId)
}

// A floating join panel (link + QR) shown once a game is live online.
let invitePanel: HTMLElement | null = null
const showInvite = async (roomId: string): Promise<void> => {
  if (invitePanel) return
  const joinUrl = `${location.origin}/solo?table=${encodeURIComponent(roomId)}`
  const panel = document.createElement('aside')
  panel.className = 'solo-invite'
  panel.style.cssText =
    'position:absolute;top:12px;right:12px;z-index:6;display:flex;flex-direction:column;align-items:center;gap:6px;' +
    'padding:12px;border-radius:10px;background:rgba(8,11,10,0.86);border:1px solid #1c3a2e;color:#cfe;font:12px var(--font-ui,monospace);max-width:200px;text-align:center'
  // The QR is black modules — it needs a white backdrop and an explicit size, or it
  // is invisible on the dark panel.
  panel.innerHTML =
    '<span style="letter-spacing:1px;color:#7ad19a">SCAN TO JOIN</span>' +
    '<div class="solo-invite-qr" aria-hidden="true" style="width:148px;height:148px;background:#fff;border-radius:4px;padding:6px;box-sizing:border-box;display:flex;align-items:center;justify-content:center"></div>' +
    `<code style="word-break:break-all;color:#9fb">${joinUrl}</code>`
  document.querySelector('.solo-shell')?.appendChild(panel)
  invitePanel = panel
  try {
    const {default: qrcode} = await import('qrcode-generator')
    const qr = qrcode(0, 'M')
    qr.addData(joinUrl)
    qr.make()
    const slot = panel.querySelector('.solo-invite-qr')
    if (slot) slot.innerHTML = qr.createSvgTag({cellSize: 4, margin: 1, scalable: true})
  } catch {
    /* the printed URL is the fallback */
  }
}

// A player action during their own turn (movement, an action, a door, a push).
// The Room folds + animates the produced events through the subscribed pump; the
// fold runs synchronously, so movement stays responsive (no await here).
const playerAct = (action: Parameters<typeof reduce>[1]): void => {
  if (busy || !state || state.phase.t !== 'playerTurn' || !myTurn()) return
  void submitCommand(action)
}

// If the just-dispatched action resolved a fresh attack (a new lastAttack object),
// play its weapon sound + projectile/strike + impact effect. Returns whether it fired.
const fireAttackFx = (prev: AttackFx | undefined): boolean => {
  const fa = state?.lastAttack
  if (!state || !fa || fa === prev) return false
  const attacker = entityById(state, fa.attackerId)
  const target = entityById(state, fa.targetId)
  if (!attacker || !target) return false
  spawnAttackFx({
    from: positionOf(attacker),
    to: positionOf(target),
    weapon: weaponById(fa.weaponId),
    hit: fa.hit,
    effect: fa.effect,
    damage: fa.damage,
    killed: fa.killed,
    targetFaction: target.faction,
    gridScale: state.map.gridScale
  })
  requestDraw()
  return true
}

// An attack: roll the 3D dice, resolve the to-hit with the settled faces, then —
// once the dice clear — fire the weapon (sound + tracer/strike + impact burst).
const onAttack = async (targetId: string): Promise<void> => {
  if (busy || !state || state.phase.t !== 'playerTurn' || !myTurn()) return
  const actor = activeEntity(state)
  const target = entityById(state, targetId)
  if (!actor || !target || !canAttackTarget(target)) return // also gates range / LOS / ammo / action budget
  // Online the server rolls the dice (authority); skip the local 3D dice and just
  // submit — the pump animates the weapon fx when the server's events arrive.
  if (mySeat() !== undefined) {
    void submitCommand({t: 'Attack', targetId})
    return
  }
  const gridScale = state.grid.gridScale
  busy = true
  renderPanel()
  const prevFx = state.lastAttack
  // The 3D dice are a flourish over an authoritative throw, never a gate. Roll them
  // when they load; if they can't (e.g. offline before the chunk was cached), fall
  // back to a no-dice attack so the turn still resolves. try/finally guarantees
  // `busy` is always cleared — a thrown roll must never freeze the game.
  try {
    let faces: number[] | null = null
    try {
      // First roll lazy-loads three.js (showDice kicks the dynamic import); the
      // layer appears immediately and rollDice awaits the roller.
      showDice(boardViewport)
      // First roll: the 2D6 to-hit (shown). The settled faces are authoritative —
      // they feed the reducer below, so the dice on screen ARE the resolved to-hit.
      const toHit = await rollDice([1, 1])
      faces = [...toHit.faces]
      // On a hit, roll and SHOW the weapon's damage dice; their settled faces feed
      // the reducer's damage roll, so the dice on screen are the damage applied
      // (plus the weapon's flat modifier and the Effect).
      const pred = predictAttack(actor, target, gridScale, faces[0] ?? 1, faces[1] ?? 1)
      if (pred.hit) {
        const dmgDice = parseDamage(weaponById(actor.weaponId).damage).count
        await delay(220)
        const damage = await rollDice(new Array(dmgDice).fill(1))
        faces.push(...damage.faces)
      }
    } catch {
      faces = null // dice unavailable — resolve the attack with the engine's own rng
    }
    // With faces: the on-screen dice drive the throw. Without: the engine rolls.
    // The Room folds the Attacked event (the pump skips auto-fx for PC attackers),
    // so after this resolves state.lastAttack holds the result for the fx below.
    await submitCommand({t: 'Attack', targetId}, faces ? queuedFaces(faces) : undefined)
    if (faces) await delay(520)
    hideDice()
    if (fireAttackFx(prevFx)) await delay(720)
  } finally {
    busy = false
    renderPanel()
    requestDraw()
  }
}

// Can the active character attack `target` right now — their turn, their own line
// of sight, in range, with ammo? Mirrors the panel's Attack-button gate, so the
// quick-attack gestures (double-click / F) only fire on a real shot.
const canAttackTarget = (target: Entity): boolean => {
  if (busy || !state || state.phase.t !== 'playerTurn') return false
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc' || !isActive(actor) || state.actionUsed) return false
  if (state.moveRemainingPx + 0.5 < SIGNIFICANT_ACTION_COST * moveBudgetPx(state.grid.gridScale, actor.moveMeters))
    return false
  if (target.faction !== 'monster' || isDead(target) || !canSeePoint(state, actor, target.x, target.y)) return false
  const weapon = weaponById(actor.weaponId)
  if (
    weapon.rangeDm[rangeBandFor(Math.hypot(actor.x - target.x, actor.y - target.y), state.grid.gridScale)] === undefined
  ) {
    return false
  }
  return weapon.magazine === undefined || actor.loadedRounds > 0
}

// End the player's turn. The engine runs the monster AI (and any wave upkeep) to
// completion inside the same command; the pump animates the resulting events while
// input is locked, then returns control to the player.
const endTurn = async (): Promise<void> => {
  if (busy || !state || state.phase.t !== 'playerTurn' || !myTurn()) return
  cancelPendingMove()
  playUi('endTurn')
  // Online: submitCommand locks input; the pump unlocks when control returns.
  if (mySeat() !== undefined) {
    void submitCommand({t: 'EndTurn'})
    return
  }
  // Offline: lock, await the synchronous AI animation, then unlock.
  busy = true
  renderPanel()
  try {
    await submitCommand({t: 'EndTurn'})
  } finally {
    busy = false
    renderPanel()
    requestDraw()
  }
}

// The floating End-Turn button shows only while it's the player's turn to act.
const updateEndFab = (): void => {
  if (!endFab) return
  endFab.hidden = !(!!state && state.phase.t === 'playerTurn' && !busy)
}

// Keyboard: Space / Enter end the turn (no trip to the side panel); Esc clears
// the current target. Ignored while typing in a field.
const onKey = (event: KeyboardEvent): void => {
  const el = event.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault()
    endTurn()
  } else if (event.key === 'f' || event.key === 'F') {
    // Fire at the current target.
    const target = state && selectedId ? entityById(state, selectedId) : undefined
    if (target && canAttackTarget(target)) {
      event.preventDefault()
      void onAttack(target.id)
    }
  } else if (event.key === 'Escape' && selectedId) {
    selectedId = null
    renderPanel()
    requestDraw()
  }
}

// ---- camera: zoom (wheel / pinch) + pan (drag / scroll) -------------------
const updateCanvasDisplaySize = (): void => {
  if (!state) return
  canvas.style.width = `${state.map.width * zoom}px`
  canvas.style.height = `${state.map.height * zoom}px`
}

const fitBoardToViewport = (): void => {
  if (!state || !boardViewport) return
  const pad = 24
  const availWidth = boardViewport.clientWidth - pad
  const availHeight = boardViewport.clientHeight - pad
  if (availWidth <= 0 || availHeight <= 0) return
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availWidth / state.map.width, availHeight / state.map.height)))
  updateCanvasDisplaySize()
  boardViewport.scrollLeft = 0
  boardViewport.scrollTop = 0
}

// Open zoomed in on the squad: frame the PCs' bounding box plus a few squares of
// breathing room, and centre the view on them. Falls back to a full-map fit if
// the viewport isn't laid out yet or there are no PCs.
const focusOnSquad = (): void => {
  if (!state || !boardViewport) return
  const pcs = state.entities.filter((e) => e.faction === 'pc')
  const availW = boardViewport.clientWidth
  const availH = boardViewport.clientHeight
  if (pcs.length === 0 || availW <= 0 || availH <= 0) {
    fitBoardToViewport()
    return
  }
  const pad = state.map.gridScale * 3.5 // ~3.5 squares of space around the squad
  const minX = Math.min(...pcs.map((p) => p.x)) - pad
  const maxX = Math.max(...pcs.map((p) => p.x)) + pad
  const minY = Math.min(...pcs.map((p) => p.y)) - pad
  const maxY = Math.max(...pcs.map((p) => p.y)) + pad
  const boxW = Math.max(1, maxX - minX)
  const boxH = Math.max(1, maxY - minY)
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availW / boxW, availH / boxH)))
  updateCanvasDisplaySize()
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  boardViewport.scrollLeft = cx * zoom - availW / 2
  boardViewport.scrollTop = cy * zoom - availH / 2
}

// Apply a desired scroll: eased over a few frames when `animate` (so switching
// characters pans across), or snapped instantly (initial framing, zoom, drag).
const aimCamera = (left: number, top: number, animate: boolean): void => {
  if (!state || !boardViewport) return
  const maxLeft = Math.max(0, state.map.width * zoom - boardViewport.clientWidth)
  const maxTop = Math.max(0, state.map.height * zoom - boardViewport.clientHeight)
  const L = Math.min(maxLeft, Math.max(0, left))
  const T = Math.min(maxTop, Math.max(0, top))
  if (animate) {
    camAnim = {left: L, top: T}
    ensureRaf()
  } else {
    camAnim = null
    boardViewport.scrollLeft = L
    boardViewport.scrollTop = T
  }
}

// Ease the viewport toward camAnim; returns true while still travelling.
const CAM_EASE = 0.2
const stepCamera = (): boolean => {
  if (!camAnim || !boardViewport) return false
  const dl = camAnim.left - boardViewport.scrollLeft
  const dt = camAnim.top - boardViewport.scrollTop
  if (Math.abs(dl) < 0.5 && Math.abs(dt) < 0.5) {
    boardViewport.scrollLeft = camAnim.left
    boardViewport.scrollTop = camAnim.top
    camAnim = null
    return false
  }
  boardViewport.scrollLeft += dl * CAM_EASE
  boardViewport.scrollTop += dt * CAM_EASE
  return true
}

// Pan the viewport so a board point sits in the middle of the visible map area.
const focusOnPoint = (x: number, y: number, animate = true): void => {
  if (!state || !boardViewport) return
  const availW = boardViewport.clientWidth
  const availH = boardViewport.clientHeight
  if (availW <= 0 || availH <= 0) return
  aimCamera(x * zoom - availW / 2, y * zoom - availH / 2, animate)
}

// The living enemy nearest the actor (for PCs, only ones the squad can see).
const nearestEnemyOf = (s: SoloState, actor: Entity): Entity | undefined => {
  let best: Entity | undefined
  let bestD = Infinity
  for (const e of s.entities) {
    if (e.faction === actor.faction || isDead(e)) continue
    if (actor.faction === 'pc' && !visibleToSquad(s, e.x, e.y)) continue
    const d = Math.hypot(e.x - actor.x, e.y - actor.y)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return best
}

// Centre on whoever holds the initiative — but pan to keep the nearest enemy in
// view too, even if that pushes the active character toward an edge.
// `animate` eases the camera (smooth pan); it defaults off while the monster AI is
// running so the horde's turn isn't slowed by easing the camera every step.
const focusOnActive = (animate = !busy): void => {
  if (!state || !boardViewport) return
  const actor = activeEntity(state)
  if (!actor) return
  const availW = boardViewport.clientWidth
  const availH = boardViewport.clientHeight
  if (availW <= 0 || availH <= 0) return
  const at = renderPos.get(actor.id) ?? {x: actor.x, y: actor.y}
  const enemy = nearestEnemyOf(state, actor)
  if (!enemy) {
    focusOnPoint(at.x, at.y, animate)
    return
  }
  const z = zoom
  const ep = renderPos.get(enemy.id) ?? {x: enemy.x, y: enemy.y}
  let left = at.x * z - availW / 2 // start centred on the character
  let top = at.y * z - availH / 2
  const m = Math.min(availW, availH) * 0.16 // keep the enemy this far inside the edge
  const cm = Math.min(availW, availH) * 0.1 // but never let the character leave the view
  const ex = ep.x * z
  const ey = ep.y * z
  const ax = at.x * z
  const ay = at.y * z
  if (ex < left + m)
    left = ex - m // shift to bring the enemy on-screen…
  else if (ex > left + availW - m) left = ex - availW + m
  if (ey < top + m) top = ey - m
  else if (ey > top + availH - m) top = ey - availH + m
  if (ax < left + cm)
    left = ax - cm // …but not so far the character drops off it
  else if (ax > left + availW - cm) left = ax - availW + cm
  if (ay < top + cm) top = ay - cm
  else if (ay > top + availH - cm) top = ay - availH + cm
  const maxLeft = Math.max(0, state.map.width * z - availW)
  const maxTop = Math.max(0, state.map.height * z - availH)
  boardViewport.scrollLeft = Math.min(maxLeft, Math.max(0, left))
  boardViewport.scrollTop = Math.min(maxTop, Math.max(0, top))
}

const setZoom = (
  next: number,
  anchor?: {boardX: number; boardY: number; viewportX: number; viewportY: number}
): void => {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
  updateCanvasDisplaySize()
  if (anchor && boardViewport) {
    camAnim = null // a manual zoom takes the camera; cancel any pan in flight
    boardViewport.scrollLeft = anchor.boardX * zoom - anchor.viewportX
    boardViewport.scrollTop = anchor.boardY * zoom - anchor.viewportY
  }
}

const handleWheel = (event: WheelEvent): void => {
  if (!state || !boardViewport) return
  event.preventDefault()
  const rect = canvas.getBoundingClientRect()
  const vp = boardViewport.getBoundingClientRect()
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
  setZoom(zoom * factor, {
    boardX: ((event.clientX - rect.left) / rect.width) * state.map.width,
    boardY: ((event.clientY - rect.top) / rect.height) * state.map.height,
    viewportX: event.clientX - vp.left,
    viewportY: event.clientY - vp.top
  })
}

// Movement (px) before a plain left press stops being a tap and becomes a pan.
const TAP_SLOP = 5

const onBoardDragMove = (event: PointerEvent): void => {
  if (!boardViewport || !boardDrag || boardDrag.id !== event.pointerId) return
  const dx = event.clientX - boardDrag.startX
  const dy = event.clientY - boardDrag.startY
  if (!boardDrag.panning && Math.hypot(dx, dy) <= TAP_SLOP) return // still possibly a tap
  if (!boardDrag.panning) {
    boardDrag.panning = true
    boardViewport.classList.add('is-panning')
  }
  event.preventDefault()
  camAnim = null // user is panning by hand; release the camera
  boardViewport.scrollLeft = boardDrag.scrollLeft - dx
  boardViewport.scrollTop = boardDrag.scrollTop - dy
}

const onBoardDragEnd = (event: PointerEvent): void => {
  if (!boardDrag || boardDrag.id !== event.pointerId) return
  const tapped = boardDrag.tap && !boardDrag.panning
  const {clientX, clientY} = event
  boardDrag = null
  boardViewport?.classList.remove('is-panning')
  window.removeEventListener('pointermove', onBoardDragMove)
  window.removeEventListener('pointerup', onBoardDragEnd)
  window.removeEventListener('pointercancel', onBoardDragEnd)
  if (tapped) actAt(clientX, clientY) // a click that never dragged = an action
}

// One press handler for mouse + trackpad. ⌘/Ctrl-left, middle, and right pan from
// the start; a plain left press is a tap that turns into a pan once it drags
// (covers the macOS three-finger drag, which arrives as a left-button drag).
const onBoardPointerDown = (event: PointerEvent): void => {
  if (event.pointerType === 'touch' || !boardViewport) return // touch handled separately
  const panFromStart =
    event.button === 1 || event.button === 2 || (event.button === 0 && (event.metaKey || event.ctrlKey))
  const tap = event.button === 0 && !event.metaKey && !event.ctrlKey
  if (!panFromStart && !tap) return
  event.preventDefault()
  boardDrag = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: boardViewport.scrollLeft,
    scrollTop: boardViewport.scrollTop,
    panning: panFromStart,
    tap
  }
  if (panFromStart) boardViewport.classList.add('is-panning')
  window.addEventListener('pointermove', onBoardDragMove)
  window.addEventListener('pointerup', onBoardDragEnd)
  window.addEventListener('pointercancel', onBoardDragEnd)
}

const blockContextMenu = (event: Event): void => event.preventDefault()

// Touch: one finger pans (or taps to act), two fingers pinch-zoom.
type TouchPt = {id: number; x: number; y: number}
const touchList = (event: TouchEvent): TouchPt[] =>
  Array.from(event.touches).map((t) => ({id: t.identifier, x: t.clientX, y: t.clientY}))

const onTouchStart = (event: TouchEvent): void => {
  if (!boardViewport || !state) return
  const touches = touchList(event)
  touchMoved = false
  if (touches.length === 1) {
    touchPan = {
      x: touches[0].x,
      y: touches[0].y,
      scrollLeft: boardViewport.scrollLeft,
      scrollTop: boardViewport.scrollTop
    }
    pinch = null
  } else if (touches.length >= 2) {
    const rect = canvas.getBoundingClientRect()
    const midX = (touches[0].x + touches[1].x) / 2
    const midY = (touches[0].y + touches[1].y) / 2
    pinch = {
      startDist: Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y),
      startZoom: zoom,
      boardX: ((midX - rect.left) / rect.width) * state.map.width,
      boardY: ((midY - rect.top) / rect.height) * state.map.height
    }
    touchPan = null
  }
}

const onTouchMove = (event: TouchEvent): void => {
  if (!boardViewport) return
  const touches = touchList(event)
  if (pinch && touches.length >= 2) {
    event.preventDefault()
    touchMoved = true
    const vp = boardViewport.getBoundingClientRect()
    const midX = (touches[0].x + touches[1].x) / 2
    const midY = (touches[0].y + touches[1].y) / 2
    const dist = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
    setZoom(pinch.startZoom * (dist / Math.max(1, pinch.startDist)), {
      boardX: pinch.boardX,
      boardY: pinch.boardY,
      viewportX: midX - vp.left,
      viewportY: midY - vp.top
    })
  } else if (touchPan && touches.length === 1) {
    const dx = touches[0].x - touchPan.x
    const dy = touches[0].y - touchPan.y
    if (Math.hypot(dx, dy) > 6) touchMoved = true
    if (touchMoved) {
      event.preventDefault()
      camAnim = null // user is panning by hand; release the camera
      boardViewport.scrollLeft = touchPan.scrollLeft - dx
      boardViewport.scrollTop = touchPan.scrollTop - dy
    }
  }
}

const onTouchEnd = (event: TouchEvent): void => {
  if (!touchMoved && !pinch && event.changedTouches.length === 1) {
    const t = event.changedTouches[0]
    actAt(t.clientX, t.clientY)
  }
  if (event.touches.length === 0) {
    touchPan = null
    pinch = null
  }
}

// ---- input ----------------------------------------------------------------
const boardPointFromXY = (clientX: number, clientY: number): Point => {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height
  }
}

// A door the active PC could toggle and that the click landed on (near its
// segment). Returns its id, else null → the click is a move instead.
const doorHitAt = (point: Point): string | null => {
  if (!state) return null
  const actor = activeEntity(state)
  if (!actor) return null
  const reach = doorReachForGrid(state.grid.gridScale)
  const near = state.grid.gridScale * 0.6
  let best: {id: string; d: number} | null = null
  for (const occluder of state.map.occluders) {
    if (occluder.type !== 'door') continue
    if (distanceToOccluder(point, occluder) > near) continue
    if (distanceToOccluder({x: actor.x, y: actor.y}, occluder) > reach) continue
    const d = distanceToOccluder(point, occluder)
    if (!best || d < best.d) best = {id: occluder.id, d}
  }
  return best?.id ?? null
}

// Is (x,y) within any conscious PC's current line of sight? Gates monster + loot
// visibility (you only see hostiles you can actually see).
const visibleToSquad = (s: SoloState, x: number, y: number): boolean =>
  s.entities.some(
    (e) =>
      e.faction === 'pc' &&
      isActive(e) &&
      Math.hypot(e.x - x, e.y - y) <= s.sightRadius &&
      hasLineOfSight({x: e.x, y: e.y}, {x, y}, s.map.occluders, s.doorStates)
  )

// Midpoint of a door segment (for placing a "locked" denial right on it).
const doorMidpoint = (doorId: string): Point | null => {
  const door = state?.map.occluders.find((o) => o.id === doorId && o.type === 'door')
  return door ? {x: (door.x1 + door.x2) / 2, y: (door.y1 + door.y2) / 2} : null
}

// An unsearched container the click landed on (and the squad can see). Searched
// ones are inert, so they fall through to a normal move.
const containerHitAt = (point: Point): Container | null => {
  if (!state) return null
  const tol = state.map.gridScale * 0.6
  let best: {container: Container; d: number} | null = null
  for (const container of state.containers) {
    if (container.searched || !visibleToSquad(state, container.x, container.y)) continue
    const d = Math.hypot(container.x - point.x, container.y - point.y)
    if (d <= tol && (!best || d < best.d)) best = {container, d}
  }
  return best?.container ?? null
}

// The entity the click landed on: any PC, or a monster the squad can currently see.
const entityHitAt = (point: Point): Entity | null => {
  if (!state) return null
  const tol = state.map.gridScale * 0.7
  let best: {entity: Entity; d: number} | null = null
  for (const entity of state.entities) {
    if (isDead(entity)) continue
    if (entity.faction === 'monster' && !visibleToSquad(state, entity.x, entity.y)) continue
    const at = positionOf(entity)
    const d = Math.hypot(at.x - point.x, at.y - point.y)
    if (d <= tol && (!best || d < best.d)) best = {entity, d}
  }
  return best?.entity ?? null
}

// Walk the active PC toward a tapped open-floor point (or show why it's blocked).
const TAP_END_MS = 220 // a second open-floor tap within this window ends the turn
const doMove = async (point: Point): Promise<void> => {
  if (!state || busy || state.phase.t !== 'playerTurn' || !myTurn()) return
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc') return
  const from = {x: actor.x, y: actor.y}
  const result = await submitCommand({t: 'Move', to: point})
  if (!state) return
  const moved = entityById(state, actor.id)
  if (moved && (moved.x !== from.x || moved.y !== from.y)) {
    playUi('move')
  } else if (result.rejected) {
    // The move was refused — show why, right where they clicked.
    const cell = cellOf(state.grid, point.x, point.y)
    const at = cellCenter(state.grid, cell.cx, cell.cy)
    spawnDenied(at, result.rejected, state.map.gridScale)
    playUi('denied')
    requestDraw()
  }
}

// Act at a screen point: toggle an adjacent door, select a tapped entity (target /
// patient), search a container, else move the active PC there. A double-tap on
// open floor ends the turn (hands off to the next combatant).
async function actAt(clientX: number, clientY: number): Promise<void> {
  if (!state || busy) return
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc') return
  // A move-tap is held for TAP_END_MS; anything that lands before it (this tap)
  // cancels it. Two open-floor taps in a row → end turn instead of two moves.
  const hadPendingMove = pendingMove !== null
  cancelPendingMove()
  const point = boardPointFromXY(clientX, clientY)
  const doorId = doorHitAt(point)
  if (doorId) {
    const before = state.doorStates[doorId]?.open ?? false
    const result = await submitCommand({t: 'ToggleDoor', doorId})
    const after = state?.doorStates[doorId]?.open ?? false
    if (state && after === before && result.rejected) {
      // Refused (sealed without a card/hack, or out of actions) — show why on the door.
      const mid = doorMidpoint(doorId)
      if (mid) spawnDenied(mid, result.rejected, state.map.gridScale)
      playUi('denied')
      requestDraw()
    } else {
      playUi('door')
    }
    return
  }
  const hit = entityHitAt(point)
  if (hit) {
    const isOwnTurn = hit.faction === 'pc' && hit.id === actor.id
    // Double-click your own (active) token to end the turn — first tap selects you
    // and shows the hint, the second tap ends it.
    if (isOwnTurn && hit.id === selectedId) {
      endTurn()
      return
    }
    // Tapping an already-targeted foe fires (so a double-click attacks outright).
    if (hit.id === selectedId && canAttackTarget(hit)) {
      void onAttack(hit.id)
      return
    }
    selectedId = selectedId === hit.id ? null : hit.id
    if (selectedId) {
      playUi('select')
      if (isOwnTurn) spawnHint(positionOf(hit), 'Double-click: end turn', state.map.gridScale)
    }
    renderPanel()
    requestDraw()
    return
  }
  // A container: search it when adjacent, else fall through to walk toward it.
  const container = containerHitAt(point)
  if (container && Math.hypot(actor.x - container.x, actor.y - container.y) <= 1.6 * state.grid.gridScale) {
    playUi('pickup')
    playerAct({t: 'Search', containerId: container.id})
    return
  }
  // Open floor: a second tap (the move is still pending) ends the turn; otherwise
  // hold the move briefly so a double-tap can be caught.
  if (hadPendingMove) {
    endTurn()
    return
  }
  pendingMove = {
    to: point,
    timer: setTimeout(() => {
      const to = pendingMove?.to
      pendingMove = null
      if (to) doMove(to)
    }, TAP_END_MS)
  }
}

// ---- rendering ------------------------------------------------------------
const tracePolygon = (target: CanvasRenderingContext2D, polygon: Point[]): void => {
  target.moveTo(polygon[0].x, polygon[0].y)
  for (const point of polygon.slice(1)) target.lineTo(point.x, point.y)
  target.closePath()
}

// Three-tier fog over the union of the squad's line of sight: clear where any PC
// can currently see, dim grey where the squad has been (memory), opaque dark
// where never seen.
const drawFog = (s: SoloState): void => {
  const w = s.map.width
  const h = s.map.height

  curCtx.clearRect(0, 0, w, h)
  curCtx.fillStyle = '#fff'
  for (const entity of s.entities) {
    if (entity.faction !== 'pc' || !isActive(entity)) continue
    const at = positionOf(entity)
    const polygon = visibilityPolygon(at.x, at.y, w, h, s.sightRadius, s.map.occluders, s.doorStates)
    if (polygon.length < 3) continue
    curCtx.beginPath()
    tracePolygon(curCtx, polygon)
    curCtx.fill()
  }
  exploredCtx.drawImage(cur, 0, 0)

  // Grey veil everywhere outside the current view (memory + not-yet-darkened).
  scratchCtx.globalCompositeOperation = 'source-over'
  scratchCtx.clearRect(0, 0, w, h)
  scratchCtx.fillStyle = 'rgba(8, 11, 10, 0.62)'
  scratchCtx.fillRect(0, 0, w, h)
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.drawImage(cur, 0, 0)
  scratchCtx.globalCompositeOperation = 'source-over'
  ctx.drawImage(scratch, 0, 0)

  // Opaque dark wherever never explored (covers the grey there).
  scratchCtx.globalCompositeOperation = 'source-over'
  scratchCtx.clearRect(0, 0, w, h)
  scratchCtx.fillStyle = '#050606'
  scratchCtx.fillRect(0, 0, w, h)
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.drawImage(explored, 0, 0)
  scratchCtx.globalCompositeOperation = 'source-over'
  ctx.drawImage(scratch, 0, 0)
}

// Keycard clearance colours (ids match loot.ts KEY_CLEARANCES); hack locks read cyan.
const KEY_COLORS: Record<string, string> = {
  blue: 'rgba(86, 156, 255, 1)',
  amber: 'rgba(255, 178, 60, 1)',
  violet: 'rgba(197, 120, 255, 1)',
  red: 'rgba(255, 96, 84, 1)'
}
const HACK_COLOR = 'rgba(94, 214, 240, 1)'
const lockColor = (lock: DoorLock): string =>
  lock.kind === 'hack' ? HACK_COLOR : (KEY_COLORS[lock.keyId ?? ''] ?? KEY_COLORS.amber)

// A small padlock at a sealed door — coloured by keycard clearance, cyan for a
// hackable one — on a dark backing disc so it reads over the deck art.
const drawLockGlyph = (x: number, y: number, gs: number, lock: DoorLock): void => {
  const col = lockColor(lock)
  const w = gs * 0.4
  const h = gs * 0.34
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = 'rgba(6, 9, 9, 0.82)' // dark disc so the lock reads over the door art
  ctx.beginPath()
  ctx.arc(0, 0, gs * 0.42, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = col
  ctx.lineWidth = Math.max(1.4, gs * 0.045)
  ctx.beginPath()
  ctx.arc(0, 0, gs * 0.42, 0, Math.PI * 2) // tinted rim
  ctx.stroke()
  ctx.lineWidth = Math.max(1.8, gs * 0.06)
  ctx.beginPath()
  ctx.arc(0, -h * 0.22, w * 0.32, Math.PI, 0) // shackle
  ctx.stroke()
  ctx.fillStyle = col
  ctx.fillRect(-w * 0.42, -h * 0.08, w * 0.84, h * 0.7) // body
  ctx.restore()
}

const drawDoorStates = (s: SoloState): void => {
  const reach = doorReachForGrid(s.grid.gridScale)
  const actor = activeEntity(s)
  // Only hint doors the active PC can actually reach (open = solid "close me",
  // closed = dashed "open me"); far doors just read as gaps/lines in the deck art.
  for (const occluder of s.map.occluders) {
    if (occluder.type !== 'door') continue
    const door = occluder as DoorOccluder
    const lock = s.locks[door.id]
    // A sealed door shows a padlock wherever the squad can see it; it is closed, so
    // the open/close hint below doesn't apply. The midpoint sits on the wall line
    // (LOS there is flaky), so test the two cell-centres the door separates — a PC
    // in or seeing either side reveals the lock.
    if (lock && !lock.unlocked) {
      const mx = (door.x1 + door.x2) / 2
      const my = (door.y1 + door.y2) / 2
      const len = Math.hypot(door.x2 - door.x1, door.y2 - door.y1) || 1
      const nx = (-(door.y2 - door.y1) / len) * s.grid.gridScale * 0.5
      const ny = ((door.x2 - door.x1) / len) * s.grid.gridScale * 0.5
      const seen =
        visibleToSquad(s, mx + nx, my + ny) || visibleToSquad(s, mx - nx, my - ny) || visibleToSquad(s, mx, my)
      if (seen) drawLockGlyph(mx, my, s.grid.gridScale, lock)
      continue
    }
    const reachable =
      actor != null && actor.faction === 'pc' && distanceToOccluder({x: actor.x, y: actor.y}, door) <= reach
    if (!reachable) continue
    const open = s.doorStates[door.id]?.open ?? false
    ctx.save()
    ctx.lineCap = 'round'
    ctx.strokeStyle = open ? 'rgba(57, 255, 20, 0.85)' : 'rgba(255, 159, 28, 0.85)'
    ctx.lineWidth = open ? 8 : 6
    if (!open) ctx.setLineDash([6, 5])
    ctx.beginPath()
    ctx.moveTo(door.x1, door.y1)
    ctx.lineTo(door.x2, door.y2)
    ctx.stroke()
    ctx.restore()
  }
}

// Which floor cells the active PC can actually move to this turn: in budget, in
// their own line of sight, on floor, and unoccupied — exactly the moves the
// reducer accepts. Recomputed per action (cheap: one visibility polygon + a small
// cell sweep), cached for the render loop.
const computeReachable = (): void => {
  reachable = []
  if (!state || busy || state.phase.t !== 'playerTurn') return
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc' || !isActive(actor)) return
  const gs = state.grid.gridScale
  const budget = state.moveRemainingPx
  if (budget < gs * 0.4) return
  const poly = visibilityPolygon(
    actor.x,
    actor.y,
    state.map.width,
    state.map.height,
    state.sightRadius,
    state.map.occluders,
    state.doorStates
  )
  if (poly.length < 3) return
  const blocked = new Set<string>()
  for (const e of state.entities) {
    if (e.id === actor.id || isDead(e)) continue
    const c = cellOf(state.grid, e.x, e.y)
    blocked.add(`${c.cx},${c.cy}`)
  }
  for (const prop of state.props) {
    const c = cellOf(state.grid, prop.x, prop.y)
    blocked.add(`${c.cx},${c.cy}`)
  }
  const ac = cellOf(state.grid, actor.x, actor.y)
  const reach = Math.ceil(budget / gs) + 1
  for (let cy = ac.cy - reach; cy <= ac.cy + reach; cy += 1) {
    for (let cx = ac.cx - reach; cx <= ac.cx + reach; cx += 1) {
      if (cx === ac.cx && cy === ac.cy) continue
      if (!isFloor(state.grid, cx, cy) || blocked.has(`${cx},${cy}`)) continue
      const c = cellCenter(state.grid, cx, cy)
      if (Math.hypot(c.x - actor.x, c.y - actor.y) > budget + 0.5) continue
      if (!pointInPolygon({x: c.x, y: c.y}, poly)) continue
      reachable.push({cx, cy})
    }
  }
}

const drawReachable = (s: SoloState): void => {
  if (reachable.length === 0) return
  const gs = s.grid.gridScale
  ctx.save()
  ctx.fillStyle = 'rgba(57, 255, 20, 0.13)'
  for (const {cx, cy} of reachable) ctx.fillRect(cx * gs + 1, cy * gs + 1, gs - 2, gs - 2)
  ctx.restore()
}

const drawFloorDebug = (s: SoloState): void => {
  const g = s.grid
  ctx.save()
  ctx.fillStyle = 'rgba(57, 255, 20, 0.10)'
  for (let cy = 0; cy < g.rows; cy += 1) {
    for (let cx = 0; cx < g.cols; cx += 1) {
      if (g.floor[cy * g.cols + cx] === 1) ctx.fillRect(cx * g.gridScale, cy * g.gridScale, g.gridScale, g.gridScale)
    }
  }
  ctx.restore()
}

const drawGroundItem = (s: SoloState, item: GroundItem): void => {
  const r = s.map.gridScale * 0.24
  const k = item.stack.kind
  const fill =
    k === 'medkit'
      ? 'rgba(57,255,20,0.92)'
      : k === 'weapon'
        ? 'rgba(150,182,214,0.95)'
        : k === 'armor'
          ? 'rgba(150,158,172,0.95)'
          : k === 'keycard'
            ? (KEY_COLORS[item.stack.keyId ?? ''] ?? 'rgba(255,210,74,0.92)')
            : 'rgba(255,210,74,0.92)' // ammo
  ctx.save()
  ctx.translate(item.x, item.y)
  ctx.fillStyle = fill
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.rect(-r, -r, r * 2, r * 2)
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = 'rgba(6,14,10,0.85)'
  ctx.lineWidth = Math.max(1.5, r * 0.26)
  ctx.lineJoin = 'round'
  if (k === 'medkit') {
    ctx.beginPath()
    ctx.moveTo(0, -r * 0.55)
    ctx.lineTo(0, r * 0.55)
    ctx.moveTo(-r * 0.55, 0)
    ctx.lineTo(r * 0.55, 0)
    ctx.stroke()
  } else if (k === 'weapon') {
    // a crude pistol: barrel along the top, a grip dropping from it
    ctx.beginPath()
    ctx.moveTo(-r * 0.6, -r * 0.2)
    ctx.lineTo(r * 0.6, -r * 0.2)
    ctx.lineTo(r * 0.6, r * 0.02)
    ctx.moveTo(-r * 0.2, -r * 0.2)
    ctx.lineTo(-r * 0.45, r * 0.55)
    ctx.stroke()
  } else if (k === 'armor') {
    // a shield outline
    ctx.beginPath()
    ctx.moveTo(0, -r * 0.58)
    ctx.lineTo(r * 0.55, -r * 0.15)
    ctx.lineTo(r * 0.38, r * 0.52)
    ctx.lineTo(-r * 0.38, r * 0.52)
    ctx.lineTo(-r * 0.55, -r * 0.15)
    ctx.closePath()
    ctx.stroke()
  } else if (k === 'keycard') {
    // a key: round bow + stem with a tooth
    ctx.beginPath()
    ctx.arc(-r * 0.28, 0, r * 0.3, 0, Math.PI * 2)
    ctx.moveTo(0, 0)
    ctx.lineTo(r * 0.62, 0)
    ctx.moveTo(r * 0.62, 0)
    ctx.lineTo(r * 0.62, r * 0.3)
    ctx.stroke()
  }
  ctx.restore()
}

// Searchable fixtures (lockers/cabinets/crates/terminals). Unsearched ones carry a
// bright edge + highlight ring; searched ones go dim with an open lid. Drawn only
// where the squad can see, so they live under the fog like floor loot.
const drawContainers = (s: SoloState): void => {
  const gs = s.map.gridScale
  for (const c of s.containers) {
    if (!visibleToSquad(s, c.x, c.y)) continue
    const r = gs * 0.3
    const terminal = c.kind === 'terminal'
    const edge = c.searched
      ? 'rgba(120, 138, 148, 0.55)'
      : terminal
        ? 'rgba(94, 214, 240, 0.95)'
        : 'rgba(255, 200, 110, 0.95)'
    const body = c.searched ? 'rgba(40, 48, 52, 0.7)' : terminal ? 'rgba(20, 46, 56, 0.92)' : 'rgba(48, 60, 44, 0.92)'
    ctx.save()
    ctx.translate(c.x, c.y)
    ctx.fillStyle = body
    ctx.strokeStyle = edge
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(-r, -r, r * 2, r * 2)
    ctx.fill()
    ctx.stroke()
    ctx.lineWidth = Math.max(1.3, r * 0.16)
    if (terminal) {
      ctx.beginPath() // a couple of screen lines
      ctx.moveTo(-r * 0.5, -r * 0.2)
      ctx.lineTo(r * 0.5, -r * 0.2)
      ctx.moveTo(-r * 0.5, r * 0.12)
      ctx.lineTo(r * 0.2, r * 0.12)
      ctx.stroke()
    } else {
      ctx.beginPath() // lid line
      ctx.moveTo(-r, -r * 0.28)
      ctx.lineTo(r, -r * 0.28)
      ctx.stroke()
      if (!c.searched) {
        ctx.beginPath() // clasp
        ctx.arc(0, r * 0.14, r * 0.16, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    if (!c.searched) {
      ctx.strokeStyle = terminal ? 'rgba(94, 214, 240, 0.45)' : 'rgba(255, 205, 120, 0.45)'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.rect(-r - 3, -r - 3, (r + 3) * 2, (r + 3) * 2)
      ctx.stroke()
    }
    ctx.restore()
  }
}

// Health as a fraction of total physical characteristics (STR+DEX+END). Damage
// drains END first then STR/DEX, so this hits 0 exactly when the entity dies —
// a truer "health level" than END alone.
const vitalityRatio = (e: Entity): number => {
  const cur = Math.max(0, e.stats.str) + Math.max(0, e.stats.dex) + Math.max(0, e.stats.end)
  const max = e.statsMax.str + e.statsMax.dex + e.statsMax.end
  return max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0
}

const healthColor = (ratio: number): string => (ratio > 0.5 ? '#3ddc6b' : ratio > 0.25 ? '#ffc24b' : '#ff5a4e')

// A slim health bar under a token, coloured by remaining vitality.
const drawHealthBar = (at: Point, entity: Entity, gridScale: number): void => {
  const size = counterTokenSize(gridScale)
  const w = size * 0.92
  const h = Math.max(4, size * 0.13)
  const x = at.x - w / 2
  const y = at.y + size / 2 + Math.max(3, size * 0.14)
  const ratio = vitalityRatio(entity)
  ctx.save()
  ctx.fillStyle = 'rgba(4, 8, 5, 0.85)'
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2)
  ctx.fillStyle = healthColor(ratio)
  ctx.fillRect(x, y, w * ratio, h)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
  ctx.lineWidth = 1
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2)
  ctx.restore()
}

const drawSelectionRing = (at: Point, faction: Entity['faction'], gridScale: number): void => {
  const radius = gridScale * 0.62
  ctx.save()
  ctx.strokeStyle = faction === 'monster' ? 'rgba(255,72,72,0.95)' : 'rgba(57,255,20,0.95)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// A cyan ring under a piece YOU control (online only), so you can pick your
// characters out on the shared board at a glance.
const drawOwnerRing = (at: Point, gridScale: number): void => {
  ctx.save()
  ctx.strokeStyle = 'rgba(70, 224, 200, 0.9)'
  ctx.lineWidth = Math.max(2, gridScale * 0.06)
  ctx.beginPath()
  ctx.arc(at.x, at.y, gridScale * 0.7, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// Red dashed = the active character has a clear shot. Grey dotted = the foe is
// visible to the squad but this character has no line of sight (no shot).
const drawTargetingLine = (from: Point, to: Point, clear: boolean): void => {
  ctx.save()
  ctx.strokeStyle = clear ? 'rgba(255,72,72,0.7)' : 'rgba(150,156,148,0.45)'
  ctx.lineWidth = 2
  ctx.setLineDash(clear ? [6, 6] : [2, 7])
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

const drawProps = (s: SoloState): void => {
  const sz = s.map.gridScale * 0.74
  for (const prop of s.props) {
    ctx.save()
    ctx.translate(prop.x, prop.y)
    ctx.fillStyle = 'rgba(96, 74, 38, 0.92)'
    ctx.strokeStyle = 'rgba(255, 200, 120, 0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(-sz / 2, -sz / 2, sz, sz)
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(-sz / 2, -sz / 2)
    ctx.lineTo(sz / 2, sz / 2)
    ctx.moveTo(sz / 2, -sz / 2)
    ctx.lineTo(-sz / 2, sz / 2)
    ctx.stroke()
    ctx.restore()
  }
}

const draw = (): void => {
  if (!state || !ctx) return
  const s = state
  renderMap(ctx, s.map)
  drawProps(s)
  if (showGrid) drawFloorDebug(s)
  drawFog(s)
  drawDoorStates(s)
  drawReachable(s)
  drawContainers(s)

  for (const item of s.ground) {
    if (visibleToSquad(s, item.x, item.y)) drawGroundItem(s, item)
  }

  const actor = activeEntity(s)
  const selected = selectedId ? entityById(s, selectedId) : undefined
  if (
    actor &&
    actor.faction === 'pc' &&
    selected &&
    selected.faction === 'monster' &&
    visibleToSquad(s, selected.x, selected.y)
  ) {
    drawTargetingLine(positionOf(actor), positionOf(selected), canSeePoint(s, actor, selected.x, selected.y))
  }

  for (const entity of s.entities) {
    if (isDead(entity)) continue
    if (entity.faction === 'monster' && !visibleToSquad(s, entity.x, entity.y)) continue
    const at = positionOf(entity)
    drawCounterToken(
      ctx,
      {kind: entity.kind, label: entity.label, x: at.x, y: at.y},
      {
        gridScale: s.map.gridScale,
        portraits: counterPortraits,
        counterDefinitions,
        isPov: entity.id === actor?.id
      }
    )
    if (mySeat() !== undefined && entity.faction === 'pc' && entity.owner === mySeat()) {
      drawOwnerRing(at, s.map.gridScale)
    }
    if (vitalityRatio(entity) < 1) drawHealthBar(at, entity, s.map.gridScale)
    if (entity.id === selectedId) drawSelectionRing(at, entity.faction, s.map.gridScale)
  }

  // Combat effects (muzzle flashes, tracers, slashes, impact bursts, callouts) on top.
  drawEffects(ctx)
}

// ---- panel ----------------------------------------------------------------
const escapeHtml = (text: string): string =>
  text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

// --- Traveller-style character read-outs for the combat HUD ----------------
const hexDigit = (n: number): string => Math.max(0, Math.round(n)).toString(16).toUpperCase()
const uppOf = (e: Entity): string => `${hexDigit(e.stats.str)}${hexDigit(e.stats.dex)}${hexDigit(e.stats.end)}`
const topSkillsOf = (e: Entity, max = 3): string[] =>
  Object.entries(e.skills)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, level]) => `${name}-${level}`)
const gearOf = (e: Entity): string => {
  const w = weaponById(e.weaponId)
  const ammo = w.magazine !== undefined ? ` ${e.loadedRounds}/${w.magazine}` : ''
  const armour = e.armorId ? `${ARMORS[e.armorId]?.name ?? '—'} AR${ARMORS[e.armorId]?.ar ?? 0}` : 'unarmoured'
  return `${w.name}${ammo} · ${armour}`
}
const weaponCompactOf = (e: Entity): string => {
  const w = weaponById(e.weaponId)
  return w.magazine !== undefined ? `${w.name} ${e.loadedRounds}/${w.magazine}` : w.name
}
const endOf = (e: Entity): string => `${e.stats.end}/${e.statsMax.end}`
// Carried keycards as small colour-coded chips, so the player can match a card to
// the matching sealed-door padlock.
const keycardChipsHtml = (e: Entity): string => {
  const cards = e.inventory.filter((s) => s.kind === 'keycard' && s.count > 0)
  if (cards.length === 0) return ''
  return `<div class="solo-track-keys">${cards
    .map(
      (c) =>
        `<span class="solo-key-chip" style="--key:${KEY_COLORS[c.keyId ?? ''] ?? KEY_COLORS.amber}">${escapeHtml(keyLabel(c.keyId))} key${c.count > 1 ? ` ×${c.count}` : ''}</span>`
    )
    .join('')}</div>`
}
const conditionBadge = (e: Entity): string =>
  isDead(e)
    ? '<span class="solo-badge is-kia">KIA</span>'
    : isDown(e)
      ? '<span class="solo-badge is-down">DOWN</span>'
      : ''

// Turn order starting at the active combatant; squad always listed, visible foes only.
const trackCombatants = (s: SoloState): Entity[] => {
  const out: Entity[] = []
  const count = s.entities.length
  for (let i = 0; i < count; i += 1) {
    const entity = s.entities[(s.turnPtr + i) % count]
    if (entity.faction === 'pc' || (!isDead(entity) && visibleToSquad(s, entity.x, entity.y))) out.push(entity)
  }
  return out
}

type TrackCombat = {
  playerTurn: boolean
  squares: number
  actionUsed: boolean
  stance: CombatStance
  canSetStance: boolean
  attackLabel: string
  canAttack: boolean
  canReload: boolean
  canMedkit: boolean
  canPickup: boolean
  canSearch: boolean
  canPush: boolean
  aim: number
  canAim: boolean
  targetNote: string
}

const SOLO_ICON = {
  attack:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  aim: '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>',
  reload:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 1-5.3 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7 6.5 4.5 9 7 11.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  medkit:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="7" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 10v6M9 13h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pickup:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9V6a4 4 0 1 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="6" y="9" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 12v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  push: '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="8" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 14h5M18 11l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  search:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 15l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  stand:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="2.2" fill="currentColor"/><path d="M12 8v9M9.5 20h5M10 12l2 3 2-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  crouch:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="14" cy="7" r="2.2" fill="currentColor"/><path d="M8 18h8M10.5 18l1.5-5 3 2 2-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  prone:
    '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="12" r="2.2" fill="currentColor"/><path d="M10 12h10M10 12l2-2M10 12l2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  end: '<svg class="solo-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h8l-2 12H10L8 6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 6l1-2h4l1 2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
} as const

const iconBtn = (id: string | null, icon: string, label: string, enabled: boolean, extraClass = ''): string => {
  const idAttr = id ? ` id="${id}"` : ''
  return `<button${idAttr} class="solo-icon-btn${extraClass ? ` ${extraClass}` : ''}" type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${enabled ? '' : ' disabled'}>${icon}</button>`
}

const stanceBtn = (value: CombatStance, current: CombatStance, enabled: boolean): string => {
  const label = stanceLabel(value)
  const active = value === current ? ' is-active' : ''
  const icon = SOLO_ICON[value === 'standing' ? 'stand' : value === 'crouched' ? 'crouch' : 'prone']
  return `<button class="solo-icon-btn is-stance${active}" type="button" data-stance="${value}" title="${label}" aria-label="${label}" aria-pressed="${value === current}"${enabled ? '' : ' disabled'}>${icon}</button>`
}

const trackControlsHtml = (combat: TrackCombat): string => {
  const actionChip = combat.actionUsed
    ? '<span class="solo-chip is-spent">Action spent</span>'
    : '<span class="solo-chip is-ready">Action ready</span>'
  return `<div class="solo-track-controls">
    <div class="solo-track-chips">
      <span class="solo-chip">${combat.squares} sq left</span>
      ${actionChip}
      <span class="solo-chip solo-chip-stance">${stanceLabel(combat.stance)}</span>
      ${combat.aim > 0 ? `<span class="solo-chip solo-chip-aim">Aim +${combat.aim}</span>` : ''}
    </div>
    ${combat.targetNote ? `<div class="solo-target-card">${escapeHtml(combat.targetNote)}</div>` : ''}
    <div class="solo-icon-bar">
      <div class="solo-icon-group" role="group" aria-label="Combat stance">
        ${STANCES.map((value) => stanceBtn(value, combat.stance, combat.canSetStance)).join('')}
      </div>
      <span class="solo-icon-sep" aria-hidden="true"></span>
      ${iconBtn('solo-attack', SOLO_ICON.attack, combat.attackLabel, combat.canAttack, 'is-primary')}
      ${iconBtn('solo-aim', SOLO_ICON.aim, combat.aim > 0 ? `Aim (+${combat.aim})` : 'Aim', combat.canAim, combat.aim > 0 ? 'is-aiming' : '')}
      ${iconBtn('solo-reload', SOLO_ICON.reload, 'Reload', combat.canReload)}
      ${iconBtn('solo-medkit', SOLO_ICON.medkit, 'Medkit', combat.canMedkit)}
      ${iconBtn('solo-pickup', SOLO_ICON.pickup, 'Pick up', combat.canPickup)}
      ${iconBtn('solo-search', SOLO_ICON.search, 'Search', combat.canSearch)}
      ${iconBtn('solo-push', SOLO_ICON.push, 'Push crate', combat.canPush)}
      ${iconBtn('solo-end', SOLO_ICON.end, 'End turn (Space)', true, 'is-end')}
    </div>
  </div>`
}

const trackRowHtml = (s: SoloState, entity: Entity, rank: number, combat: TrackCombat | null): string => {
  const def = counterDefinitions.find((d) => d.kind === entity.kind)
  const actor = activeEntity(s)
  const active = entity.id === actor?.id
  const selected = entity.id === selectedId
  const expanded = active || selected
  const acting = active && entity.faction === 'pc' && !!combat?.playerTurn
  const foe = entity.faction === 'monster'
  const hp = vitalityRatio(entity)
  const detail =
    entity.faction === 'pc' && expanded
      ? `<div class="solo-track-detail">
          <span class="solo-tag solo-tag-upp" title="STR DEX END (hex)">UPP ${uppOf(entity)}</span>
          ${topSkillsOf(entity)
            .map((skill) => `<span class="solo-tag">${escapeHtml(skill)}</span>`)
            .join('')}
          <span class="solo-track-gear">${escapeHtml(gearOf(entity))}</span>
          ${keycardChipsHtml(entity)}
        </div>`
      : foe
        ? ''
        : `<div class="solo-track-loadout">${escapeHtml(weaponCompactOf(entity))}</div>`
  const status = active ? '<span class="solo-track-now">NOW</span>' : ''
  // Online, tag each character with its owner ("You" / "P2") so it is clear which
  // pieces you control. Nothing offline (no seats).
  const ownerChip =
    entity.faction === 'pc' && mySeat() !== undefined && entity.owner
      ? `<span class="solo-tag" style="${
          entity.owner === mySeat() ? 'background:#1f5d3f;color:#cffbe6' : 'background:#33323a;color:#cfc8d8'
        }">${escapeHtml(seatLabel(entity.owner))}</span>`
      : ''
  const stanceTag =
    entity.faction === 'pc' && entity.stance !== 'standing'
      ? `<span class="solo-tag solo-tag-stance">${stanceLabel(entity.stance)}</span>`
      : ''
  const controls = acting && combat ? trackControlsHtml(combat) : ''
  return `<li class="solo-track-row${foe ? ' is-foe' : ' is-pc'}${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}${acting ? ' is-acting' : ''}" data-select="${entity.id}">
    <div class="solo-track-summary">
      <span class="solo-track-rank">${rank}</span>
      <img class="solo-track-portrait" src="${def?.portrait ?? ''}" alt="" />
      <div class="solo-track-body">
        <div class="solo-track-head">
          <span class="solo-track-name">${escapeHtml(entity.label)}</span>
          ${ownerChip}
          ${conditionBadge(entity)}
          ${stanceTag}
          ${status}
          <span class="solo-track-init" title="Initiative">${entity.initiative ?? '—'}</span>
        </div>
        <div class="solo-track-vitals">
          <span class="solo-track-end">END ${endOf(entity)}</span>
          <div class="solo-track-bar"><div class="solo-track-bar-fill" style="width:${Math.round(hp * 100)}%;background:${healthColor(hp)}"></div></div>
        </div>
        ${detail}
      </div>
    </div>
    ${controls}
  </li>`
}

const trackHtml = (s: SoloState, combat: TrackCombat | null): string =>
  trackCombatants(s)
    .map((entity, index) => trackRowHtml(s, entity, index + 1, combat))
    .join('')

const logHtml = (lines: string[]): string =>
  lines.length === 0
    ? '<div class="solo-log-empty">No events yet.</div>'
    : lines.map((line) => `<div class="solo-log-line">${line}</div>`).join('')

const renderPanel = (): void => {
  if (!state) return
  const s = state
  const actor = activeEntity(s)
  const weapon = actor ? weaponById(actor.weaponId) : null
  const selected = selectedId ? entityById(s, selectedId) : undefined
  const squares = actor ? Math.max(0, Math.round(s.moveRemainingPx / s.grid.gridScale)) : 0
  // Action economy: a minor action costs one 6 m move's worth of budget; a
  // significant action (attack / first aid / shove) costs two, and only one is
  // allowed per round (actionUsed).
  const minorPx = actor ? moveBudgetPx(s.grid.gridScale, actor.moveMeters) : 0
  const canMinor = !!actor && isActive(actor) && s.moveRemainingPx + 0.5 >= minorPx
  const canSignificant =
    !!actor && isActive(actor) && !s.actionUsed && s.moveRemainingPx + 0.5 >= SIGNIFICANT_ACTION_COST * minorPx

  // Attack availability against a selected enemy. The active character can only
  // fire on a foe IT can see — not one only an ally has line of sight to.
  const selectedEnemy = selected && selected.faction === 'monster' ? selected : undefined
  const enemy =
    actor && selectedEnemy && canSeePoint(s, actor, selectedEnemy.x, selectedEnemy.y) ? selectedEnemy : undefined
  let attackLabel = 'Attack'
  let canAttack = false
  let targetNote = ''
  if (actor && enemy && weapon) {
    const band = rangeBandFor(Math.hypot(actor.x - enemy.x, actor.y - enemy.y), s.grid.gridScale)
    const inRange = weapon.rangeDm[band] !== undefined
    const hasAmmo = weapon.magazine === undefined || actor.loadedRounds > 0
    const meleeBlocked = actor.stance === 'prone' && weapon.skill === 'Melee Combat'
    canAttack = canSignificant && inRange && hasAmmo && !meleeBlocked
    attackLabel = meleeBlocked ? 'No melee while prone' : `Attack ${enemy.label}`
    targetNote = `${enemy.label} · ${enemy.stats.end}/${enemy.statsMax.end} END · ${inRange ? band : `out of range (${band})`}${hasAmmo ? '' : ' · no ammo'}${canAttack ? ' · double-click or F to fire' : ''}`
  } else if (selectedEnemy) {
    // Selected, squad-visible, but this character can't see it.
    attackLabel = 'No line of sight'
    targetNote = `${selectedEnemy.label} · no line of sight from ${actor?.label ?? 'here'}`
  }

  const canReload =
    canMinor &&
    weapon?.magazine !== undefined &&
    !!actor &&
    actor.loadedRounds < (weapon.magazine ?? 0) &&
    actor.inventory.some((i) => i.kind === 'ammo' && i.weaponId === actor.weaponId && i.count > 0)

  const patient = selected && selected.faction === 'pc' && !isDead(selected) ? selected : actor
  const canMedkit =
    canSignificant &&
    !!actor &&
    actor.inventory.some((i) => i.kind === 'medkit' && i.count > 0) &&
    !!patient &&
    patient.stats.end < patient.statsMax.end &&
    (patient.id === actor.id || withinReach(actor, patient, s.grid.gridScale))

  const loot = actor
    ? s.ground.find((g) => Math.hypot(actor.x - g.x, actor.y - g.y) <= 1.6 * s.grid.gridScale)
    : undefined
  const canPickup = canMinor && !!loot

  const searchTarget = actor
    ? s.containers.find((c) => !c.searched && Math.hypot(actor.x - c.x, actor.y - c.y) <= 1.6 * s.grid.gridScale)
    : undefined
  const canSearch = canMinor && !!searchTarget

  const pushable = actor
    ? s.props.find((p) => {
        const ac = cellOf(s.grid, actor.x, actor.y)
        const pc = cellOf(s.grid, p.x, p.y)
        return Math.abs(pc.cx - ac.cx) + Math.abs(pc.cy - ac.cy) === 1
      })
    : undefined
  const canPush = canSignificant && !!pushable

  const recentLog = s.log.slice(logExpanded ? -40 : -2).map(escapeHtml)
  const over = s.phase.t === 'lost' || s.phase.t === 'won'
  const overText = s.phase.t === 'won' ? 'Survived — the deck is clear.' : 'Squad lost.'
  const playerTurn = !!actor && actor.faction === 'pc' && !busy
  const trackCount = trackCombatants(s).length
  const trackCombat: TrackCombat | null = over
    ? null
    : {
        playerTurn,
        squares,
        actionUsed: s.actionUsed,
        stance: actor?.stance ?? 'standing',
        canSetStance: playerTurn && canMinor,
        attackLabel,
        canAttack,
        canReload,
        canMedkit,
        canPickup,
        canSearch,
        canPush,
        aim: actor?.aim ?? 0,
        canAim: canSignificant && (actor?.aim ?? 0) < AIM_MAX,
        targetNote
      }
  // Banner driven by who is up: the horde, another player (online), or no banner on
  // my own turn. Makes "whose turn is it" unambiguous in co-op.
  const otherPlayerUp = !!actor && actor.faction === 'pc' && mySeat() !== undefined && actor.owner !== mySeat()
  const bannerText =
    actor?.faction === 'monster'
      ? 'Hostiles acting…'
      : otherPlayerUp
        ? `${escapeHtml(actor.label)} — ${seatLabel(actor.owner)}'s turn`
        : ''
  const busyBanner = bannerText ? `<div class="solo-busy-banner">${bannerText}</div>` : ''

  panel.innerHTML = `
    <header class="solo-hud-top">
      <img class="solo-hud-mark" src="/favicon.svg" alt="" />
      <div class="solo-hud-title">
        <span class="solo-hud-eyebrow">CEPHEUS</span>
        <span class="solo-hud-name">Survive the Horde</span>
      </div>
      <div class="solo-hud-meta">
        <span class="solo-hud-stat">R${s.round}</span>
        <span class="solo-hud-stat">W${s.wave}/${s.wavesTotal}</span>
      </div>
    </header>

    <section class="solo-hud-track">
      <div class="solo-hud-track-head">
        <h2 class="solo-hud-label">Turn order</h2>
        <span class="solo-hud-count">${trackCount}</span>
      </div>
      ${busyBanner}
      <ol class="solo-track-list">${trackHtml(s, trackCombat)}</ol>
    </section>

    ${
      over
        ? `<section class="solo-hud-outcome">
            <div class="solo-outcome${s.phase.t === 'won' ? ' is-won' : ''}">${overText}</div>
            <button id="solo-new" class="solo-foot-btn" type="button">New game</button>
          </section>`
        : ''
    }

    <section class="solo-hud-log${logExpanded ? ' is-expanded' : ''}">
      <div class="solo-hud-log-head">
        <h2 class="solo-hud-label">Combat log</h2>
        <button id="solo-log-toggle" class="solo-log-toggle" type="button" aria-expanded="${logExpanded}">${logExpanded ? 'Minimize' : 'Expand'}</button>
      </div>
      <div class="solo-log-feed">${logHtml(recentLog)}</div>
    </section>

    <footer class="solo-hud-foot">
      <button id="solo-new" class="solo-foot-btn" type="button">New deck</button>
      ${mySeat() === undefined ? '<button id="solo-invite" class="solo-foot-btn" type="button">Play with friends</button>' : ''}
      <label class="solo-foot-check"><input type="checkbox" id="solo-grid" ${showGrid ? 'checked' : ''}/> Grid</label>
      <p class="solo-foot-hint">Move + one action, or run ${MINOR_ACTIONS_PER_ROUND * 6} m. Double-click a foe (or <b>F</b>) to fire; double-click yourself (or <b>Space</b>) to end the turn.</p>
      <p class="solo-foot-hint">Search lockers &amp; terminals for ammo, medkits, and access cards. A sealed door wants its matching keycard or a hack (Electronics).</p>
    </footer>`

  for (const el of panel.querySelectorAll<HTMLElement>('[data-select]')) {
    el.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) return
      const id = el.dataset.select ?? null
      selectedId = selectedId === id ? null : id
      if (selectedId) playUi('select')
      renderPanel()
      requestDraw()
    })
  }
  panel.querySelector<HTMLButtonElement>('#solo-attack')?.addEventListener('click', () => {
    if (enemy) void onAttack(enemy.id)
  })
  panel.querySelector<HTMLButtonElement>('#solo-aim')?.addEventListener('click', () => {
    playUi('select')
    playerAct({t: 'Aim'})
  })
  panel.querySelector<HTMLButtonElement>('#solo-reload')?.addEventListener('click', () => {
    playUi('reload')
    playerAct({t: 'Reload'})
  })
  panel.querySelector<HTMLButtonElement>('#solo-medkit')?.addEventListener('click', () => {
    if (patient) {
      playUi('medkit')
      playerAct({t: 'UseMedkit', targetId: patient.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-pickup')?.addEventListener('click', () => {
    if (loot) {
      playUi('pickup')
      playerAct({t: 'PickUp', groundItemId: loot.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-search')?.addEventListener('click', () => {
    if (searchTarget) {
      playUi('pickup')
      playerAct({t: 'Search', containerId: searchTarget.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-push')?.addEventListener('click', () => {
    if (pushable) {
      playUi('push')
      playerAct({t: 'PushProp', propId: pushable.id})
    }
  })
  panel.querySelector<HTMLButtonElement>('#solo-end')?.addEventListener('click', () => endTurn())
  for (const btn of panel.querySelectorAll<HTMLButtonElement>('[data-stance]')) {
    btn.addEventListener('click', (event) => {
      event.stopPropagation()
      const stance = btn.dataset.stance as CombatStance
      if (!STANCES.includes(stance)) return
      playUi('select')
      playerAct({t: 'SetStance', stance})
    })
  }
  panel.querySelector<HTMLButtonElement>('#solo-log-toggle')?.addEventListener('click', () => {
    logExpanded = !logExpanded
    renderPanel()
  })
  panel.querySelector<HTMLButtonElement>('#solo-new')?.addEventListener('click', () => void newGame())
  panel.querySelector<HTMLButtonElement>('#solo-invite')?.addEventListener('click', () => void promote())
  panel.querySelector<HTMLInputElement>('#solo-grid')?.addEventListener('change', (event) => {
    showGrid = (event.target as HTMLInputElement).checked
    requestDraw()
  })
  updateEndFab()
  computeReachable()
}

// ---- mount ----------------------------------------------------------------
const mount = (): void => {
  const app = document.getElementById('app')
  if (!app) throw new Error('#app not found')
  app.innerHTML = `
    <div class="solo-shell">
      <aside class="solo-panel" id="solo-panel"></aside>
      <div class="solo-board"><canvas id="solo-canvas"></canvas></div>
    </div>`
  panel = app.querySelector('#solo-panel') as HTMLDivElement
  boardViewport = app.querySelector('.solo-board') as HTMLDivElement
  canvas = app.querySelector('#solo-canvas') as HTMLCanvasElement
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is required.')
  ctx = context
  canvas.addEventListener('pointerdown', onBoardPointerDown)
  canvas.addEventListener('wheel', handleWheel, {passive: false})
  canvas.addEventListener('contextmenu', blockContextMenu)
  canvas.addEventListener('touchstart', onTouchStart, {passive: false})
  canvas.addEventListener('touchmove', onTouchMove, {passive: false})
  canvas.addEventListener('touchend', onTouchEnd)
  window.addEventListener('resize', () => {
    updateCanvasDisplaySize()
    focusOnActive(false)
  })
  // Unlock the Web Audio context on the first interaction so weapon sounds play.
  window.addEventListener('pointerdown', () => primeAudio(), {once: true})

  // Big End-Turn button floating over the board (no trip to the side panel), plus
  // Space/Enter as the keyboard equivalent.
  endFab = document.createElement('button')
  endFab.id = 'solo-end-fab'
  endFab.type = 'button'
  endFab.hidden = true
  endFab.innerHTML = 'End Turn <span class="solo-fab-key">Space</span>'
  endFab.addEventListener('click', () => endTurn())
  app.querySelector('.solo-shell')?.appendChild(endFab)
  window.addEventListener('keydown', onKey)

  const params = new URLSearchParams(location.search)
  const seedParam = params.get('seed')
  const requestedSeed = seedParam !== null && Number.isFinite(Number(seedParam)) ? Number(seedParam) : undefined
  const table = params.get('table')
  // ?table=<room> joins a live multiplayer game over a RemoteRoom; otherwise play
  // offline over a LocalRoom (resume or fresh). A failed join falls back to solo.
  if (table) void joinRoom(table, requestedSeed)
  else void bootGame(requestedSeed)
}

mount()

if (import.meta.env.DEV) {
  ;(window as unknown as {__solo: unknown}).__solo = {
    newGame,
    peek: () => state,
    cellOf: (x: number, y: number) => (state ? cellOf(state.grid, x, y) : null),
    // Test helpers (dev only): reposition an entity, select a target, force redraw.
    place: (id: string, x: number, y: number) => {
      if (!state) return
      const e = entityById(state, id)
      if (e) {
        e.x = x
        e.y = y
        renderPos.set(id, {x, y})
      }
      renderPanel()
      requestDraw()
    },
    select: (id: string | null) => {
      selectedId = id
      renderPanel()
      requestDraw()
    },
    attack: (id: string) => onAttack(id),
    endTurn: async () => {
      void endTurn()
      // give the async monster driver time to finish (tweens + beats)
      for (let i = 0; i < 200 && busy; i += 1) await delay(30)
    },
    // Fast-forward `n` turns synchronously (no tweens): PCs idle, monsters use the
    // real AI + reducer, waves spawn on clear. For headless verification only.
    simulate: (n: number) => {
      for (let k = 0; k < n && state && state.phase.t === 'playerTurn'; k += 1) {
        const actor = activeEntity(state)
        if (actor?.faction === 'monster') {
          const plan = decideMonster(state, actor.id)
          for (const cell of plan.moves)
            state = reduce(state, {t: 'Move', to: cellCenter(state.grid, cell.cx, cell.cy)})
          if (plan.attackTargetId) state = reduce(state, {t: 'Attack', targetId: plan.attackTargetId})
        }
        state = reduce(state, {t: 'EndTurn'})
        if (state.phase.t === 'playerTurn' && !state.entities.some((e) => e.faction === 'monster' && !isDead(e))) {
          if (state.wave >= state.wavesTotal) state = {...state, phase: {t: 'won'}}
          else state = reduce(state, {t: 'AddWave', monsters: buildWave(state.map, state.grid, state.wave + 1)})
        }
      }
      renderPanel()
      requestDraw()
    },
    // Preview the dice overlay without driving a full attack (visual tuning only).
    rollDice: async (n = 2) => {
      showDice(boardViewport)
      await rollDice(new Array(n).fill(1))
    },
    hideDice,
    // Slow effects down (or back to 1) for inspection.
    fxTimeScale: (s = 1) => setFxTimeScale(s),
    // Preview a weapon's attack effect (sound + projectile/strike + impact + the
    // Effect callout) across the middle of the map, no combat needed.
    previewFx: (weaponId = 'autorifle', hit = true, effect = 3, killed = false) => {
      if (!state) return
      const cx = state.map.width / 2
      const cy = state.map.height / 2
      const span = state.map.gridScale * 3.5
      spawnAttackFx({
        from: {x: cx - span, y: cy},
        to: {x: cx + span, y: cy},
        weapon: weaponById(weaponId),
        hit,
        effect,
        damage: hit ? Math.max(1, 6 + effect) : 0,
        killed,
        targetFaction: 'monster',
        gridScale: state.map.gridScale
      })
      requestDraw()
    }
  }
}
