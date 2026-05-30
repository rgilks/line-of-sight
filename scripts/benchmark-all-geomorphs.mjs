#!/usr/bin/env node
/**
 * Benchmark wall/door detection across all local Geomorph JPGs.
 * Usage: node scripts/benchmark-all-geomorphs.mjs [gridScale]
 */
import sharp from 'sharp'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { analyzeImageRgba } from '../web/src/los-core.ts'

const gridScale = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 50
const folders = ['Standard Geomorphs', 'Edge Geomorphs', 'Corner Geomorphs']
const files = []

for (const folder of folders) {
  const dir = path.join('Geomorphs', folder)
  for (const name of (await readdir(dir)).filter((entry) => entry.toLowerCase().endsWith('.jpg')).sort()) {
    files.push({ folder, name, path: path.join(dir, name) })
  }
}

const rows = []
for (const file of files) {
  const { data, info } = await sharp(file.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const occluders = analyzeImageRgba(info.width, info.height, data, gridScale)
  const walls = occluders.filter((entry) => entry.type === 'wall')
  const doors = occluders.filter((entry) => entry.type === 'door')
  rows.push({
    folder: file.folder,
    map: file.name,
    walls: walls.length,
    doors: doors.length,
    total: walls.length + doors.length,
    size: `${info.width}x${info.height}`
  })
}

const totals = rows.reduce(
  (accumulator, row) => ({
    walls: accumulator.walls + row.walls,
    doors: accumulator.doors + row.doors
  }),
  { walls: 0, doors: 0 }
)

const summary = {
  gridScale,
  maps: rows.length,
  totals,
  averageWalls: totals.walls / rows.length,
  zeroWallMaps: rows.filter((row) => row.walls === 0).length,
  sparseMaps: rows.filter((row) => row.walls > 0 && row.walls <= 8).length,
  heavyMaps: rows.filter((row) => row.walls >= 120).length
}

console.log(JSON.stringify(summary, null, 2))
await writeFile('/tmp/los-geomorph-benchmark.json', JSON.stringify({ summary, rows }, null, 2))
console.log('Wrote /tmp/los-geomorph-benchmark.json')
