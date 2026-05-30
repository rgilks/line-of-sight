# Deployment

Line of Sight is a static single-page app served by a thin Cloudflare Worker on
the custom domain `los.tre.systems`. The deploy cadence (commit, push, deploy
when served assets change, then verify the live site) is defined in
[`AGENTS.md`](../../AGENTS.md) — this page documents the moving parts.

## Build

Vite builds the browser app from `web/` into `dist/client`:

```bash
npm run build       # vite build  → dist/client
```

- `vite.config.ts` sets `root: 'web'` and `build.outDir: '../dist/client'`.
- `dist/` is generated output and is git-ignored.
- `web/public/` (token portraits) is copied into the build as static assets.

## The Worker

`src/worker.ts` is the entire server. It:

- answers `GET /healthz` with `{ "ok": true, "service": "line-of-sight" }`, and
- delegates everything else to the static `ASSETS` binding.

`wrangler.toml` wires it up:

- `main = "src/worker.ts"`
- `[assets] directory = "./dist/client"`, `binding = "ASSETS"`,
  `not_found_handling = "single-page-application"` (unknown paths fall back to
  the SPA shell)
- a custom-domain route for `los.tre.systems`
- observability/log settings enabled

## Deploy

```bash
npm run deploy      # npm run build, then wrangler deploy
```

`deploy` always rebuilds first, so `dist/client` is fresh. Deploy when the served
app, the Worker, the build output, or deployment config changed. Documentation or
agent-instruction changes that are not served by the app do not require a deploy.

## Verify the live site

After pushing/deploying (per [`AGENTS.md`](../../AGENTS.md)):

```bash
curl https://los.tre.systems/healthz      # expect {"ok":true,"service":"line-of-sight"}
```

Then a browser smoke check of `https://los.tre.systems` with the console open —
confirm the app loads and there are no console errors.

## Local development

```bash
npm install
npm run dev         # vite --host 127.0.0.1
```

`npm run dev` serves the browser app directly; it does not run the Worker. The
Worker shell is exercised at deploy time and via the live `/healthz` check.

## Checks

```bash
npm run test        # tsc --noEmit (type check — there is no unit-test runner)
npm run check       # build + test
```

Use the narrowest check that proves the change (see Common Commands in
[`AGENTS.md`](../../AGENTS.md)).
