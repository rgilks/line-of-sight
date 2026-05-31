// Throwaway spike verifier: load /generate.html in headless Chromium, generate a
// few maps, and save PNGs + a stats dump so we can eyeball convincingness without
// depending on the flaky preview channel. Run: node scripts/spike-shots.mjs
import {chromium} from 'playwright'
import {mkdirSync, writeFileSync} from 'node:fs'

const BASE = process.env.BASE || 'http://127.0.0.1:5173'
const OUT = '/tmp/synth-shots'
mkdirSync(OUT, {recursive: true})

const browser = await chromium.launch()
const page = await browser.newPage({viewport: {width: 1100, height: 1100}})
page.on('console', (m) => m.type() === 'error' && console.log('PAGE ERROR:', m.text()))
page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message))

await page.goto(`${BASE}/generate.html`, {waitUntil: 'networkidle'})

// Pull structural stats straight from the generator for a range of seeds.
const stats = await page.evaluate(async () => {
  const gm = await import('/src/synth/generate-map.ts')
  const t = await import('/src/synth/types.ts')
  const rows = []
  for (const seed of [1, 2, 3, 7, 42, 99, 100, 777]) {
    const map = gm.generateMap(t.defaultSpec(seed))
    const doors = map.occluders.filter((o) => o.type === 'door').length
    const walls = map.occluders.filter((o) => o.type === 'wall').length
    // adjacency + overlap sanity
    const R = map.rooms
    let overlaps = 0
    for (let i = 0; i < R.length; i++)
      for (let j = i + 1; j < R.length; j++) {
        const a = R[i], b = R[j]
        if (
          Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w) &&
          Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h)
        )
          overlaps++
      }
    rows.push({seed, rooms: R.length, walls, doors, furniture: map.decorations.length, overlaps})
  }
  return rows
})
console.log('STATS', JSON.stringify(stats, null, 2))

const shoot = async (seed, theme, cols, rows, overlay, name) => {
  await page.fill('#seed', String(seed))
  await page.selectOption('#theme', theme)
  await page.fill('#cols', String(cols))
  await page.fill('#rows', String(rows))
  await page.click('#gen')
  if (overlay) await page.click('#overlay')
  await page.waitForTimeout(150)
  // Read the canvas pixels directly — robust against element-screenshot quirks.
  const dataUrl = await page.evaluate(() => document.querySelector('#board').toDataURL('image/png'))
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '')
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64, 'base64'))
  if (overlay) await page.click('#overlay') // reset
}

await shoot(1, 'civilian', 20, 20, false, '01-civilian-s1')
await shoot(7, 'military', 20, 20, false, '02-military-s7')
await shoot(42, 'industrial', 24, 18, false, '03-industrial-s42')
await shoot(99, 'derelict', 20, 20, false, '04-derelict-s99')
await shoot(7, 'military', 20, 20, true, '05-military-s7-overlay')

console.log('WROTE', OUT)
await browser.close()
