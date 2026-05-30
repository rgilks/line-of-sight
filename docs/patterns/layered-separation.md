# Layered Separation

## Pattern

The code is three layers with a strict, one-directional dependency rule:

```
web/src/los-core.ts   Deterministic core   (no DOM, no Cloudflare, no Preact)
        ▲
web/src/main.tsx      Browser UI           (imports the core; owns DOM + state)
        ▲
src/worker.ts         Cloudflare Worker    (serves the built UI; no app logic)
```

- The **core** depends on nothing in the repo. It is pure TypeScript geometry
  and image analysis.
- The **UI** imports the core and owns everything browser-specific: the canvas,
  signals, pointer/keyboard input, and the sidecar export.
- The **Worker** is a static shell. It serves `dist/client` and answers
  `/healthz`; it contains no detection or visibility logic.

## Where it lives

- `web/src/los-core.ts` — core.
- `web/src/main.tsx`, `web/src/gpu.ts`, `web/src/styles.css` — UI.
- `src/worker.ts`, `wrangler.toml` — platform.

The same split is enforced in [`AGENTS.md`](../../AGENTS.md) under Coding Rules.

## Why this shape

Keeping platform concerns out of the core is what lets the core be deterministic
and unit-tested (see [deterministic-core.md](./deterministic-core.md)). Keeping
app logic out of the Worker means the app is a plain static SPA that can run
anywhere — the Worker is replaceable hosting, not a backend. There is no server
round-trip for analysis or visibility: everything computes in the browser.

## Gotchas

- Do not import `preact`, `document`, `window`, or Cloudflare types into
  `los-core.ts`. If the core needs pixels, take a plain `Uint8ClampedArray`; if
  it needs a board, take numbers — let the UI do the canvas work.
- The UI rasterises tiles to an offscreen canvas and passes the raw RGBA buffer
  into `analyzeImageRgba`; that boundary is the only place pixels cross into the
  core.
- The previous Rust/WASM implementation lived behind this same boundary and is
  preserved on the `rust-wasm-version` branch.
