# Claude Code Notes

Read [`AGENTS.md`](AGENTS.md) first. It is the shared source of truth for agent
workflow, the default completion/deploy cadence, verification commands, project
shape, and the coding and visual rules in this repo.

For deeper architecture and reference material, see [`docs/`](docs/README.md):

- [`docs/architecture/overview.md`](docs/architecture/overview.md) — the three
  layers (deterministic core, browser UI, Cloudflare Worker) and how data flows.
- [`docs/architecture/los-core.md`](docs/architecture/los-core.md) — the
  deterministic geometry and image-analysis core.
- [`docs/guides/ui.md`](docs/guides/ui.md) — the browser app: tools, drawer
  tabs, counters, fog, undo/redo, and keyboard shortcuts.
- [`docs/reference/sidecar-format.md`](docs/reference/sidecar-format.md) — the
  exported LOS sidecar JSON shape.
- [`docs/reference/deployment.md`](docs/reference/deployment.md) — the Worker
  and `los.tre.systems` deployment.
