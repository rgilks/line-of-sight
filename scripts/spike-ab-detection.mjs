#!/usr/bin/env node
/**
 * A/B the experimental stroke-thickness detector (detect-cv-spike.ts) against the
 * current detector (analyzeImageRgba) on real local Geomorph maps. Local-only —
 * needs gitignored Geomorphs/ in the repo root.
 *
 * Writes side-by-side overlay PNGs to /tmp/los-spike-ab/ and prints a count
 * table. Reuses the sharp → raw RGBA → SVG-overlay pattern from the existing
 * benchmark/visual-check scripts so the comparison is apples-to-apples.
 *
 * Usage: node scripts/spike-ab-detection.mjs [gridScale]
 */
import sharp from 'sharp'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {analyzeImageRgba} from '../web/src/los-core.ts'
import {analyzeImageRgbaSpike} from '../web/src/detect-cv-spike.ts'

const gridScale = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 50
const outDir = '/tmp/los-spike-ab'
mkdirSync(outDir, {recursive: true})

// A spread of the hard cases the research and CV_REVIEW_PIPELINE.md call out:
// furniture-heavy, cargo, text labels, plus the composed multi-tile map.
const maps = [
  'Geomorphs/Standard Geomorphs/101 Multi purpose.jpg',
  'Geomorphs/Standard Geomorphs/103 Cargo Bay - Full.jpg',
  'Geomorphs/Standard Geomorphs/102 Research Deck.jpg',
  'Geomorphs/shuttle-weather-station-barren-planet-map.png'
]

const overlaySvg = (width, height, occluders) => {
  const lines = occluders
    .map((o) => {
      const color = o.type === 'door' ? '#ff6b6b' : '#39ff14'
      const w = o.type === 'door' ? 5 : 3
      return `<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" stroke="${color}" stroke-width="${w}" stroke-opacity="0.9"/>`
    })
    .join('')
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`
  )
}

const rows = []
for (const mapPath of maps) {
  let raw
  try {
    raw = await sharp(mapPath).ensureAlpha().raw().toBuffer({resolveWithObject: true})
  } catch {
    console.warn(`skip (missing): ${mapPath}`)
    continue
  }
  const {data, info} = raw
  const base = mapPath.split('/').pop().replace(/\.(jpg|png)$/i, '')

  const current = analyzeImageRgba(info.width, info.height, data, gridScale)
  const spike = analyzeImageRgbaSpike(info.width, info.height, data, gridScale)

  for (const [label, occluders] of [
    ['current', current],
    ['spike', spike]
  ]) {
    const out = join(outDir, `${base}.${label}.png`)
    await sharp(mapPath)
      .composite([{input: overlaySvg(info.width, info.height, occluders), top: 0, left: 0}])
      .png()
      .toFile(out)
  }

  const count = (list, type) => list.filter((o) => o.type === type).length
  rows.push({
    map: base.slice(0, 28),
    'cur walls': count(current, 'wall'),
    'cur doors': count(current, 'door'),
    'spk walls': count(spike, 'wall'),
    'spk doors': count(spike, 'door')
  })
}

console.log(`gridScale=${gridScale}  overlays → ${outDir}`)
console.table(rows)
console.log('\nOpen the *.current.png vs *.spike.png pairs to compare quality by eye.')
