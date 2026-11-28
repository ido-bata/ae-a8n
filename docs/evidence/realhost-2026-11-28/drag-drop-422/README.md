# drag-drop-422 — real-host e2e evidence (#422)

Script: `scripts/poc-drag-drop-422.mjs`（production `ae.dragDrop().dropFile()`
path against an owned AE 2027 launch; foreign AE 2026 instance never touched）。

## Runs

- `run.json` — `dropFile` verified on real host（8x8 fixture PNG を Project
  panel へ vend、`project.items` oracle で delta 確認）。あわせて pid-scoped
  surface attribution（`windowNumber` 解決）の実機証拠。

## 訂正（#432 監査で確定した harness 欠陥）

`run.json` は欠陥を持つ旧版 script が生成した記録である。artifact 自体は改変していないが、解釈上の注意が必要。

- **dialog watchdog の Return 注入**: 起動時および window 観測中に `maybeDismissDialogs` が稼働していた。owned pid + onScreen + layer>=8 + <800x600 という heuristic で検出した window に `osascript key code 36`（Return）を posting しており、dialog 分類・taxonomy・GUI lease・audit・pid attribution を全て bypass していた。記録上の `dialogDismissals` は 0（実際に dismiss された dialog は無い）だが、仕組みとしては未分類 dialog の default button を押し得た。
- **候補反復**: 本 script の op は `dropFile` 単発で候補 loop を持たないため、この欠陥の対象外。
- **emit が cleanup 前**: `run.json` に `close` step が無い。`emit(evidence)` が `finally { ae.close() }` より先に実行されていたため、close 結果と postflight census は JSON に残っていない。
- **readiness timeout**: `readinessTimeoutMs: 240_000` 固定・CLI flag 無し・phase 不分離。darwin では `awaitScriptable` が即 true を返すため、budget 全てが単一 `app.info` probe に費やされ、「まだ起動中」と「hang」を区別する記録が無い。

修正は #432 で実施: watchdog を撤去し sanctioned path（`createHostRecovery().attempt()` = taxonomy 分類 + lease/audit/pid attribution、`ae.guiState()` = read-only 分類）のみに置換、emit を close+postflight 後へ移動、readiness timeout を CLI configurable（既定 120s）+ per-poll samples 付きに変更。

## Honest verification level

- `dropFile`（file vend → Project panel drop → `project.items` oracle）:
  `verified on real host`（本 run.json）。
