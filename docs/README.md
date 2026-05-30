# Line of Sight Documentation

Reference material for the Line of Sight tool. Start with [`AGENTS.md`](../AGENTS.md)
at the repo root for agent workflow, completion cadence, and the coding/visual
rules; this folder covers architecture and formats in more depth.

## Contents

### Architecture

- [overview.md](architecture/overview.md) — the three layers (deterministic
  core, browser UI, Cloudflare Worker), how a session flows from map to sidecar,
  and where state lives.
- [los-core.md](architecture/los-core.md) — the deterministic geometry and
  image-analysis core in `web/src/los-core.ts`: the dark mask, wall/door
  candidate detection, line-of-sight tests, and the visibility polygon.

### Guides

- [ui.md](guides/ui.md) — the browser app in `web/src/main.tsx`: tools, drawer
  tabs, counters/tokens, the visible/explored fog, undo/redo, and keyboard
  shortcuts.

### Reference

- [sidecar-format.md](reference/sidecar-format.md) — the exported LOS sidecar
  JSON shape and the occluder/token types it contains.
- [deployment.md](reference/deployment.md) — build outputs, the Cloudflare
  Worker shell, and the `los.tre.systems` custom domain.

## Project layout

```
web/src/los-core.ts   Deterministic TS geometry + image analysis (no DOM/CF)
web/src/main.tsx      Preact + signals browser UI, canvas rendering
web/src/gpu.ts        WebGPU capability check
web/src/styles.css    TRE-themed styling
web/index.html        Vite entry document
web/public/           Static assets served as-is (token portraits)
src/worker.ts         Cloudflare Worker: /healthz + static asset serving
dist/client/          Vite build output served by the Worker (generated)
```

Local licensed product art lives in `Geomorphs/` and `Counters/` and is git-ignored;
see the Local Asset Policy in [`AGENTS.md`](../AGENTS.md).
