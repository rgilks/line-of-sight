// EXPERIMENTAL map-generator page (/generate, branch spike/synthetic-maps).
// Generate a deck from a seed + spec, render it in TRE style, toggle the LOS
// occluder overlay to confirm walls/doors line up with the drawing, and export
// a sidecar that drops straight into the existing publish-to-table flow.
// Self-contained; the live tool is untouched.
import {generateMap} from './synth/generate-map'
import {renderLabels, renderMap} from './synth/render-map'
import {defaultSpec, type MapSpec, type RoomType, type Theme} from './synth/types'
import './generate.css'

const THEMES: Theme[] = ['civilian', 'military', 'industrial', 'derelict']
const ALL_TYPES: RoomType[] = [
  'bridge',
  'quarters',
  'cargo',
  'medbay',
  'engineering',
  'common',
  'fresher',
  'storage'
]

let spec: MapSpec = defaultSpec(1)
let showOverlay = false
let showLabels = true // GM view by default; toggle off to preview the player view

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let labelCanvas: HTMLCanvasElement
let labelCtx: CanvasRenderingContext2D
let meta: HTMLElement

const regenerate = (): void => {
  const map = generateMap(spec)
  canvas.width = map.width
  canvas.height = map.height
  labelCanvas.width = map.width
  labelCanvas.height = map.height
  renderMap(ctx, map)

  // GM-only room labels live on their own layer so they can be hidden from the
  // player view without re-rendering the map.
  if (showLabels) renderLabels(labelCtx, map)
  else labelCtx.clearRect(0, 0, map.width, map.height)

  if (showOverlay) {
    for (const o of map.occluders) {
      ctx.strokeStyle = o.type === 'door' ? '#ff3b3b' : '#39ff14'
      ctx.lineWidth = o.type === 'door' ? 6 : 3
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(o.x1, o.y1)
      ctx.lineTo(o.x2, o.y2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  const walls = map.occluders.filter((o) => o.type === 'wall').length
  const doors = map.occluders.filter((o) => o.type === 'door').length
  meta.textContent = `seed ${spec.seed} · ${map.rooms.length} rooms · ${walls} walls · ${doors} doors · ${map.decorations.length} furnishings`
}

const exportSidecar = (map = generateMap(spec)): void => {
  const sidecar = {
    assetRef: `synth-${spec.seed}`,
    width: map.width,
    height: map.height,
    gridScale: map.gridScale,
    occluders: map.occluders,
    // GM-only room metadata: lets the table render the same hideable label layer.
    rooms: map.rooms.map((r) => ({id: r.id, type: r.type, label: r.label, x: r.x, y: r.y, w: r.w, h: r.h}))
  }
  const json = `${JSON.stringify(sidecar, null, 2)}\n`
  const blob = new Blob([json], {type: 'application/json'})
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `synth-${spec.seed}-sidecar.json`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const mount = (): void => {
  const root = document.querySelector('#app')
  if (!root) throw new Error('Missing #app root.')
  root.innerHTML = `
    <header class="gen-hud">
      <strong>Map Generator</strong>
      <label>seed <input id="seed" type="number" value="1" /></label>
      <button id="roll" class="ghost" type="button">🎲 random</button>
      <label>theme
        <select id="theme">${THEMES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      </label>
      <label>size
        <input id="cols" type="number" min="12" max="48" value="28" /> ×
        <input id="rows" type="number" min="12" max="48" value="28" />
      </label>
      <label>furniture
        <input id="density" type="range" min="0" max="1" step="0.1" value="0.7" />
      </label>
      <label>require <input id="required" type="text" placeholder="bridge, cargo" /></label>
      <button id="gen" type="button">Generate</button>
      <button id="labels" class="ghost active" type="button">Labels (GM)</button>
      <button id="overlay" class="ghost" type="button">LOS overlay</button>
      <button id="export" class="ghost" type="button">Export sidecar</button>
      <span id="meta" class="meta"></span>
    </header>
    <main class="gen-board">
      <div class="gen-stack">
        <canvas id="board"></canvas>
        <canvas id="labelboard"></canvas>
      </div>
    </main>
    <p class="gen-hint">Walls white, doors orange. Room labels are a GM-only layer — toggle "Labels (GM)" off to preview what players see. "LOS overlay" draws the occluders (green walls / red doors) to confirm they match. Export drops a sidecar (with GM room data) into the publish-to-table flow.</p>`

  canvas = root.querySelector('#board') as HTMLCanvasElement
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable.')
  ctx = context
  labelCanvas = root.querySelector('#labelboard') as HTMLCanvasElement
  const labelContext = labelCanvas.getContext('2d')
  if (!labelContext) throw new Error('Label canvas unavailable.')
  labelCtx = labelContext
  meta = root.querySelector('#meta') as HTMLElement

  const seedInput = root.querySelector('#seed') as HTMLInputElement
  const themeSel = root.querySelector('#theme') as HTMLSelectElement
  const colsInput = root.querySelector('#cols') as HTMLInputElement
  const rowsInput = root.querySelector('#rows') as HTMLInputElement
  const densityInput = root.querySelector('#density') as HTMLInputElement
  const requiredInput = root.querySelector('#required') as HTMLInputElement

  const readSpec = (): void => {
    const required = requiredInput.value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is RoomType => (ALL_TYPES as string[]).includes(s))
    spec = {
      ...defaultSpec(Number(seedInput.value) || 1),
      theme: themeSel.value as Theme,
      cols: Math.max(12, Math.min(48, Number(colsInput.value) || 28)),
      rows: Math.max(12, Math.min(48, Number(rowsInput.value) || 28)),
      furnitureDensity: Number(densityInput.value),
      required
    }
  }

  root.querySelector('#gen')?.addEventListener('click', () => {
    readSpec()
    regenerate()
  })
  root.querySelector('#roll')?.addEventListener('click', () => {
    seedInput.value = String(Math.floor(performance.now() * 1000) % 100000)
    readSpec()
    regenerate()
  })
  root.querySelector('#labels')?.addEventListener('click', (e) => {
    showLabels = !showLabels
    ;(e.currentTarget as HTMLElement).classList.toggle('active', showLabels)
    regenerate()
  })
  root.querySelector('#overlay')?.addEventListener('click', (e) => {
    showOverlay = !showOverlay
    ;(e.currentTarget as HTMLElement).classList.toggle('active', showOverlay)
    regenerate()
  })
  root.querySelector('#export')?.addEventListener('click', () => {
    readSpec()
    exportSidecar()
  })

  readSpec()
  regenerate()
}

mount()
