# Line of Sight Documentation

Start with [`AGENTS.md`](../AGENTS.md) for agent workflow, commands, deploy
cadence, and the coding/visual rules. This folder covers architecture and
formats in more depth.

- [ARCHITECTURE.md](ARCHITECTURE.md) — the three layers (deterministic core,
  browser UI, Cloudflare Worker), session data flow, the detection pipeline and
  visibility geometry, the UI, and the sidecar JSON format.
- [PATTERNS.md](PATTERNS.md) — the load-bearing design patterns. Read before
  non-trivial changes.
- [MULTIPLAYER.md](MULTIPLAYER.md) — design + roadmap for multiplayer with
  server-authoritative per-player fog of war (Durable Objects, CQRS-lite, SSE,
  Discord auth). Forward-looking; not built yet.
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
