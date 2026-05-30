# Snapshot Undo/Redo

## Pattern

Undo/redo is implemented as a **bounded stack of whole-state snapshots**, not a
log of reversible operations. Before a mutation, the current editor state is
deep-cloned into an `EditorSnapshot` and pushed onto the undo stack.

An `EditorSnapshot` captures:

- `occluders`
- `doorStates`
- `tokens`
- `selectedOccluderId`, `selectedTokenId`, `povTokenId`

## Where it lives

`web/src/main.tsx`: `editorSnapshot()`, `pushUndoHistory()`,
`undoEditorChange()`, `redoEditorChange()`, `restoreEditorSnapshot()`, with
`undoStack` / `redoStack` signals and a `historyLimit` of 60.

## Why this shape

The editable state is small (a few arrays of plain objects), so cloning it whole
is cheap and far simpler than maintaining an inverse for every operation. A
snapshot also captures selection and POV, so undo restores not just geometry but
*what you were looking at*, which feels right in an editor. Re-analysis,
draws, and toggles all become "mutate state, then redraw" with one shared
history hook.

## Gotchas

- Call `pushUndoHistory()` **before** applying a mutation you want to be
  undoable — analysis, occluder/token edits, deletes, door carving.
- The undo stack is bounded at `historyLimit` (60); the oldest snapshots are
  dropped. Don't rely on unbounded history.
- The **explored fog** (`exploredCanvas`) is *not* part of the snapshot. Undo
  restores occluders/tokens/POV and then `markExplored()` recomputes visibility,
  but previously-revealed area is canvas pixels, not state — treat the sidecar
  export, not undo, as the durable record.
- Clones must stay deep (`cloneOccluders`, `cloneTokens`, `cloneDoorStates`); a
  shallow copy would let a later mutation corrupt a stored snapshot.
