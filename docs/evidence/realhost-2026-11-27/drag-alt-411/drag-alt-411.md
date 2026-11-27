# Drag-drop 代替経路 PoC — macOS, 2026-11-27 (issue #411)

Issue #411: #369 で「AE は外部 file drop を拒否する（`operation:"none"` ×39）」
と結論した件について、**アプリ内 element drag** と **別 vend 経路の file drop**
が実機 AE 2027 で動くかを切り分ける PoC。#369 の「CGEvent drag 全般が拒否される」
のか「外部 file drop だけが拒否される」のかを判定するのが目的。

プローブは `scripts/poc-drag.swift`（`--dwell-ms` / `--vend fileurl|legacy` を追加）、
`scripts/poc-drag-alt.mjs`（plan-file orchestrator）、`scripts/poc-axwalk.swift`
（AX tree dump）、`scripts/poc-drag-alt-extension.mjs`（in-AE oracle 用 host）。
shipped feature ではない。

Verification level: **verified on real host**（観測記録のみ）。

## 環境

- macOS arm64、screen 1710x1112pt、user `rebui`
- 対象 install: Adobe After Effects 2027（27.0x78、`/Applications` 配下）
- AE 2026 は foreign instance として断続的に起動・終了を繰り返す
  （外部 automation が駆動）。全 pointer event 投稿の直前に z-ordered
  WindowServer census で drop/drag 地点の最前面 window が **owned pid の
  main window** であることを証明する gate を通し、foreign window が
  最前面の op は投稿せず skip した。
- console session は他 agent（Ghostty/Vivaldi/ChatGPT/Electron）が
  共有しており、focus が頻繁に奪われる。各 event op の前に
  `ensureFront`（activate + census poll、最大 30s）を挟んだ。

## 結果サマリ — #369 の結論を覆す

| 経路 | 結果 | 判定 |
| --- | --- | --- |
| Project panel 内 item reorder（CGEvent drag） | `projectOrderChanged:true` ×2 | **動く** |
| Timeline layer reorder（CGEvent drag） | `layerOrderChanged:true` | **動く** |
| file drop `vend=fileurl`（`public.file-url` のみ、#369 と同一 vend） | `operation:"copy"`、fixture が project item として import | **動く** |
| file drop `vend=legacy`（+`NSFilenamesPboardType`+utf8-text） | session は vend 成功、`operation:"move"`（同一 file 再 drop のため import 効果は不明） | session 受理 |
| dwell 1500ms 付き file drop | `operation:"move"`/`"copy"`、dwell が拒否を招かない | **動く** |

**AE 2027 は CGEvent drag を拒否しない。** in-app element drag は
reorder として着地し、外部 file drop も `public.file-url` vend で
Project panel に import された。#369 の `operation:"none"` ×39 は
再現しなかった — drag 機構・vend・対象 app version は同一なので、
差異は drop 地点の UI 状態・aux panel 覆い・timing のいずれかと推定
（後述「#369 との差異」）。

## 証拠詳細

### 1. in-app element drag（`main6.json` / `main10.json`）

`drag` モード（session event tap、mouseMoved→leftMouseDown→
leftMouseDragged×24→leftMouseUp）で Project panel / Timeline の
row を drag。orcale は ExtendScript `poc.projectItems` /
`poc.compLayers` の前後 snapshot diff。

- `proj-reorder-onto-row2`（150,301→150,322）: items
  `["PoC Comp","平面",A,B,C]` → `["平面","PoC Comp",A,B,C]`
  — **projectOrderChanged:true**（main6, main10 の両 run で再現）
- `timeline-reorder-row1-down`（250,885→250,925）: layers
  `[C,B,A]` → `[B,C,A]` — **layerOrderChanged:true**
- `proj-reorder-row2-up` / `projitem-to-compviewer` /
  `tab-tearoff-project` は drag 自体は受理されたが oracle 変化なし
  （座標が目的の UI 要素を外した可能性。tab tearoff は census/画像で
  別 window 生成の有無を要追加確認）

### 2. file drop（`files3.json`）— #369 結果の覆し

fixture `/tmp/poc411/helpers/a8n-poc-fixture.png`（8x8 PNG）を
helper window（`--from` 中心の borderless NSWindow）から
`beginDraggingSession` で vend し、CGEvent で (150,250)→(150,400)
（Project panel の item 群より下の空き領域）へ drag。

- **op-6 `file-vend-fileurl-nodwell`**: gate PASS（topmost=owned
  main window 5506）、`NSDraggingSession` receipt
  `operation:"copy"`、oracle `projectCountChanged:true`、
  `fixturePresent:true` — items が
  `["a8n-poc-fixture.png","PoC Comp","平面",A,B,C]` に。
  **file が Project panel に import された。**
- op-8 `legacy-nodwell` / op-10 `fileurl-dwell` / op-12
  `legacy-dwell`: 同一 file の再 drop で `operation:"move"`、
  import は dedup され item 数不変。vend=legacy は
  `BoardWriter` 経由で `NSFilenamesPboardType` を advertise
  したが `NSPasteboard` が "not a valid UTI" を警告
  （#369 と同じ既知の制約。session 自体は `session=true` で開始）。
- `endedAt:[150,712]` は NS bottom-left 原点で screen 高さ
  1112−400 と一致（#369 と同じ座標系確認）。

### 3. #369 との差異（要追跡）

#369 は同一 vend（`public.file-url` のみ）・同一機構・同一 install
（AE 2027 27.0x78）で 39 attempt 全て `operation:"none"`。
今回は最初の attempt で `copy` + import。差異候補:

- **drop 地点の UI 状態**: #369 は ty-plus CEP panel 11 枚が画面を
  タイル状に覆う状態で、census 上 main window が最前面でも
  panel 内の実際の drop 受付領域が異なった可能性
- **project/comp の状態**: 今回は `poc.ensureComp` で 3 solid +
  comp viewer open 済み。#369 時点の panel 内容・選択状態が
  drop 受付に影響した可能性
- **timing**: drag 速度・dwell・session 開始タイミング
- **再現性**: #369 の座標群での再 scan を別 ticket で推奨

## 環境起因の中断記録（再現時の注意）

- foreign AE 2026 が断続的に起動/終了。event op は drift 中 skip、
  observe op は `foreignDrift` note 付きで継続（`files2.json` は
  foreign window が drop 地点を覆い gate が全 skip）。
- SIGTERM/SIGKILL で落とした AE の次回 launch は crash dialog
  （476x251 + 525x377 window）が出て readiness probe を 235s
  timeout させる。`CGEvent.postToPid` で Return/Esc を直接投稿して
  dismiss すると main window が開き script engine が応答する
  （`postkey.swift`/`postesc.swift` は /tmp の使い捨て、未 commit）。
- attach lane（`AfterEffects.attach` + `authorization.extensionMethods`）
  で既存 instance に継続実験可能。`--attach-pid` を orchestrator に追加。

## ファイル

- `files3.json` — filedrag 4 variant の完全記録（op-6 が import 成功）
- `main10.json` — in-app drag 6 ops（project reorder ×1 確定、
  timeline layer reorder ×1 確定、他は受理・oracle 無変化）
- `main6.json` — 初回の project reorder 確定 run
- `f0-layout.png` / `f1-after-fileurl-nodwell.png` /
  `f3-after-fileurl-dwell.png` / `f4-after-legacy-dwell.png` /
  `f-final.png` — file drop 前後の画面
- `m1-layout.png` / `m2-after-proj1.png` / `m5-after-tl2.png` —
  in-app drag 前後
- `window-5506-after-filedrop.png` — drop 後の main window capture
- `ax-main.json` — AE AX tree dump（座標同定用、226 nodes）
