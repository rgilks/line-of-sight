// Solo board display: the shared-screen view of a SoloRoom game (a TV, monitor,
// or projector). It connects to the room's omniscient stream, renders the deck
// with the squad's fog of war, animates moves, and shows a join QR so phones pair
// as the controllers. Read-only — no input; the phones drive the game.
//
// URL: /solo-board?table=<roomId>[&seed=<n>]
import {installErrorReporting} from './error-reporting'
import {renderMap} from './synth/render-map'
import {drawCounterToken} from './counter-render'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import {visibilityPolygon, type Point} from '../../core/los'
import {pointInPolygon} from '../../core/rules'
import {createTweenLoop} from './viewport'
import {isDead, type Entity, type SoloState} from './solo/model'
import './solo-board.css'

installErrorReporting('solo-board')

const params = new URLSearchParams(location.search)
const room = params.get('table') ?? 'demo'
const seedParam = params.get('seed')

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing #app root.')

preloadCounterPortraits()

const canvas = document.createElement('canvas')
canvas.className = 'sb-canvas'
app.appendChild(canvas)
const ctx = canvas.getContext('2d')
if (!ctx) throw new Error('No 2D canvas context.')

// Offscreen fog layer, composited over the deck each frame.
const fog = document.createElement('canvas')
const fogCtx = fog.getContext('2d')

// The board needs every field except `grid` (server-only); the snapshot omits it.
type BoardState = Omit<SoloState, 'grid'>
let state: BoardState | null = null

const posOf = (e: Entity): Point => renderPos.get(e.id) ?? {x: e.x, y: e.y}

const marker = (x: number, y: number, r: number, color: string): void => {
  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

const draw = (): void => {
  if (!state) return
  const s = state
  const map = s.map
  const gs = map.gridScale
  renderMap(ctx, map)

  // Squad-vision fog: the union of every living PC's visibility polygon. Monsters
  // and loot outside it stay hidden, so the shared screen preserves the tension.
  const polys = s.entities
    .filter((e) => e.faction === 'pc' && !isDead(e))
    .map((pc) => {
      const p = posOf(pc)
      return visibilityPolygon(p.x, p.y, map.width, map.height, s.sightRadius, map.occluders, s.doorStates)
    })
  const seesSquad = (x: number, y: number): boolean =>
    polys.some((poly) => poly.length >= 3 && pointInPolygon({x, y}, poly))

  if (fogCtx) {
    fog.width = map.width
    fog.height = map.height
    fogCtx.fillStyle = 'rgba(2, 8, 4, 0.84)'
    fogCtx.fillRect(0, 0, map.width, map.height)
    fogCtx.globalCompositeOperation = 'destination-out'
    for (const poly of polys) {
      if (poly.length < 3) continue
      fogCtx.beginPath()
      fogCtx.moveTo(poly[0].x, poly[0].y)
      for (let i = 1; i < poly.length; i += 1) fogCtx.lineTo(poly[i].x, poly[i].y)
      fogCtx.closePath()
      fogCtx.fill()
    }
    fogCtx.globalCompositeOperation = 'source-over'
    ctx.drawImage(fog, 0, 0)
  }

  // Crates / barricades, then loot and unsearched containers the squad can see.
  for (const prop of s.props) marker(prop.x, prop.y, gs * 0.22, 'rgba(150, 150, 160, 0.85)')
  for (const item of s.ground) if (seesSquad(item.x, item.y)) marker(item.x, item.y, gs * 0.16, '#ffd24a')
  for (const c of s.containers) if (!c.searched && seesSquad(c.x, c.y)) marker(c.x, c.y, gs * 0.18, '#7cd1ff')

  // Tokens: PCs always; monsters only when the squad can see them.
  for (const e of s.entities) {
    if (isDead(e)) continue
    if (e.faction === 'monster' && !seesSquad(e.x, e.y)) continue
    const p = posOf(e)
    drawCounterToken(
      ctx,
      {x: p.x, y: p.y, kind: e.kind, label: e.label},
      {gridScale: gs, portraits: counterPortraits, counterDefinitions}
    )
  }
}

const {renderPos, startEase, requestDraw} = createTweenLoop({
  easeMs: 360,
  onFrame: () => {
    draw()
    return false
  }
})

const sizeCanvas = (): void => {
  if (!state) return
  canvas.width = state.map.width
  canvas.height = state.map.height
}

const source = new EventSource(
  `/api/solo/${encodeURIComponent(room)}/stream${seedParam ? `?seed=${encodeURIComponent(seedParam)}` : ''}`
)
source.onmessage = (event) => {
  const message = JSON.parse(event.data) as {type?: string; view?: string; state?: BoardState}
  if (message.view !== 'board' || !message.state) return
  if (message.type === 'snapshot') {
    state = message.state
    sizeCanvas()
    for (const e of state.entities) renderPos.set(e.id, {x: e.x, y: e.y})
    requestDraw()
    return
  }
  // update: dynamic fields only (no map) — merge, then glide any moved token.
  if (!state) return
  const prev = new Map(state.entities.map((e) => [e.id, {x: e.x, y: e.y}]))
  state = {...state, ...message.state}
  for (const e of state.entities) {
    const old = prev.get(e.id)
    if (old && (old.x !== e.x || old.y !== e.y)) startEase(e.id, renderPos.get(e.id) ?? old, {x: e.x, y: e.y})
    else if (!old) renderPos.set(e.id, {x: e.x, y: e.y})
  }
  requestDraw()
}

// Join panel: a QR to the controller (phones pick a character there).
const showJoin = async (): Promise<void> => {
  const joinUrl = `${location.origin}/controller?table=${encodeURIComponent(room)}`
  const panel = document.createElement('aside')
  panel.className = 'sb-join'
  panel.innerHTML = `
    <span class="sb-join-eyebrow">SCAN TO PLAY</span>
    <div class="sb-join-qr" aria-hidden="true"></div>
    <code class="sb-join-url">${joinUrl}</code>`
  app.appendChild(panel)
  try {
    const {default: qrcode} = await import('qrcode-generator')
    const qr = qrcode(0, 'M')
    qr.addData(joinUrl)
    qr.make()
    const slot = panel.querySelector('.sb-join-qr')
    if (slot) slot.innerHTML = qr.createSvgTag({cellSize: 5, margin: 1, scalable: true})
  } catch {
    /* the printed URL is the fallback */
  }
}

void showJoin()
