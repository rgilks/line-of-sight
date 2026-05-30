# CV-Assisted Wall Review Pipeline

This branch experiments with a deliberately non-neural workflow for improving
Geomorph wall and door data:

1. Run the current classical CV detector.
2. Render a visual overlay on top of the source map.
3. Review the overlay locally in Codex.
4. Patch the draft sidecar JSON when the overlay is wrong.
5. Re-render and repeat until the result is good enough for play.

The goal is not to make automatic detection authoritative. The goal is to find
out whether CV plus local visual review can produce curated wall overlays much
faster than manual drawing in the browser.

## Why This Is Worth Testing

The current detector already gives a useful first pass: it finds grid-aligned
bulkheads, doors, and sliding-door candidates across Standard, Edge, and Corner
Geomorphs. The remaining errors are usually visual and local:

- furniture or machinery mistaken for wall segments;
- missing short interior wall runs;
- overlong wall segments across doors or open corridors;
- sliding doors and iris valves missed or offset;
- compact Edge and Corner tiles needing different assumptions from full tiles.

Those are exactly the cases where reviewing an overlay image is more efficient
than reasoning from raw coordinates.

## Local-Only Asset Rule

The source Geomorph images are local licensed assets. Any generated overlay PNGs
include the source artwork and must stay out of git. Corrected sidecars may also
derive from that artwork, so for the pilot they stay local too.

Use an ignored local workspace such as:

```text
local-reference/cv-review-pilot/
  detected/
    overlays/
    sidecars/
  corrected/
    overlays/
    sidecars/
  reports/
```

Only generic tooling and documentation should be committed.

## Pilot Shape

Start with a small mixed sample before touching all 400 maps:

- 4 Standard Geomorphs;
- 4 Edge Geomorphs;
- 4 Corner Geomorphs;
- include at least one cargo/engineering map, one furniture-heavy map, one
  compact map, and one map with obvious sliding doors or iris valves.

For each map:

1. Generate a draft sidecar with `analyzeImageRgba`.
2. Render `detected` overlay PNGs:
   - walls in green;
   - doors in orange;
   - source map visible underneath.
3. Review visually and record:
   - false-positive walls removed;
   - missed walls added;
   - doors added, deleted, or moved;
   - whether the map becomes usable for line-of-sight play.
4. Render a `corrected` overlay from the patched sidecar.
5. Summarise time/correction cost and whether the process is promising.

The helper script for this branch is:

```bash
node scripts/cv-review-pilot.mjs
```

It writes detected sidecars, detected overlays, corrected overlays when matching
corrected sidecars exist, and contact sheets under
`local-reference/cv-review-pilot/`.

## First Pilot Notes

Initial sample size: 12 maps, covering Standard, Edge, and Corner tiles. Raw CV
output over the sample produced 488 wall segments and 126 door segments.

The first visual pass suggests three categories:

- **Already useful:** structured engineering, bridge, stateroom, and room-heavy
  tiles often need only spot correction. The detector usually finds the main
  partition network and door candidates.
- **Reviewable but ambiguous:** cargo maps depend on whether cargo containers
  should block line of sight. If yes, CV currently under-detects them because it
  treats disconnected cargo outlines as non-structural. A local review pass can
  add those obstacles cleanly.
- **Hard cases:** curved/domed rooms and decorative diagonal architecture need
  either manual approximation with segments or a new deterministic post-process.
  They are possible to correct, but not cheap enough to do blindly across all
  maps.

One representative hard correction was tried locally:

| Map | Raw CV | Reviewed result | Note |
| --- | --- | --- | --- |
| `537 Cargo Bay - Full` | 2 walls, 2 doors | 46 walls, 3 doors | Added cargo-container obstacle outlines and a cargo-door segment. This changed an unusable sparse sidecar into a plausible LOS overlay. |

The corrected files and overlay PNGs are intentionally local-only:

```text
local-reference/cv-review-pilot/corrected/sidecars/537-cargo-bay-full.sidecar.json
local-reference/cv-review-pilot/corrected/overlays/537-cargo-bay-full.overlay.png
```

Early conclusion: this is a promising direction for a curated sidecar library,
but not as a fully automatic batch process. The highest-value path is to let CV
produce drafts, use local visual review for maps with high error or high play
value, and feed recurring misses back into deterministic detection where
possible.

## Correction Format

Use the app's existing sidecar shape:

```json
{
  "assetRef": "local filename or stable asset ref",
  "width": 1000,
  "height": 1000,
  "gridScale": 50,
  "occluders": [
    {"type": "wall", "id": "wall-0001", "x1": 0, "y1": 50, "x2": 300, "y2": 50},
    {
      "type": "door",
      "id": "door-0001",
      "x1": 300,
      "y1": 50,
      "x2": 350,
      "y2": 50,
      "open": false
    }
  ]
}
```

For pilot patches, prefer small JSON patch files over editing generated drafts
in place. That keeps the detector output, human/agent corrections, and final
sidecar separable.

## Success Criteria

This direction is promising if the pilot shows:

- corrected overlays are visibly better than raw CV output;
- correction cost is small enough to scale map-by-map;
- most corrections are simple segment add/delete/move operations;
- corrected sidecars can be reloaded or published without changing the line of
  sight core;
- the process finds recurring detector weaknesses that can also improve
  `analyzeImageRgba`.

It is not promising if most maps need near-complete redrawing, if judging
overlay quality is too ambiguous, or if corrected sidecars are too brittle to
reuse after detector changes.

## Possible Future App Integration

For now, review is done locally in Codex. Later, the app could offer an optional
"review with AI" workflow:

- browser generates CV sidecar and overlay;
- user explicitly sends the overlay and sidecar to an API;
- API returns proposed sidecar patches;
- user reviews before accepting.

That should be treated as opt-in because it sends map imagery or derived map
data off-device. The default app should remain local-first.
