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

## 訂正（#432 監査で確定した harness 欠陥）

以下の run*.json は、欠陥を持つ旧版 script が生成した記録である。artifact 自体は改変していないが、解釈上の注意が必要。

- **dialog watchdog の Return 注入**: run.json / run2.json / run3.json / run4 の全 run で、起動時および window 観測中に `maybeDismissDialogs` が稼働していた。owned pid + onScreen + layer>=8 + <800x600 という heuristic で検出した window に `osascript key code 36`（Return）を posting しており、dialog 分類・taxonomy・GUI lease・audit・pid attribution を全て bypass していた。記録上の `dialogDismissals` は全 run で 0（実際に dismiss された dialog は無い）だが、仕組みとしては「破棄確認」「crash recovery」等の未分類 dialog の default button を押し得た。run4 は JSON 未生成のため記録自体が無い。
- **error code を見ない候補反復**: `timeline-layer` / `project-item` の候補 loop は `dragElement` の失敗時に `error.code` を確認せず次候補へ進んでいた。run.json は各 op 3 回、run3.json は各 op 5 回の試行を記録し、run2.json も同じ経路で反復している（記録 code は全て pre-act 系: `stale-locator` / `unproven`）。この artifact 上は post-act な再送は起きていないが、`indeterminate`（部分 drag が着弾した可能性・再送禁止の contract）でも同じ経路で resend し得た。`panel-tab` loop のみ `preAct` whitelist を持っていた。
- **emit が cleanup 前**: run.json / run2.json / run3.json のいずれにも `close` step が無い。`emit(evidence)` が `finally { ae.close() }` より先に実行されていたため、close 結果と postflight census は JSON に残っていない。run4 は uncaught failure で JSON 自体が出力されなかった。
- **readiness timeout**: `readinessTimeoutMs: 240_000` 固定・CLI flag 無し・phase 不分離。darwin では `awaitScriptable` が即 true を返すため、budget 全てが単一 `app.info` probe に費やされ、「まだ起動中」と「hang」を区別する記録が無い。

修正は #432 で実施: watchdog を撤去し sanctioned path（`createHostRecovery().attempt()` = taxonomy 分類 + lease/audit/pid attribution、`ae.guiState()` = read-only 分類）のみに置換、候補 loop に `preAct` whitelist を適用、emit を close+postflight 後へ移動、readiness timeout を CLI configurable（既定 120s）+ per-poll samples 付きに変更。

## Honest verification level

- `project-item` / `timeline-layer` reorder: vehicle `verified on real host`
  via the #411 PoC (`docs/evidence/realhost-2026-11-27/drag-alt-411/`);
  production path is `automated test` + real-host attempted here but
  environment-blocked — NOT claimed as production-path verified.
- `panel-tab` dock→float: mechanism `verified on real host` (run.json raw
  probe, census window count 2→3); production path `automated test`,
  clean e2e pending a quieter host layout.
- `other` element classes: refused by `dragDropMutationGate()` (contract test).
