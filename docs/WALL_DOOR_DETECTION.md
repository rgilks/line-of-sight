# Wall and Door Detection — research and recommended pipeline

Status: **forward-looking design guidance.** This is not how the detector works
today (see [ARCHITECTURE.md](ARCHITECTURE.md) for current state); it is the
recommended direction after a multi-source, adversarially-verified research pass.
The hands-on review flow that complements any detector lives in
[CV_REVIEW_PIPELINE.md](CV_REVIEW_PIPELINE.md).

## The core finding

The current detector (~2600 lines in `web/src/los-core.ts`) scans pixel runs and
then rejects noise case-by-case. Every new failure mode (furniture, text, door
arcs, grid) becomes another special-case scan, so it never converges. The
research says the problem is the **primitive**, not the tuning.

The canonical classical floor-plan pipeline does not scan-then-reject. It
**classifies strokes by thickness**: thick grid-aligned strokes are walls; thin
strokes (furniture outlines, text labels, door-swing arcs, the background grid)
are rejected. One geometric gate replaces the entire accreted special-case stack
(Ahmed et al., ICDAR 2011; Mace et al., DAS 2010).

## Recommended pipeline

Steps, with the OpenCV operation where relevant. Steps 1–2 already have partial
analogues in the code; step 3 is the missing high-leverage piece.

1. **Binarize → dark mask.** (Already done by `buildDarkMask`.)
2. **Strip text and furniture early**, before wall extraction. The canonical
   pipeline splits the image into a *text/graphics layer*. Practically:
   connected-component analysis (`connectedComponentsWithStats`) that drops
   compact/blobby components by size / aspect-ratio / density (text glyphs,
   terminals, furniture icons) and keeps only long thin grid-aligned strokes.
3. **Stroke-width gate — the core discriminator.** Distance transform
   (`distanceTransform`) on the mask, then keep a component only if its stroke
   is thick enough.
   - **Gate on per-component *max* distance value, or distance sampled on the
     skeleton** — *not* a naive per-pixel threshold. The distance value equals
     half the local stroke width only at the medial-axis *ridge*, not at every
     foreground pixel. (The naive `threshold(dist, 0.4)` approach was explicitly
     refuted during verification.)
   - Use `DIST_L2` with `maskSize=5` or `DIST_MASK_PRECISE` for accuracy; the
     default `maskSize=3` is a coarse chamfer approximation.
4. **Vectorize the clean wall mask → segments.** `LineSegmentDetector` (LSD):
   linear-time, subpixel, emits `(x1,y1,x2,y2)` endpoints directly — the format
   the occluder model needs, with no Hough threshold tuning.
   - **Run LSD on the skeleton/centerline**, not the raw mask: a thick wall has
     two parallel edges, so edge-based detection on the raw stroke yields *two*
     parallel segments per wall. Skeletonize first to get one centerline.
   - **Merge collinear segments afterward** — LSD over-segments long lines and
     emits short spurious segments; "no tuning" is a design property, not a
     promise of clean output.
   - **Axis-aligned fast path:** directional morphological opening with `1×N`
     and `N×1` `MORPH_RECT` kernels isolates horizontal/vertical runs cheaply —
     but it **loses diagonals**, so keep LSD-on-skeleton for the diagonal case.
5. **Snap to grid; snap angles to 0° / 45° / 90°; merge collinear runs.**
6. **Doors = grid-aligned gaps in wall lines.** Find collinear segment pairs
   separated by a small wall-aligned gap and emit a door there. Optionally
   confirm with a swing-arc (`HoughCircles` / arc fit) or a door-glyph template
   near the gap. The gap-analysis part is well-grounded; the symbol-matching
   part is plausible engineering, not strongly evidenced — treat it as a bonus,
   not load-bearing.

## Architecture to borrow: decouple detection from assembly

Raster-to-Vector (Liu et al., ICCV 2017) is a neural method, but its *structure*
transfers with the CNN swapped for classical detection: **detect low-level
primitives** (wall segments, junctions) → **assemble** them into a consistent
wall graph under grid-snap and door-gap constraints. This two-stage split is the
structural antidote to a monolithic per-failure-mode scan, and it matches how the
codebase already separates a pure detector from a human review/assembly step.

## Honest verdict: how far classical CV can get

Fully-automatic detection on **arbitrary uploaded maps is the field's central
unsolved problem.** Every published method — classical *and* neural — is tuned to
a particular plan style and fails to generalize (Pizarro et al. survey, 2022;
CubiCasa5K domain-shift analyses). State-of-the-art full-floorplan parsing is
deep CNNs *precisely because* classical heuristics did not converge — which is
exactly the failure mode the current 2600-line stack hit.

**But that pessimism is scoped to full semantic parsing of messy real
architectural drawings.** This project's task is far narrower — thick-wall
segments plus door gaps on **clean synthetic line-art** — which is materially
easier, and the classical distance-transform → skeleton → LSD pipeline suits it
well. The realistic target is **"mostly right, the human reviews the rest,"** not
hands-off automation. That is the right goal because the review loop already
exists (`startReview` / `keepReviewCandidate` / `deleteReviewCandidate`); the
detector only has to make review fast, not perfect. The overlay-driven review
workflow and its pilot findings are documented in
[CV_REVIEW_PIPELINE.md](CV_REVIEW_PIPELINE.md) — this doc covers the detector
*algorithm*; that one covers the *review process* on top of it.

### On neural networks

Lightweight/"classical-era" ML options exist (patch-based Bag-of-Visual-Words +
SVM segmentation, de las Heras et al., IJDAR 2014) but they are **supervised and
data-hungry** — exactly what this prototype rejected. The training-free classical
pipeline above is the recommended path.

## Open questions (need empirical work, not more literature)

The research could not settle these; they need measurement on the real corpus:

1. **OpenCV.js cost in-browser.** The full build is ~8–10 MB of WASM. Benchmark
   bundle size, cold-load time, and per-analysis performance on a ~1500px map.
   Consider whether a hand-rolled distance transform + `HoughLinesP` (or a small
   targeted library) avoids shipping all of OpenCV.
2. **Actual accuracy ceiling on *these* maps.** No verified figure exists for
   thick-wall + door-gap detection on Geomorphs / Dungeondraft / VTT line-art.
   (The "~90% precision/recall" figure that circulates is about real
   architectural plans and was refuted in verification.) Measure on a small
   hand-labeled sample of real maps.

## Recommended next step: a spike, not a rewrite

Prototype `binarize → CC filter → distance-transform thickness gate → skeleton →
LSD → grid-snap` in an **isolated experimental module**, leaving the current
detector untouched, and A/B it against current output on real local maps
(`Geomorphs/` plus the composed shuttle map). Measure hit-rate before committing.
That answers both open questions cheaply and shows whether OpenCV.js earns its
weight. If the thickness gate alone dramatically cleans up a noisy tile — likely
— most of the 2600 lines can retire.

## References

- Pizarro et al., "Automatic floor plan analysis and recognition," *Automation
  in Construction* 140:104348 (2022) — survey; rule-based vs. learning-based;
  generalization as the open problem.
- Liu et al., "Raster-to-Vector: Revisiting Floorplan Transformation," ICCV 2017
  — junction-detect-then-assemble architecture.
- Ahmed et al., "Improved Automatic Analysis of Architectural Floor Plans,"
  ICDAR 2011 — thick/medium/thin line separation; text/graphics layering.
- de las Heras et al., IJDAR 17 (2014) — patch-based statistical segmentation
  (supervised); doors resolved against wall context via A*.
- Kalervo et al., "CubiCasa5K," ACCV 2018 — CNN SOTA; classical heuristics did
  not converge on varied input.
- Epshtein et al., "Detecting Text in Natural Scenes with Stroke Width
  Transform," CVPR 2010 — SWT (heavier per-pixel width fallback).
- OpenCV docs: Distance Transform; Morphological line extraction;
  `LineSegmentDetector`; `HoughLinesP`.
