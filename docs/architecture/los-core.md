# The Line-of-Sight Core

`web/src/los-core.ts` is the deterministic heart of the tool. It has two
responsibilities: **detect** candidate occluders from raster map art, and
**answer visibility queries** against a set of occluders. It is pure TypeScript
with no DOM, Cloudflare, or Preact dependencies, so it must stay free of those
concerns (see Coding Rules in [`AGENTS.md`](../../AGENTS.md)).

All coordinates are in board pixels with the origin at the top-left.

## Types

```ts
type Point = { x: number; y: number }

type WallOccluder = { type: 'wall'; id: string; x1; y1; x2; y2 }
type DoorOccluder = { type: 'door'; id: string; x1; y1; x2; y2; open: boolean }
type Occluder    = WallOccluder | DoorOccluder
```

`analyzeImageRgba` returns a flat `Occluder[]` — the detected walls followed by
the detected doors. The board's width, height, and grid scale are inputs the
caller already holds, so they are not echoed back in the result.

A `DoorStateLookup` (`Record<string, boolean | {open: boolean} | undefined>`)
lets callers override door open/closed state without mutating the occluders;
both the boolean and `{open}` shapes are accepted, falling back to the door's own
`open` field.

## Detection pipeline — `analyzeImageRgba`

Input is a raw RGBA buffer plus a `gridScale` hint. The buffer length must equal
`width * height * 4` and dimensions must be positive, or it throws.

![Wall and door analysis pipeline](../diagrams/analysis-pipeline.png)

1. **Dark mask** (`buildDarkMask`). Each pixel is marked `1` when its alpha is
   above 32 and its Rec. 709 luminance (`0.2126r + 0.7152g + 0.0722b`) is below
   58 — i.e. opaque and dark, which is how walls are drawn on these maps.
2. **Derived thresholds.** `effectiveGrid` defaults to 50 if the hint is invalid.
   `minRun = max(grid * 0.45, 18)` is the shortest accepted run; `snap = max(grid / 4, 4)`
   quantises endpoints onto a sub-grid.
3. **Directional scans.** The mask is scanned for dark runs along eight
   orientations: horizontal, vertical, the two 45° diagonals, and four
   shallow/steep slopes (1:2 and 2:1 in each diagonal direction). Diagonal scans
   use `isDarkNear` (a 3×3 neighbourhood test) for tolerance to anti-aliasing.
4. **Collapse** (`collapseCandidates`) removes duplicate runs that quantise to
   the same key.
5. **Structural filter** (`isStructuralWallCandidate`). Axis runs must sit near a
   grid line (`nearGridLine`), clear a minimum length, and have a dark band at
   least 3px thick (`candidateBandThickness`). Diagonals use a longer minimum
   length and a perpendicular band test (`diagonalBandThickness`).
6. **Thin-wall promotion** (`promoteConnectedThinAxisCandidates`). Axis runs that
   are only ~2px thick are promoted to walls when they are long enough or
   connect to perpendicular walls at their endpoints
   (`axisEndpointSupportCount`) — this recovers thin interior walls that the
   strict band test would drop.
7. **Door detection** (`detectDoorCandidates`), see below.
8. **Refine** (`refineWallCandidates`). Collinear axis walls on the same grid
   line are merged across small gaps (`mergeAxisCandidates`), then segments
   mostly covered by a longer one are dropped (`removeRedundantCandidates`).
9. **Emit.** Walls are sorted longest-first, capped at **500**, clamped to the
   board, and assigned stable ids `wall-0001`, `wall-0002`, …. Doors are emitted
   `closed` (`open: false`) with ids `door-0001`, ….

### Door detection

Two complementary strategies, deduped and capped at **200**:

- **Axis-gap doors** (`detectAxisGapDoorCandidates`). A gap between two
  collinear wall runs on the same grid line, within `[~0.3·grid, ~1.15·grid]`,
  is a door. Larger gaps up to `~1.75·grid` are accepted only if a faint door
  marker is found in the gap (`gapContainsDoorMarker`) — sparse dark pixels that
  read as a drawn door rather than an open corridor.
- **Sliding doors** (`detectSlidingDoorCandidates`). Pairs of short parallel
  dark runs that form a thin track, with dark end-caps, a clear interior, and a
  collinear wall on the same line (`hasCollinearWallSupport`), are detected as
  sliding doors.

## Visibility queries

### `hasLineOfSight(from, to, occluders, doorStates)`

Returns `true` when the segment `from→to` crosses no **blocking** occluder. An
occluder blocks when it is a wall, or a door that is not open (`isBlocking` /
`isOpenDoor`). Uses the standard orientation-based segment-intersection test
(`segmentsIntersect`).

### `visibilityPolygon(x, y, width, height, radius, occluders, doorStates)`

Builds the polygon visible from a viewpoint:

1. Collect blocking occluder segments plus the four board-edge segments
   (`boardSegments`).
2. Cast rays at 128 evenly-spaced base angles, plus three rays per segment
   endpoint (the angle and a tiny ± offset) so corners are captured cleanly.
3. For each angle, `castRay` keeps the nearest intersection
   (`raySegmentIntersection`) within `radius` (default: the board diagonal).
4. Sort hits by angle and `dedupePolygon` collinear/coincident points.

The viewpoint is clamped into the board. Non-positive or non-finite board
dimensions throw.

## Invariants worth preserving

- **Walls and closed doors block; open doors do not.** This is encoded in
  `isBlocking` and relied on across the UI.
- **Determinism.** Same pixels + same `gridScale` ⇒ same occluders. No
  randomness, no time, no I/O.
- **Stable ids.** `wall-NNNN` / `door-NNNN` ids are zero-padded and
  position-ordered; the UI distinguishes hand-authored occluders by a
  `manual-` id prefix and preserves them across re-analysis.
- **Caps.** ≤500 walls and ≤200 doors per analysis. If a map legitimately needs
  more, that limit is the first thing to revisit.
