#!/usr/bin/env node
/**
 * Generate local CV-review artifacts for a small Geomorph pilot.
 *
 * Outputs are written under local-reference/, which is git-ignored because the
 * overlay PNGs contain published map art.
 */
import sharp from 'sharp'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {analyzeImageRgba} from '../web/src/los-core.ts'

const defaultMaps = [
  'Geomorphs/Standard Geomorphs/102 Research Deck.jpg',
  'Geomorphs/Standard Geomorphs/103 Cargo Bay - Full.jpg',
  'Geomorphs/Standard Geomorphs/114 Engineering.jpg',
  'Geomorphs/Standard Geomorphs/152 Passenger Staterooms.jpg',
  'Geomorphs/Edge Geomorphs/301 Bridge.jpg',
  'Geomorphs/Edge Geomorphs/314 Restaurant ][ Bar.jpg',
  'Geomorphs/Edge Geomorphs/351 Engineering.jpg',
  'Geomorphs/Edge Geomorphs/429 Drop Capsule Deck.jpg',
  'Geomorphs/Corner Geomorphs/506 Bridge ][ Crew Area.jpg',
  'Geomorphs/Corner Geomorphs/520 Engineering.jpg',
  'Geomorphs/Corner Geomorphs/537 Cargo Bay - Full.jpg',
  'Geomorphs/Corner Geomorphs/572 Stellar Cartography.jpg'
]

const root = path.resolve('local-reference/cv-review-pilot')
const gridScale = Number(process.env.LOS_GRID_SCALE) > 0 ? Number(process.env.LOS_GRID_SCALE) : 50
const maps = process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaultMaps

const detectedSidecarDir = path.join(root, 'detected', 'sidecars')
const detectedOverlayDir = path.join(root, 'detected', 'overlays')
const correctedSidecarDir = path.join(root, 'corrected', 'sidecars')
const correctedOverlayDir = path.join(root, 'corrected', 'overlays')
const reportDir = path.join(root, 'reports')

const ensureDirs = async () => {
  await Promise.all(
    [
      detectedSidecarDir,
      detectedOverlayDir,
      correctedSidecarDir,
      correctedOverlayDir,
      reportDir
    ].map((directory) => mkdir(directory, {recursive: true}))
  )
}

const slugFor = (mapPath) =>
  path
    .basename(mapPath, path.extname(mapPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const sidecarPathFor = (directory, slug) => path.join(directory, `${slug}.sidecar.json`)
const overlayPathFor = (directory, slug) => path.join(directory, `${slug}.overlay.png`)

const svgEscape = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const renderOverlay = async ({mapPath, sidecar, overlayPath, title}) => {
  const walls = sidecar.occluders.filter((occluder) => occluder.type === 'wall')
  const doors = sidecar.occluders.filter((occluder) => occluder.type === 'door')
  const wallLines = walls
    .map(
      (wall) =>
        `<line x1="${wall.x1}" y1="${wall.y1}" x2="${wall.x2}" y2="${wall.y2}" stroke="#39ff14" stroke-width="3" stroke-opacity="0.86" stroke-linecap="round"/>`
    )
    .join('')
  const doorLines = doors
    .map(
      (door) =>
        `<line x1="${door.x1}" y1="${door.y1}" x2="${door.x2}" y2="${door.y2}" stroke="#ff7a00" stroke-width="8" stroke-opacity="0.9" stroke-linecap="round"/>`
    )
    .join('')
  const label = `
    <rect x="10" y="10" width="470" height="42" rx="6" fill="rgba(0,0,0,0.74)"/>
    <text x="24" y="36" font-family="JetBrains Mono, Menlo, monospace" font-size="18" fill="#ffffff">${svgEscape(
      title
    )}: ${walls.length} walls, ${doors.length} doors</text>
  `
  const svg = Buffer.from(
    `<svg width="${sidecar.width}" height="${sidecar.height}" xmlns="http://www.w3.org/2000/svg">${wallLines}${doorLines}${label}</svg>`
  )

  await sharp(mapPath).composite([{input: svg, top: 0, left: 0}]).png().toFile(overlayPath)
}

const renderContactSheet = async ({rows, layer, outPath}) => {
  const columns = 3
  const thumbWidth = 360
  const gap = 18
  const labelHeight = 28
  const thumbs = []

  for (const row of rows) {
    const source = row[layer]?.overlayPath
    if (!source) continue
    const image = sharp(source).resize({width: thumbWidth})
    const buffer = await image.png().toBuffer()
    const metadata = await sharp(buffer).metadata()
    thumbs.push({row, buffer, width: metadata.width ?? thumbWidth, height: metadata.height ?? 1})
  }

  if (thumbs.length === 0) return

  const cellWidth = thumbWidth + gap
  const cellHeight = Math.max(...thumbs.map((thumb) => thumb.height)) + labelHeight + gap
  const sheetWidth = columns * cellWidth + gap
  const sheetHeight = Math.ceil(thumbs.length / columns) * cellHeight + gap
  const composites = []

  for (const [index, thumb] of thumbs.entries()) {
    const column = index % columns
    const row = Math.floor(index / columns)
    const left = gap + column * cellWidth
    const top = gap + row * cellHeight
    const labelSvg = Buffer.from(
      `<svg width="${thumbWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="19" font-family="Menlo, monospace" font-size="15" fill="#ffffff">${svgEscape(
        thumb.row.slug
      )}</text></svg>`
    )
    composites.push({input: labelSvg, left, top})
    composites.push({input: thumb.buffer, left, top: top + labelHeight})
  }

  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: '#050505'
    }
  })
    .composite(composites)
    .png()
    .toFile(outPath)
}

const readJsonIfPresent = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

await ensureDirs()

const rows = []

for (const mapPath of maps) {
  const absoluteMapPath = path.resolve(mapPath)
  const slug = slugFor(mapPath)
  const {data, info} = await sharp(absoluteMapPath)
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject: true})
  const occluders = analyzeImageRgba(info.width, info.height, data, gridScale)
  const sidecar = {
    assetRef: mapPath,
    width: info.width,
    height: info.height,
    gridScale,
    occluders,
    tokens: []
  }

  const detectedSidecarPath = sidecarPathFor(detectedSidecarDir, slug)
  const detectedOverlayPath = overlayPathFor(detectedOverlayDir, slug)
  await writeFile(detectedSidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`)
  await renderOverlay({
    mapPath: absoluteMapPath,
    sidecar,
    overlayPath: detectedOverlayPath,
    title: 'detected'
  })

  const correctedSidecarPath = sidecarPathFor(correctedSidecarDir, slug)
  const corrected = await readJsonIfPresent(correctedSidecarPath)
  let correctedOverlayPath = null
  if (corrected) {
    correctedOverlayPath = overlayPathFor(correctedOverlayDir, slug)
    await renderOverlay({
      mapPath: absoluteMapPath,
      sidecar: corrected,
      overlayPath: correctedOverlayPath,
      title: 'corrected'
    })
  }

  const walls = occluders.filter((occluder) => occluder.type === 'wall').length
  const doors = occluders.filter((occluder) => occluder.type === 'door').length
  rows.push({
    slug,
    mapPath,
    size: `${info.width}x${info.height}`,
    detected: {walls, doors, sidecarPath: detectedSidecarPath, overlayPath: detectedOverlayPath},
    corrected: corrected
      ? {
          walls: corrected.occluders.filter((occluder) => occluder.type === 'wall').length,
          doors: corrected.occluders.filter((occluder) => occluder.type === 'door').length,
          sidecarPath: correctedSidecarPath,
          overlayPath: correctedOverlayPath
        }
      : null
  })
}

const report = {
  generatedAt: new Date().toISOString(),
  gridScale,
  count: rows.length,
  rows
}

await writeFile(path.join(reportDir, 'pilot-report.json'), `${JSON.stringify(report, null, 2)}\n`)
await renderContactSheet({
  rows,
  layer: 'detected',
  outPath: path.join(reportDir, 'detected-contact-sheet.png')
})
await renderContactSheet({
  rows,
  layer: 'corrected',
  outPath: path.join(reportDir, 'corrected-contact-sheet.png')
})
console.log(JSON.stringify(report, null, 2))
