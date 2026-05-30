# Deterministic Core

## Pattern

Every geometry and image-analysis function is **pure**: it depends only on its
arguments, performs no I/O, and returns the same result for the same inputs.
There is no randomness, no clock, no global mutable state. The core's three
public entry points are total functions of their inputs:

- `analyzeImageRgba(width, height, rgba, gridScale)` → `Occluder[]`
- `hasLineOfSight(from, to, occluders, doorStates)` → `boolean`
- `visibilityPolygon(x, y, width, height, radius, occluders, doorStates)` → `Point[]`

## Where it lives

`web/src/los-core.ts`, exercised by `web/src/los-core.test.ts`.

## Why this shape

Determinism is what makes the tool reviewable and testable:

- The same map always yields the same candidate walls and doors, so a user's
  hand corrections stay meaningful between runs.
- The core can be unit-tested with synthetic RGBA buffers and plain occluder
  arrays — no browser, no canvas, no fixtures. The tests build a dark band in a
  buffer and assert a wall is found; they place a wall between two points and
  assert sight is blocked.
- Bugs reproduce: a failing case is fully described by its inputs.

## Gotchas

- Door state is passed in as a `DoorStateLookup` rather than read from the
  occluders, so visibility queries never mutate the occluder list. Accept both
  the `boolean` and `{open}` shapes, falling back to the door's own `open` field
  (`isOpenDoor`).
- Thresholds are derived from `gridScale` (e.g. `minRun`, `snap`), not
  hard-coded — keep new thresholds relative to the grid so behaviour scales with
  map resolution.
- The caps (≤500 walls, ≤200 doors) are part of the contract; if you change them
  update [`reference/sidecar-format.md`](../reference/sidecar-format.md) and the
  [analysis pipeline diagram](../diagrams/analysis-pipeline.dot).
- Keep floating-point tolerances centralized (the `0.000001` epsilons in the
  segment tests) rather than sprinkling new ones.

See the full pipeline in
[architecture/los-core.md](../architecture/los-core.md) and the
[analysis pipeline diagram](../diagrams/analysis-pipeline.png).
