# element-drag-427 — real-host e2e evidence (#427)

Script: `scripts/poc-element-drag-427.mjs` (production `ae.dragDrop().dragElement()`
path against an owned AE 2027 launch; foreign AE 2026 instance never touched).

## Runs

- `run.json` — first production-path attempt. All `element-drag` ops failed
  `stale-locator` (surface resolved before fixture setup dirtied the project;
  window title gained ` *`). The raw `input-drag` panel-tab probe DID tear off
  a panel: owned census window count 2 → 3 — the mechanism evidence that
  justified permitting `panel-tab` with the census window-count oracle.
- `run2.json` — after the surface re-resolution fix. Reorder ops reported
  `verified:true` with a FLAT delta — this exposed oracle bug (a):
  `countDelta !== null` satisfied the postcondition on the first poll even
  with zero change. Fixed in `src/dragdrop/controller.ts` (only a NONZERO
  count change counts) with a regression test. `panel-tab` refused `unproven`:
  the drop point was covered by the owned comp-viewer window.
- `run3.json` — with the oracle fix and candidate probing. Reorder attempts
  refused `unproven` (foreign AE 2026 window occluding the timeline band;
  owned floating panel occluding the project panel). `panel-tab` attempts
  revealed bug (b): mid-tear-off the dragged panel's own floating window
  becomes topmost and the strict segment re-check aborted the drag.
  Fixed: `panel-tab` segment checks are pid-only (foreign pid still aborts).
- run4 (no json — uncaught bridge failure before emit; script now always
  emits) — stray presses tore off additional panels and the host went busy;
  the workspace layout (restored floating panels + foreign AE overlap +
  #406 AX non-vend) made clean verification impossible in this session.

## Honest verification level

- `project-item` / `timeline-layer` reorder: vehicle `verified on real host`
  via the #411 PoC (`docs/evidence/realhost-2026-11-27/drag-alt-411/`);
  production path is `automated test` + real-host attempted here but
  environment-blocked — NOT claimed as production-path verified.
- `panel-tab` dock→float: mechanism `verified on real host` (run.json raw
  probe, census window count 2→3); production path `automated test`,
  clean e2e pending a quieter host layout.
- `other` element classes: refused by `dragDropMutationGate()` (contract test).
