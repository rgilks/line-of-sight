import type {CounterDefinition, CounterKind} from './types'

export type CounterDrawTarget = {
  kind: CounterKind
  label: string
  x: number
  y: number
}

export type CounterDrawOptions = {
  gridScale: number
  portraits: Map<CounterKind, HTMLImageElement>
  counterDefinitions: CounterDefinition[]
  visible?: boolean
  selected?: boolean
  hovered?: boolean
  isPov?: boolean
  /** Editor zoom; play passes 1 (board pixels, no scaling). */
  zoom?: number
}

export const counterTokenSize = (gridScale: number): number => Math.min(64, Math.max(38, gridScale * 0.84))

const screenPixels = (pixels: number, zoom: number): number => Math.max(0.5, pixels / zoom)

const counterDefinitionFor = (kind: CounterKind, definitions: CounterDefinition[]): CounterDefinition =>
  definitions.find((definition) => definition.kind === kind) ?? definitions[0]

const roundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void => {
  const limitedRadius = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + limitedRadius, y)
  ctx.lineTo(x + width - limitedRadius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + limitedRadius)
  ctx.lineTo(x + width, y + height - limitedRadius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - limitedRadius, y + height)
  ctx.lineTo(x + limitedRadius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - limitedRadius)
  ctx.lineTo(x, y + limitedRadius)
  ctx.quadraticCurveTo(x, y, x + limitedRadius, y)
  ctx.closePath()
}

const drawImageCover = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
): void => {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

const drawCounterPortrait = (
  ctx: CanvasRenderingContext2D,
  kind: CounterKind,
  x: number,
  y: number,
  width: number,
  height: number,
  portraits: Map<CounterKind, HTMLImageElement>,
  definitions: CounterDefinition[]
): void => {
  const image = portraits.get(kind)
  if (image?.complete && image.naturalWidth > 0) {
    drawImageCover(ctx, image, x, y, width, height)
    return
  }

  const fallback = ctx.createLinearGradient(x, y, x + width, y + height)
  fallback.addColorStop(0, '#1f2937')
  fallback.addColorStop(1, '#050505')
  ctx.fillStyle = fallback
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)'
  ctx.font = `900 ${Math.max(16, width * 0.38)}px "JetBrains Mono", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(counterDefinitionFor(kind, definitions).name[0] ?? '?', x + width / 2, y + height / 2)
}

/** Draw one counter token — rounded square frame, portrait, bottom-left label chip. */
export const drawCounterToken = (
  ctx: CanvasRenderingContext2D,
  token: CounterDrawTarget,
  options: CounterDrawOptions
): void => {
  const {
    gridScale,
    portraits,
    counterDefinitions,
    visible = true,
    selected = false,
    hovered = false,
    isPov = false,
    zoom = 1
  } = options

  const size = counterTokenSize(gridScale)
  const half = size / 2
  const inset = Math.max(2, size * 0.045)

  ctx.save()
  ctx.globalAlpha = visible ? 1 : 0.28
  ctx.translate(token.x, token.y)

  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = screenPixels(7, zoom)
  ctx.shadowOffsetY = screenPixels(2, zoom)
  roundedRect(ctx, -half, -half, size, size, size * 0.055)
  ctx.fillStyle = '#050505'
  ctx.fill()

  ctx.shadowColor = 'transparent'
  ctx.save()
  roundedRect(ctx, -half + inset, -half + inset, size - inset * 2, size - inset * 2, size * 0.035)
  ctx.clip()
  drawCounterPortrait(
    ctx,
    token.kind,
    -half + inset,
    -half + inset,
    size - inset * 2,
    size - inset * 2,
    portraits,
    counterDefinitions
  )
  ctx.restore()

  const highlight = ctx.createLinearGradient(0, -half + inset, 0, half - inset)
  highlight.addColorStop(0, 'rgba(255, 255, 255, 0.18)')
  highlight.addColorStop(0.5, 'rgba(255, 255, 255, 0.02)')
  highlight.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
  roundedRect(ctx, -half + inset, -half + inset, size - inset * 2, size - inset * 2, size * 0.035)
  ctx.fillStyle = highlight
  ctx.fill()

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
  ctx.lineWidth = screenPixels(1, zoom)
  ctx.stroke()

  ctx.font = `900 ${Math.max(11, size * 0.24)}px "JetBrains Mono", monospace`
  const labelMetrics = ctx.measureText(token.label)
  const labelWidth = Math.max(size * 0.36, labelMetrics.width + size * 0.16)
  const labelHeight = Math.max(14, size * 0.3)
  const labelX = -half + inset
  const labelY = half - inset - labelHeight
  roundedRect(ctx, labelX, labelY, labelWidth, labelHeight, size * 0.045)
  ctx.fillStyle = '#050505'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.lineWidth = screenPixels(1, zoom)
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(token.label, labelX + labelWidth / 2, labelY + labelHeight / 2 + screenPixels(0.4, zoom))

  if (selected || hovered) {
    ctx.strokeStyle = selected ? '#39ff14' : 'rgba(57, 255, 20, 0.55)'
    ctx.lineWidth = selected ? screenPixels(2.25, zoom) : screenPixels(1.5, zoom)
    const outlineInset = screenPixels(2.5, zoom)
    roundedRect(
      ctx,
      -half - outlineInset,
      -half - outlineInset,
      size + outlineInset * 2,
      size + outlineInset * 2,
      size * 0.13
    )
    ctx.stroke()
  }

  if (isPov) {
    ctx.strokeStyle = 'rgba(74, 163, 255, 0.96)'
    ctx.lineWidth = screenPixels(2.25, zoom)
    const povInset = screenPixels(5, zoom)
    roundedRect(ctx, -half - povInset, -half - povInset, size + povInset * 2, size + povInset * 2, size * 0.16)
    ctx.stroke()
  }

  ctx.restore()
}
