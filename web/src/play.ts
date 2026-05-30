// Minimal multiplayer client (separate /play page; the single-player tool at
// index.html is untouched). It opens the per-player SSE stream, renders the
// fog-gated tokens the server sends, draws its own POV fog with the shared core,
// POSTs MoveToken when you click the board, and toggles a door when you click on
// one. Open in two browsers to watch server-authoritative line of sight: another
// player's counter only appears when your point of view can actually see it.
//
//   ?table=<name>  join a specific table (default "demo")
//   ?gm=1          spectator/GM view — sees ALL counters, manages doors, no fog
import {effect, signal} from '@preact/signals'
import {visibilityPolygon, type Occluder, type Point} from './los-core'
import type {Board, CommandEnvelope, CounterKind, Token, ViewMessage} from '../../src/protocol'
import './play.css'

const params = new URLSearchParams(location.search)
const tableId = params.get('table') ?? 'demo'
const isGm = params.get('gm') === '1'

const you = signal<string | null>(null)
const board = signal<Board | null>(null)
const tokens = signal<Token[]>([])
const status = signal('Connecting…')
const mapImage = signal<HTMLImageElement | null>(null)
let loadedAssetRef = ''

// Counter portraits (shared with the single-player tool, served from
// /token-portraits). Cached per kind; loading one bumps portraitTick so the
// render effect redraws once the image is ready.
const portraitTick = signal(0)
const portraits = new Map<CounterKind, HTMLImageElement>()
const portraitFor = (kind: CounterKind): HTMLImageElement => {
  let image = portraits.get(kind)
  if (!image) {
    image = new Image()
    image.onload = () => {
      portraitTick.value += 1
    }
    image.src = `/token-portraits/${kind}.webp`
    portraits.set(kind, image)
  }
  return image
}

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D

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

// Load the GM-uploaded map for a real assetRef; the seed board has no image.
const ensureMap = (next: Board): void => {
  if (!next.assetRef || next.assetRef === 'composed-board') {
    mapImage.value = null
    loadedAssetRef = ''
    return
  }
  if (next.assetRef === loadedAssetRef) return
  loadedAssetRef = next.assetRef
  const image = new Image()
  image.onload = () => {
    mapImage.value = image
  }
  image.src = `/api/tables/${tableId}/map/${next.assetRef}`
}

const applyView = (next: Board, nextTokens: Token[]): void => {
  board.value = next
  tokens.value = nextTokens
  ensureMap(next)
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
  return {
    x: ((event.clientX - rect.left) / rect.width) * active.width,
    y: ((event.clientY - rect.top) / rect.height) * active.height
  }
}

const distanceToSegment = (point: Point, segment: Occluder): number => {
  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(point.x - segment.x1, point.y - segment.y1)
  const t = Math.max(
    0,
    Math.min(1, ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared)
  )
  return Math.hypot(point.x - (segment.x1 + t * dx), point.y - (segment.y1 + t * dy))
}

const doorOpen = (active: Board, door: Occluder): boolean =>
  active.doorStates[door.id]?.open ?? (door.type === 'door' && door.open)

const nearestDoor = (point: Point, active: Board): Occluder | null => {
  let nearest: Occluder | null = null
  let nearestDistance = 26
  for (const occluder of active.occluders) {
    if (occluder.type !== 'door') continue
    const distance = distanceToSegment(point, occluder)
    if (distance < nearestDistance) {
      nearest = occluder
      nearestDistance = distance
    }
  }
  return nearest
}

const onPointerDown = (event: PointerEvent): void => {
  const point = pointerToBoard(event)
  const active = board.value
  if (!point || !active) return

  // Clicking a door toggles it (re-gates everyone's sight). Anywhere else moves.
  const door = nearestDoor(point, active)
  if (door) {
    post({type: 'ToggleDoor', doorId: door.id, open: !doorOpen(active, door)})
    return
  }

  const me = myToken()
  if (!me) return
  // Optimistic local move; the server echo reconciles it.
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
  ctx.save()
  ctx.fillStyle = 'rgba(5, 7, 6, 0.72)'
  ctx.beginPath()
  ctx.rect(0, 0, active.width, active.height)
  if (polygon.length > 2) {
    ctx.moveTo(polygon[0].x, polygon[0].y)
    for (const point of polygon.slice(1)) ctx.lineTo(point.x, point.y)
    ctx.closePath()
    ctx.fill('evenodd')
  } else {
    ctx.fill()
  }
  ctx.restore()

  ctx.strokeStyle = 'rgba(74, 163, 255, 0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(me.x, me.y, active.sightRadius, 0, Math.PI * 2)
  ctx.stroke()
}

const drawToken = (token: Token): void => {
  const mine = token.ownerId === you.value
  const ring = mine ? '#39ff14' : '#4aa3ff'
  const radius = 26
  const image = portraitFor(token.kind)

  ctx.save()
  ctx.beginPath()
  ctx.arc(token.x, token.y, radius, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()
  if (image.complete && image.naturalWidth > 0) {
    ctx.drawImage(image, token.x - radius, token.y - radius, radius * 2, radius * 2)
  } else {
    ctx.fillStyle = ring
    ctx.fill()
  }
  ctx.restore()

  ctx.beginPath()
  ctx.arc(token.x, token.y, radius, 0, Math.PI * 2)
  ctx.lineWidth = 3
  ctx.strokeStyle = ring
  ctx.stroke()

  // Label sits just below the token for legibility over any portrait.
  ctx.font = '700 15px "JetBrains Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 3
  ctx.strokeStyle = '#050505'
  ctx.strokeText(token.label, token.x, token.y + radius + 11)
  ctx.fillStyle = '#f5f5f5'
  ctx.fillText(token.label, token.x, token.y + radius + 11)
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
  if (me) drawFog(active, me) // GM (no token) sees the whole board, no fog
  for (const token of tokens.value) drawToken(token)
}

const mount = (): void => {
  const root = document.querySelector('#app')
  if (!root) throw new Error('Missing #app root.')
  const hint = isGm
    ? 'GM view — you see every counter. Click a door to open/close it.'
    : 'Click the board to move your counter. Click a door to open/close it. Open this URL in another browser to join.'
  root.innerHTML = `
    <header class="play-hud">
      <strong>Line of Sight — Multiplayer</strong>
      <span id="status"></span>
      <span id="who"></span>
      <button id="copyLink" type="button">Copy invite link</button>
      <span class="hint">${hint}</span>
    </header>
    <main class="play-board"><canvas id="board"></canvas></main>`

  const element = document.querySelector<HTMLCanvasElement>('#board')
  const context = element?.getContext('2d')
  if (!element || !context) throw new Error('Canvas unavailable.')
  canvas = element
  ctx = context
  canvas.addEventListener('pointerdown', onPointerDown)
  wireCopyLink()
  connect()
}

// Copy the clean player-join URL for this table (no gm flag) to the clipboard so
// the GM can paste it to players.
const wireCopyLink = (): void => {
  const button = document.querySelector<HTMLButtonElement>('#copyLink')
  if (!button) return
  const inviteUrl = `${location.origin}/play?table=${encodeURIComponent(tableId)}`
  button.addEventListener('click', () => {
    void navigator.clipboard.writeText(inviteUrl).then(
      () => {
        button.textContent = 'Copied!'
        window.setTimeout(() => (button.textContent = 'Copy invite link'), 1500)
      },
      () => {
        // Clipboard blocked (e.g. insecure context) — show the URL to copy by hand.
        button.textContent = inviteUrl
      }
    )
  })
}

mount()

effect(() => {
  portraitTick.value // redraw when a counter portrait finishes loading
  draw()
  const statusEl = document.querySelector('#status')
  if (statusEl) statusEl.textContent = status.value
  const whoEl = document.querySelector('#who')
  if (!whoEl) return
  const me = myToken()
  whoEl.textContent = isGm
    ? `GM · ${tokens.value.length} counters`
    : me
      ? `You are ${me.label} · ${tokens.value.length} visible`
      : ''
})
