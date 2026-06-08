// Solo board display: the shared-screen view of a SoloRoom game (a TV, monitor,
// or projector). It connects to the room's omniscient stream and renders the deck
// the way /solo does — a camera that zooms in and follows the active character
// (biased to keep the nearest visible enemy in frame), and three-tier fog:
// current squad vision is bright, explored areas dim to memory, and never-seen
// areas are opaque black. Read-only — no input; the phones drive the game.
//
// URL: /solo-board?table=<roomId>[&seed=<n>]
import {installErrorReporting} from './error-reporting'
import {renderMap} from './synth/render-map'
import {drawCounterToken} from './counter-render'
import {counterDefinitions, counterPortraits, preloadCounterPortraits} from './state'
import {visibilityPolygon, type Point} from '../../core/los'
import {pointInPolygon} from '../../core/rules'
import {createTweenLoop} from './viewport'
import {isActive, isDead, type Entity, type SoloState} from './solo/model'
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

// Three map-sized fog layers, like /solo: the current squad view, the accumulated
// explored mask (memory), and a scratch for compositing.
const makeLayer = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas')
  const cx = c.getContext('2d')
  if (!cx) throw new Error('No 2D context.')
  return [c, cx]
}
const [cur, curCtx] = makeLayer()
const [explored, exploredCtx] = makeLayer()
const [scratch, scratchCtx] = makeLayer()

type BoardState = Omit<SoloState, 'grid'>
let state: BoardState | null = null

// How many cells span the smaller screen dimension (sets the zoom), how fast the
// camera glides, and the current camera centre + target (deck coordinates).
const CELLS_ACROSS = 15
const CAM_EASE = 0.16
const cam: Point = {x: 0, y: 0}
let camTarget: Point = {x: 0, y: 0}
let camReady = false
let zoom = 1

const dpr = (): number => Math.min(2, window.devicePixelRatio || 1)
const posOf = (e: Entity): Point => renderPos.get(e.id) ?? {x: e.x, y: e.y}

const fitCanvas = (): void => {
  const r = dpr()
  const w = app.clientWidth || window.innerWidth
  const h = app.clientHeight || window.innerHeight
  canvas.width = Math.round(w * r)
  canvas.height = Math.round(h * r)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
}

const sizeFog = (w: number, h: number): void => {
  for (const layer of [cur, explored, scratch]) {
    layer.width = w
    layer.height = h
  }
  exploredCtx.clearRect(0, 0, w, h)
}

const tracePoly = (c: CanvasRenderingContext2D, poly: ReadonlyArray<Point>): void => {
  c.beginPath()
  c.moveTo(poly[0].x, poly[0].y)
  for (let i = 1; i < poly.length; i += 1) c.lineTo(poly[i].x, poly[i].y)
  c.closePath()
}

const marker = (x: number, y: number, r: number, color: string): void => {
  ctx.save()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// The camera follows the active character; if a visible enemy is near, shift the
// centre toward it (capped) so both stay in frame — the player may sit off-centre.
const nextTarget = (s: BoardState, seesSquad: (x: number, y: number) => boolean, halfFrame: number): Point => {
  const active = s.entities[s.turnPtr]
  const focus = active && active.faction === 'pc' ? active : s.entities.find((e) => e.faction === 'pc' && !isDead(e))
  if (!focus) return cam
  const fp = posOf(focus)
  let near: Point | null = null
  let nd = Number.POSITIVE_INFINITY
  for (const e of s.entities) {
    if (e.faction !== 'monster' || isDead(e) || !seesSquad(e.x, e.y)) continue
    const p = posOf(e)
    const d = Math.hypot(p.x - fp.x, p.y - fp.y)
    if (d < nd) {
      nd = d
      near = p
    }
  }
  if (!near) return {x: fp.x, y: fp.y}
  let sx = (near.x - fp.x) * 0.5
  let sy = (near.y - fp.y) * 0.5
  const maxShift = 0.45 * halfFrame
  const sm = Math.hypot(sx, sy)
  if (sm > maxShift) {
    sx = (sx / sm) * maxShift
    sy = (sy / sm) * maxShift
  }
  return {x: fp.x + sx, y: fp.y + sy}
}

const draw = (): void => {
  if (!state) return
  const s = state
  const map = s.map
  const gs = map.gridScale
  const w = map.width
  const h = map.height
  const r = dpr()
  const cssW = canvas.width / r
  const cssH = canvas.height / r
  zoom = Math.min(cssW, cssH) / (CELLS_ACROSS * gs)

  // Glide the camera toward its target (snaps on the first frame of a game).
  if (!camReady) {
    cam.x = camTarget.x
    cam.y = camTarget.y
    camReady = true
  } else {
    cam.x += (camTarget.x - cam.x) * CAM_EASE
    cam.y += (camTarget.y - cam.y) * CAM_EASE
  }

  // Current squad vision = the union of every active PC's visibility polygon.
  const polys = s.entities
    .filter((e) => e.faction === 'pc' && isActive(e))
    .map((e) => {
      const p = posOf(e)
      return visibilityPolygon(p.x, p.y, w, h, s.sightRadius, map.occluders, s.doorStates)
    })
    .filter((poly) => poly.length >= 3)
  const seesSquad = (x: number, y: number): boolean => polys.some((poly) => pointInPolygon({x, y}, poly))

  // Paint the current view into `cur`, then fold it into the explored memory.
  curCtx.clearRect(0, 0, w, h)
  curCtx.fillStyle = '#fff'
  for (const poly of polys) {
    tracePoly(curCtx, poly)
    curCtx.fill()
  }
  exploredCtx.drawImage(cur, 0, 0)

  ctx.setTransform(r, 0, 0, r, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)
  ctx.translate(cssW / 2, cssH / 2)
  ctx.scale(zoom, zoom)
  ctx.translate(-cam.x, -cam.y)

  renderMap(ctx, map)

  // Grey veil everywhere outside the current view (dims explored memory).
  scratchCtx.globalCompositeOperation = 'source-over'
  scratchCtx.clearRect(0, 0, w, h)
  scratchCtx.fillStyle = 'rgba(8, 11, 10, 0.62)'
  scratchCtx.fillRect(0, 0, w, h)
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.drawImage(cur, 0, 0)
  scratchCtx.globalCompositeOperation = 'source-over'
  ctx.drawImage(scratch, 0, 0)

  // Opaque black wherever never explored.
  scratchCtx.globalCompositeOperation = 'source-over'
  scratchCtx.clearRect(0, 0, w, h)
  scratchCtx.fillStyle = '#050606'
  scratchCtx.fillRect(0, 0, w, h)
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.drawImage(explored, 0, 0)
  scratchCtx.globalCompositeOperation = 'source-over'
  ctx.drawImage(scratch, 0, 0)

  // Objects and tokens only where the squad can currently see them.
  for (const prop of s.props)
    if (seesSquad(prop.x, prop.y)) marker(prop.x, prop.y, gs * 0.22, 'rgba(150, 150, 160, 0.85)')
  for (const item of s.ground) if (seesSquad(item.x, item.y)) marker(item.x, item.y, gs * 0.16, '#ffd24a')
  for (const c of s.containers) if (!c.searched && seesSquad(c.x, c.y)) marker(c.x, c.y, gs * 0.18, '#7cd1ff')
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

  camTarget = nextTarget(s, seesSquad, Math.min(cssW, cssH) / 2 / zoom)
}

const {renderPos, startEase, requestDraw} = createTweenLoop({
  easeMs: 360,
  onFrame: () => {
    draw()
    return Math.hypot(camTarget.x - cam.x, camTarget.y - cam.y) > 0.5
  }
})

window.addEventListener('resize', () => {
  fitCanvas()
  requestDraw()
})

const source = new EventSource(
  `/api/solo/${encodeURIComponent(room)}/stream${seedParam ? `?seed=${encodeURIComponent(seedParam)}` : ''}`
)
source.onmessage = (event) => {
  const message = JSON.parse(event.data) as {type?: string; view?: string; state?: BoardState}
  if (message.view !== 'board' || !message.state) return
  if (message.type === 'snapshot') {
    state = message.state
    fitCanvas()
    sizeFog(state.map.width, state.map.height)
    for (const e of state.entities) renderPos.set(e.id, {x: e.x, y: e.y})
    const focus = state.entities[state.turnPtr] ?? state.entities.find((e) => e.faction === 'pc')
    if (focus) camTarget = {x: focus.x, y: focus.y}
    camReady = false
    requestDraw()
    return
  }
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
