// Minimal multiplayer client (separate /play page; the single-player tool at
// index.html is untouched). It opens the per-player SSE stream, renders the
// fog-gated tokens the server sends, draws its own POV fog with the shared core,
// and POSTs MoveToken when you click the board. Open in two browsers to watch
// server-authoritative line of sight: another player's counter only appears when
// your point of view can actually see it.
import {effect, signal} from '@preact/signals'
import {visibilityPolygon, type Point} from './los-core'
import type {Board, CommandEnvelope, Token, ViewMessage} from '../../src/protocol'
import './play.css'

const tableId = new URLSearchParams(location.search).get('table') ?? 'demo'

const you = signal<string | null>(null)
const board = signal<Board | null>(null)
const tokens = signal<Token[]>([])
const status = signal('Connecting…')
const mapImage = signal<HTMLImageElement | null>(null)
let loadedAssetRef = ''

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

const connect = (): void => {
  const source = new EventSource(`/api/tables/${tableId}/stream`)
  source.onopen = () => {
    status.value = `Connected · table "${tableId}"`
  }
  source.onerror = () => {
    status.value = 'Disconnected — retrying…'
  }
  source.onmessage = (event) => {
    const message = JSON.parse(event.data) as ViewMessage
    if (message.type === 'snapshot') {
      you.value = message.you
      board.value = message.board
      tokens.value = message.tokens
      ensureMap(message.board)
      return
    }
    tokens.value = message.tokens
    const current = board.value
    if (current) board.value = {...current, doorStates: message.doorStates}
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

const onPointerDown = (event: PointerEvent): void => {
  const point = pointerToBoard(event)
  const me = myToken()
  if (!point || !me) return
  // Optimistic local move; the server echo reconciles it.
  tokens.value = tokens.value.map((token) =>
    token.id === me.id ? {...token, x: point.x, y: point.y} : token
  )
  post({type: 'MoveToken', x: point.x, y: point.y})
}

const drawOccluders = (active: Board): void => {
  ctx.lineCap = 'round'
  for (const occluder of active.occluders) {
    const open = occluder.type === 'door' && (active.doorStates[occluder.id]?.open ?? occluder.open)
    ctx.strokeStyle =
      occluder.type === 'door'
        ? open
          ? 'rgba(22, 163, 74, 0.85)'
          : 'rgba(249, 115, 22, 0.9)'
        : 'rgba(230, 230, 230, 0.5)'
    ctx.lineWidth = occluder.type === 'door' ? 6 : 4
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
  ctx.beginPath()
  ctx.arc(token.x, token.y, 26, 0, Math.PI * 2)
  ctx.fillStyle = mine ? '#39ff14' : '#4aa3ff'
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = '#050505'
  ctx.stroke()
  ctx.fillStyle = '#050505'
  ctx.font = '700 22px "JetBrains Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(token.label, token.x, token.y)
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

const mount = (): void => {
  const root = document.querySelector('#app')
  if (!root) throw new Error('Missing #app root.')
  root.innerHTML = `
    <header class="play-hud">
      <strong>Line of Sight — Multiplayer</strong>
      <span id="status"></span>
      <span id="who"></span>
      <span class="hint">Click the board to move your counter. Open this URL in another browser to join.</span>
    </header>
    <main class="play-board"><canvas id="board"></canvas></main>`

  const element = document.querySelector<HTMLCanvasElement>('#board')
  const context = element?.getContext('2d')
  if (!element || !context) throw new Error('Canvas unavailable.')
  canvas = element
  ctx = context
  canvas.addEventListener('pointerdown', onPointerDown)
  connect()
}

mount()

effect(() => {
  draw()
  const statusEl = document.querySelector('#status')
  if (statusEl) statusEl.textContent = status.value
  const whoEl = document.querySelector('#who')
  const me = myToken()
  if (whoEl) whoEl.textContent = me ? `You are ${me.label} · ${tokens.value.length} visible` : ''
})
