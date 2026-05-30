# Line of Sight Coding Agent Guide

This file is the entry point for coding agents working in this repository.

## First Steps

- Run `git status --short --branch` before editing. Preserve user changes and
  untracked local files.
- Use `rg` and `rg --files` for codebase search.
- Keep edits scoped to the requested change.
- Do not commit, push, deploy, or change Cloudflare state when the user has
  explicitly asked you not to.

## Default Completion Workflow

The user prefers completed changes to be carried all the way through without a
separate reminder. Unless the user says not to:

1. Make the requested change.
2. Run the narrowest useful check.
3. Commit the change with a clear message.
4. Push `main` to GitHub.
5. For code changes (not docs-only): confirm CI is green, then smoke-test the
   live site in a browser — not just `curl`.
6. Deploy to Cloudflare when the served app, Worker, build output, or deployment
   config changed.
7. Verify the live site at `https://los.tre.systems` after pushing/deploying.

For documentation-only or agent-instruction changes that are not served by the
Cloudflare app, a deploy is usually unnecessary; still push the commit and verify
that the live site remains healthy.

Live verification should include:

- `curl https://los.tre.systems/healthz`
- a browser smoke check of `https://los.tre.systems`
- checking that the browser console has no errors

## Project Shape

- `web/src/los-core.ts` contains the deterministic TypeScript geometry and
  image-analysis core; `web/src/los-core.test.ts` is its Vitest suite.
- `web/` contains the browser UI built by Vite.
- `src/worker.ts` is the Cloudflare Worker shell that serves static assets and
  `/healthz`.
- `wrangler.toml` owns Cloudflare deployment config for `los.tre.systems`.
- `scripts/` holds the diagram render/check tooling.
- `dist/` is generated output.
- The previous Rust/WASM implementation is preserved on the
  `rust-wasm-version` branch.

Architecture, design patterns, and diagrams are documented in [`docs/`](docs/README.md).
Read [`docs/patterns/`](docs/patterns/README.md) before non-trivial changes — this
codebase is organised around a small set of named patterns (deterministic core,
layered separation, signals + single render effect, snapshot undo/redo, and
candidate → review → export).

## Common Commands

```bash
npm run typecheck      # tsc --noEmit
npm run test           # vitest run (unit tests for web/src/los-core.ts)
npm run build          # vite build -> dist/client
npm run check          # typecheck + test + build + check:diagrams
npm run diagrams       # render docs/diagrams/*.dot to PNG
npm run check:diagrams # verify each .dot renders and its PNG exists
npm run deploy         # build, then wrangler deploy
```

Use the narrowest check that proves the change:

- CSS or HTML only: `npm run build:web` is usually enough.
- Core geometry/analysis (`web/src/los-core.ts`): `npm run test` (add/adjust
  cases in `web/src/los-core.test.ts`), then `npm run check`.
- TypeScript UI changes: `npm run check`.
- Worker or deployment config changes: `npm run check`, then `npm run deploy`.
- Diagram (`.dot`) changes: `npm run diagrams` to re-render, then commit the PNGs.
- Documentation-only changes: no build is required unless the docs affect a
  generated or served artifact.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build, and the diagram
check on every push to `main` and on PRs.

## Local Asset Policy

- `Geomorphs/` and `Counters/` are local licensed product asset folders.
- They may be copied into the repo root for local development.
- They must remain ignored by git and must not be committed or deployed.
- The public app should expect users to select their own map images in the
  browser.

## Coding Rules

- Keep `web/src/los-core.ts` deterministic and free of browser or Cloudflare
  concerns.
- Keep browser-only code in `web/src/`.
- Keep Cloudflare platform code in `src/worker.ts`.
- Avoid adding runtime dependencies unless there is a clear reason.
- Preserve the sidecar JSON shape used by the app:
  `{ assetRef, width, height, gridScale, occluders }`.
- Walls and closed doors block visibility. Open doors do not.
- Treat automatic wall extraction as a candidate generator only; the user should
  review and correct wall/door vectors before relying on exported sidecars.

## Visual Direction

The app should feel related to the main TRE site:

- black background
- terminal green accent (`#39ff14`)
- white text
- JetBrains Mono for brand/navigation/tool labels
- restrained green borders and glow
- avoid overly bright UI chrome that competes with the map canvas
