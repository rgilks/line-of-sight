# Synthetic Map Generation — design and current state

A spike on `spike/synthetic-maps`: generate our own tactical deck maps from the
structural layer (walls + doors) outward, instead of detecting structure from
existing raster art. The generator and a `/generate` page are implemented; the
LLM steering/critique layer is not yet.

## The core idea, and why it is strong

Every hard problem in this codebase so far — the wall scanner, the CV research,
the detection spike — exists for one reason: we **start from pixels and try to
recover structure.** Detecting walls and doors from arbitrary line-art is, per
the research, the field's central unsolved problem.

Generation inverts it. If we **author the structure first** (rooms, corridors,
walls, doors) and render a picture *from* that structure, there is nothing to
detect. The line-of-sight occluders are not recovered from an image — they are
the **source of truth**, and the image is a downstream artifact.

| | Detection | Generation |
| --- | --- | --- |
| LOS correctness | Approximated from pixels; never certain | **Exact by construction** |
| IP | Geomorphs are licensed; can't ship/host | **Ours; freely shippable** |
| Visual fit | Whatever the GM uploaded; clashes | **Native TRE style by design** |
| Hard part | Recovering structure (maybe unsolvable) | Making it *look convincing* (solvable) |

## How it fits what already exists

The data model needs no new representation:

- A generated map **is** a sidecar: `{assetRef, width, height, gridScale,
  occluders}`. The generator emits `Occluder[]` (walls + doors) directly.
- It lives beside `los-core.ts` as a **pure, deterministic, seeded** module —
  no DOM/Cloudflare, same constraints as the core. Same seed ⇒ same map.
- It renders to canvas and exports straight into the multiplayer
  **publish-to-table** flow that already exists.

## Architecture: separate the model from the render

Two layers stay distinct:

1. **Layout (structural truth).** Rooms, corridors, walls, doors, and the hull —
   pure and seeded, and what becomes `Occluder[]`.
2. **Render (the picture).** Floor, corridor shading, wall strokes, hull skin,
   door/airlock glyphs, furniture, labels — in the TRE aesthetic. The render
   reads the layout; the layout never depends on the render.

So the LOS model is trustworthy regardless of how fancy the render gets, and
**furniture is decorative only** — it never becomes an occluder, matching the
geomorph convention that furniture does not block sight. LOS stays exact no
matter how richly rooms are decorated.

## Layout model (mirrors the Starship Geomorphs grammar)

The originals are a **picture-frame of tiles**: 1000×1000 Standard interior
tiles, 1000×530 Edge tiles carrying the hull, 530×530 Corner tiles, all
connecting through corridors at standardized edge-midpoint points. The generator
reproduces that *look* procedurally rather than from a tile library:

1. **Seed → RNG.** A seeded PRNG (mulberry32) makes the map a deterministic
   function of its spec.
2. **Hull + margin.** An octagonal outer skin (chamfered corners) at the board
   bounds, with a margin gap inside it — the convention that keeps rooms from
   stair-stepping against the angled hull (fuel/conduits live in that margin).
3. **Corridor cross.** A corridor reaches the four edge-midpoint *connection
   points*; **airlocks** bridge the margin from each corridor end to the hull.
4. **Rooms.** BSP fills the four quadrants between the corridor arms; each room
   gets a function (bridge, quarters, cargo…) honoring `required` types.
5. **Doors + connectivity.** A union-find spanning tree over the room/corridor
   adjacency graph guarantees every room is reachable, **preferring room↔corridor
   edges** so rooms open onto the corridor; a few extra doors add loops.
6. **Walls.** Extracted from cell-tag boundaries (coincident walls are never
   duplicated), merged into long segments, with door gaps removed.
7. **Furniture.** Per-room-type decoration (decorative only — never occludes).

`MapSpec` is the steerable "brief": `seed`, `cols`/`rows`, `gridScale`, `theme`,
`minRoom`/`maxRoom`, `required` room types, `furnitureDensity`, `corridorWidth`,
`hullMargin`. It is the structured object an LLM can emit from a natural-language
adventure idea.

## Implementation

Pure, seeded modules under `web/src/synth/`, mirroring `los-core`:

- `types.ts` — `MapSpec`, `Room`, `Rect`, `Decoration`, `GeneratedMap`, room
  types and themes, `defaultSpec(seed)` (a 28×28 deck at 36px/cell).
- `rng.ts` — `makeRng` (mulberry32) + `randInt`/`chance`/`pick`/`shuffle`.
- `generate-map.ts` — hull + margin → corridor cross → quadrant BSP + typing →
  spanning-tree doors (room↔corridor first) → wall extraction from cell-tag
  boundaries → airlocks → furnish.
- `render-map.ts` — floor, corridor shading, grid, furniture, labels, interior
  walls, the thick hull skin, and door/airlock glyphs.

`web/generate.ts` mounts the `/generate` page: seed + 🎲, theme/size/density
controls, a `required` list, **Generate**, an **LOS overlay** toggle that draws
the occluders over the art to confirm they match, and **Export sidecar** (the
same JSON the publish-to-table flow consumes). Registered as a Vite entry.

`generate-map.test.ts` covers determinism, seed variance,
rooms/corridors/walls/doors/hull/airlocks, honored `required` types,
non-overlapping rooms, full reachability through the corridor/door graph, and
in-bounds furniture. `scripts/spike-shots.mjs` renders sample seeds to PNGs.

## Current look

The maps read as plausible decks: an octagonal hull with airlocks, a varied
corridor network with rooms opening off it, chamfered feature-room corners,
function-specific furniture at geomorph-like density, and an LOS overlay that
lines up exactly with the walls.

Built so far:

- **Corridor-topology variety.** Per-seed choice of full-span corridor bands
  placed off-centre — spine, off-centre cross, ladder, grid — with asymmetric
  regions between them, so the macro-layout differs across seeds.
- **Singular focal rooms.** Bridge and medbay appear at most once per deck (on the
  largest rooms); other rooms fill from a weighted per-theme palette.
- **Chamfered corners.** Corridor-facing room corners clip into 45° diagonals
  where the geometry allows, with LOS sealed by construction (the diagonal always
  lands on a real wall; otherwise the corner stays square).
- **Furniture grammar.** Paired bunk rows with lockers (quarters), round tables
  ringed by chairs (common), reactor core plus machinery (engineering), a console
  horseshoe (bridge), bed bank plus cabinets (medbay), packed crates (cargo),
  shelf runs (storage). Decorative only — never occluders.

## What is left

In rough order of leverage:

1. **Whole-room shapes.** Beyond corner chamfers, the originals use octagonal and
   circular feature rooms (reactor halls, hangars).
2. **Hull margin detail.** The margin is empty; the originals fill it with fuel
   tanks, conduits, escape pods.
3. **Furniture polish.** Bunks read a little large in big quarters, and furniture
   can visually overlap a chamfered corner (cosmetic only — not an occluder).

## The LLM loop (next, kept off the critical path)

The LLM shapes the *spec* and critiques the *picture* — never the structural
truth — and the generator must produce valid maps with it switched off:

- **Designer.** Natural-language brief → `MapSpec` (theme, required rooms,
  adjacency hints).
- **Critic.** Render → critique ("too sterile", "rooms too uniform") → adjust
  spec → regenerate.

## Relationship to the detection work

Complementary, not either/or. **Detection** lets a GM bring their own existing
map; **generation** produces ours on demand with no IP, exact LOS, and native
styling. They share the same sidecar/occluder model, so neither blocks the other.
The `spike/wall-detection-cv` branch keeps the bring-your-own path alive.

## Verdict

Generation converts an open research problem (detect structure from pixels) into
an established craft (generate structure, render it), removes the IP constraint,
and gives exact line-of-sight for free. The one real risk — looking generated
rather than convincing — is being worked down through layout variety, a room and
decoration grammar, and an optional LLM critique loop, and it fails *safe*: a
less-pretty generated map is still a perfectly correct, playable one.
