# Line of Sight

A browser-first **Cepheus tactical-map toolkit** by Total Reality Engineering,
deployed on Cloudflare Workers at [los.tre.systems](https://los.tre.systems). One
Vite build serves three apps that share a deterministic, framework-free core for
geometry, line of sight, Cepheus rules, dice, and pathfinding.

## The apps

- **Multiplayer table** (`/` host, `/play` player/GM) — a GM hosts a generated
  starship deck; each player joins with their own **server-authoritative point of
  view** and fog of war (one Durable Object per table), so you only see other
  tokens your counter can actually see. See [`docs/MULTIPLAYER.md`](docs/MULTIPLAYER.md).
- **Map editor** (`/edit`) — author a board: generate a synthetic deck, or import
  map art and **detect candidate walls and doors** from the raster, correct them
  by hand, review visibility by placing tokens and toggling doors, and export a
  **line-of-sight sidecar** for any virtual tabletop. See
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **Survive the Horde** (`/solo`) — a single-player, turn-based Cepheus game:
  four characters hold a generated deck against boarding alien waves, with a pure
  reducer + monster AI, scavenging, and barricades. See [`docs/SOLO.md`](docs/SOLO.md).

## How it fits together

- **`core/`** — deterministic TypeScript with no DOM or Cloudflare: `los.ts`
  (visibility geometry + wall/door detection), `rules.ts` (Cepheus movement /
  initiative / the domain model), `dice.ts`, `pathfinding.ts`. Unit-tested in
  isolation and shared by every app and the Worker.
- **`web/`** — the browser UI (Vite): the table client, the editor, the solo
  game, and the seeded **synthetic deck generator** (`web/src/synth/`) that builds
  decks with exact line of sight from the structural layer outward.
- **`src/`** — the Cloudflare Worker: serves the static build, routes the table
  API to the `GameTable` Durable Object, and stores GM-uploaded maps privately in
  R2.

Full map of the codebase and docs: [`docs/README.md`](docs/README.md). Agents
start with [`AGENTS.md`](AGENTS.md).

## Development

```bash
npm install
npm run dev      # Vite dev server
npm run check    # typecheck + tests + build + diagram check
```

The local asset folders are optional — the deployed app expects users to bring
their own map images (the editor) or play on generated decks (table and solo).

## Deployment

```bash
npm run deploy   # build, then wrangler deploy
```

The Worker is configured for `los.tre.systems`.

## License

MIT, for the source code in this repository. Licensed product art is **not**
included: `Geomorphs/` and `Counters/` may be copied in for local development but
are git-ignored and never committed or deployed (see the Local Asset Policy in
[`AGENTS.md`](AGENTS.md)).
