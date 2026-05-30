#!/usr/bin/env node
import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {diagramDir, dotAvailable, listDotFiles, renderDiagram} from './_diagrams.mjs'

if (!dotAvailable()) {
  console.error('Cannot render diagrams: Graphviz `dot` is not on PATH.')
  console.error('Install it with `brew install graphviz` (macOS) or your package manager.')
  process.exit(1)
}

if (!existsSync(diagramDir)) {
  console.error('docs/diagrams does not exist.')
  process.exit(1)
}

const dotFiles = listDotFiles()

if (dotFiles.length === 0) {
  console.log('No .dot files to render.')
  process.exit(0)
}

let failed = false
for (const file of dotFiles) {
  const png = file.replace(/\.dot$/, '.png')
  const result = renderDiagram(file, join(diagramDir, png))
  if (result.status !== 0) {
    failed = true
    console.error(`Failed to render ${file}: ${result.stderr.trim()}`)
  } else {
    console.log(`Rendered ${file} -> ${png}`)
  }
}

process.exit(failed ? 1 : 0)
