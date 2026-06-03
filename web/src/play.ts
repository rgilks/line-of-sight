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
import {drawCounterToken} from './counter-render'
import {distanceToOccluder, visibilityPolygon, type Occluder, type Point} from './los-core'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import {
  canToggleDoorFrom,
  moveRadiusPixels,
  tokenMoveFeet,
  validateTokenMove,
  type Board,
  type CommandEnvelope,
  type Token,
  type ViewMessage
} from '../../src/protocol'
import {publishGeneratedDeck, randomSeed} from './host'
import {playerPlayUrl} from './table-links'
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
const status = signal('Connecting…')
const mapImage = signal<HTMLImageElement | null>(null)
const drawerOpen = signal(true)
const zoom = signal(1)
const minZoom = 0.08
const maxZoom = 4
let loadedMapKey = ''

// Movement animation: renderPos is each token's currently-drawn position; anim
// holds in-flight eases. The rAF loop (rafId/dirty) is the sole owner of draw()
// — see requestDraw/frame below. Kept distinct from fitFrame.
const MOVE_EASE_MS = 350
type Anim = {fromX: number; fromY: number; toX: number; toY: number; start: number}
const renderPos = new Map<string, Point>()
const anim = new Map<string, Anim>()
let rafId = 0
let dirty = false

// Player fog memory: an offscreen mask of everywhere this player's POV has ever
// seen. Areas never seen are fully hidden; explored-but-not-currently-visible
// areas are greyed; the current visibility polygon is clear. Reset when the
// board geometry changes (a new deck means old memory is meaningless).
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

const post = (command: CommandEnvelope['command']): void => {
  const playerId = you.value
  if (!playerId) return
  void fetch(`/api/tables/${tableId}/commands`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({playerId, command} satisfies CommandEnvelope)
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

const applyView = (next: Board, nextTokens: Token[]): void => {
  const previous = board.value
  const geometryChanged = boardGeometryChanged(previous, next)
  reconcileRenderPos(nextTokens, geometryChanged)
  board.value = next
  tokens.value = nextTokens
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

const now = (): number => performance.now()

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

const startEase = (id: string, from: Point, to: Point): void => {
  anim.set(id, {fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, start: now()})
  ensureRaf()
}

// Advance every in-flight ease to time `t`. Returns whether any remain unsettled.
const stepRenderPos = (t: number): boolean => {
  let moving = false
  for (const [id, a] of anim) {
    const progress = Math.min(1, (t - a.start) / MOVE_EASE_MS)
    const eased = 1 - (1 - progress) ** 3 // ease-out cubic
    renderPos.set(id, {
      x: a.fromX + (a.toX - a.fromX) * eased,
      y: a.fromY + (a.toY - a.fromY) * eased
    })
    if (progress >= 1) anim.delete(id)
    else moving = true
  }
  return moving
}

const requestDraw = (): void => {
  dirty = true
  ensureRaf()
}

const ensureRaf = (): void => {
  if (rafId === 0) rafId = requestAnimationFrame(frame)
}

const frame = (t: number): void => {
  rafId = 0
  const moving = stepRenderPos(t)
  draw()
  dirty = false
  if (moving) ensureRaf()
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
    applyView(message.board, message.tokens)
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

const doorOpen = (active: Board, door: Occluder): boolean =>
  active.doorStates[door.id]?.open ?? (door.type === 'door' && door.open)

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

const onPointerDown = (event: PointerEvent): void => {
  if (event.button !== 0 || event.metaKey) return
  const point = pointerToBoard(event)
  const active = board.value
  if (!point || !active) return

  const door = nearestDoor(point, active)
  if (door) {
    if (!canToggleDoors()) {
      status.value = 'Doors are locked — GM only.'
      return
    }
    if (!canToggleDoorFrom(myToken(), active, door, {gm: isGm})) {
      status.value = 'Move next to the door to open it.'
      return
    }
    post({type: 'ToggleDoor', doorId: door.id, open: !doorOpen(active, door)})
    return
  }

  const me = myToken()
  if (!me) return
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
//   - explored but not visible — a translucent grey veil (memory),
//   - never seen — additionally blacked out.
// Layer 1 veils everything outside the current view; layer 2 adds opaque dark
// only over never-explored cells, so explored memory shows through as grey. The
// explored mask accumulates every frame, so moving permanently reveals visited
// areas as memory without exposing the rest. Memory resets on a board change.
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

  const key = `${active.assetRef}:${active.boardSeq ?? 0}:${active.width}x${active.height}`
  if (exploredCtx && (exploredKey !== key || exploredCanvas.width !== active.width)) {
    exploredKey = key
    exploredCanvas.width = active.width
    exploredCanvas.height = active.height
    fogScratch.width = active.width
    fogScratch.height = active.height
    exploredCtx.clearRect(0, 0, active.width, active.height)
  }
  if (exploredCtx && polygon.length > 2) {
    exploredCtx.fillStyle = '#fff'
    exploredCtx.beginPath()
    tracePolygon(exploredCtx, polygon)
    exploredCtx.fill()
  }

  // Layer 1 — translucent veil over everything OUTSIDE the current view.
  ctx.save()
  ctx.fillStyle = 'rgba(8, 11, 10, 0.6)'
  ctx.beginPath()
  ctx.rect(0, 0, active.width, active.height)
  if (polygon.length > 2) {
    tracePolygon(ctx, polygon)
    ctx.fill('evenodd')
  } else {
    ctx.fill()
  }
  ctx.restore()

  // Layer 2 — opaque dark only where NEVER explored. Build it on a scratch canvas:
  // fill solid dark, then punch out the explored mask, then stamp onto the board.
  if (exploredCtx && fogScratchCtx) {
    fogScratchCtx.globalCompositeOperation = 'source-over'
    fogScratchCtx.clearRect(0, 0, active.width, active.height)
    fogScratchCtx.fillStyle = 'rgba(4, 5, 5, 0.93)'
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
  if (me && !isGm) {
    // Fog and the move ring follow the animated position so they glide with the
    // counter rather than snapping ahead of it.
    const animated = {...me, ...positionOf(me)}
    drawFog(active, animated)
    drawMoveRadius(active, animated)
  }
  for (const token of tokens.value) drawToken(token)
  // GM-only room labels, drawn on top of everything (the GM has no fog).
  if (isGm) drawRoomLabels(active)
}

const drawMoveRadius = (active: Board, me: Token): void => {
  const radius = moveRadiusPixels(me, active)
  ctx.save()
  ctx.strokeStyle = 'rgba(57, 255, 20, 0.42)'
  ctx.lineWidth = 2
  ctx.setLineDash([10, 8])
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
  if (isGm) {
    const locked = active != null && !playerDoorControl(active)
    return locked
      ? 'GM view — wheel to zoom; ⌘-drag or right-drag to pan. Doors locked; click doors to toggle.'
      : 'GM view — wheel to zoom; ⌘-drag or right-drag to pan. Click doors to toggle.'
  }
  if (active && !playerDoorControl(active)) {
    return 'Move within the green ring (30 ft by default). Wheel to zoom; ⌘-drag or right-drag to pan. Doors are GM-only.'
  }
  return 'Move within the green ring (30 ft by default). Click doors to toggle. Wheel to zoom; ⌘-drag or right-drag to pan.'
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
            value="${tokenMoveFeet(token, active)}"
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
    post({type: 'SetTokenMoveFeet', playerId, moveFeet: Math.max(0, Number(input.value) || 0)})
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
            <div class="play-brand">
              <strong>Line of Sight</strong>
              <span>${isHost ? 'GM — hosting' : 'Multiplayer'}</span>
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
            <button id="copyLink" type="button">Copy player link</button>
            ${isHost ? '<button id="newMap" class="play-secondary" type="button">New map</button>' : ''}
            ${gmControls}
            <div id="gmTokenMoves" class="play-gm-moves" hidden>
              <h3 class="play-gm-moves-title">Movement (ft / turn)</h3>
              <p class="play-gm-moves-lead">D&amp;D 5e SRD default is 30 ft. Override per counter for haste, slow, etc.</p>
            </div>
            <p class="play-hint">${hintText()}</p>
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
  wireCopyLink()
  wireDoorControl()
  wireGmTokenMoves()
  wireNewMap()
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

mount()

effect(() => {
  portraitTick.value
  mapImage.value
  board.value
  tokens.value
  zoom.value
  drawerOpen.value
  updateCanvasDisplaySize()
  syncGmTokenMoves()
  requestDraw() // the rAF loop owns pixels; this also services token eases
  const statusEl = document.querySelector('#status')
  if (statusEl) statusEl.textContent = status.value
  const whoEl = document.querySelector('#who')
  if (whoEl) {
    const me = myToken()
    const active = board.value
    whoEl.textContent = isGm
      ? `GM · ${tokens.value.length} counters`
      : me && active
        ? `You are ${me.label} · ${tokenMoveFeet(me, active)} ft move · ${tokens.value.length} visible`
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
