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
import {visibilityPolygon, type Occluder, type Point} from './los-core'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import type {Board, CommandEnvelope, Token, ViewMessage} from '../../src/protocol'
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

const params = new URLSearchParams(location.search)
const tableId = params.get('table') ?? 'demo'
const isGm = params.get('gm') === '1'

const you = signal<string | null>(null)
const board = signal<Board | null>(null)
const tokens = signal<Token[]>([])
const status = signal('Connecting…')
const mapImage = signal<HTMLImageElement | null>(null)
let loadedAssetRef = ''

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D

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
  syncDoorControlUi(next)
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

  const door = nearestDoor(point, active)
  if (door) {
    if (canToggleDoors()) {
      post({type: 'ToggleDoor', doorId: door.id, open: !doorOpen(active, door)})
    }
    return
  }

  const me = myToken()
  if (!me) return
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
  const active = board.value
  if (!active) return
  const mine = token.ownerId === you.value
  drawCounterToken(
    ctx,
    {kind: token.kind, label: token.label, x: token.x, y: token.y},
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
  if (me) drawFog(active, me)
  for (const token of tokens.value) drawToken(token)
}

const hintText = (): string => {
  const active = board.value
  if (isGm) {
    const locked = active != null && !playerDoorControl(active)
    return locked
      ? 'GM view — doors locked (players cannot toggle). Click a door to open/close it.'
      : 'GM view — you see every counter. Click a door to open/close it.'
  }
  if (active && !playerDoorControl(active)) {
    return 'Click the board to move your counter. Doors are locked — ask the GM to open them.'
  }
  return 'Click the board to move your counter. Click a door to open/close it. Open this URL in another browser to join.'
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
      <aside class="play-sidebar" aria-label="Session controls">
        <div class="play-brand">
          <strong>Line of Sight</strong>
          <span>Multiplayer</span>
        </div>
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
        <button id="copyLink" type="button">Copy invite link</button>
        ${gmControls}
        <p class="play-hint">${hintText()}</p>
      </aside>
      <main class="play-board"><canvas id="board"></canvas></main>
    </div>`

  const element = document.querySelector<HTMLCanvasElement>('#board')
  const context = element?.getContext('2d')
  if (!element || !context) throw new Error('Canvas unavailable.')
  canvas = element
  ctx = context
  canvas.addEventListener('pointerdown', onPointerDown)
  wireCopyLink()
  wireDoorControl()
  connect()
}

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
        button.textContent = inviteUrl
      }
    )
  })
}

mount()

effect(() => {
  portraitTick.value
  board.value
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
