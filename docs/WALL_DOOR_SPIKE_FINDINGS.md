# Wall/Door Detection Spike — findings

Branch: `spike/wall-detection-cv`. Experimental, not wired into the app. Tests
the stroke-thickness pipeline from [WALL_DOOR_DETECTION.md](WALL_DOOR_DETECTION.md)
against the current detector on real local maps.

- `web/src/detect-cv-spike.ts` — pure-TS detector: binarize → connected-component
  + distance-transform thickness gate → axis-run extraction → grid snap →
  `assembleLines` (two-gap union/door logic). No OpenCV.js (deliberately — see
  "OpenCV question" below).
- `scripts/spike-ab-detection.mjs` — quick A/B on a few maps → `/tmp/los-spike-ab/`.
- `scripts/spike-corpus.mjs` — full-corpus run: both detectors over all ~400
  Geomorphs → `/tmp/los-corpus/` (per-folder contact sheets, full-res overlays,
  `summary.json`) + an aggregate count table. Run: `node scripts/spike-corpus.mjs`.

## Result: thickness gate works; doors now detected

Full corpus, current detector vs. spike (`gridScale=50`, 400 tiles):

| Folder | files | cur walls | spk walls | cur doors | spk doors | spk 0-door tiles |
| --- | --- | --- | --- | --- | --- | --- |
| Standard | 120 | 65,021 | 7,830 | 1,799 | 1,345 | 15 |
| Edge | 160 | 58,174 | 6,108 | 1,668 | 903 | 32 |
| Corner | 120 | 26,371 | 2,760 | 608 | 366 | 38 |
| **Total** | **400** | **149,566** | **16,698** | **4,075** | **2,614** | **85** |

The current detector's ~9× larger wall count *is* noise — its overlays paint
furniture, text, and grid green. The spike traces actual hull/room/corridor
structure and ignores that, via one distance-transform thickness gate instead of
the ~2700-line per-failure scan. Every tile gets walls (0 tiles with 0 walls).

**Doors now work** (`assembleLines`, two gap scales): tiny gaps union into a
solid wall; a medium gap (≈0.4–1.7 cells) flanked by real wall on both sides is a
door. This took doors from 0 → 2,614 across the corpus.

## Visual judgement (inspected, not just counted)

Reviewed ~12 full-res overlays across all three folders plus the contact sheets:

- **Orthogonal tiles (the majority — Multi-Purpose, Research Deck, Passenger
  Deck, Cargo Bay): clear win.** Walls follow the real structure, doors land in
  real openings, clutter is ignored. Decisively better than the current detector.
- The **85 tiles with 0 doors** are partly genuine (fuel decks have none) and
  partly the diagonal/curved tiles where the axis-only flank test can't fire.

## Diagonal extraction (added next, verified)

`extractDiagonalSegments` walks the thick-wall mask along both ±45° directions,
keeps runs that are mostly NOT already on an axis wall (so orthogonal walls
aren't re-drawn as stairs), and `mergeDiagonals` collapses near-collinear runs.
Inspected on the tiles that previously regressed:

- **Fuel Refinery: fixed.** The chamfered corners of all four fuel tanks now get
  diagonal borders; previously those 45° cuts leaked open.
- **Bridge: improved.** Angled hull walls flanking the dome are now bordered.
- **Multi-Purpose: no regression** — orthogonal structure and doors unchanged.

So the axis-only regression on diagonal tiles is largely closed. Curved walls
(the Bridge dome arc) are still only approximated by short diagonal facets, not a
smooth curve.

## Honest gaps (still open)

1. **Curves still approximate** — domes/arcs become short facets, not smooth
   borders. Acceptable for LOS blocking; not pretty.
2. **Large tanks/pods get crude bounding-box walls.** Chamfers now bordered, but
   the whole-tank box is debatable as an LOS occluder.
3. **Quality is eyeballed, not scored.** No ground-truth labels, so "better" is a
   visual judgement on the corpus, not measured precision/recall.
4. **Thresholds are reasoned, not swept** — including the new diagonal ones
   (`minDiagLength`, merge tolerance, the 0.6 off-axis ratio).

## OpenCV question — deferred on purpose, looking unnecessary

The spike is dependency-free pure TS, including a hand-rolled exact Euclidean
distance transform. It already runs and produces clean walls, which is early
evidence we may **not** need to ship ~8-10MB of OpenCV.js WASM at all — the
expensive primitive (DT) is ~30 lines. Revisit only if diagonal handling
(LSD/Hough) or door-symbol matching proves too fiddly by hand.

## Recommended next steps

1. **Scoring, not eyeballing.** Hand-label walls/doors on ~10 representative
   tiles and add precision/recall to the corpus harness, so further tuning is
   measured. This is now the highest-value next step.
2. Tune the door and diagonal thresholds against that labeled set (door gap
   bounds; `minDiagLength`, merge tolerance, off-axis ratio).
3. Optional polish: smoother curve handling; reconsider whole-tank bounding
   boxes as occluders.
4. If the scored result beats the current detector, promote the spike into the
   deterministic core (it is already pure and core-compatible) and retire the
   bulk of the old scan logic.

Done so far: thickness gate (walls), two-gap door detection, diagonal extraction,
full-corpus + contact-sheet harness.
