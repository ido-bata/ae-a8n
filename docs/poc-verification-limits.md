# PoC / 検証 script の既知の制限（#433 監査）

#432 で確定した 6 欠陥 class を残りの全 PoC/検証 script と証跡へ適用監査した
記録。ここに挙げる項目は **修正せず制限として明記する** もの、または契約上
やむを得ない bypass である。各 script の個別判定は PR 本文の verdict 表を
参照。

## 1. swift input helper 群は production gate を構造的に bypass する（契約上の既知 gap）

`scripts/isolated-session/` の input 系 helper — `input-post.swift`、
`input-drag.swift`、`input-mouse.swift`、`input-clipboard.swift`、
`input-focus.swift`、`input-source.swift`、および関連する `window-ops.swift`、
`screen-record.swift`、`ax-press.swift` — は **delivery vehicle であり
gate ではない**。これらを手動実行すると `runInputPlan`
（`src/input/runner.ts`）の mutation gate・global-input authorization・
3 段階 focus proof、および `DragDropController` の gate chain
（`src/dragdrop/`）を **一切通らず**、その時点で focus/カーソル下にある
任意の app へ実キー・実マウスイベントを投稿する。

強制機構は存在しない。各 helper の冒頭コメントがこの事実を明記しており、
呼び出し側（`poc-panel-ax-vehicle.mjs` 等）が owned-pid 証明・census
gate・focus proof を自前で担保する運用契約になっている。helper 自体に
gate を retrofit することは本 ticket の範囲外（#433 明記）。

影響を受ける証跡: `docs/evidence/ime-realhost-2026-11-28/`（W1–W3 の
session-stream / to-pid posting は全てこの vehicle 経由。runbook
`docs/ime-input-realhost-poc.md` の abort 条件・focus proof 手順が
実質の gate として機能した記録であり、helper 側の強制ではない）。

## 2. aux window の raw CGEvent 移動は production op 外の workspace mutation

`poc-drag-drop.mjs`（`close-aux-windows` step）と `poc-drag-alt.mjs`
（`aux-clear` op / `moveAuxDown`）は、AE の補助浮動 window（ty-plus CEP
panel 等）を title-strip drag で画面下へ移動する。これは production の
どの op でもなく、`poc-drag.swift` が production gate chain を通さず
CGEvent を直接投稿する。

補償として実装されている gate: owned pid の window のみ対象、main window
（最大面積）は除外、各 drag 直前に z-ordered census で title 位置の
topmost が当該 windowNumber と一致することを再証明、foreign AE の
census drift で中断。対象は「この run が起動した AE の小さい補助
window」に限定されるため、実害リスクは限定的だが **production 契約の
外側の mutation であることは変わらない**。証跡
`realhost-2026-11-27/drag-drop-poc.md`・`drag-alt-411/` の解釈時は
この点を考慮すること。

## 3. bespoke activation / focus recovery loop

以下の script は `osascript`（System Events `set frontmost`）、`open`
（LaunchServices activate）、JXA `NSRunningApplication.activateWithOptions`
を使った **独自の activation loop** を持つ: `poc-panel-mutation-e2e.mjs`
（最大 12 回 + AX settle poll 15 回）、`poc-drag-alt.mjs`（`wait-visible`
op・ensure-front retry）、`poc-drag-drop.mjs`（attempt ごとの再 activate）、
`poc-panel-ax-vehicle.mjs`（`open` activate + post-activate poll）、
`poc-panel-mutation.mjs`（`open` activate）。

- いずれも **owned pid / owned bundle に pin** されており foreign process
  を activate しない。dialog への key 注入は行わない（class 2 非該当）。
- bounded で各 attempt が evidence に記録される。
- production に「activate」という公開契約が存在しないため、既存 infra
  （gui-lease / supervision）に乗せる経路が無い。class 6 の
  「場当たり的 recovery」としては **documented limitation** とする。
  将来 production に activation 契約ができたらこれらを置き換える。
- 同種の例として `poc-panel-mutation.mjs` の `AX_SET_ATTR_SCRIPT` は
  owned pid の process に `AXManualAccessibility` /
  `AXEnhancedUserInterface` を `true` に設定する（AX tree を vend させる
  既知 trigger の実験）。owned-pid pin・単発・証跡記録ありだが、
  production op ではない属性 mutation である点は同じ。

## 4. `poc-drag-alt.mjs --attach-pid` lane の SIGTERM→SIGKILL

attach した pid はこの run では起動していない。「以前の owned run が
起動したインスタンス」という前提は **証明不能** であり、運用契約上の
仮定である。#433 で signal 直前に `inScopeAEPids`（install.executable
一致）を再確認する guard を追加した — attach 時に transport が証明した
「この install の AE」であることは維持されるが、「この PoC が起動した」
ことの証明ではない点は変わらない。attach 対象が本当に前回 run の
残りであることは operator が確認すること。

## 5. readiness timeout の phase 不分離は残存

`--readiness-timeout-ms` を `poc-drag-drop.mjs`、`poc-drag-alt.mjs`
（launch/attach 両 lane）、`poc-panel-mutation.mjs`、
`poc-panel-mutation-e2e.mjs`、`poc-panel-ax-vehicle.mjs` に追加し
CLI configurable 化した（#432 と同じ対応）。ただし `AfterEffects.launch`
内部の readiness probe は単一 `app.info` poll であり、「まだ起動中」と
「hang」の phase 区別は src 側の課題として残る。sampled attribution
（`poc-boot-attribution.mjs` の方式）を readiness probe 本体に入れるのは
production code の変更を伴うため本 ticket では扱わない。

## 6. `element-drag-verify/` の証跡は #432 の欠陥を含む

`docs/evidence/realhost-2026-11-28/element-drag-verify/run*.json` は
`poc-element-drag-427.mjs`（#432 で修正中）の出力であり、以下を含む:

- `run.json` の `dialog-dismiss-launch` step — 独自 watchdog が dialog
  class を区別せず key を注入した記録（#432 欠陥 class 2）。
- 全 run で `close` / `postflight-census` step が JSON に無い
  （emit-before-cleanup、#432 欠陥 class 5）。README の「owned instance
  quit cleanly (`close` → `quit: true`)」は console 出力の記述であり、
  JSON 証跡には cleanup が残っていない。
- `run2.json` の `project-candidates` 8 連続 drag（indeterminate 後の
  候補反復、#432 欠陥 class 3/4）。

これらの run の「verified」判定は oracle readback（`comp.layers` /
`project.items` delta）に基づくため mutation 証拠としては有効だが、
**watchdog が dialog を誤って dismiss した可能性と、cleanup が証跡に
残っていない点を割り引いて解釈すること**。#432 の修正で script 側は
正される；証跡 JSON 自体は歴史的記録として改変しない。

## 7. その他の監査済み clean 項目（参考）

- `poc-boot-attribution.mjs`: positive pattern の原本。configurable
  sampled waits・fail-closed preflight・emit-after-close 全て健全。
- `check-dispatcher-acceptance.js` / `check-consumer-smoke.js`:
  A8N_RESULT は cleanup 後に emit、blocked≠pass の exit code 対応
  （blocked→3）・cleanup field も一貫。clean。
- `startup-probe.mjs` / `script-trust-probe.mjs` / `probe-windows.mjs` /
  `windows-agent.mjs` / `inprocess-proof.mjs`: AE プロセス制御を
  持たないか、既存 API 経由のみ。clean。
- `scripts/isolated-session/*.mjs`（dispatch/session-agent/
  run-in-isolated-session/session-rules/grant-check/permission-probe/
  ae-e2e）: job 配送・session 証明の infra であり、kill は自分が spawn
  した child の timeout escalation のみ。`run-in-isolated-session.mjs`
  は `assertNoRunningAfterEffects` で fail-closed。clean。
- `poc-panel-extension.mjs` / `poc-drag-extension.mjs` /
  `poc-drag-alt-extension.mjs`: in-AE ExtendScript source のみ。
  defect class 非該当。
