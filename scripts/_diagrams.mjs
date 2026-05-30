// Shared helpers for the Graphviz diagram scripts (render-diagrams.mjs, check-diagrams.mjs).
import {spawnSync} from 'node:child_process'
import {readdirSync} from 'node:fs'
import {join} from 'node:path'

export const diagramDir = join(process.cwd(), 'docs', 'diagrams')

// True when Graphviz `dot` is on PATH and runnable.
export const dotAvailable = () => {
  const probe = spawnSync('dot', ['-V'], {stdio: 'ignore'})
  return !probe.error && probe.status === 0
}

export const listDotFiles = () =>
  readdirSync(diagramDir)
    .filter((file) => file.endsWith('.dot'))
    .sort()

// Render a .dot file from diagramDir to the given PNG path. Returns the spawnSync
// result so callers can inspect .error / .status / .stderr.
export const renderDiagram = (file, output) =>
  spawnSync('dot', ['-Tpng:cairo', join(diagramDir, file), '-Gdpi=220', '-o', output], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
