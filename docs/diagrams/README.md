# Diagrams

Graphviz / DOT sources plus rendered PNGs. The `.dot` files are the source of
truth; the PNGs are committed so they render inline on GitHub. Mermaid is used
only for small diagrams inline in Markdown (see [PATTERNS.md](../PATTERNS.md));
anything with clusters or many edges is a `.dot` here.

## Files

| Diagram | Source | Rendered |
| --- | --- | --- |
| System overview | `system-overview.dot` | `system-overview.png` |
| Multiplayer table | `multiplayer-architecture.dot` | `multiplayer-architecture.png` |
| Solo game loop | `solo-game-loop.dot` | `solo-game-loop.png` |
| Wall and door analysis pipeline | `analysis-pipeline.dot` | `analysis-pipeline.png` |
| Visibility and fog rendering | `visibility-and-fog.dot` | `visibility-and-fog.png` |

## Reading order

1. **System overview** for the three apps, the shared `core/`, and the Worker /
   Durable Object / R2 shape.
2. **Multiplayer table** for the server-authoritative per-POV design
   ([`MULTIPLAYER.md`](../MULTIPLAYER.md)).
3. **Solo game loop** for the reducer-driven turn loop ([`SOLO.md`](../SOLO.md)).
4. **Analysis pipeline** when changing wall/door detection in
   [`core/los.ts`](../../core/los.ts).
5. **Visibility and fog** when changing the POV, the visibility polygon, or the
   canvas render order in [`main.tsx`](../../web/src/main.tsx).

## Conventions

These follow the shared house style used across the TRE projects (see
`antenna` and `swade-toolbox`). Colour coding by domain:

- **Blue** — client surface, user inputs, and external/reads.
- **Purple** — the deterministic pure core (no DOM, no side effects).
- **Green** — Cloudflare Worker and imperative render code.
- **Yellow / orange** — build/tooling and time-driven steps.
- **Teal** — persistence and in-memory state stores (offscreen canvases).
- **Red** — error / stale outcomes.
- **Diamonds** — decisions.
- **Bold green outline** — terminal success state.

Font: Avenir. Rendered at 220 DPI.

## Render

```bash
npm run diagrams          # render all .dot files to PNG next to the source
npm run check:diagrams    # verify each .dot renders cleanly and the PNG exists
```

Both assume Graphviz is on PATH (`brew install graphviz`). CI installs Graphviz
before `npm run check:diagrams`. On a machine without `dot`, `check:diagrams`
skips with a clear message; refresh the PNGs before committing diagram changes.

Render one manually:

```bash
dot -Tpng:cairo docs/diagrams/<name>.dot -Gdpi=220 -o docs/diagrams/<name>.png
```
