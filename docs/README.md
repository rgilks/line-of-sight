# Line of Sight Documentation

Start with [`AGENTS.md`](../AGENTS.md) for agent workflow, commands, deploy
cadence, and the coding/visual rules. This folder covers architecture and
formats in more depth.

- [ARCHITECTURE.md](ARCHITECTURE.md) — the three layers (deterministic core,
  browser UI, Cloudflare Worker), session data flow, the detection pipeline and
  visibility geometry, the UI, and the sidecar JSON format.
- [PATTERNS.md](PATTERNS.md) — the load-bearing design patterns. Read before
  non-trivial changes.
- [MULTIPLAYER.md](MULTIPLAYER.md) — the multiplayer table with
  server-authoritative per-player fog of war (one Durable Object per table,
  CQRS-lite, SSE, private R2 map storage). The core host/player/GM loop is built
  and live; the roadmap tracks what's left (Discord auth, persistence, lobby).
- [SOLO.md](SOLO.md) — the single-player game at `/solo` ("Survive the Horde"):
  Cepheus turn-based combat against boarding waves, a pure reducer + monster AI,
  and barricades. Reuses the shared `core/`.
- [CV_REVIEW_PIPELINE.md](CV_REVIEW_PIPELINE.md) — branch experiment for
  improving CV-generated wall/door sidecars through local visual overlay review.
- [WALL_DOOR_DETECTION.md](WALL_DOOR_DETECTION.md) — research + recommended
  detector pipeline (stroke-thickness gate, distance transform, LSD).
  Forward-looking; the primitive to move toward.
- [SYNTHETIC_MAPS.md](SYNTHETIC_MAPS.md) — the deck generator that builds our own
  tactical maps from the structural layer outward (walls/doors plus furnishings)
  with exact line of sight, instead of detecting structure from raster art. It
  feeds the table host, the solo game, and the editor's "generate" path.
- [diagrams/](diagrams/README.md) — Graphviz/DOT sources + rendered PNGs.

## Project layout

```
core/los.ts              Deterministic TS geometry + image analysis (no DOM/CF)
core/rules.ts            Shared Cepheus rules + domain model (movement, initiative)
core/dice.ts             rollD6 / roll2D6 (seedable)
core/pathfinding.ts      A* over a grid (used by the solo monster AI)
web/src/main.tsx         Editor (/edit): Preact + signals UI, canvas rendering
web/src/play.ts          Multiplayer table client (/ host, /play player/GM)
web/src/solo.ts          Single-player game (/solo); engine in web/src/solo/
web/src/synth/           Deterministic deck generator + renderer
web/public/              Static assets served as-is (token portraits, icons)
src/worker.ts            Cloudflare Worker: routes API to the Durable Object,
                         else serves static assets (/, /play, /edit, /solo)
src/game-table.ts        GameTable Durable Object (multiplayer authority)
src/protocol.ts          Multiplayer transport (re-exports the core rules)
scripts/                 Diagram render + check tooling
dist/client/             Vite build output served by the Worker (generated)
```

Local licensed art (`Geomorphs/`, `Counters/`) is git-ignored; see the Local
Asset Policy in [`AGENTS.md`](../AGENTS.md).
