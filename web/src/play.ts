// Minimal multiplayer client (separate /play page; the single-player tool at
// index.html is untouched). It opens the per-player SSE stream, renders the
// fog-gated tokens the server sends, draws its own POV fog with the shared core,
// POSTs MoveToken when you click the board, and toggles a door when you click on
// one (unless the GM has locked doors). Open in two browsers to watch
// server-authoritative line of sight: another player's counter only appears when
// your point of view can actually see it.
//
//   ?table=<name>  join a specific table (default "demo")
//   ?gm=1          spectator/GM view — sees ALL counters, manages doors, no fog
import {effect, signal} from '@preact/signals'
import {counterTokenSize, drawCounterToken} from './counter-render'
import {drawReachableDoorAffordance} from './door-affordance'
import {distanceToOccluder, visibilityPolygon, type Occluder, type Point} from '../../core/los'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import {
  activeCombatant,
  canToggleDoorFrom,
  combatantForPlayer,
  combatReady,
  isPlayersCombatTurn,
  metersPerSquare,
  moveRadiusPixels,
  tokenMoveMeters,
  tokenMoveSquares,
  validateTokenMove,
  type Board,
  type Combatant,
  type CombatState,
  type ChatSay,
  type CommandEnvelope,
  type Token,
  type ViewMessage
} from '../../src/protocol'
import {publishGeneratedDeck, randomSeed} from './host'
import {playerPlayUrl} from './table-links'
import {createTweenLoop} from './viewport'
import './play.css'

preloadCounterPortraits()

// Redraw when a counter portrait finishes loading.
const portraitTick = signal(0)
const bumpPortraitTick = (): void => {
  portraitTick.value += 1
}
for (const image of counterPortraits.values()) {
  image.addEventListener('load', bumpPortraitTick)
}

// Mode is derived from the path: `/` is the GM host front door (auto-generates a
// deck, publishes it, and runs the table); `/play` is a player (or GM spectator
// with ?gm=1). The host renders as a GM (sees all, no fog) plus a hosting panel.
const params = new URLSearchParams(location.search)
const isHost = location.pathname === '/' || location.pathname === '/host'

// A host keeps a stable table id across reloads: reuse ?table= if present,
// otherwise mint one and reflect it into the URL so F5 rejoins the same table
// (players are not orphaned) and the map is not regenerated.
const resolveTableId = (): string => {
  const fromUrl = params.get('table')
  if (fromUrl) return fromUrl
  if (!isHost) return 'demo'
  const minted = crypto.randomUUID().slice(0, 8)
  const url = new URL(location.href)
  url.searchParams.set('table', minted)
  history.replaceState(null, '', url)
  return minted
}

const tableId = resolveTableId()
// A host minted a fresh id this load ⇒ it owns the table and should publish a
// deck. A host arriving with an id already in the URL is a reload ⇒ reconnect
// without republishing so connected players keep the same map.
const hostShouldPublish = isHost && !params.get('table')
const isGm = isHost || params.get('gm') === '1'

const you = signal<string | null>(null)
const board = signal<Board | null>(null)
const tokens = signal<Token[]>([])
const says = signal<ChatSay[]>([])
const combat = signal<CombatState | null>(null)
const status = signal('Connecting…')
const mapImage = signal<HTMLImageElement | null>(null)
const drawerOpen = signal(true)
const targetTokenId = signal<string | null>(null)

// A chat bubble shows for this long, fading over its final stretch.
const SAY_VISIBLE_MS = 6000
const SAY_FADE_MS = 1200
const zoom = signal(1)
const minZoom = 0.08
const maxZoom = 4
let loadedMapKey = ''

// Movement animation: renderPos is each token's currently-drawn position; anim
// holds in-flight eases. The shared tween/rAF core lives in viewport.ts; the rAF
// loop is the sole owner of draw() — see requestDraw/onFrame below. Kept distinct
// from fitFrame.
const MOVE_EASE_MS = 350
let dirty = false

// Player fog memory: an offscreen mask of everywhere this player's POV has ever
// seen. Never-seen areas are fully hidden (opaque); explored-but-not-currently-
// visible areas are greyed (remembered); the current visibility polygon is clear.
// Reset when the board geometry changes (a new deck means old memory is stale).
const exploredCanvas = document.createElement('canvas')
const exploredCtx = exploredCanvas.getContext('2d')
const fogScratch = document.createElement('canvas')
const fogScratchCtx = fogScratch.getContext('2d')
let exploredKey = ''

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let boardViewport: HTMLDivElement | null = null

let panPointer: {
  pointerId: number
  startX: number
  startY: number
  scrollLeft: number
  scrollTop: number
} | null = null

// Touch gesture state: one finger pans, two fingers pinch-zoom. Tracked
// separately from the desktop pointer-pan so a tap still falls through to a
// move/door action.
type TouchPoint = {id: number; x: number; y: number}
let touchPan: {x: number; y: number; scrollLeft: number; scrollTop: number} | null = null
let pinch: {startDist: number; startZoom: number; boardX: number; boardY: number} | null = null
let touchMoved = false

let fitFrame = 0

const playerDoorControl = (active: Board): boolean => active.playerDoorControl !== false

const canToggleDoors = (): boolean => {
  const active = board.value
  if (!active) return false
  return isGm || playerDoorControl(active)
}

const myToken = (): Token | null => {
  const id = you.value
  return id ? (tokens.value.find((token) => token.ownerId === id) ?? null) : null
}

const targetedToken = (): Token | null => {
  const targetId = targetTokenId.value
  const mine = you.value
  if (!targetId || !mine) return null
  return tokens.value.find((token) => token.id === targetId && token.ownerId !== mine) ?? null
}

const post = (command: CommandEnvelope['command']): void => {
  const playerId = you.value
  if (!playerId) return
  void fetch(`/api/tables/${tableId}/commands`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({playerId, command} satisfies CommandEnvelope)
  }).then(async (response) => {
    if (response.ok) return
    const body = (await response.json().catch(() => null)) as {error?: string} | null
    status.value = body?.error ?? 'Command rejected.'
  })
}

const ensureMap = (next: Board): void => {
  if (!next.assetRef || next.assetRef === 'composed-board') {
    mapImage.value = null
    loadedMapKey = ''
    return
  }
  const mapKey = `${next.assetRef}:${next.boardSeq ?? 0}`
  if (mapKey === loadedMapKey) return
  loadedMapKey = mapKey
  const image = new Image()
  image.onload = () => {
    mapImage.value = image
  }
  image.src = `/api/tables/${tableId}/map/${next.assetRef}?v=${next.boardSeq ?? 0}`
}

const boardGeometryChanged = (previous: Board | null, next: Board): boolean => {
  if (!previous) return true
  if (previous.boardSeq !== next.boardSeq) return true
  if (previous.assetRef !== next.assetRef) return true
  if (previous.width !== next.width || previous.height !== next.height) return true
  if (previous.occluders.length !== next.occluders.length) return true
  if (JSON.stringify(previous.doorStates) !== JSON.stringify(next.doorStates)) return true
  return JSON.stringify(previous.occluders) !== JSON.stringify(next.occluders)
}

const applyView = (
  next: Board,
  nextTokens: Token[],
  nextSays: ChatSay[],
  nextCombat: CombatState | null
): void => {
  const previous = board.value
  const geometryChanged = boardGeometryChanged(previous, next)
  reconcileRenderPos(nextTokens, geometryChanged)
  says.value = nextSays
  combat.value = nextCombat
  board.value = next
  tokens.value = nextTokens
  if (targetTokenId.value && !nextTokens.some((token) => token.id === targetTokenId.value)) {
    targetTokenId.value = null
    status.value = 'Target lost.'
  }
  ensureMap(next)
  syncDoorControlUi(next)
  if (geometryChanged && previous) {
    status.value = isGm ? 'Table map updated.' : 'The GM updated the map.'
  }
  const boardLayoutChanged =
    !previous ||
    previous.width !== next.width ||
    previous.height !== next.height ||
    previous.assetRef !== next.assetRef
  if (boardLayoutChanged) {
    // Player: open zoomed-in centered on their token. GM: fit the whole board.
    scheduleInitialView()
  } else {
    updateCanvasDisplaySize()
  }
}

const updateCanvasDisplaySize = (): void => {
  const active = board.value
  if (!active || !canvas) return
  canvas.style.width = `${active.width * zoom.value}px`
  canvas.style.height = `${active.height * zoom.value}px`
}

// ---- Movement animation -----------------------------------------------------

// Wall-clock epoch ms, to compare against a say's server `sentAt`.
const nowEpoch = (): number => Date.now()

// Per-frame work for the rAF loop. Returns whether to keep ticking beyond the
// tween: while a chat bubble is still fading.
const onFrame = (_t: number, _moving: boolean): boolean => {
  draw()
  dirty = false
  return bubblesActive(nowEpoch())
}

const {renderPos, anim, startEase, ensureRaf} = createTweenLoop({easeMs: MOVE_EASE_MS, onFrame})

const requestDraw = (): void => {
  dirty = true
  ensureRaf()
}

const positionOf = (token: Token): Point => renderPos.get(token.id) ?? {x: token.x, y: token.y}

// Reconcile drawn positions against an incoming token set. New/returning tokens
// snap to their target (joining and fog re-entry must not glide across the map);
// moved tokens start an ease; departed tokens are forgotten. On a map republish
// everything snaps. The local player's own token is special-cased so the
// authoritative SSE echo confirms an in-flight ease instead of restarting it.
const reconcileRenderPos = (nextTokens: Token[], geometryChanged: boolean): void => {
  const seen = new Set<string>()
  for (const token of nextTokens) {
    seen.add(token.id)
    const target = {x: token.x, y: token.y}
    const current = renderPos.get(token.id)
    if (!current || geometryChanged) {
      renderPos.set(token.id, target)
      anim.delete(token.id)
      continue
    }
    const active = anim.get(token.id)
    const targetUnchanged =
      active && Math.hypot(active.toX - target.x, active.toY - target.y) <= 1
    if (targetUnchanged) continue // echo of a move already animating — let it finish
    if (Math.hypot(current.x - target.x, current.y - target.y) <= 1) {
      renderPos.set(token.id, target)
      anim.delete(token.id)
      continue
    }
    startEase(token.id, current, target)
  }
  for (const id of [...renderPos.keys()]) {
    if (!seen.has(id)) {
      renderPos.delete(id)
      anim.delete(id)
    }
  }
  requestDraw()
}

const fitBoardToViewport = (): void => {
  const active = board.value
  if (!boardViewport || !active) return

  const fitPaddingPx = 12
  const availWidth = boardViewport.clientWidth - fitPaddingPx * 2
  const availHeight = boardViewport.clientHeight - fitPaddingPx * 2
  if (availWidth <= 0 || availHeight <= 0) return

  const fitZoom = Math.min(availWidth / active.width, availHeight / active.height)
  zoom.value = Math.min(maxZoom, Math.max(minZoom, fitZoom))
  updateCanvasDisplaySize()
  boardViewport.scrollLeft = 0
  boardViewport.scrollTop = 0
}

// Players start zoomed in with their token centered, so they open on "their
// surroundings" rather than a tiny whole-ship view. Zoom is chosen so the move
// ring (roughly) fills the viewport. The GM keeps the fit-to-board overview.
const centerOnToken = (): void => {
  const active = board.value
  const me = myToken()
  if (!boardViewport || !active || !me) {
    fitBoardToViewport()
    return
  }
  const at = positionOf(me)
  const ringPx = moveRadiusPixels(me, active)
  const avail = Math.min(boardViewport.clientWidth, boardViewport.clientHeight)
  if (avail <= 0) {
    fitBoardToViewport()
    return
  }
  // Fit ~2.6 move-rings across the smaller viewport dimension — close, but with
  // room to see adjacent space.
  const desired = avail / Math.max(1, ringPx * 2.6)
  zoom.value = Math.min(maxZoom, Math.max(minZoom, desired))
  updateCanvasDisplaySize()
  boardViewport.scrollLeft = at.x * zoom.value - boardViewport.clientWidth / 2
  boardViewport.scrollTop = at.y * zoom.value - boardViewport.clientHeight / 2
}

const scheduleInitialView = (): void => {
  const run = isGm ? fitBoardToViewport : centerOnToken
  if (typeof window === 'undefined') {
    run()
    return
  }
  if (fitFrame !== 0) cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => {
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0
      run()
    })
  })
}

const scheduleFitBoardToViewport = (): void => {
  if (typeof window === 'undefined') {
    fitBoardToViewport()
    return
  }

  if (fitFrame !== 0) cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => {
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0
      fitBoardToViewport()
    })
  })
}

const setZoom = (
  nextZoom: number,
  anchor?: {boardX: number; boardY: number; viewportX: number; viewportY: number}
): void => {
  zoom.value = Math.min(maxZoom, Math.max(minZoom, nextZoom))
  updateCanvasDisplaySize()
  if (anchor && boardViewport) {
    boardViewport.scrollLeft = anchor.boardX * zoom.value - anchor.viewportX
    boardViewport.scrollTop = anchor.boardY * zoom.value - anchor.viewportY
  }
}

const handleWheel = (event: WheelEvent): void => {
  const active = board.value
  if (!active || !boardViewport || !canvas) return
  event.preventDefault()

  const rect = canvas.getBoundingClientRect()
  const viewportRect = boardViewport.getBoundingClientRect()
  const boardX = ((event.clientX - rect.left) / rect.width) * active.width
  const boardY = ((event.clientY - rect.top) / rect.height) * active.height
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12

  setZoom(zoom.value * factor, {
    boardX,
    boardY,
    viewportX: event.clientX - viewportRect.left,
    viewportY: event.clientY - viewportRect.top
  })
}

const connect = (): void => {
  const source = new EventSource(`/api/tables/${tableId}/stream${isGm ? '?gm=1' : ''}`)
  source.onopen = () => {
    status.value = `Connected · table "${tableId}"${isGm ? ' · GM view' : ''}`
  }
  source.onerror = () => {
    status.value = 'Disconnected — retrying…'
  }
  source.onmessage = (event) => {
    const message = JSON.parse(event.data) as ViewMessage
    if (message.type === 'snapshot') you.value = message.you
    applyView(message.board, message.tokens, message.says, message.combat ?? null)
  }
  window.addEventListener('beforeunload', () => source.close())
}

const pointerToBoard = (event: PointerEvent): Point | null => {
  const active = board.value
  if (!active) return null
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: ((event.clientX - rect.left) / rect.width) * active.width,
    y: ((event.clientY - rect.top) / rect.height) * active.height
  }
}

const boardPickRadius = (screenPixels: number): number => {
  const active = board.value
  if (!active) return screenPixels
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0) return screenPixels
  return screenPixels * (active.width / rect.width)
}

const nearestDoor = (point: Point, active: Board): Occluder | null => {
  let nearest: Occluder | null = null
  let nearestDistance = boardPickRadius(26)
  for (const occluder of active.occluders) {
    if (occluder.type !== 'door') continue
    const distance = distanceToOccluder(point, occluder)
    if (distance < nearestDistance) {
      nearest = occluder
      nearestDistance = distance
    }
  }
  return nearest
}

const nearestTargetableToken = (point: Point): Token | null => {
  if (isGm) return null
  const mine = you.value
  if (!mine) return null
  let nearest: Token | null = null
  let nearestDistance = boardPickRadius(30)
  for (const token of tokens.value) {
    if (token.ownerId === mine) continue
    const at = positionOf(token)
    const distance = Math.hypot(point.x - at.x, point.y - at.y)
    if (distance < nearestDistance) {
      nearest = token
      nearestDistance = distance
    }
  }
  return nearest
}

const doorOpen = (active: Board, door: Occluder): boolean =>
  active.doorStates[door.id]?.open ?? (door.type === 'door' && door.open)

const screenPixels = (pixels: number): number => Math.max(0.5, pixels / zoom.value)

const rangeMetersBetween = (active: Board, from: Point, to: Point): number =>
  (Math.hypot(to.x - from.x, to.y - from.y) / active.gridScale) * metersPerSquare(active)

const formatRange = (meters: number): string => {
  const rounded = meters >= 10 ? Math.round(meters) : Math.round(meters * 10) / 10
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
}

const targetingStatus = (active: Board, me: Token, target: Token): string => {
  const meters = rangeMetersBetween(active, positionOf(me), positionOf(target))
  return `Targeting ${target.label} · ${formatRange(meters)}`
}

const combatMovementBlockReason = (): string | null => {
  const activeCombat = combat.value
  if (!activeCombat || isGm) return null
  const playerId = you.value
  const mine = combatantForPlayer(activeCombat, playerId)
  if (!mine) return 'You are not in this combat.'
  if (!combatReady(activeCombat)) {
    return mine.initiative == null ? 'Roll initiative before moving.' : 'Waiting for initiative rolls.'
  }
  const current = activeCombatant(activeCombat)
  return current?.playerId === playerId ? null : `${current?.label ?? 'Another combatant'} is acting.`
}

const canMoveNow = (): boolean => combatMovementBlockReason() == null

const drawReachableDoorHints = (active: Board, me: Token): void => {
  if (isGm || !canToggleDoors()) return
  for (const occluder of active.occluders) {
    if (occluder.type === 'door' && canToggleDoorFrom(me, active, occluder)) {
      drawReachableDoorAffordance(ctx, occluder, screenPixels, me)
    }
  }
}

const drawTargetingLine = (active: Board, me: Token, target: Token): void => {
  const from = positionOf(me)
  const to = positionOf(target)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance <= 0) return

  const ux = dx / distance
  const uy = dy / distance
  const px = -uy
  const py = ux
  const tokenRadius = counterTokenSize(active.gridScale) / 2 + screenPixels(5)
  const startInset = Math.min(tokenRadius, distance * 0.25)
  const endInset = Math.min(tokenRadius, distance * 0.35)
  const startX = from.x + ux * startInset
  const startY = from.y + uy * startInset
  const tipX = to.x - ux * endInset
  const tipY = to.y - uy * endInset
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const label = formatRange(rangeMetersBetween(active, from, to))
  const fontSize = screenPixels(12)
  const padX = screenPixels(7)
  const padY = screenPixels(4)
  const arrowLength = screenPixels(15)
  const arrowHalfWidth = screenPixels(6)

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.62)'
  ctx.fillStyle = 'rgba(57, 255, 20, 0.78)'
  ctx.lineWidth = screenPixels(1.6)
  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.lineTo(tipX, tipY)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - ux * arrowLength + px * arrowHalfWidth, tipY - uy * arrowLength + py * arrowHalfWidth)
  ctx.lineTo(tipX - ux * arrowLength - px * arrowHalfWidth, tipY - uy * arrowLength - py * arrowHalfWidth)
  ctx.closePath()
  ctx.fill()

  ctx.font = `800 ${fontSize}px "JetBrains Mono", ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const width = ctx.measureText(label).width + padX * 2
  const height = fontSize + padY * 2
  roundRect(midX - width / 2, midY - height / 2, width, height, screenPixels(5))
  ctx.fillStyle = 'rgba(5, 8, 6, 0.9)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.78)'
  ctx.lineWidth = screenPixels(1.2)
  ctx.stroke()
  ctx.fillStyle = 'rgba(244, 255, 241, 0.96)'
  ctx.fillText(label, midX, midY + screenPixels(0.2))
  ctx.restore()
}

/** Pan gestures: right/middle drag, or ⌘/Meta + left-drag (natural on Mac trackpads). */
const shouldStartPan = (event: PointerEvent): boolean =>
  event.button === 1 || event.button === 2 || (event.button === 0 && event.metaKey)

const onPanPointerMove = (event: PointerEvent): void => {
  if (!boardViewport || !panPointer || panPointer.pointerId !== event.pointerId) return
  event.preventDefault()
  boardViewport.scrollLeft = panPointer.scrollLeft - (event.clientX - panPointer.startX)
  boardViewport.scrollTop = panPointer.scrollTop - (event.clientY - panPointer.startY)
}

const endPanPointer = (event: PointerEvent): void => {
  if (!boardViewport || !panPointer || panPointer.pointerId !== event.pointerId) return
  panPointer = null
  boardViewport.classList.remove('is-panning')
  window.removeEventListener('pointermove', onPanPointerMove)
  window.removeEventListener('pointerup', endPanPointer)
  window.removeEventListener('pointercancel', endPanPointer)
}

const onPanPointerDown = (event: PointerEvent): void => {
  if (!boardViewport || !shouldStartPan(event)) return

  event.preventDefault()
  event.stopPropagation()
  panPointer = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    scrollLeft: boardViewport.scrollLeft,
    scrollTop: boardViewport.scrollTop
  }
  boardViewport.classList.add('is-panning')
  window.addEventListener('pointermove', onPanPointerMove)
  window.addEventListener('pointerup', endPanPointer)
  window.addEventListener('pointercancel', endPanPointer)
}

const blockContextMenu = (event: Event): void => {
  event.preventDefault()
}

// ---- Touch: one-finger pan, two-finger pinch-zoom ---------------------------

const touchList = (event: TouchEvent): TouchPoint[] =>
  Array.from(event.touches).map((t) => ({id: t.identifier, x: t.clientX, y: t.clientY}))

const onTouchStart = (event: TouchEvent): void => {
  if (!boardViewport) return
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
    // Begin a pinch anchored at the midpoint, in board coordinates.
    const active = board.value
    const rect = canvas?.getBoundingClientRect()
    if (!active || !rect) return
    const midX = (touches[0].x + touches[1].x) / 2
    const midY = (touches[0].y + touches[1].y) / 2
    pinch = {
      startDist: Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y),
      startZoom: zoom.value,
      boardX: ((midX - rect.left) / rect.width) * active.width,
      boardY: ((midY - rect.top) / rect.height) * active.height
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
    const viewportRect = boardViewport.getBoundingClientRect()
    const midX = (touches[0].x + touches[1].x) / 2
    const midY = (touches[0].y + touches[1].y) / 2
    const dist = Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
    const factor = dist / Math.max(1, pinch.startDist)
    setZoom(pinch.startZoom * factor, {
      boardX: pinch.boardX,
      boardY: pinch.boardY,
      viewportX: midX - viewportRect.left,
      viewportY: midY - viewportRect.top
    })
  } else if (touchPan && touches.length === 1) {
    const dx = touches[0].x - touchPan.x
    const dy = touches[0].y - touchPan.y
    if (Math.hypot(dx, dy) > 6) touchMoved = true
    if (touchMoved) {
      event.preventDefault()
      boardViewport.scrollLeft = touchPan.scrollLeft - dx
      boardViewport.scrollTop = touchPan.scrollTop - dy
    }
  }
}

const onTouchEnd = (event: TouchEvent): void => {
  // A clean single-finger tap (no drag/pinch) becomes a board action.
  if (!touchMoved && !pinch && event.changedTouches.length === 1 && board.value) {
    const t = event.changedTouches[0]
    handleBoardTap(t.clientX, t.clientY)
  }
  if (event.touches.length === 0) {
    touchPan = null
    pinch = null
  }
}

const onPointerDown = (event: PointerEvent): void => {
  // Touch is handled by the dedicated touch listeners (pan/pinch/tap).
  if (event.pointerType === 'touch') return
  if (event.button !== 0 || event.metaKey) return
  handleBoardTap(event.clientX, event.clientY)
}

// Map a screen point to the board, then act: toggle a nearby door, or move the
// player's own token. Shared by mouse pointer-down and a single-finger touch tap.
const handleBoardTap = (clientX: number, clientY: number): void => {
  const active = board.value
  if (!active || !canvas) return
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const point: Point = {
    x: ((clientX - rect.left) / rect.width) * active.width,
    y: ((clientY - rect.top) / rect.height) * active.height
  }
  const me = myToken()

  const target = nearestTargetableToken(point)
  if (target && me) {
    if (targetTokenId.value === target.id) {
      targetTokenId.value = null
      status.value = `Cleared target ${target.label}.`
    } else {
      targetTokenId.value = target.id
      status.value = targetingStatus(active, me, target)
    }
    requestDraw()
    return
  }

  const door = nearestDoor(point, active)
  if (door) {
    if (!canToggleDoors()) {
      status.value = 'Doors are locked — GM only.'
      return
    }
    if (!canToggleDoorFrom(me, active, door, {gm: isGm})) {
      status.value = 'Move next to the door to open it.'
      return
    }
    post({type: 'ToggleDoor', doorId: door.id, open: !doorOpen(active, door)})
    return
  }

  if (!me) return
  const combatBlock = combatMovementBlockReason()
  if (combatBlock) {
    status.value = combatBlock
    return
  }
  const moveCheck = validateTokenMove(me, active, point, {gm: isGm})
  if (!moveCheck.ok) {
    status.value = moveCheck.reason
    return
  }
  // Optimistically glide from the current drawn position to the destination,
  // then post. The authoritative echo confirms the ease (reconcileRenderPos).
  startEase(me.id, positionOf(me), point)
  tokens.value = tokens.value.map((token) =>
    token.id === me.id ? {...token, x: point.x, y: point.y} : token
  )
  post({type: 'MoveToken', x: point.x, y: point.y})
}

const drawOccluders = (active: Board): void => {
  ctx.lineCap = 'round'
  for (const occluder of active.occluders) {
    ctx.strokeStyle =
      occluder.type === 'door'
        ? doorOpen(active, occluder)
          ? 'rgba(22, 163, 74, 0.85)'
          : 'rgba(249, 115, 22, 0.9)'
        : 'rgba(230, 230, 230, 0.5)'
    ctx.lineWidth = occluder.type === 'door' ? 8 : 4
    ctx.beginPath()
    ctx.moveTo(occluder.x1, occluder.y1)
    ctx.lineTo(occluder.x2, occluder.y2)
    ctx.stroke()
  }
}

const tracePolygon = (target: CanvasRenderingContext2D, polygon: Point[]): void => {
  target.moveTo(polygon[0].x, polygon[0].y)
  for (const point of polygon.slice(1)) target.lineTo(point.x, point.y)
  target.closePath()
}

// Three-tier player fog:
//   - currently visible (inside the POV polygon) — clear,
//   - explored but not currently visible — a translucent grey veil (memory),
//   - never seen — FULLY opaque dark (nothing shows through).
// An accumulating offscreen mask records everywhere this player has ever seen, so
// moving permanently reveals visited rooms as grey memory without exposing the
// rest. The mask resets when the board geometry changes.
const drawFog = (active: Board, me: Token): void => {
  const polygon = visibilityPolygon(
    me.x,
    me.y,
    active.width,
    active.height,
    active.sightRadius,
    active.occluders,
    active.doorStates
  )

  // Reset and resize the explored mask when the board changes.
  const key = `${active.assetRef}:${active.boardSeq ?? 0}:${active.width}x${active.height}`
  if (exploredCtx && (exploredKey !== key || exploredCanvas.width !== active.width)) {
    exploredKey = key
    exploredCanvas.width = active.width
    exploredCanvas.height = active.height
    fogScratch.width = active.width
    fogScratch.height = active.height
    exploredCtx.clearRect(0, 0, active.width, active.height)
  }
  // Accumulate the current view into the explored (ever-seen) mask.
  if (exploredCtx && polygon.length > 2) {
    exploredCtx.fillStyle = '#fff'
    exploredCtx.beginPath()
    tracePolygon(exploredCtx, polygon)
    exploredCtx.fill()
  }

  // Tier 2 — translucent grey veil over everything OUTSIDE the current view (this
  // is what makes already-visited rooms read as dim "memory").
  ctx.save()
  ctx.fillStyle = 'rgba(8, 11, 10, 0.62)'
  ctx.beginPath()
  ctx.rect(0, 0, active.width, active.height)
  if (polygon.length > 2) {
    tracePolygon(ctx, polygon)
    ctx.fill('evenodd')
  } else {
    ctx.fill()
  }
  ctx.restore()

  // Tier 3 — FULLY opaque dark wherever NEVER explored: build solid opaque on a
  // scratch canvas, punch out the ever-seen mask, then stamp it on. So never-seen
  // cells are completely hidden while explored cells keep only the grey veil.
  if (exploredCtx && fogScratchCtx) {
    fogScratchCtx.globalCompositeOperation = 'source-over'
    fogScratchCtx.clearRect(0, 0, active.width, active.height)
    fogScratchCtx.fillStyle = '#050606' // opaque (alpha 1) — no bleed-through
    fogScratchCtx.fillRect(0, 0, active.width, active.height)
    fogScratchCtx.globalCompositeOperation = 'destination-out'
    fogScratchCtx.drawImage(exploredCanvas, 0, 0)
    fogScratchCtx.globalCompositeOperation = 'source-over'
    ctx.drawImage(fogScratch, 0, 0)
  }

  // Sight ring around the player.
  ctx.strokeStyle = 'rgba(74, 163, 255, 0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(me.x, me.y, active.sightRadius, 0, Math.PI * 2)
  ctx.stroke()
}

const drawToken = (token: Token): void => {
  const active = board.value
  if (!active) return
  const mine = token.ownerId === you.value
  const at = positionOf(token)
  drawCounterToken(
    ctx,
    {kind: token.kind, label: token.label, x: at.x, y: at.y},
    {
      gridScale: active.gridScale,
      portraits: counterPortraits,
      counterDefinitions,
      isPov: mine
    }
  )
}

const draw = (): void => {
  const active = board.value
  if (!active) return
  if (canvas.width !== active.width) canvas.width = active.width
  if (canvas.height !== active.height) canvas.height = active.height

  ctx.fillStyle = '#0c0e0d'
  ctx.fillRect(0, 0, active.width, active.height)
  const image = mapImage.value
  if (image) ctx.drawImage(image, 0, 0, active.width, active.height)

  drawOccluders(active)
  const me = myToken()
  const target = me ? targetedToken() : null
  if (me && !isGm) {
    // Fog and the move ring follow the animated position so they glide with the
    // counter rather than snapping ahead of it.
    const animated = {...me, ...positionOf(me)}
    drawFog(active, animated)
    if (canMoveNow()) drawMoveRadius(active, animated)
    drawReachableDoorHints(active, animated)
    if (target) drawTargetingLine(active, animated, target)
  }
  for (const token of tokens.value) drawToken(token)
  // GM-only room labels, drawn on top of everything (the GM has no fog).
  if (isGm) drawRoomLabels(active)
  drawSpeechBubbles(active)
}

// True while any chat bubble is still within its visible+fade lifetime — used to
// keep the rAF loop ticking so bubbles fade out smoothly and then disappear.
const bubblesActive = (t: number): boolean =>
  says.value.some((say) => t - say.sentAt < SAY_VISIBLE_MS + SAY_FADE_MS)

const bubbleAlpha = (say: ChatSay, t: number): number => {
  const age = t - say.sentAt
  if (age < 0) return 1
  if (age < SAY_VISIBLE_MS) return 1
  if (age < SAY_VISIBLE_MS + SAY_FADE_MS) return 1 - (age - SAY_VISIBLE_MS) / SAY_FADE_MS
  return 0
}

// Draw chat bubbles: a player's bubble points at their token's current (animated)
// position; a GM bubble shows as a banner near the top of the board, centred on
// the current view. Bubbles fade out over their final stretch.
const drawSpeechBubbles = (active: Board): void => {
  const t = nowEpoch()
  // Only the most recent bubble per speaker, so rapid messages don't stack.
  const latest = new Map<string, ChatSay>()
  for (const say of says.value) latest.set(say.fromId, say)
  for (const say of latest.values()) {
    const alpha = bubbleAlpha(say, t)
    if (alpha <= 0) continue
    if (say.fromGm) {
      drawGmBanner(active, say, alpha)
      continue
    }
    const token = tokens.value.find((tk) => tk.id === `token-${say.fromId}` || tk.ownerId === say.fromId)
    const at = token ? positionOf(token) : say.at
    drawBubble(active, say.text, at.x, at.y - active.gridScale * 0.9, alpha, false)
  }
}

const drawGmBanner = (active: Board, say: ChatSay, alpha: number): void => {
  // Centre the banner on the visible part of the board (account for scroll/zoom).
  let cx = active.width / 2
  let topY = active.gridScale
  if (boardViewport) {
    cx = (boardViewport.scrollLeft + boardViewport.clientWidth / 2) / zoom.value
    topY = boardViewport.scrollTop / zoom.value + active.gridScale * 0.8
  }
  drawBubble(active, `GM: ${say.text}`, cx, topY, alpha, true)
}

const drawBubble = (
  active: Board,
  text: string,
  anchorX: number,
  anchorY: number,
  alpha: number,
  gm: boolean
): void => {
  const fontSize = Math.max(13, active.gridScale * 0.34)
  ctx.save()
  ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  const padX = fontSize * 0.7
  const padY = fontSize * 0.5
  const maxW = Math.min(active.width * 0.6, fontSize * 22)
  const lines = wrapText(text, maxW)
  const lineH = fontSize * 1.25
  const boxW = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width))) + padX * 2
  const boxH = lines.length * lineH + padY * 2
  // Keep the bubble on the board.
  const bx = Math.max(boxW / 2 + 4, Math.min(active.width - boxW / 2 - 4, anchorX))
  const by = Math.max(boxH / 2 + 4, anchorY - boxH / 2)

  ctx.globalAlpha = alpha
  roundRect(bx - boxW / 2, by - boxH / 2, boxW, boxH, fontSize * 0.5)
  ctx.fillStyle = gm ? 'rgba(57, 255, 20, 0.92)' : 'rgba(244, 246, 243, 0.95)'
  ctx.fill()
  // Little tail toward the speaker (players only).
  if (!gm) {
    ctx.beginPath()
    ctx.moveTo(bx - 6, by + boxH / 2 - 1)
    ctx.lineTo(bx + 6, by + boxH / 2 - 1)
    ctx.lineTo(bx, by + boxH / 2 + 9)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = gm ? '#05140a' : '#0c0e0d'
  lines.forEach((line, i) => {
    ctx.fillText(line, bx, by - boxH / 2 + padY + lineH * (i + 0.5))
  })
  ctx.restore()
}

const wrapText = (text: string, maxWidth: number): string[] => {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 4)
}

const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

const drawMoveRadius = (active: Board, me: Token): void => {
  const radius = moveRadiusPixels(me, active)
  ctx.save()
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.3)'
  ctx.lineWidth = screenPixels(1.2)
  ctx.beginPath()
  ctx.arc(me.x, me.y, radius, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// GM-only room labels (terminal green with a dark halo so they read over the
// map). The server only sends `rooms` to the GM connection, so this never shows
// for players even though the same draw() runs for both.
const drawRoomLabels = (active: Board): void => {
  if (!active.rooms || active.rooms.length === 0) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  for (const room of active.rooms) {
    const size = Math.max(11, Math.min(20, Math.min(room.w, room.h) * 0.18))
    ctx.font = `600 ${size}px "JetBrains Mono", monospace`
    const cx = room.x + room.w / 2
    const cy = room.y + room.h / 2
    ctx.strokeStyle = 'rgba(5, 5, 5, 0.85)'
    ctx.lineWidth = Math.max(2, size * 0.28)
    ctx.strokeText(room.label, cx, cy)
    ctx.fillStyle = 'rgba(57, 255, 20, 0.9)'
    ctx.fillText(room.label, cx, cy)
  }
  ctx.restore()
}

const hintText = (): string => {
  const active = board.value
  const activeCombat = combat.value
  if (isGm) {
    const locked = active != null && !playerDoorControl(active)
    if (activeCombat) {
      return combatReady(activeCombat)
        ? 'Combat running — use the turn arrow to advance, or end combat to unlock everyone.'
        : 'Combat started — waiting for players to roll initiative.'
    }
    return locked
      ? 'GM view — wheel to zoom; ⌘-drag or right-drag to pan. Doors locked; click doors to toggle.'
      : 'GM view — wheel to zoom; ⌘-drag or right-drag to pan. Click doors to toggle.'
  }
  if (activeCombat) {
    const mine = combatantForPlayer(activeCombat, you.value)
    if (!combatReady(activeCombat)) {
      return mine?.initiative == null
        ? 'Combat started. Roll initiative before moving.'
        : 'Waiting for the remaining initiative rolls.'
    }
    return isPlayersCombatTurn(activeCombat, you.value)
      ? 'Your turn. Move within the green ring, then tap the down arrow to end your turn.'
      : 'Combat is locked to the current turn. You can target, but only the active combatant can move.'
  }
  if (active && !playerDoorControl(active)) {
    return 'Click visible counters to target. Move within the green ring (6 m / 4 squares by default). Wheel to zoom; ⌘-drag or right-drag to pan. Doors are GM-only.'
  }
  return 'Click visible counters to target. Move within the green ring (6 m / 4 squares by default). Click doors to toggle. Wheel to zoom; ⌘-drag or right-drag to pan.'
}

const syncDoorControlUi = (active: Board): void => {
  const checkbox = document.querySelector<HTMLInputElement>('#playerDoors')
  const hint = document.querySelector('.play-hint')
  if (checkbox) checkbox.checked = playerDoorControl(active)
  if (hint) hint.textContent = hintText()
}

const wireDoorControl = (): void => {
  const checkbox = document.querySelector<HTMLInputElement>('#playerDoors')
  if (!checkbox) return
  checkbox.addEventListener('change', () => {
    post({type: 'SetPlayerDoorControl', enabled: checkbox.checked})
  })
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })

// The collapsed-drawer rail: visible portraits out of combat, initiative order
// during combat. The server already filters this per viewer.
const portraitForKind = (kind: string): string =>
  counterDefinitions.find((d) => d.kind === kind)?.portrait ??
  counterDefinitions[0].portrait

const tokenForCombatant = (combatant: Combatant): Token | null =>
  tokens.value.find((token) => token.ownerId === combatant.playerId) ?? null

const initiativeText = (combatant: Combatant): string =>
  combatant.initiative == null ? 'roll' : String(combatant.initiative)

const combatantClasses = (combatant: Combatant, active: Combatant | null): string => {
  const classes = ['play-combatant']
  if (combatant.playerId === you.value) classes.push('is-me')
  if (active?.playerId === combatant.playerId) classes.push('is-active')
  if (combatant.initiative == null) classes.push('is-pending')
  return classes.join(' ')
}

const combatantRowHtml = (combatant: Combatant, active: Combatant | null): string => {
  const dice = combatant.dice ? ` (${combatant.dice[0]}+${combatant.dice[1]})` : ''
  return `<div class="${combatantClasses(combatant, active)}">
    <span class="play-combatant-label">${escapeHtml(combatant.label)}</span>
    <span class="play-combatant-score">${initiativeText(combatant)}${dice}</span>
  </div>`
}

const canRollInitiative = (activeCombat: CombatState | null): boolean => {
  if (isGm) return false
  const mine = combatantForPlayer(activeCombat, you.value)
  return mine != null && mine.initiative == null
}

const canAdvanceCombat = (activeCombat: CombatState | null): boolean =>
  combatReady(activeCombat) && (isGm || isPlayersCombatTurn(activeCombat, you.value))

const syncCombatPanel = (): void => {
  const panel = document.querySelector<HTMLDivElement>('#combatPanel')
  if (!panel) return
  const activeCombat = combat.value

  if (!activeCombat) {
    if (!isGm) {
      panel.hidden = true
      panel.innerHTML = ''
      return
    }
    panel.hidden = false
    panel.innerHTML = `
      <h3 class="play-combat-title">Combat</h3>
      <button class="play-combat-button" type="button" data-combat-action="start">Start combat</button>`
    return
  }

  const ready = combatReady(activeCombat)
  const active = activeCombatant(activeCombat)
  const waiting = activeCombat.combatants.filter((combatant) => combatant.initiative == null).length
  const statusLine = ready
    ? `Round ${activeCombat.round} · ${active?.label ?? 'Unknown'} acting`
    : `Initiative · ${waiting} to roll`
  const rollButton = canRollInitiative(activeCombat)
    ? '<button class="play-combat-button" type="button" data-combat-action="roll">Roll initiative</button>'
    : ''
  const advanceButton = ready
    ? `<button class="play-combat-button" type="button" data-combat-action="advance" ${
        canAdvanceCombat(activeCombat) ? '' : 'disabled'
      }>End turn ↓</button>`
    : ''
  const endButton = isGm
    ? '<button class="play-combat-button play-combat-danger" type="button" data-combat-action="end">End combat</button>'
    : ''

  panel.hidden = false
  panel.innerHTML = `
    <h3 class="play-combat-title">Combat</h3>
    <p class="play-combat-status">${escapeHtml(statusLine)}</p>
    <div class="play-combat-list">${activeCombat.combatants
      .map((combatant) => combatantRowHtml(combatant, active))
      .join('')}</div>
    <div class="play-combat-actions">${rollButton}${advanceButton}${endButton}</div>`
}

const syncPortraitRail = (): void => {
  const rail = document.querySelector<HTMLDivElement>('#portraitRail')
  if (!rail) return
  const activeCombat = combat.value
  if (activeCombat) {
    const active = activeCombatant(activeCombat)
    const ready = combatReady(activeCombat)
    const rollEnabled = canRollInitiative(activeCombat)
    const advanceEnabled = canAdvanceCombat(activeCombat)
    const action = ready ? 'advance' : 'roll'
    const actionText = ready ? '↓' : '2D6'
    const actionDisabled = ready ? !advanceEnabled : !rollEnabled
    const html = `<div class="play-initiative-rail">
      <div class="play-initiative-list">${activeCombat.combatants
        .map((combatant) => {
          const token = tokenForCombatant(combatant)
          return `<div class="${combatantClasses(combatant, active)}" title="${escapeHtml(combatant.label)}">
            <img src="${portraitForKind(token?.kind ?? 'officer')}" alt="${escapeHtml(combatant.label)}" loading="lazy" />
            <span class="play-combatant-label">${escapeHtml(combatant.label)}</span>
            <span class="play-combatant-score">${initiativeText(combatant)}</span>
          </div>`
        })
        .join('')}</div>
      <button
        class="play-rail-action"
        type="button"
        data-combat-action="${action}"
        ${actionDisabled ? 'disabled' : ''}
        aria-label="${ready ? 'End turn' : 'Roll initiative'}"
      >${actionText}</button>
    </div>`
    if (rail.innerHTML !== html) rail.innerHTML = html
    return
  }
  const mine = you.value
  const ordered = [...tokens.value].sort((a, b) => {
    if (a.ownerId === mine) return -1
    if (b.ownerId === mine) return 1
    return a.label.localeCompare(b.label)
  })
  const html = ordered
    .map((token) => {
      const isMe = token.ownerId === mine
      return `<div class="play-portrait${isMe ? ' is-me' : ''}" title="${escapeHtml(token.label)}">
        <img src="${portraitForKind(token.kind)}" alt="${escapeHtml(token.label)}" loading="lazy" />
        <span>${escapeHtml(token.label)}</span>
      </div>`
    })
    .join('')
  if (rail.innerHTML !== html) rail.innerHTML = html
}

const wireCombatControls = (): void => {
  document.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-combat-action]')
    if (!button || button.disabled) return
    const action = button.dataset.combatAction
    if (action === 'start') {
      status.value = 'Starting combat…'
      post({type: 'StartCombat'})
    } else if (action === 'roll') {
      status.value = 'Rolling initiative…'
      post({type: 'RollInitiative'})
    } else if (action === 'advance') {
      post({type: 'AdvanceTurn'})
    } else if (action === 'end') {
      status.value = 'Ending combat…'
      post({type: 'EndCombat'})
    }
  })
}

const syncGmTokenMoves = (): void => {
  const container = document.querySelector<HTMLDivElement>('#gmTokenMoves')
  if (!container) return
  if (!isGm) {
    container.hidden = true
    return
  }

  const active = board.value
  container.hidden = false
  const list = document.querySelector('#gmTokenMoveList')
  if (!list) {
    const listEl = document.createElement('div')
    listEl.id = 'gmTokenMoveList'
    listEl.className = 'play-gm-move-list'
    container.appendChild(listEl)
  }

  const moveList = document.querySelector('#gmTokenMoveList')
  if (!moveList || !active) return

  const owned = [...tokens.value].sort((a, b) => a.label.localeCompare(b.label))
  moveList.innerHTML = owned
    .map(
      (token) => `
        <label class="play-gm-move-row">
          <span>${token.label}</span>
          <input
            type="number"
            min="0"
            max="999"
            step="5"
            value="${tokenMoveMeters(token, active)}"
            data-player-id="${token.ownerId}"
            aria-label="Move feet for ${token.label}"
          />
        </label>`
    )
    .join('')
}

const wireGmTokenMoves = (): void => {
  const container = document.querySelector('#gmTokenMoves')
  if (!container || !isGm) return
  container.addEventListener('change', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-player-id]')
    if (!input) return
    const playerId = input.dataset.playerId
    if (!playerId) return
    post({type: 'SetTokenMoveMeters', playerId, moveMeters: Math.max(0, Number(input.value) || 0)})
  })
}

const mount = (): void => {
  const root = document.querySelector('#app')
  if (!root) throw new Error('Missing #app root.')
  const gmControls = isGm
    ? `<label class="gm-door-lock">
        <input id="playerDoors" type="checkbox" checked />
        Players can open doors
      </label>`
    : ''
  root.innerHTML = `
    <div class="play-shell">
      <aside class="play-drawer open" aria-label="Session controls">
        <div class="play-drawer-panel">
          <header class="play-drawer-header">
            <div class="play-brand" aria-label="Cepheus · Line of Sight">
              <img class="play-brand-mark" src="/favicon.svg" alt="" width="28" height="28" />
              <div class="play-brand-copy">
                <span class="play-brand-eyebrow">CEPHEUS</span>
                <strong class="play-brand-tool">Line of Sight</strong>
                <span class="play-brand-role">${isHost ? 'GM — hosting' : 'Multiplayer'}</span>
              </div>
            </div>
            <button
              id="drawerToggle"
              class="play-drawer-toggle"
              type="button"
              aria-expanded="true"
              aria-label="Hide session panel"
            >
              <svg class="play-drawer-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          </header>
          <div id="portraitRail" class="play-portrait-rail" aria-label="Visible characters"></div>
          <div class="play-drawer-content">
            <dl class="play-meta">
              <div>
                <dt>Status</dt>
                <dd id="status"></dd>
              </div>
              <div>
                <dt>Table</dt>
                <dd>${tableId}</dd>
              </div>
              <div>
                <dt>You</dt>
                <dd id="who"></dd>
              </div>
            </dl>
            ${isHost ? '<button id="copyLink" type="button">Copy player link</button>' : ''}
            ${isHost ? '<button id="newMap" class="play-secondary" type="button">New map</button>' : ''}
            ${gmControls}
            <div id="combatPanel" class="play-combat-panel" hidden></div>
            <div id="gmTokenMoves" class="play-gm-moves" hidden>
              <h3 class="play-gm-moves-title">Movement (m / round)</h3>
              <p class="play-gm-moves-lead">Cepheus Engine default is 6 m (≈ 4 squares of 1.5 m). Override per counter.</p>
            </div>
            <p class="play-hint">${hintText()}</p>
            <form id="chatForm" class="play-chat" autocomplete="off">
              <input
                id="chatInput"
                type="text"
                maxlength="200"
                placeholder="Say something…"
                aria-label="Chat message"
              />
              <button type="submit" aria-label="Send">Say</button>
            </form>
          </div>
        </div>
      </aside>
      <main class="play-board">
        <div id="playBoardViewport" class="play-board-viewport">
          <div class="play-board-canvas-host">
            <canvas id="board"></canvas>
          </div>
        </div>
      </main>
    </div>`

  document.querySelector('#drawerToggle')?.addEventListener('click', () => {
    drawerOpen.value = !drawerOpen.value
  })

  boardViewport = document.querySelector<HTMLDivElement>('#playBoardViewport')
  const element = document.querySelector<HTMLCanvasElement>('#board')
  const context = element?.getContext('2d')
  if (!element || !context || !boardViewport) throw new Error('Canvas unavailable.')
  canvas = element
  ctx = context
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('contextmenu', blockContextMenu)
  boardViewport.addEventListener('wheel', handleWheel, {passive: false})
  boardViewport.addEventListener('pointerdown', onPanPointerDown, {capture: true})
  boardViewport.addEventListener('contextmenu', blockContextMenu)
  // Touch gestures: one-finger pan, two-finger pinch-zoom, tap = board action.
  boardViewport.addEventListener('touchstart', onTouchStart, {passive: false})
  boardViewport.addEventListener('touchmove', onTouchMove, {passive: false})
  boardViewport.addEventListener('touchend', onTouchEnd)
  boardViewport.addEventListener('touchcancel', onTouchEnd)
  wireCopyLink()
  wireDoorControl()
  wireCombatControls()
  wireGmTokenMoves()
  wireNewMap()
  wireChat()
  void startSession()
}

// Host: publish a generated deck (first load only) before connecting, so the GM
// never flashes the seed board. Player/GM-spectator: connect straight away.
const startSession = async (): Promise<void> => {
  if (hostShouldPublish) {
    status.value = 'Generating a deck…'
    try {
      const {rooms} = await publishGeneratedDeck(tableId, randomSeed())
      status.value = `Hosting · ${rooms} rooms · share the player link`
    } catch (error) {
      status.value = error instanceof Error ? error.message : 'Could not generate a deck.'
      return
    }
  }
  connect()
}

const wireCopyLink = (): void => {
  const button = document.querySelector<HTMLButtonElement>('#copyLink')
  if (!button) return
  const inviteUrl = playerPlayUrl(tableId)
  const label = button.textContent ?? 'Copy player link'
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(inviteUrl).then(
      () => {
        button.textContent = 'Copied!'
        window.setTimeout(() => (button.textContent = label), 1500)
      },
      () => {
        button.textContent = inviteUrl
      }
    )
  })
}

// Host "New map": regenerate and republish to the SAME table id. Connected
// players hot-swap to the new deck (the DO bumps boardSeq and re-projects).
const wireNewMap = (): void => {
  const button = document.querySelector<HTMLButtonElement>('#newMap')
  if (!button || !isHost) return
  button.addEventListener('click', () => {
    button.disabled = true
    status.value = 'Generating a new deck…'
    void publishGeneratedDeck(tableId, randomSeed())
      .then(({rooms}) => {
        status.value = `New deck · ${rooms} rooms`
      })
      .catch((error: unknown) => {
        status.value = error instanceof Error ? error.message : 'Could not generate a deck.'
      })
      .finally(() => {
        button.disabled = false
      })
  })
}

const wireChat = (): void => {
  const form = document.querySelector<HTMLFormElement>('#chatForm')
  const input = document.querySelector<HTMLInputElement>('#chatInput')
  if (!form || !input) return
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    post({type: 'Say', text})
    input.value = ''
  })
}

mount()

// Register the service worker so the app is installable as a PWA (home-screen on
// iOS/iPad, standalone window). The SW never caches the live game API.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW is a progressive enhancement; ignore registration failures */
    })
  })
}

effect(() => {
  portraitTick.value
  mapImage.value
  board.value
  tokens.value
  says.value
  combat.value
  targetTokenId.value
  zoom.value
  drawerOpen.value
  updateCanvasDisplaySize()
  syncCombatPanel()
  syncGmTokenMoves()
  syncPortraitRail()
  requestDraw() // the rAF loop owns pixels; this also services token eases
  const statusEl = document.querySelector('#status')
  if (statusEl) statusEl.textContent = status.value
  const hintEl = document.querySelector('.play-hint')
  if (hintEl) hintEl.textContent = hintText()
  const whoEl = document.querySelector('#who')
  if (whoEl) {
    const me = myToken()
    const active = board.value
    whoEl.textContent = isGm
      ? `GM · ${tokens.value.length} counters`
      : me && active
        ? `You are ${me.label} · ${tokenMoveMeters(me, active)} m / ${tokenMoveSquares(me, active)} sq · ${tokens.value.length} visible`
        : ''
  }

  const drawer = document.querySelector('.play-drawer')
  const toggle = document.querySelector('#drawerToggle')
  const icon = document.querySelector('.play-drawer-icon')
  if (drawer) {
    drawer.classList.remove('open', 'closed')
    drawer.classList.add(drawerOpen.value ? 'open' : 'closed')
  }
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(drawerOpen.value))
    toggle.setAttribute('aria-label', drawerOpen.value ? 'Hide session panel' : 'Show session panel')
  }
  if (icon) {
    icon.innerHTML = drawerOpen.value ? '<path d="m15 18-6-6 6-6" />' : '<path d="m9 18 6-6-6-6" />'
  }
})
