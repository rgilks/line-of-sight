#!/usr/bin/env node
/**
 * Corpus run: both detectors over every Geomorph, with counts, timing, and
 * visual contact sheets for judgement. Local-only (gitignored Geomorphs/).
 *
 *   node scripts/spike-corpus.mjs [limitPerFolder]
 *
 * Writes to /tmp/los-corpus/:
 *   summary.json                aggregate + per-file counts
 *   <folder>-sheet-N.png        contact sheets of spike overlays (thumbnails)
 *   full/<name>.spike.png       full-res spike overlays (for drill-down)
 */
import sharp from 'sharp'
import {readdir, mkdir, writeFile} from 'node:fs/promises'
import {join, basename} from 'node:path'
import {analyzeImageRgba} from '../web/src/los-core.ts'
import {analyzeImageRgbaSpike} from '../web/src/detect-cv-spike.ts'

const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : Infinity
const gridScale = 50
const out = '/tmp/los-corpus'
const fullDir = join(out, 'full')
await mkdir(fullDir, {recursive: true})

const folders = ['Standard Geomorphs', 'Edge Geomorphs', 'Corner Geomorphs']
const thumb = 240 // contact-sheet cell size
const cols = 6
const perSheet = cols * 5 // 30 per sheet

const overlay = (w, h, occ) => {
  const seg = (o) => {
    const c = o.type === 'door' ? '#ff9f1c' : '#39ff14'
    const sw = o.type === 'door' ? 7 : 4
    return `<line x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}" stroke="${c}" stroke-width="${sw}" stroke-opacity="0.95"/>`
  }
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${occ.map(seg).join('')}</svg>`
  )
}

const labelSvg = (text, walls, doors, w) =>
  Buffer.from(
    `<svg width="${w}" height="28" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${w}" height="28" fill="#050505"/>` +
      `<text x="6" y="13" fill="#e7e9e6" font-family="monospace" font-size="11">${text.slice(0, 30)}</text>` +
      `<text x="6" y="25" fill="#39ff14" font-family="monospace" font-size="11">W ${walls}</text>` +
      `<text x="70" y="25" fill="#ff9f1c" font-family="monospace" font-size="11">D ${doors}</text>` +
      `</svg>`
  )

const summary = {gridScale, folders: {}, files: []}

for (const folder of folders) {
  const dir = join(process.cwd(), 'Geomorphs', folder)
  let names
  try {
    names = (await readdir(dir)).filter((n) => /\.(jpe?g|png)$/i.test(n)).sort()
  } catch {
    continue
  }
  names = names.slice(0, limit)

  const cells = []
  const agg = {
    files: 0,
    curWalls: 0,
    curDoors: 0,
    spkWalls: 0,
    spkDoors: 0,
    spkZeroWalls: 0,
    spkZeroDoors: 0
  }

  for (const name of names) {
    const path = join(dir, name)
    const {data, info} = await sharp(path).ensureAlpha().raw().toBuffer({resolveWithObject: true})

    const t0 = performance.now()
    const spk = analyzeImageRgbaSpike(info.width, info.height, data, gridScale)
    const t1 = performance.now()
    const cur = analyzeImageRgba(info.width, info.height, data, gridScale)
    const t2 = performance.now()

    const c = (l, t) => l.filter((o) => o.type === t).length
    const row = {
      folder,
      name,
      curWalls: c(cur, 'wall'),
      curDoors: c(cur, 'door'),
      spkWalls: c(spk, 'wall'),
      spkDoors: c(spk, 'door'),
      spkMs: Math.round(t1 - t0),
      curMs: Math.round(t2 - t1)
    }
    summary.files.push(row)
    agg.files += 1
    agg.curWalls += row.curWalls
    agg.curDoors += row.curDoors
    agg.spkWalls += row.spkWalls
    agg.spkDoors += row.spkDoors
    if (row.spkWalls === 0) agg.spkZeroWalls += 1
    if (row.spkDoors === 0) agg.spkZeroDoors += 1

    // Build the thumbnail base by resizing the SOURCE first (square box), then
    // overlay the spike geometry scaled into that box, then a label strip below.
    // Scaling the overlay (instead of compositing a full-res SVG onto the raw
    // image) sidesteps any width/height vs EXIF-orientation mismatch in sharp.
    const scale = thumb / Math.max(info.width, info.height)
    const tw = Math.round(info.width * scale)
    const th = Math.round(info.height * scale)
    const base = await sharp(path).resize(tw, th, {fit: 'fill'}).removeAlpha().toBuffer()
    const overlaySheet = (w, h, occ, k) =>
      Buffer.from(
        `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
          occ
            .map((o) => {
              const c = o.type === 'door' ? '#ff9f1c' : '#39ff14'
              const sw = o.type === 'door' ? 5 : 3
              return `<line x1="${o.x1 * k}" y1="${o.y1 * k}" x2="${o.x2 * k}" y2="${o.y2 * k}" stroke="${c}" stroke-width="${sw}" stroke-opacity="0.95"/>`
            })
            .join('') +
          `</svg>`
      )
    const labelled = await sharp({
      create: {width: tw, height: th + 28, channels: 3, background: '#050505'}
    })
      .composite([
        {input: base, top: 0, left: 0},
        {input: overlaySheet(tw, th, spk, scale), top: 0, left: 0},
        {input: labelSvg(name, row.spkWalls, row.spkDoors, tw), top: th, left: 0}
      ])
      .png()
      .toBuffer()
    cells.push({buf: labelled, w: tw, h: th + 28})

    // Keep a handful of full-res overlays per folder for detailed inspection.
    if (cells.length <= 6) {
      await sharp(path)
        .composite([{input: overlay(info.width, info.height, spk), top: 0, left: 0}])
        .png()
        .toFile(join(fullDir, `${folder.replace(/\s/g, '_')}-${basename(name, '.jpg')}.spike.png`))
    }
  }

  summary.folders[folder] = agg

  // Tile the thumbnails into contact sheets. Cells share a size within a folder
  // (all tiles in a folder are the same resolution), so use the first cell's box.
  const cellW = cells[0]?.w ?? thumb
  const cellH = cells[0]?.h ?? thumb + 28
  for (let s = 0; s * perSheet < cells.length; s += 1) {
    const slice = cells.slice(s * perSheet, (s + 1) * perSheet)
    const rows = Math.ceil(slice.length / cols)
    const sheet = sharp({
      create: {
        width: cols * cellW,
        height: rows * cellH,
        channels: 3,
        background: '#1a1a1a'
      }
    })
    const composite = slice.map((cell, i) => ({
      input: cell.buf,
      top: Math.floor(i / cols) * cellH,
      left: (i % cols) * cellW
    }))
    await sheet
      .composite(composite)
      .png()
      .toFile(join(out, `${folder.replace(/\s/g, '_')}-sheet-${s + 1}.png`))
  }
  console.log(`${folder}: ${agg.files} files → sheets written`)
}

await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2))

// Aggregate report.
const f = summary.folders
const total = (k) => folders.reduce((s, name) => s + (f[name]?.[k] ?? 0), 0)
console.log('\n=== corpus totals ===')
console.table(
  folders.map((name) => ({
    folder: name,
    files: f[name]?.files ?? 0,
    'cur walls': f[name]?.curWalls ?? 0,
    'cur doors': f[name]?.curDoors ?? 0,
    'spk walls': f[name]?.spkWalls ?? 0,
    'spk doors': f[name]?.spkDoors ?? 0,
    'spk 0-wall': f[name]?.spkZeroWalls ?? 0,
    'spk 0-door': f[name]?.spkZeroDoors ?? 0
  }))
)
console.log(
  `TOTAL ${total('files')} files | walls cur ${total('curWalls')} vs spk ${total('spkWalls')} | ` +
    `doors cur ${total('curDoors')} vs spk ${total('spkDoors')} | ` +
    `spike maps with 0 doors: ${total('spkZeroDoors')}`
)
console.log(`\nContact sheets + summary.json → ${out}`)
