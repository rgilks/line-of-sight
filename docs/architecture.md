# Architecture Overview

Line of Sight is a browser-first tool for extracting and reviewing visibility
metadata from geomorphic tactical maps. It is built from three layers with a
strict separation of concerns (see the Coding Rules in [`AGENTS.md`](../../AGENTS.md)).

![System overview](../diagrams/system-overview.png)

The load-bearing design patterns are written up in [`docs/patterns/`](../patterns/README.md);
this document is the map of *what exists and where*, and the patterns explain
*why each piece has its shape*. Diagram sources live in
[`docs/diagrams/`](../diagrams/README.md).

## Layers

### 1. Deterministic core — `web/src/los-core.ts`

Pure TypeScript geometry and image analysis. No DOM, no Cloudflare, no Preact.
Given a raw RGBA buffer it produces candidate walls and doors; given occluders
and a viewpoint it answers line-of-sight queries and builds a visibility polygon.
Because it is side-effect free and deterministic, it is exercised directly by the
type checker (`npm run test` is `tsc --noEmit`) and is safe to reuse anywhere.

Key exports:

- `analyzeImageRgba(width, height, rgba, gridScale)` → `AnalysisResult`
- `hasLineOfSight(from, to, occluders, doorStates)` → `boolean`
- `visibilityPolygon(x, y, width, height, radius, occluders, doorStates)` → `Point[]`

See [los-core.md](los-core.md) for the detection pipeline and geometry details.

### 2. Browser UI — `web/src/main.tsx`

A Preact app using `@preact/signals` for state, rendering the board to a 2D
`<canvas>`. It owns the whole interactive surface: arranging map tiles, running
analysis, hand-correcting walls/doors, placing counter tokens, toggling doors,
tracking visible and previously-seen areas, and exporting the sidecar. It calls
into the core for all geometry and never embeds detection logic itself.

`web/src/gpu.ts` is a small runtime WebGPU capability probe surfaced in the UI as
a status string; the app renders with the 2D canvas regardless.

See [ui.md](../guides/ui.md) for tools, drawer tabs, fog, and shortcuts.

### 3. Cloudflare Worker — `src/worker.ts`

A thin shell that answers `GET /healthz` with a small JSON body and otherwise
delegates to the static `ASSETS` binding (the Vite build in `dist/client`).
`not_found_handling = "single-page-application"` in `wrangler.toml` routes unknown
paths back to the app. Keep platform concerns here and out of the core/UI.

See [deployment.md](../reference/deployment.md).

## Session data flow

```
Local map images ──drag/drop or picker──▶ tiles ──arrange──▶ placements (board grid)
                                                                  │
                                              analyze (per placement, via core)
                                                                  ▼
        manual walls/doors  ◀──hand-correct──  occluders  ──carveDoorGaps──▶ occluders
                                                                  │
   place counter tokens ──pick a point-of-view token──▶ visibilityPolygon (core)
                                                                  │
                                          render: map + walls + fog + tokens
                                                                  ▼
                                       export ──▶ LOS sidecar JSON (clipboard/download)
```

1. **Load** one or more local images. Each becomes a `Tile`; `arrangeTiles`
   lays them into a `columns`-wide grid of `Placement`s and sizes the board.
2. **Analyze** rasterises each placement to an offscreen canvas, runs
   `analyzeImageRgba`, and maps detected occluders back into board space
   (`transformOccluder`). Existing `manual-*` occluders are preserved.
3. **Correct** walls and doors by hand with the editing tools; door gaps are
   carved out of overlapping walls so a closed door actually blocks and an open
   one actually lets sight through.
4. **Review** by placing counter tokens, electing one as the point-of-view, and
   toggling doors. The viewpoint's visibility polygon drives the live fog; seen
   areas accumulate on a separate "explored" canvas.
5. **Export** the reviewed `occluders` (plus board size, grid scale, and tokens)
   as sidecar JSON for another virtual tabletop. See
   [sidecar-format.md](../reference/sidecar-format.md).

## Where state lives

All UI state is **in-memory only**, held in module-level signals in
`web/src/main.tsx` (e.g. `occluders`, `doorStates`, `tokens`, `placements`,
`boardSize`). There is no `localStorage`/`indexedDB` persistence: a page reload
starts fresh, and the **sidecar export is the durable artifact**. Two offscreen
canvases back the fog — `exploredCanvas` (cumulative seen area) and `fogCanvas`
(scratch compositing) — and undo/redo is a bounded stack of `EditorSnapshot`s
covering occluders, door states, tokens, and selection.

This reactive-state-driving-an-imperative-canvas arrangement is the
[signals and rendering](../patterns/signals-and-rendering.md) pattern; the
history mechanism is [snapshot undo/redo](../patterns/snapshot-undo-redo.md).

## Patterns

The design patterns that hold this codebase together are documented one-per-file
in [`docs/patterns/`](../patterns/README.md):

- [Layered separation](../patterns/layered-separation.md) — the three layers and
  their one-directional dependency rule.
- [Deterministic core](../patterns/deterministic-core.md) — pure, side-effect-free
  geometry and analysis; the basis for the unit tests.
- [Signals and rendering](../patterns/signals-and-rendering.md) — module-level
  signals + a single `effect(renderBoard)` driven by a `renderTick`.
- [Snapshot undo/redo](../patterns/snapshot-undo-redo.md) — a bounded stack of
  whole-state snapshots.
- [Candidate → review → export](../patterns/candidate-review-export.md) —
  detection proposes candidates; the human corrects; the sidecar is the artifact.

## Build and runtime shape

- **Vite** builds `web/` into `dist/client` (`root: 'web'` in `vite.config.ts`).
- **TypeScript** is strict, ESM, `jsxImportSource: "preact"`; `npm run test`
  is a no-emit type check — there is no separate unit-test runner.
- **Wrangler** deploys the Worker, which serves `dist/client` and the custom
  domain `los.tre.systems`.
- Runtime dependencies are intentionally minimal: `preact` and `@preact/signals`.
