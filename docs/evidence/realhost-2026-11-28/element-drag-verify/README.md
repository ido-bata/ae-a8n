# element-drag-verify — real-host e2e evidence (#427 production path)

Script: `scripts/poc-element-drag-427.mjs` (production
`ae.dragDrop().dragElement()` against an owned AE 2027 launch; the foreign
AE 2026 instance, pid 4536, was never touched — every run preflights the
install-scoped pid census and the drag gates re-check topmost ownership per
segment).

This directory continues `docs/evidence/realhost-2026-11-28/element-drag-427/`
(the #427 landing runs). Goal here: ONE clean `verified` production-path run
for at least one proven element class.

## Runs

- `run.json` (+ `run-attempt1` console notes inline in git history) —
  cold AE 2027 launch: `AfterEffects.launch` readiness probe timed out at
  ~237s (`app.info` unanswered) while the process kept running and its main
  window was already on screen. Outcome `failed` at launch; the orphaned
  owned instance (pid 79028, path verified `…/2027/…`) was quit cleanly via
  `osascript … quit` before the next attempt. No drag was ever posted.
- `run2.json` — fresh owned launch (pid 26104, AE 27.0x78 build 78),
  outcome **`partial`**:
  - `timeline-layer` reorder: **`verified: true`** on attempt 0
    (`from {250,885} → {250,925}`, 24 segments, every segment census-clean,
    topmost = owned main window 7122). Oracle delta
    `orderChanged: true, countDelta: 0`; readback
    `comp.layers` `[L6,L5,L4,L3,L2,L1] → [L5,L4,L6,L3,L2,L1]` — L6 moved
    down two rows. This is the first clean production-path
    `element-drag`/`timeline-layer` verification on a real host.
  - `project-item`: 8 census-clean candidate drags all posted but produced
    no `project.items` delta → `indeterminate` (never resent). Root cause
    is targeting, not mechanism: `dockedPane` could not vend AX rows
    (`0 window(s) observed` — the `parent.windowNumber` was undefined in
    the pre-fix script; even after the fix, AE's AX tree does not vend the
    main window, #406-class non-vend), so press points were #411-relative
    guesses that missed the item rows.
  - `panel-tab`: one census-gated candidate posted; owned window count
    stayed 3 → unproven (see run3 for the abort-path evidence).
  - Owned instance quit cleanly (`close` → `quit: true`).
- `run3.json` — fresh owned launch (pid 80114) with the `windowNumber`
  census fix, outcome `failed` (0 verified):
  - `timeline-layer`: x=250 column was census-occluded this run so the
    candidate set shifted right; two drags posted with no delta
    (`indeterminate`), then the DOM readback oracle began returning no
    usable snapshot (`unavailable` — bridge readback degraded mid-run).
    No reorder occurred (`layers` unchanged).
  - `project-item`: 8 attempts, all `indeterminate` — same targeting gap.
  - `panel-tab`: the drag **aborted mid-sequence at segment 13** when the
    topmost window became pid 1961 — `UserNotificationCenter` (a macOS
    notification posted mid-drag). The per-segment census re-check refused
    to finish the gesture on a foreign window, exactly as designed; a
    partial drag may have occurred and was honestly reported
    `indeterminate`, never resent.
  - Owned instance quit cleanly.

## Script fix carried by this branch

`scripts/poc-element-drag-427.mjs`: resolve the main window's
`windowNumber` from the WindowServer census (pid + frame match) and pass it
as `dockedPane({ parent: { windowNumber } })`. In run2 the parent locator
degenerated to `{}` → "0 window(s) observed". In run3 the census number
resolved (7151) but AE still does not vend a framed AX window for it —
the pane-row oracle remains unavailable on this host (#406-class AX
non-vend), so row targeting still falls back to #411-relative anchors.

## Honest verification level

| element class | vehicle/mechanism | production `dragElement` path |
| --- | --- | --- |
| `timeline-layer` reorder | verified on real host (#411 PoC) | **verified on real host** — run2.json (`verified:true`, `orderChanged:true`, `comp.layers` delta) |
| `project-item` reorder | verified on real host (#411 PoC) | automated test + real-host attempted (run2/run3 `indeterminate` — coordinate targeting, not mechanism); NOT claimed verified |
| `panel-tab` dock→float | mechanism verified on real host (#427 run1 raw probe, census 2→3) | automated test + real-host attempted (run2 unproven, run3 census-abort on foreign notification window); NOT claimed verified |
| `other` element classes | — | refused by `dragDropMutationGate()` (contract test) |

Incidents: one cold-launch readiness timeout (run.json), one foreign
`UserNotificationCenter` window correctly aborting a panel-tab drag
mid-sequence (run3.json). No foreign AE process was signalled; owned
instances were quit via the API (`close`) or `osascript quit` after path
verification.
