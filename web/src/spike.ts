// EXPERIMENTAL detection test page (/spike, branch spike/wall-detection-cv).
// Drop or pick any map image, run BOTH detectors on it, and see the walls
// (green) and doors (orange) drawn over the image. Toggle Current vs Spike to
// compare by eye. Self-contained; nothing here touches the live tool.
import {analyzeImageRgba, type Occluder} from './los-core'
import {analyzeImageRgbaSpike} from './detect-cv-spike'
import './spike.css'

type Detector = 'spike' | 'current'

let sourceImage: HTMLImageElement | null = null
let rgba: Uint8ClampedArray | null = null
let imgWidth = 0
let imgHeight = 0
let detector: Detector = 'spike'
let gridScale = 50
let result: Record<Detector, Occluder[]> = {spike: [], current: []}

const els = {
  canvas: null as HTMLCanvasElement | null,
  status: null as HTMLElement | null,
  counts: null as HTMLElement | null
}

const rasterize = (image: HTMLImageElement): void => {
  const scratch = document.createElement('canvas')
  scratch.width = image.naturalWidth
  scratch.height = image.naturalHeight
  const sctx = scratch.getContext('2d', {willReadFrequently: true})
  if (!sctx) throw new Error('2D canvas unavailable.')
  sctx.drawImage(image, 0, 0)
  const data = sctx.getImageData(0, 0, scratch.width, scratch.height)
  rgba = data.data
  imgWidth = scratch.width
  imgHeight = scratch.height
}

const analyze = (): void => {
  if (!rgba) return
  const t0 = performance.now()
  result.spike = analyzeImageRgbaSpike(imgWidth, imgHeight, rgba, gridScale)
  const t1 = performance.now()
  result.current = analyzeImageRgba(imgWidth, imgHeight, rgba, gridScale)
  const t2 = performance.now()
  const ms = (n: number): string => `${Math.round(n)}ms`
  els.status!.textContent = `${imgWidth}×${imgHeight} · spike ${ms(t1 - t0)} · current ${ms(t2 - t1)}`
  draw()
}

const count = (list: Occluder[], type: 'wall' | 'door'): number =>
  list.filter((o) => o.type === type).length

const draw = (): void => {
  const canvas = els.canvas
  if (!canvas || !sourceImage) return
  canvas.width = imgWidth
  canvas.height = imgHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, imgWidth, imgHeight)
  ctx.drawImage(sourceImage, 0, 0)

  const occluders = result[detector]
  for (const o of occluders) {
    ctx.strokeStyle = o.type === 'door' ? '#ff9f1c' : '#39ff14'
    ctx.lineWidth = o.type === 'door' ? 6 : 3
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(o.x1, o.y1)
    ctx.lineTo(o.x2, o.y2)
    ctx.stroke()
  }

  els.counts!.textContent =
    `${detector.toUpperCase()} — walls ${count(occluders, 'wall')}, doors ${count(occluders, 'door')}` +
    `  (other: walls ${count(result[detector === 'spike' ? 'current' : 'spike'], 'wall')}, ` +
    `doors ${count(result[detector === 'spike' ? 'current' : 'spike'], 'door')})`
}

const loadFile = (file: File): void => {
  const url = URL.createObjectURL(file)
  const image = new Image()
  image.onload = () => {
    sourceImage = image
    rasterize(image)
    analyze()
    URL.revokeObjectURL(url)
  }
  image.onerror = () => {
    els.status!.textContent = `Could not load ${file.name}`
    URL.revokeObjectURL(url)
  }
  image.src = url
}

const firstImage = (items: Iterable<File>): File | null => {
  for (const file of items) {
    if (file.type.startsWith('image/') || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name)) {
      return file
    }
  }
  return null
}

const mount = (): void => {
  const root = document.querySelector('#app')
  if (!root) throw new Error('Missing #app root.')
  root.innerHTML = `
    <header class="spike-hud">
      <strong>Detection Spike</strong>
      <label class="spike-file">
        <input id="file" type="file" accept="image/*" />
        <span>Drop a map or choose a file</span>
      </label>
      <span class="spike-toggle" role="group" aria-label="Detector">
        <button id="useSpike" type="button" class="active">Spike</button>
        <button id="useCurrent" type="button">Current</button>
      </span>
      <label class="spike-grid">grid
        <input id="grid" type="number" min="10" max="200" value="50" />
      </label>
      <span id="status" class="spike-meta"></span>
      <span id="counts" class="spike-meta"></span>
    </header>
    <main class="spike-board"><canvas id="board"></canvas></main>
    <p class="spike-hint">Green = walls, orange = doors. Toggle Spike/Current to compare on the same image.</p>`

  els.canvas = root.querySelector('#board')
  els.status = root.querySelector('#status')
  els.counts = root.querySelector('#counts')

  const fileInput = root.querySelector<HTMLInputElement>('#file')
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) loadFile(file)
  })

  const setDetector = (next: Detector): void => {
    detector = next
    root.querySelector('#useSpike')?.classList.toggle('active', next === 'spike')
    root.querySelector('#useCurrent')?.classList.toggle('active', next === 'current')
    draw()
  }
  root.querySelector('#useSpike')?.addEventListener('click', () => setDetector('spike'))
  root.querySelector('#useCurrent')?.addEventListener('click', () => setDetector('current'))

  const gridInput = root.querySelector<HTMLInputElement>('#grid')
  gridInput?.addEventListener('change', () => {
    gridScale = Math.max(10, Math.min(200, Number(gridInput.value) || 50))
    analyze()
  })

  // Whole-window drag-and-drop.
  window.addEventListener('dragover', (event) => event.preventDefault())
  window.addEventListener('drop', (event) => {
    event.preventDefault()
    const file = event.dataTransfer ? firstImage(event.dataTransfer.files) : null
    if (file) loadFile(file)
  })

  els.status!.textContent = 'Drop a map image to begin.'
}

mount()
