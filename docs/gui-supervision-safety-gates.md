# GUI supervision 安全性ゲート監査（#338 / A-SAFETY）

- 親 program: [#337](https://github.com/ido-bata/ae-a8n/issues/337)（A-SAFETY = 本監査）
- 対象: #278 / #294 / #295 / #304 / #309 / #313 / #316 / #321 / #322 / #323 / #324 / #329 / #330 / #336
- 判定基準: open/closed ではなく **現行コード・merge 済み PR・実機証跡**。基準 revision は `release-0-7-0`（0.6.0 merge 済み + train 開設 commit `3eb643c`）。
- 位置づけ: Stage 0 の 3 チェックのうち「対象誤認 issue の特定」が本書。残り 2 点（ae-devtools#423 の生存判定、#339 A-BOOT の応答前監視 PoC）は本書の対象外であり、**本書の結論はこの 2 点を待たない**。

## 結論サマリ

- **誤対象への mutation 経路は現時点で確認されなかった。** macOS の press は census 帰属 `"owned"` + frame 一致 + lease 内再帰属を必須とし（#330/#332 修正済み）、Windows は auto-safe class がゼロで press 経路が事実上不活性。fail-closed（監視なし・`unavailable`）側に倒れる gap のみ残る。
- **新規の mutation 無効化 ticket は不要。** 安全性欠陥は全て既存 ticket が owner。
- **未修正の安全関連 defect は #329 のみ**（Windows helper window の false blocked）。mutation ではなく誤報告方向の欠陥で、既存 ticket に受入条件を追記した。
- **#336 は診断 gap** であり対象誤認・誤操作に直結しない。A0/A1 ブロッカーにしない。
- 残存 gap は「監視が存在しない/不完全」側（fail-closed）に集中: win32 dispatcher session、native-channel session（両 OS）、detached supervisor の win32、#329 の分類精度。

## Issue 別 evidence / state / gate / owner

| Issue | 内容 | コード・PR 証跡 | 検証レベル | 分類 | 担当 |
| --- | --- | --- | --- | --- | --- |
| #278 | Epic: GUI supervision 基盤 | #280〜#316 系 PR が 0.6.0 で merge（release PR #320）。`src/supervision/`、`src/platform/*/gui-probe.ts`、`docs/sessions.md`、spec/ADR-0005 が正本 | automated test（fake host）中心。実機 matrix は #288 lane | epic tracking（委譲） | #278 |
| #294 | dispatcher/native-channel の pid/session attestation | PR #298/#300/#312 merge。`DispatcherTransport.#attestedHost()`（dispatcher-transport.ts:1312-1391）が provenance + heartbeat instance/nonce + OS census `sameProcess` + GUI session を再証明。`attributeAeByCensus`（supervision-session.ts:186-203）で一意 AE のみ帰属。launch.ts:553-612 で darwin dispatcher session に配線 | automated test + 実機観測（#294 本文の調査）。**残存 gap**: win32 dispatcher session と native-channel session（両 OS）は monitor 未配線 → `unavailable`（fail-closed）。native-channel の pid は plug-in 自己申告で census 未照合 | 部分検証済み・残 gap は fail-closed | #294（残 gap の受入条件を追記） |
| #295 | monitor の request-process 非依存化 | PR #299/#302 merge。`src/supervision/detached.ts` + `supervisor-entry.ts`。observation-only・lease 重複防止・`unref` detached spawn。macOS のみ（win32 はコードコメントで deliberate follow-up と明記） | automated test（`test/supervision-detached.test.ts`）。実機での「親終了後も heartbeat 継続」は未確認 | 検証済み（契約）・実機継続性は未検証 | #295 |
| #304 | AX windows クラスに AE window が出ず常時 blocked | PR #307 merge。`UI elements` 配下の `AXLayoutArea`/`AXFloatingWindow` を window inventory に算入（gui-recovery.ts）。健全 AE が `running` に到達する経路を回復 | automated test + #288 実機スモークで発見・修正 | 検証済み（修正の実機再確認は #288 lane） | #304 |
| #309 | recovering 中の新規 blocking を再ブロックしない | PR #310 merge。`monitor.ts:354-369` で `recovering && !clear` かつ detail 変化時に `blocking-observed` を再 dispatch（flap 防止の detail 一致条件付き） | automated test（supervision.test.ts） | 検証済み | #309 |
| #313 | verified rebuild 後の transport 再 stage | PR #314 merge。`src/api/rebuild.ts` `restageSessionTransports`（:215-351）: dispatcher activation を provenance（pid 結合）経由で再配信、script-invocation は `not-required`、native-channel は session transport 非該当を明示、失敗は `failed`/`unproven` で正直に報告。UNKNOWN 非再送契約は不変 | automated test（session-rebuild.test.ts）。実機での dispatcher 再 activation 確認は #288 受入へ | 検証済み（契約）・実機は未検証 | #313 |
| #316 | Windows session への GuiProbe 統合（観測のみ） | PR #319 merge。`WindowsGuiProbe`（platform/windows/gui-probe.ts）を `SessionSupervision.#buildProbe`（supervision-session.ts:302-344）に接続。`expectedSessionId` + 呼出側 `verifyPid` で pid 再証明。capabilities は `platforms: ["darwin","win32"]`・`probe: "win32-uia"` を正直に報告。monitor/observation 経路に mutation 権限なし | automated test（supervision-windows.test.ts, windows-gui-probe.test.ts）。実機 Windows lane は #288 | 検証済み（契約）・実機未検証 | #316 |
| #321 | AE 2027 AX-invisible modal → false green | PR #325 merge。`axUnaccountedWindows`（gui-recovery.ts:309-311, 188）+ `UNACCOUNTED_CONFIRM_OBSERVATIONS=2`（gui-probe.ts:91, 285-312）で census on-screen window を 2 連続観測で blocking 化 | 実機発見（AE 2027 実測）+ 修正は automated test。修正後の実機再確認は未実施 | 修正実装済み・実機再検証は未確認 | #321 |
| #322 | 起動直後の過渡的 AX 空で blocked 張り付き | PR #326 merge。`AX_SUSPECT_STARTUP_GRACE_MS = 5min`（gui-probe.ts:110）+ `processAgeMs`（`ps -o etime=`）。猶予内は degraded evidence のみ、経過後・年齢不明は従来通り blocking window を合成（fail-closed） | 同上 | 同上 | #322 |
| #323 | win32: 第 2 AfterFX.exe で supervision が構造的に起動不能 | PR #328 merge。`#hostProcessesFrom`（script-invocation.ts:1433-1452）が `windowsSameInstall` で install path scope。`windowsProcesses` は全 AfterFX.exe を返すが in-scope 判定は install 単位。ownership evidence の誤帰属も install scope で解消 | 実機発見（device-windows、AE 2026+2027 同居）+ 修正は automated test | 修正実装済み・実機再検証は未確認 | #323 |
| #324 | win32: WindowsGuiProbe 30s timeout 超過 + TimeoutError 実測乖離 | PR #327 merge。observer は `done`/`censusComplete`/`uiaComplete`/`timedOut` を NDJSON で報告、probe 側 deadline（40s）で有限化、`windowsGuiHostState` は完了証明なしを `unknown` に倒す（gui-probe.ts:415-438） | 実機発見 + 修正は automated test | 同上 | #324 |
| #329 | win32: helper/invisible window が blocking 誤分類（DroverLord） | **未修正**。`isBlockingWindowsWindow`（gui-probe.ts:369-381）は visible かつ `#32770` または owner 無効化のみで判定し、helper class の除外・帰属精緻化なし。Windows auto-safe class はゼロのため誤 press リスクはないが、modal 解消後の false `blocked`/`recovering` 残留リスクは残る | 実機発見（device-windows）。修正なし | **open defect（信頼性ゲート）** | #329（受入条件を追記） |
| #330 | macOS multi-install: AX window listing が bundle で混同 | PR #331 + #332/#333 merge。AX window ごとに WindowServer census で `owned`/`foreign`/`unmatched` 帰属（gui-recovery.ts:100-138, 302-348）。`isPidAttributedWindow` で blocking/mutation evidence から除外。press は `expected.censusAttribution === "owned"` + frame 必須、lease 内で再帰属、座標 fallback も同ゲート（gui-recovery.ts:1218-1358） | 実機発見（AE 2026+2027 同居、`unix id` 指定は動作確認済み）+ 修正は automated test | 修正実装済み・実機再検証は未確認 | #330 |
| #336 | diagnostics: CEPHtmlEngine crash report / CSXS ログ未収集 | **未修正**。`darwinDiagnosticSources`（session-diagnostics.ts:148-170）の `AE_PATH_PATTERN` は `after effects|afterfx|aerender` のみで `CEPHtmlEngine`・`~/Library/Logs/CSXS` を含まない | 実機観測（ty-plus E2E の wedge 事例） | 診断 gap（対象誤認に非直結） | #336 |
| #406 | AE が起動 phase で AXChildren/AXWindows/UI elements を vend しないことがある（AXFocusedWindow のみ到達可能） | 本 PR。`window-ops` helper の `state` が `focusedWindow`（AXFocusedWindow の属性一式）と `axTrusted`（AXIsProcessTrusted）を報告。`ae.windowOps(locator, { focusedOnly: true })` で AXFocusedWindow + CGWindowList census 照合による observe-only resolve を追加。mutation は focusedOnly 下で gate の如何に関わらず refuse。`axSuspectReason`（gui-recovery.ts）と panel/window-ops の not-found hint で「列挙が空」を正直に報告 | **verified on real host**（非 vend は起動途中・readiness timeout の instance で観測。証跡 `docs/evidence/realhost-2026-11-27/`。起動完了後の instance は通常どおり vend することも同日確認）。`window-ops state` の `focusedWindow`/`axTrusted` 出力は実機 AE 2026/2027 双方で確認済み（`window-ops-state-ae2026.json`/`window-ops-state-ae2027.json`）。focusedOnly resolve・`axSuspectReason`・not-found hint は automated test（fake host）— 実機 AE への end-to-end 適用は未検証 | 修正実装済み（observe のみ）・mutation vehicle は未許可 | #406 |

## 不変条件の現行評価

| 不変条件 | 現状 | 根拠 |
| --- | --- | --- |
| PID + 開始 identity | 維持。`sameProcess`（pid+start time、Windows は creation identity）を census/provenance/press 直前に再証明。pid 再利用は別 process として fail-closed | host-processes.ts, session-rebuild.ts:92-173, gui-recovery.ts verifyProcess, supervision-session verifyPid |
| install path | 維持・強化。Windows は `windowsSameInstall` で install 単位 scope（#323）。macOS は executable path + uid scope | script-invocation.ts:1417-1453 |
| OS user/session | 維持。macOS は uid+asid（Aqua session）、Windows は sessionId + `expectedSessionId` probe 内照合。別 session の AE は対象外 | supervision-session.ts, gui-probe.ts:549-560, censusPidVerifier |
| window 帰属（AX→pid） | #330 で census 帰属必須化。`foreign`/`unmatched` は evidence から除外、press は `owned`+frame のみ | gui-recovery.ts:122-138, 1234-1248 |
| 複数版共存 | macOS: bundle-confused AX listing を census 帰属で無効化。Windows: install scope で census、supervision は script-invocation session のみ起動（dispatcher は gap） | #330/#323/#294 |
| PID/HWND 再利用 | pid は start identity で再証明。HWND は press script が同一 run 内で title/class/marker text を再検証（TOCTOU は lease 内に限定、完全には残る） | windows-gui-recovery.ts:757-839, gui-recovery.ts pressButtonIn |
| TOCTOU | lease 保持下で press 直前に再帰属・再一覧。AX listing と press の間の窓は「狭いが残る」とコードが明記 | gui-recovery.ts:1314-1326 |
| 観測不能を正常扱いしない | 維持・強化。census 不能・AX 全滅・unaccounted window・未完了 census は全て degraded/blocked/unknown に倒す。`axSuspect` は起動 grace（5min）のみ例外で、年齢不明は fail-closed | gui-probe.ts, windows gui-probe.ts:425-438 |
| AX 非露出/過渡的空 | #321（AX-invisible modal を census frame で検出、2 連続確認）と #322（起動 grace）で両側をカバー。残る既知の死角: grace 内の真の AX-invisible modal は delayed detection（コードコメントで明記済み） | gui-probe.ts:91-110, 257-313 |
| helper window | **#329 未修正**。Windows census の blocking 判定に helper class 除外がなく、modal 解消後の false blocked リスク | gui-probe.ts:369-381 |
| 期限（bounded wait） | 維持。observer deadline、state deadline、monitor heartbeat staleness → `monitor-lost`。TimeoutError は実測経過を報告（#324） | windows gui-probe.ts:464-527, supervision/state.ts |
| lease/monitor health | 維持。monitor lease 単一 writer、GUI lease 単一 mutator、分離した権限。detached supervisor も同一 lease で重複防止 | supervision/lease.ts, detached.ts, ADR-0005 §3 |

## 概念の区別（混同防止の確認）

- **local / remote / isolated-user**（ADR-0003 の execution mode）は transport/実行場所の区別であり、supervision の観測・mutation 権限とは独立。本監査の全証跡は local mode のみ。remote host の supervision は未証明。
- **所有権（owned/attached/unknown）** は quit・rebuild の権限。census 帰属（#294）は「どの process を観測するか」のみを証明し、所有権・mutation 権限を与えない（supervision-session.ts:103-115 のコメントが明記）。
- **データ隔離**（channel dir の user-private ACL）と **GUI 専有**（GUI lease + census 帰属）は別権限。monitor lease は observation write のみを直列化し、press 権限を持たない。
- **認可（authorization grant）** は `attached` session の操作 class 許可であり、supervision の観測開始条件とは無関係。`unknown` ownership は grant でも解放されない。

## ゲート詳細（rationale / owner / 解除条件 / 最小実機 PoC）

### G1. 対象識別の誤帰属（本監査の中核）— 解除済み（#330/#323/#294 修正）

- 根拠: #330 の bundle-confused AX listing は press が他版 AE の dialog を押し得る唯一の確認済み wrong-target 経路だった。census 帰属 + lease 内再検証で塞がれた。
- 既存 owner: #330（closed 相当の修正 merge 済み、issue は open のまま）。
- 解除条件: 修正の実機再検証（AE 2026+2027 同居で `pressButtonIn` が foreign window を拒否すること）を #288 lane で記録。
- 最小実機 PoC: multi-install host で supervision blocked → auto-safe class の press が対象 pid の window のみに着地することを trace で確認。

### G2. 監視不能 session（fail-closed gap）— 未解除・ブロッカーではない

- 根拠: win32 dispatcher session、native-channel session（両 OS）、win32 detached supervisor は monitor が起動せず `unavailable` を返す。誤対象を操作する方向ではなく「監視が無い」方向の gap であり、US-A2/A3 の「対象外への dispatch/press/terminate は拒否」の AC には適合（拒否 = 監視も mutation も無し）。
- 既存 owner: #294（attestation/配線）、#295（detached の win32 はコード上 follow-up 明記）。
- 解除条件: win32 dispatcher の attestation→monitor 配線の要否を spec で決め、native-channel pid の census 照合方針を決める。
- 最小実機 PoC: win32 で `activateDispatcher` → attach session の `supervisionState()` が `unavailable` でなく観測状態を返すこと（#294 の検証欄に既出）。

### G3. Windows blocking 分類の精度（#329）— open defect

- 根拠: helper/invisible window が `blocking:true` になると modal 解消後も `blocked`/`recovering` から復帰しない false blocked。安全方向（過剰検出）だが、真の modal と helper の区別がつかないと「有限時間で needs-human」の UX を損なう。
- 既存 owner: #329。auto-safe class が Windows にゼロのため mutation リスクはなく、A0/A1 ブロッカーではない。
- 解除条件: helper class（Chromium 系 `DroverLord` 等）の除外規則または「owner が modal でない helper は blocking にしない」判定を実装し、modal→解消で `resumed` へ戻ることを実機確認。
- 最小実機 PoC: device-windows で `ui.alert` modal → Script Alert 検出 → 解消後に helper window のみ残る状態で phase が `running` に戻ること。

### G4. 診断証跡の網羅（#336）— 対象外分類

- 根拠: CEPHtmlEngine の crash report と `~/Library/Logs/CSXS` が `diagnostics()` に含まれず、「surface wedge・host 生存」の証跡が取れない。supervision の対象誤認ではなく診断完全性の問題。
- 既存 owner: #336。
- 解除条件: `darwinDiagnosticSources` に CSXS logDir と CEPHtmlEngine 系 crash pattern を追加（境界は他 Adobe app log を巻き込まない既存 `logFilePattern` の仕組みで担保）。
- 最小実機 PoC: 不要（collector の単体テスト + fixture で十分。実機再現は wedge 再現コストが高い）。

### G5. 起動応答前の監視（A-BOOT = #339）— 別 ticket

- Stage-0 の 3 点目。本監査の範囲外。#339 が「起動前に監視準備・応答前帰属証明」を扱う。#322 の grace・#294 の attestation・#330 の帰属はその入力契約として機能する。

## mutation 有効化の判定（T003）

- 現在有効な GUI mutation は macOS `auto-safe` class `ae-a8n ui.alert` の press のみ（dialog-taxonomy.ts:194-）。Windows は auto-safe class ゼロで press は不活性。いずれも lease + 監査 + 帰属再検証を経る。
- **新規の mutation-disabling 実装 ticket は起票しない。** 未修正 defect（#329）は誤報告方向、残 gap（#294/#295 の未配線側）は監視不存在方向であり、いずれも「誤対象を操作する」経路を新たに開かない。
- 既存 ticket への受入条件追記: #294（残 gap の明確化）、#329（分類精度の受入条件）、#336（診断 gap である旨の分類確認）。

### panel mutation（#343 / B-PLATFORM）— 未許可（fail-closed）

- 対象: `ae.panel()` の `resize`/`restore`（`mutate-gui` class。実装は `src/panels/` + `RESIZE_PANEL_SCRIPT`、契約は `specs/panel-interaction/spec.md`）。
- 現状: **無効**。auto-safe class に panel mutation は存在せず、実機で AE panel が `set size`（System Events 経由の AX size set）に応答することも未検証（owned AE launch が #339 と同じく blocked）。`panelMutationGate()`（`src/panels/gate.ts`）が唯一の flip point で、現時点では常に refuse し、理由に本書を明記する。
- 多層防御（gate とは独立に常時有効）: census 帰属 `"owned"` 必須（`foreign`/`unmatched`/`unproven` は mutation・capture とも拒否）、GUI lease + audit、lease 内の frame/title/subrole 再検証、process identity 再証明、mutation outcome 不明時は `indeterminate` で再観測要求。
- 解除条件: (a) 本監査で panel resize class を auto-safe 相当と判定、(b) owned AE で `set size` の実機検証（resize → census/AX frame の readback 一致）、(c) 座標系の一意性確認（points 空間で DPI 換算を伴わないことの実測）。
- 最小実機 PoC: owned AE の ScriptUI resizeable window に対し `panel.resize()` → `measure()` で要求サイズと観測 frame の一致を確認し、`restore()` で元 frame に戻ること。証跡は PanelCapture artifact（sha256/backingScale/leakage）とともに #343 に記録。

### AX 非 vend の AE への window 到達（#406）— observe のみ許可、mutation は不許可

- 背景: #337 real-host PoC（証跡 `docs/evidence/realhost-2026-11-27/`）で、起動途中・readiness timeout に至った owned launch と foreign AE 2026 において `AXChildren`/`AXWindows`/AppleScript `windows of process`/`UI elements of process` が **0 件**であることが実機確認された（対照アプリは正常に AX を expose するため TCC/権限起因ではなく、`AXIsProcessTrusted=true`）。`AXFocusedWindow` のみが実 window（frame・role を持つ AX element）を返す。ただし同日の追試（同証跡 README 末尾）では、起動完了後の AE 2026/2027 が通常どおり AX window を vend することが確認されており、**非 vend は絶対的性質ではなく起動 phase 依存**と読むのが現時点の正しい前提 — 起動直後こそ supervision が必要とする局面である。
- 現行の fail-closed は維持される: 列挙が空なら `ae.panel()`/`ae.windowOps()`/`ae.dockedPane()` の target resolve は `not-found` で拒否し、supervision の window 判定は `axSuspect`（+ 新設の `axSuspectReason`）で「AX tree が信用できない」ことを明示する。誤って「window 無し = clean」と読む経路はない。
- 追加した observe-only 経路: `ae.windowOps(locator, { focusedOnly: true })`。`window-ops state` が報告する `AXFocusedWindow` の属性（title/role/subrole/frame/miniaturized/main/focused）を locator および CGWindowList census の frame 照合（AX point == census point、実機計測済み）で `PanelTarget` に解決する。`resolution: "focused-window"`、`windowIndex: null`（列挙 index は存在しない）を報告し、unfocused window を名指す locator（例: 別の `windowNumber`）は `not-found` を返す — 推測で別 window に retarget しない。
- **mutation は許可しない**: focusedOnly 下では `move`/`resize`/`minimize`/`restore`/`maximize`/`focus` が gate の如何に関わらず `refused` で失敗する（`WindowOpsController.#mutate` が構造的に拒否）。理由: `act` vehicle は AX window 列挙を再 list して identity を照合する設計であり、列挙が空のホストでは vehicle 自体が機能しない。実機 PoC が証明した「AXFocusedWindow element への直接 `AXUIElementSetAttributeValue(kAXSizeAttribute)`」は有望だが、**別 vehicle・別 identity 規則・別 postcondition を要し、A-SAFETY review なしに配線してはならない**。
- 検証レベル: AX 非 vend 挙動と AXFocusedWindow の frame 一致は **verified on real host**（2026-11-27 証跡）。focusedOnly resolve・`axSuspectReason`・not-found hint は **automated test**（fake host）のみで、実機 AE への適用は未検証。
- 解除条件（mutation を将来許可する場合）: (a) AXFocusedWindow element を直接 address する vehicle の設計（identity = census windowNumber + frame、postcondition = CGWindowList readback）、(b) focused 依存の制約（unfocused window は原理的に到達不能）の contract 明記、(c) 実機での resize/restore 往復証跡、(d) 本書への追記と gate flip の明示的 commit。
- 最小実機 PoC: `docs/evidence/realhost-2026-11-27/ax-focused-window-resize.json` が既に resize→restore の frame 一致を記録済み。focusedOnly `state()` を実機 AE に向けて実行し `resolution: "focused-window"` と census `windowNumber` が返ることを確認するのが最初の確認項目。

## 未確認事項（unverified として明記）

- #321/#322/#323/#324/#330 の各修正は実機で**発見**された defect への修正であり、修正後の実機再検証は #288（Windows 11 + macOS AE 2026/2027 matrix、freeze 後受入）に委譲されている。現時点の検証レベルは `automated test`（fake host）+ 実機発見時の観測証跡。
- #295 detached supervisor の「親 process 終了後も heartbeat が更新され続ける」は契約・fake test のみ。実機での継続性は未確認。
- #313 の dispatcher 再 activation は fake contract test のみ。実機 AE での再配信確認は #288 受入。
- remote / isolated-user mode での supervision は一切未証明（scope 外、fail-closed）。
