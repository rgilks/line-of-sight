# Solo → co-op: one engine, offline and online

The `/solo` game ([SOLO.md](SOLO.md)) is **one client over a `Room`**. Offline it
runs a `LocalRoom` (the engine in the browser, persisted to IndexedDB); online it
runs a `RemoteRoom` (the same engine in a `SoloRoom` Durable Object). Solo is
literally **multiplayer with one local player who owns every piece** — the only
difference is where the engine runs and how many seats have joined.

This is distinct from the GM-run [MULTIPLAYER.md](MULTIPLAYER.md) tabletop (a
different Durable Object) and builds on the [companion-play](COMPANION-PLAY.md)
SoloRoom.

## The Room seam

`web/src/room/room.ts` defines the interface the `/solo` view programs against:

- `submit(command, rng?)` — issue a player command; produced events are persisted
  and delivered to listeners.
- `subscribe(listener)` — receive each event batch; the view's pump folds + animates
  it one event at a time, preserving the per-move monster glide.
- `getState()` — the authoritative state; `mySeat()` — this client's seat, or
  `undefined` offline.

Both rooms speak the same event-sourced engine (`web/src/solo/`): a command is
`decide`d into `SoloEvent`s carrying resolved outcomes, which `foldSolo` applies
deterministically (no rng), so every client and the server converge on identical
state and a game `replay`s from `(seed + event log)`.

- **`LocalRoom`** (`web/src/room/local-room.ts`) runs `step`/`runAi` in-process,
  persists the log to IndexedDB, and resumes a closed tab via `replay`.
- **`RemoteRoom`** (`web/src/room/remote-room.ts`) connects a `play` SSE stream,
  folds the server's authoritative event batches, and POSTs commands stamped with
  its seat. Dice are server-authoritative online (the client sends no faces).

## Seats and piece ownership

A multiplayer game has **seats** (`SoloState.seats`); each PC has an `owner`
(`Entity.owner`). Ownership is folded events, never runtime config:
`SeatClaimed` / `SeatReleased` carry the **full** post-redistribution assignment
(`web/src/solo/seats.ts`), so `foldSolo` applies it wholesale and replay is exact.

`redistribute` splits the four PCs evenly across present seats — 1 seat owns all
4, 2 own 2 each, 3 → 2/1/1, 4 → 1/1/1/1; seats beyond the piece count spectate.
It is **sticky**: each seat keeps the pieces it already owns up to its new quota
(active piece first, the host shedding first), so a player is never handed
someone else's character or loses the one whose turn it is.

The engine's authority gate (`decide` in `web/src/solo/reducer.ts`) accepts a
command only on the active character's turn (`byActor`) **and**, when a seat is
named (`byPlayer`), only if that seat owns the active piece. Offline, `byPlayer`
is unset and the clause is a no-op — the local player commands every piece.

## Going online: promote an offline game

"Play with friends" in `/solo` hands the local `(seed + event log)` to a fresh
server room via `POST /api/solo/:id/import` (a one-time hydrate; a second import
is a 409), reconnects as a `play` client claiming the first seat (so the host
still owns all four pieces), and shows an invite link + QR. A friend opening
`/solo?table=<room>` joins over a `RemoteRoom`, claims the next seat, and the
pieces redistribute. On disconnect a seat is released and its pieces redistribute
back across the remaining players.

## SoloRoom connection kinds

`src/solo-room.ts` serves three kinds over `/stream`, persisting `evt:`-prefixed
events and replaying them on restart (identical to the `GameTable`):

- **play** (`?play=1`) — a `/solo` `RemoteRoom`: assigned a seat on connect, gets
  a state snapshot, then raw event batches it folds locally.
- **controller** (`?actor=`) — a phone driving one character (LOS-gated
  projection); see [companion play](COMPANION-PLAY.md).
- **board** (neither) — an omniscient shared-screen state view.
