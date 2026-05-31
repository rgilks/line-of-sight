# Wall/Door Detection Spike — findings

Branch: `spike/wall-detection-cv`. Experimental, not wired into the app. Tests
the stroke-thickness pipeline from [WALL_DOOR_DETECTION.md](WALL_DOOR_DETECTION.md)
against the current detector on real local maps.

- `web/src/detect-cv-spike.ts` — pure-TS detector: binarize → connected-component
  + distance-transform thickness gate → axis-run extraction → grid snap → door
  gaps. No OpenCV.js (deliberately — see "OpenCV question" below).
- `scripts/spike-ab-detection.mjs` — A/B harness; writes side-by-side overlays to
  `/tmp/los-spike-ab/` and prints a count table. Run: `node scripts/spike-ab-detection.mjs`.

## Result: the thickness gate works

Wall-segment counts, current detector vs. spike (`gridScale=50`):

| Map | current walls | spike walls |
| --- | --- | --- |
| 101 Multi purpose | 587 | 80 |
| 103 Cargo Bay - Full | 261 | 31 |
| 102 Research Deck | 627 | 64 |
| shuttle-weather-station (composed) | 850 | 63 |

The current detector's wall count *is* the noise: on the Multi-Purpose tile its
overlay paints furniture, text labels, and the background grid green. The spike's
overlay on the same tile traces the actual hull, room dividers, and corridor
walls and ignores nearly all of that. One distance-transform thickness gate
removed the entire class of noise that the ~2700-line scan fights case-by-case.
This confirms the research's core claim: the primitive, not the tuning, was wrong.

## Honest gaps (not yet solved by the spike)

1. **Doors: 0 detected on every map.** The grid-aligned-gap heuristic is too
   strict / not yet tuned. Doors are the least-evidenced part of the research and
   need their own pass (gap thresholds, then optional swing-arc/glyph confirm).
2. **Axis-aligned only.** The spike extracts horizontal/vertical runs; diagonal
   walls are dropped. The documented next increment (LSD-on-skeleton) handles
   diagonals but isn't in this first pass.
3. **Quality is eyeballed, not scored.** No ground-truth labels yet, so "better"
   is a visual judgement on a handful of maps, not a measured precision/recall.
   A small hand-labeled sample is still needed for a real accuracy number.
4. **Thresholds are first-guess.** `minWallHalfWidth`, `minComponentArea`, and
   the door gap bounds were set by reasoning, not swept against the corpus.

## OpenCV question — deferred on purpose, looking unnecessary

The spike is dependency-free pure TS, including a hand-rolled exact Euclidean
distance transform. It already runs and produces clean walls, which is early
evidence we may **not** need to ship ~8-10MB of OpenCV.js WASM at all — the
expensive primitive (DT) is ~30 lines. Revisit only if diagonal handling
(LSD/Hough) or door-symbol matching proves too fiddly by hand.

## Recommended next steps

1. Tune door-gap detection so the seed cases (which have obvious doorways)
   produce doors; then add optional swing-arc confirmation.
2. Add a small hand-labeled ground-truth set (a few maps) and a precision/recall
   score in the A/B harness, so changes are measured not eyeballed.
3. Add diagonal handling (skeleton + segment trace, or LSD) only after the
   axis-aligned + door path is solid.
4. If the scored result beats the current detector, promote the spike into the
   deterministic core (it is already pure and core-compatible) and retire the
   bulk of the old scan logic.
