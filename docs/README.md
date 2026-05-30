# Line of Sight Documentation

Start with [`AGENTS.md`](../AGENTS.md) for agent workflow, commands, deploy
cadence, and the coding/visual rules. This folder covers architecture and
formats in more depth.

- [architecture.md](architecture.md) — the three layers (deterministic core,
  browser UI, Cloudflare Worker), session data flow, and where state lives.
- [los-core.md](los-core.md) — the deterministic geometry and image-analysis
  core: dark mask, wall/door detection, line-of-sight, and visibility polygon.
- [ui.md](ui.md) — the browser app: tools, drawer tabs, counters, fog,
  undo/redo, and keyboard shortcuts.
- [sidecar-format.md](sidecar-format.md) — the exported LOS sidecar JSON shape.
- [patterns/](patterns/README.md) — the load-bearing design patterns, one per
  file. Read before non-trivial changes.
- [diagrams/](diagrams/README.md) — Graphviz/DOT sources + rendered PNGs.

## Project layout

```
web/src/los-core.ts      Deterministic TS geometry + image analysis (no DOM/CF)
web/src/los-core.test.ts Vitest unit tests for the core
web/src/main.tsx         Preact + signals browser UI, canvas rendering
web/src/gpu.ts           WebGPU capability check
web/src/styles.css       TRE-themed styling
web/index.html           Vite entry document
web/public/              Static assets served as-is (token portraits)
src/worker.ts            Cloudflare Worker: /healthz + static asset serving
scripts/                 Diagram render + check tooling
dist/client/             Vite build output served by the Worker (generated)
```

Local licensed art (`Geomorphs/`, `Counters/`) is git-ignored; see the Local
Asset Policy in [`AGENTS.md`](../AGENTS.md).
