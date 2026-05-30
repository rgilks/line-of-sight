#!/usr/bin/env node
/**
 * Visual review: overlay detected walls/doors on Geomorph maps and screenshot the app.
 * Requires Geomorphs/ locally. Writes PNGs under /tmp/los-detection-review/.
 */
import sharp from 'sharp'
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeImageRgba } from '../web/src/los-core.ts'

const outDir = join('/tmp', 'los-detection-review')
mkdirSync(outDir, { recursive: true })

const maps = [
  'Geomorphs/Standard Geomorphs/102 Research Deck.jpg',
  'Geomorphs/Standard Geomorphs/103 Cargo Bay - Full.jpg',
  'Geomorphs/Standard Geomorphs/101 Multi purpose.jpg'
]

const gridScale = 50

for (const mapPath of maps) {
  const { data, info } = await sharp(mapPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const occluders = analyzeImageRgba(info.width, info.height, data, gridScale)
  const walls = occluders.filter((o) => o.type === 'wall')
  const doors = occluders.filter((o) => o.type === 'door')

  const wallLines = walls
    .map(
      (w) =>
        `<line x1="${w.x1}" y1="${w.y1}" x2="${w.x2}" y2="${w.y2}" stroke="#39ff14" stroke-width="3" stroke-opacity="0.9"/>`
    )
    .join('')
  const doorLines = doors
    .map(
      (d) =>
        `<line x1="${d.x1}" y1="${d.y1}" x2="${d.x2}" y2="${d.y2}" stroke="#ff6b6b" stroke-width="4" stroke-opacity="0.95"/>`
    )
    .join('')

  const svg = Buffer.from(
    `<svg width="${info.width}" height="${info.height}" xmlns="http://www.w3.org/2000/svg">${wallLines}${doorLines}</svg>`
  )

  const base = mapPath.split('/').pop().replace('.jpg', '')
  const outPath = join(outDir, `${base}-overlay.png`)
  await sharp(mapPath).composite([{ input: svg, top: 0, left: 0 }]).png().toFile(outPath)

  writeFileSync(
    join(outDir, `${base}-stats.json`),
    JSON.stringify({ map: base, walls: walls.length, doors: doors.length, outPath }, null, 2)
  )
  console.log(`${base}: ${walls.length} walls, ${doors.length} doors → ${outPath}`)
}

const baseUrl = process.env.LOS_BASE_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

try {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle', timeout: 30_000 })
  await page.locator('#board').waitFor({ state: 'attached', timeout: 10_000 })

  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles(maps[0])

  await page.waitForFunction(
    () => {
      const status = document.querySelector('#runtimeStatus')
      return status && /analyz/i.test(status.textContent ?? '')
    },
    { timeout: 120_000 }
  )

  await page.locator('#analyzeButton').click()
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#runtimeStatus')
      return status && /occluder|wall|door|ready/i.test(status.textContent ?? '')
    },
    { timeout: 120_000 }
  )

  const appShot = join(outDir, 'app-research-deck-canvas.png')
  await page.locator('#board').screenshot({ path: appShot })
  console.log(`App canvas screenshot → ${appShot}`)
} finally {
  await browser.close()
}

console.log(`\nReview folder: ${outDir}`)
