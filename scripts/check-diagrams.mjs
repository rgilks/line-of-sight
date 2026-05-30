#!/usr/bin/env node
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {diagramDir, dotAvailable, listDotFiles, renderDiagram} from './_diagrams.mjs'

// Graphviz is required to render PNGs from .dot sources. If `dot` isn't on PATH
// (typical in slim CI/build images), skip rather than fail — the .dot sources
// are the source of truth and local pre-commit / CI with Graphviz installed is
// the authoritative gate against broken syntax.
if (!dotAvailable()) {
  console.log('Diagram check skipped: Graphviz `dot` not available on PATH.')
  process.exit(0)
}

if (!existsSync(diagramDir)) {
  console.log('Diagram check skipped: docs/diagrams does not exist.')
  process.exit(0)
}

const dotFiles = listDotFiles()

if (dotFiles.length === 0) {
  console.log('Diagram check skipped: no .dot files in docs/diagrams.')
  process.exit(0)
}

const tempDir = mkdtempSync(join(tmpdir(), 'los-diagrams-'))
const failures = []

// We verify only that each .dot renders cleanly and that the committed .png
// exists alongside it. We deliberately do NOT byte-compare the rendered PNG:
// Graphviz + cairo emit slightly different bytes across versions, which would
// produce stale-PNG false positives on every push.
try {
  for (const file of dotFiles) {
    const expectedPng = join(diagramDir, file.replace(/\.dot$/, '.png'))

    if (!existsSync(expectedPng)) {
      failures.push(`${file}: missing committed PNG next to .dot source`)
      continue
    }

    const result = renderDiagram(file, join(tempDir, file.replace(/\.dot$/, '.png')))

    if (result.error) {
      failures.push(`${file}: could not run Graphviz dot (${result.error.message})`)
      continue
    }
    if (result.status !== 0) {
      failures.push(`${file}: dot exited ${result.status}\n${result.stderr.trim()}`)
    }
  }
} finally {
  rmSync(tempDir, {recursive: true, force: true})
}

if (failures.length > 0) {
  console.error('Diagram check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  console.error('\nRender locally with:')
  console.error('  npm run diagrams')
  process.exit(1)
}

console.log(`Diagram check passed (${dotFiles.length} diagrams render cleanly).`)
