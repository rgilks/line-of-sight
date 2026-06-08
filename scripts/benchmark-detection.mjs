#!/usr/bin/env node
/**
 * Local-only benchmark for wall/door detection on Geomorph maps.
 * Requires Geomorphs/ in the repo root (gitignored licensed assets).
 *
 * Usage: node scripts/benchmark-detection.mjs [gridScale]
 */
import sharp from 'sharp'
import {readdir} from 'node:fs/promises'
import path from 'node:path'
import {analyzeImageRgba} from '../web/src/los-core.ts'

const gridScale = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 50
const geomorphRoot = path.join(process.cwd(), 'Geomorphs')

const samplePaths = async () => {
  const folders = ['Standard Geomorphs', 'Edge Geomorphs', 'Corner Geomorphs']
  const files = []
  for (const folder of folders) {
    const dir = path.join(geomorphRoot, folder)
    try {
      const names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.jpg'))
      for (const name of names.slice(0, 5)) {
        files.push(path.join(dir, name))
      }
    } catch {
      // folder missing locally
    }
  }
  return files
}

const files = await samplePaths()
if (files.length === 0) {
  console.error('No Geomorph JPGs found under Geomorphs/. Add local assets and retry.')
  process.exit(1)
}

const rows = []
for (const filePath of files) {
  const {data, info} = await sharp(filePath).ensureAlpha().raw().toBuffer({resolveWithObject: true})
  const occluders = analyzeImageRgba(info.width, info.height, data, gridScale)
  const walls = occluders.filter((occluder) => occluder.type === 'wall').length
  const doors = occluders.filter((occluder) => occluder.type === 'door').length
  rows.push({
    map: path.basename(filePath),
    walls,
    doors,
    total: walls + doors,
    size: `${info.width}x${info.height}`
  })
}

console.log(`gridScale=${gridScale}`)
console.table(rows)
