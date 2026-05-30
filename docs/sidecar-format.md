# LOS Sidecar Format

The sidecar is the durable output of a review session — the reviewed visibility
metadata for a composed board, ready to hand to another virtual tabletop. It is
produced by `exportSidecar` in `web/src/main.tsx` (copied to the clipboard, or
downloaded as `line-of-sight-sidecar.json` when the clipboard is unavailable).

State in the app is otherwise in-memory only, so **the sidecar is the artifact to
keep** — see the [UI guide](ui.md).

## Shape

```jsonc
{
  "assetRef": "composed-board",   // identifier for the composed board
  "width": 2000,                  // board width in pixels
  "height": 1000,                 // board height in pixels
  "gridScale": 50,                // grid size in pixels used for analysis/snapping
  "occluders": [ /* see below */ ],
  "tokens":    [ /* see below */ ]
}
```

[`AGENTS.md`](../AGENTS.md) names the core contract fields as
`{ assetRef, width, height, gridScale, occluders }` — preserve those. The current
exporter additionally serialises `tokens` so a session's counter layout
round-trips; keep that in mind when changing the shape.

## Occluders

Each occluder is a line segment with endpoints `(x1,y1)–(x2,y2)` in board pixels
and a stable id.

```jsonc
// wall
{ "type": "wall", "id": "wall-0001", "x1": 100, "y1": 50, "x2": 100, "y2": 300 }

// door — exported with its effective open/closed state
{ "type": "door", "id": "door-0001", "x1": 250, "y1": 50, "x2": 300, "y2": 50, "open": false }
```

- Auto-generated ids are zero-padded and ordered: `wall-0001…`, `door-0001…`.
- Hand-authored occluders use `manual-wall-<hex>` / `manual-door-<hex>` ids; the
  `manual-` prefix is how the app preserves them across re-analysis.
- **Walls and closed doors block line of sight; open doors do not.** On export,
  each door's `open` flag reflects its current toggled state
  (`doorStates`), not just the value from detection.

## Tokens

Counter tokens placed during review. A token is a point plus its counter
identity.

```jsonc
{
  "id": "token-a1b2c3d4",    // "token-" + 8 hex chars
  "kind": "officer",         // one of the 12 counter kinds
  "group": "A",              // counter group A–H
  "member": 1,               // member index within the group
  "label": "A1",             // display label: group + member
  "x": 420, "y": 360         // board-pixel position
}
```

`kind` is one of: `officer`, `marine`, `scout`, `engineer`, `medic`, `scientist`,
`trader`, `security`, `reptilian`, `amphibian`, `insectoid`, `psion`.

## Notes

- All coordinates are board pixels with the origin at the top-left, matching the
  [core](los-core.md).
- Walls are capped at 500 and doors at 200 per analysis; hand-added occluders are
  not subject to those caps.
- The format is consumed by reimport into other tooling; the app itself does not
  currently re-import sidecars (export is one-way).
