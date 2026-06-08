# Backlog

Forward-looking work — what's left, not a record of what's done. Grouped by theme;
each item notes why, a sketch of the approach + "done when", and the main touch
points. See [`ARCHITECTURE.md`](ARCHITECTURE.md), [`MULTIPLAYER.md`](MULTIPLAYER.md),
[`SOLO.md`](SOLO.md), and [`PATTERNS.md`](PATTERNS.md) for current design.

Suggested order: linter (cheap, foundational) → event sourcing/CQRS → lazy shared
dice → 3D item-reveal overlay → shared viewport → the rest.

## Decisions on the table

- **Multiplayer is event-sourced + CQRS** — build it out properly (below).
- **The tactical board stays Canvas 2D** — no 3D/WebGL board renderer, ever. 3D is
  reserved for small, lazy-loaded *overlays* (dice, item reveals), never the map.
- **three.js is lazy** — pulled in on demand only on the page/feature that needs it,
  so pages that don't (the editor; the table until a roll) stay lean.

---

## 1. Multiplayer: proper event sourcing + CQRS

Today the `GameTable` Durable Object appends a `DomainEvent` log but never reads it
— it mutates state in place and re-sends full per-player views over SSE. Make the
event log the real source of truth.

### 1a. Split the write side into pure functions
- `decide(state, command, actor) -> DomainEvent[] | {error}` — validate + emit
  events, no mutation (today's `apply` mutates *and* appends).
- `fold(state, event) -> state` — the canonical write model is the fold over the log.
- Done when: command handling is two pure functions, unit-tested without a DO.
- Touch: `src/game-table.ts`, `src/protocol.ts`.

### 1b. Pure per-player read models (the CQRS read side)
- `projectFor(state, viewer) -> ViewMessage` — move `tokensFor` / `boardFor` /
  `combatFor` / `saysFor` into one pure projection (the fog-gated read model;
  per-player by construction).
- Done when: the fog gating is a pure function with unit tests for the security
  cases — a token behind a wall is absent, room labels stripped for players, says
  LOS-gated, only the active combatant may move.
- Touch: `src/game-table.ts` (+ a new test).

### 1c. Persist the log to DO storage
- Append events to `DurableObjectState.storage`; rebuild state on construction by
  replay (or snapshot + tail). Survives DO eviction/restart.
- Decide a compaction strategy: periodic snapshot + truncate, vs full log for the
  prototype. Document the choice.
- Done when: a table survives a Worker restart with state intact.
- Touch: `src/game-table.ts` (constructor now reads storage), `wrangler.toml`.

### 1d. Stream deltas + `Last-Event-ID` reconnect
- The crux with fog: raw events can leak hidden positions, so the **server** must
  project per viewer — stream fog-safe view-deltas keyed by `seq`, not the raw log.
  Non-secret facts (door toggled, board published, turn advanced) can stream as
  shared events; secret facts (token moves) stream only to viewers who can see them.
- On reconnect the client sends its last `seq`; the server replays events since then,
  re-projected for that viewer.
- Done when: a client reconnects mid-session and catches up without a full reload,
  and never receives a hidden token's position.
- Touch: `src/game-table.ts`, `web/src/play.ts` (`EventSource` + `Last-Event-ID`).

---

## 2. Lazy 3D overlays (three.js on demand)

### 2a. Lazy shared dice module + wire into the table
- Extract the dice overlay (today inline in `solo.ts`: `showDice` / `hideDice` /
  `createDiceRoller`) into one module, and **dynamic-`import()` `@rgilks/cepheus-dice`**
  so three.js is fetched only on the first roll — not at page load.
- Reuse it in the **multiplayer table** for initiative: the DO already rolls 2D6
  server-side (`RollInitiative`), so the client plays the 3D dice *settling on the
  server's authoritative faces* (cepheus-dice can roll to target faces, as solo
  already does via queued faces).
- Done when: the solo initial bundle drops the ~700 KB three.js (deferred to first
  roll); the table page stays ~27 KB until a roll, then shows 3D initiative dice.
- Touch: new `web/src/dice-overlay.ts`; `web/src/solo.ts`, `web/src/play.ts`.

### 2b. 3D item-reveal overlay (solo)
- When a PC searches a container or picks up loot and finds a **keycard or weapon**,
  show a short 3D reveal in a lazy-loaded overlay (spinning model, then dismiss) —
  reusing the same lazy three.js path as the dice (do 2a first).
- Needs glTF models (a keycard tinted per clearance; the four weapons) under
  `web/public/gltf/`, or simple procedural shapes to start.
- The reducer already names the found item (`applySearch` / `applyPickUp` log a
  weapon/armour/keycard); the driver triggers the overlay off that.
- Done when: finding a keycard/weapon plays a brief, lazy-loaded 3D reveal; nothing
  three.js loads until the first such find.
- Touch: `web/src/solo.ts` (driver hook), `web/src/solo/reducer.ts` (surface the
  found item), new `web/src/item-reveal.ts`, `web/public/gltf/`.

### Non-goal
- **No 3D board.** The deck/fog/tokens stay Canvas 2D (`render-map.ts`,
  `counter-render.ts`, the per-app draw loops). Board performance is addressed in 2D
  (item 3d), not by WebGL.

---

## 3. Engineering health

### 3a. Add a linter + formatter
- No ESLint/Prettier/Biome today — only `tsc --strict`. Add **Biome** (fast,
  format + lint, minimal config) or ESLint + Prettier, into `npm run check` and CI.
- High-value rules: exhaustiveness on the discriminated unions (`Command` /
  `DomainEvent` / solo `Action`) and `no-floating-promises` (the DO + drivers use
  `void`/async heavily).
- Touch: `package.json`, `.github/workflows/ci.yml`, config file.

### 3b. Shared viewport / camera / tween module
- `solo.ts` (~2,100 LOC) and `play.ts` (~1,600 LOC) each reimplement the board-pixel
  canvas + zoom/pan + rAF tween + follow-camera; `startEase` is copy-pasted between
  them. Extract one module reused by editor, table, and solo, and break the solo
  driver into focused units the way the editor already is.
- Done when: one camera/tween implementation; fixes apply to all clients at once.
- Touch: new `web/src/viewport.ts` (or similar); `web/src/solo.ts`, `web/src/play.ts`.

### 3c. Close the testing gaps
- The pure layers are well tested; the DO gating, the drivers, and rendering are not.
- 1b makes the DO projection unit-testable — add those security tests.
- The route smoke test (`scripts/e2e-smoke.mjs`, `npm run test:e2e`) covers boot,
  not gameplay; deeper multiplayer coverage still needs unit/integration tests
  against the DO rather than a fixed-coordinate browser script.
- Touch: new DO tests.

### 3d. 2D rendering performance (no WebGL)
- Every frame redraws the whole canvas (`renderMap` + a `visibilityPolygon` per PC) —
  the root of the slow horde turns and main-thread saturation on the big deck.
- Cache the static deck to an offscreen canvas (redraw only on map/zoom change); cache
  the fog and recompute only when a PC moves or a door toggles; keep the rAF loop idle
  when nothing animates.
- Done when: a wave's monster turns stay smooth on the 56×56 deck.
- Touch: `web/src/solo.ts` (`draw` / `drawFog`), `web/src/synth/render-map.ts`.

### 3e. Split `core/los.ts`
- 2,726 LOC doing two unrelated jobs: raster **detection** and **visibility geometry**.
  Split (e.g. `core/detect.ts` + `core/visibility.ts`) so the games import only
  visibility. Clarity, not bundle size (detection already tree-shakes out).
- Touch: `core/los.ts` → split; update importers.

### 3f. Harden the network edge
- The DO casts `CommandEnvelope` / `Board` with `as` + minimal manual checks. Add
  hand-written type guards (or a tiny validator) before Discord auth lands.
- Touch: `src/game-table.ts`, `src/worker.ts`.

### 3g. Client error reporting
- No client-side error capture today (the solo freeze was found only by hand). Add a
  lightweight error boundary / `console.error` beacon so deployed errors surface.
- Touch: `web/src/*.ts` entry points.

---

## Work streams (for parallel agents)

Five streams. The **server** and **tooling** streams are cleanly independent; the
three **client** streams all edit the two god-object drivers (`web/src/solo.ts`,
`web/src/play.ts`), so they contend on those files — see Execution waves. Each
stream owns a file set; agents stay out of each other's owned files.

### Stream S — Server: event sourcing & CQRS · items 1a–1d, 3f
- **Owns:** `src/game-table.ts`, `src/protocol.ts`, `src/worker.ts`, `wrangler.toml`,
  new `src/*.test.ts`.
- **Independence: high** — lives entirely in `src/`. The only client touch is 1d's
  `Last-Event-ID` reconnect in `web/src/play.ts` (the `EventSource` setup, ~20 lines);
  do it last and coordinate with the client streams.
- **Order:** 1a → 1b → 1c → 1d; 3f and the DO security tests fold in anywhere.
- **First move:** lift `decide` / `fold` / `projectFor` out of `apply` / `tokensFor`
  as pure functions.

### Stream T — Tooling & CI · items 3a, 3c
- **Owns:** `package.json`, `.github/workflows/ci.yml`, the formatter/linter config.
- ⚠️ The first format pass rewrites much of the tree — **land it first and alone**,
  before other streams branch, or everything conflicts. Lint-fixes after are small.
- 3c here = wire the existing Playwright e2e into CI; the new DO unit tests belong to S.
- **First move:** add Biome, run one format pass, add it to `check` + CI.

### Stream V — Client viewport & performance, the keystone · items 3b, 3d
- **Owns:** `web/src/solo.ts`, `web/src/play.ts`, new `web/src/viewport.ts`,
  `web/src/synth/render-map.ts`.
- The **decomposition keystone**: extracting the shared camera/tween and an
  offscreen-cached renderer turns the god-objects into seams the other client streams
  plug into. Run it **alone** among client streams.
- **Order:** 3b (extract the viewport) → 3d (offscreen map + fog cache).
- **First move:** lift `renderPos` / `startEase` / `stepRenderPos` / `frame` + zoom/pan
  into `viewport.ts`, used by both clients.

### Stream O — Lazy 3D overlays · items 2a, 2b
- **Owns:** new `web/src/dice-overlay.ts`, `web/src/item-reveal.ts`,
  `web/public/gltf/`; edits `web/src/solo.ts`, `web/src/play.ts`, `web/src/solo/reducer.ts`.
- Coordinate with Stream V (shares the two drivers). Cleanest **after** V lands, plugging
  the overlay into the viewport's overlay seam.
- **Order:** 2a (lazy shared dice + table) → 2b (item reveal).
- **First move:** pull the dice overlay out of `solo.ts` into `dice-overlay.ts` with a
  dynamic `import()` of `@rgilks/cepheus-dice`.

### Stream H — Core split & hygiene · items 3e, 3g
- **Owns:** `core/los.ts` (→ `core/detect.ts` + `core/visibility.ts`) and its importers;
  client entry points for 3g.
- 3e changes import paths across the editor *and* the game drivers, so it contends with
  the client files — coordinate with V/O.
- **First move:** split the file, update imports, keep the exported surface identical.

## Execution waves

Honest parallelism, given the two driver files everything client-side funnels through:

- **Wave 0 (solo, fast):** Stream T's format/lint pass — land first so all branches start
  formatted.
- **Wave 1 (parallel — 2 agents):** Stream S (server) ‖ Stream V (client keystone).
  Disjoint file sets (`src/` vs the client drivers) → no conflict.
- **Wave 2 (parallel — once V lands):** Stream O ‖ Stream H, plugging into the decomposed
  modules instead of the monoliths; Stream S's small 1d `play.ts` edit lands here, coordinated.

If you'd rather not gate on the keystone: keep S + T parallel, but run O, V, and H
**serially** (one agent owning `solo.ts` / `play.ts` at a time) — they conflict otherwise.
