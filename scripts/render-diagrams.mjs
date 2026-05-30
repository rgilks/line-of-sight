#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import {existsSync, readdirSync} from 'node:fs'
import {join} from 'node:path'

const repoRoot = process.cwd()
const diagramDir = join(repoRoot, 'docs', 'diagrams')

const probe = spawnSync('dot', ['-V'], {stdio: 'ignore'})
if (probe.error || probe.status !== 0) {
  console.error('Cannot render diagrams: Graphviz `dot` is not on PATH.')
  console.error('Install it with `brew install graphviz` (macOS) or your package manager.')
  process.exit(1)
}

if (!existsSync(diagramDir)) {
  console.error('docs/diagrams does not exist.')
  process.exit(1)
}

const dotFiles = readdirSync(diagramDir)
  .filter((file) => file.endsWith('.dot'))
  .sort()

if (dotFiles.length === 0) {
  console.log('No .dot files to render.')
  process.exit(0)
}

let failed = false
for (const file of dotFiles) {
  const source = join(diagramDir, file)
  const output = source.replace(/\.dot$/, '.png')
  const result = spawnSync('dot', ['-Tpng:cairo', source, '-Gdpi=220', '-o', output], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    failed = true
    console.error(`Failed to render ${file}: ${result.stderr.trim()}`)
  } else {
    console.log(`Rendered ${file} -> ${file.replace(/\.dot$/, '.png')}`)
  }
}

process.exit(failed ? 1 : 0)
