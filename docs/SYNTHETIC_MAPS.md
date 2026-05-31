# Synthetic Map Generation — design and feasibility

Status: **forward-looking design (a spike on `spike/synthetic-maps`).** Not built
yet. This proposes generating our own tactical maps from the structural layer
(walls + doors) outward, instead of detecting structure from existing raster art.

## The core idea, and why it is strong

Every hard problem in this codebase so far — the ~2700-line wall scanner, the
deep CV research, the detection spike — exists for one reason: we **start from
pixels and try to recover structure.** Detecting walls and doors from arbitrary
line-art is, per the research, the field's central unsolved problem.

Generation inverts it. If we **author the structure first** (rooms, walls,
doors) and then render a picture *from* that structure, there is nothing to
detect. The line-of-sight occluders are not an approximation recovered from an
image — they are the **source of truth**, and the image is a downstream artifact.

This is not a small refactor of the same problem. It is a different problem, and
a much easier one:

| | Detection (current/spike) | Generation (this proposal) |
| --- | --- | --- |
| LOS correctness | Approximated from pixels; never certain | **Exact by construction** |
| IP | Geomorphs are licensed; can't ship/host | **Ours; freely shippable** |
| Visual fit with the app | Whatever the GM uploaded; clashes | **Native TRE style by design** |
| Hard part | Recovering structure (maybe unsolvable) | Making it *look convincing* (solvable, but real work) |

The decisive point: **procedural floor-plan *generation* is well-trodden in
games, whereas floor-plan *detection* is not.** We are moving from an open
research problem to an established craft.

## How it fits what already exists

The data model is already right for this — no new representation needed:

- A generated map **is** a sidecar: `{ assetRef, width, height, gridScale,
  occluders, ... }`. The generator emits `Occluder[]` (walls + doors) directly.
- It can live beside `los-core.ts` as another **pure, deterministic, seeded**
  module (`generate-map.ts`) — same constraints as the core (no DOM/Cloudflare),
  matching the deterministic-core pattern. Same seed ⇒ same map.
- It renders to canvas like the rest of the UI, and exports straight into the
  multiplayer **publish-to-table** flow that already exists.

So generation is additive: a new front-end (a layout model + renderer) feeding
the existing geometry, fog, and multiplayer back-end unchanged.

## Architecture: separate the model from the render

The load-bearing decision is to keep two layers distinct:

1. **Layout (structural truth).** Rooms as grid-aligned rectangles/polygons,
   walls as room boundaries, doors as openings in shared walls, plus a
   room-adjacency graph and a room *type* per room (bridge, quarters, cargo,
   engineering…). This layer is pure and seeded and is what becomes
   `Occluder[]`.
2. **Render (the picture).** Draw floor, wall strokes, door glyphs, then
   decorate — furniture appropriate to each room type, labels, grid — in the TRE
   aesthetic (black background, terminal green, JetBrains Mono). The render reads
   the layout; the layout never depends on the render.

Keeping these apart means the LOS model is trustworthy regardless of how fancy
the rendering gets, and the rendering can be reworked without touching geometry.

### Generation technique

Established options, and the recommendation:

- **BSP (binary space partitioning).** Recursively split a rectangle into rooms,
  connect with corridors. The classic roguelike method; produces clean
  orthogonal room structure — exactly the geomorph look. Simple, controllable.
- **Graph-grammar / layout-graph.** Define desired rooms and connections as a
  graph, then realize it geometrically. Best for *designed-feeling* layouts where
  adjacency matters (bridge next to nothing sensitive, airlocks on the hull).
- **Own tile set (geomorph-style stamps).** Author *our own* clean room tiles
  (shapes + furniture arrangements) and compose them on a grid — exactly how the
  Starship Geomorphs themselves work, but IP-clean. Bridges procedural and
  hand-craft and is the most direct route to "looks intentional."
- **Wave Function Collapse.** Tile-based, coherent stylized output, but harder to
  control room semantics. Probably overkill to start.

**Recommendation:** start with **BSP for the deck skeleton** (rooms + corridors +
doors) because it is the smallest thing that proves the whole pipeline, then move
toward **hand-authored room stamps** for convincingness. These compose well: BSP
decides the partition; stamps fill the rooms.

## The honest risk: will it look convincing?

This is the real question, and the answer is *yes, but it is where the work is.*
A naive procedural layout looks generated — repetitive, gridded, soulless — next
to a hand-designed geomorph that has intent and character. Crossing from
"technically a valid floor plan" to "a deck someone wants to play on" is the
whole challenge. The LOS is free; the *art direction* is not.

Mitigations, roughly in order of leverage:

1. **Hand-authored room stamps.** A library of room shapes + furniture layouts
   per type. The generator assembles known-good rooms instead of inventing them
   pixel by pixel. This single choice does most of the "looks intentional" work.
2. **Decoration grammar.** Per-room-type rules for furniture/fixtures (a bridge
   has consoles facing a viewport; quarters have bunks along walls). Deterministic
   and tunable.
3. **TRE-native styling.** Because we own the render, the map matches the app
   exactly — which itself reads as "designed," not "imported."
4. **LLM in the loop (optional, not core).** Three distinct possible roles, in
   increasing ambition:
   - **Critic:** "Here is a generated deck; does it read as a plausible starship
     deck, and what is wrong?" Feeds a generate → critique → regenerate loop.
     Lowest-risk, highest-value use.
   - **Designer:** propose a deck theme and room adjacency graph, which the
     deterministic generator then realizes geometrically.
   - **Decorator:** choose/place furniture per room.

   Treat the LLM as an *enhancement layer over a working deterministic core*, not
   a dependency — consistent with this project's deterministic-first value. The
   generator must produce valid, playable maps with the LLM switched off.

## Relationship to the detection work

These are **complementary, not either/or:**

- **Detection** lets a GM bring *their own existing* map (a specific campaign
  map, a bought map pack). Irreplaceable when the GM already has the art.
- **Generation** produces *our* maps on demand — "give me a deck to play on
  now" — with no IP, exact LOS, and native styling.

For the prototype's trajectory, generation is the stronger bet: it sidesteps the
detection problems entirely and unlocks shippable content. Detection can remain a
parallel option (the `spike/wall-detection-cv` branch) for the bring-your-own
case. They share the same sidecar/occluder model, so neither blocks the other.

## What could go wrong (other than "looks generated")

- **Variety vs. coherence.** Too random reads as noise; too templated reads as
  repetitive. The BSP-skeleton + stamp-fill split is meant to balance these, but
  it needs tuning.
- **Door/connectivity correctness.** Every room must be reachable; doors must sit
  on shared walls. This is a graph-connectivity invariant the generator must
  guarantee (and is easy to assert in tests, unlike detection).
- **Scale to multi-deck / larger boards.** Start single-deck, one board.
- **LLM cost/latency/determinism** if used — another reason to keep it optional
  and off the critical path.

## Recommended spike (smallest thing that proves it)

Mirror the `/play` and `/spike` page pattern — a self-contained page, live tool
untouched:

1. `web/src/generate-map.ts` — pure seeded BSP generator → rooms + walls + doors
   → `Occluder[]` + room metadata. Assert connectivity.
2. A `/generate` page: seed input → generate → render the layout (floor, walls,
   doors, grid) in TRE style on a canvas; show the occluder overlay to confirm
   LOS lines up with the drawing.
3. Wire **Export sidecar** so a generated map drops into the existing
   publish-to-table flow — proving generation → multiplayer end to end.
4. Judge convincingness by eye. Then iterate: room stamps → decoration grammar →
   (optionally) an LLM critic pass.

Phase 1 proves the structural pipeline and exact LOS cheaply. Everything after —
stamps, decoration, LLM review — is incremental polish toward "convincing," which
is the only genuinely hard part and the right place to spend effort.

## Verdict

Feasible, and probably the better direction. It converts an open research problem
(detect structure from pixels) into an established craft (generate structure,
render it), eliminates the IP constraint, and gives exact line-of-sight for free.
The one real risk — making maps that look convincing rather than generated — is
solvable with hand-authored room stamps, a decoration grammar, and an optional
LLM critique loop, and unlike detection it fails *safe*: a less-pretty generated
map is still a perfectly correct, playable one.
