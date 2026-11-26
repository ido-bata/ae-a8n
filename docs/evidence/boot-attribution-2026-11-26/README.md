# Boot attribution PoC — macOS, 2026-11-26

Issue #339 T001: ExtendScript の初回応答より前に、起動した AE process と
その window の帰属を OS レベルでどこまで証明できるかの最小 PoC。
プローブは `scripts/poc-boot-attribution.mjs`（要 `npm run build`、
`dist/` を駆動する実機実験であり shipped feature ではない）。

Verification level: **verified on real host**（観測モードの記録のみ。
launch モードは後述の理由で未実行）。

## 環境

- macOS arm64、user `rebui`（uid 501、console Aqua session、asid 100022）
- Adobe After Effects 2026 = 26.5.3、Adobe After Effects 2027 = 27.0.0、
  ともに `/Applications` 配下
- 観測時点で **両 install に既に AE process が稼働中**
  （2026: pid 24051、2027: pid 40890 — 2027 は観測中に外部の自動化が
  restart しており、pid が 74665 → 40890 に変わった。この PoC は
  いかなる AE process にも Apple Event / DoScript / press / quit を
  送っていない）

## 実測結果（`observe.json`）

初回 ExtendScript 応答を待たずに確定できる帰属:

| 証拠 | 取得経路 | 結果 |
| --- | --- | --- |
| pid + process 開始時刻 | `ps -axo pid,uid,lstart,comm` | 両 instance で取得 |
| install の識別 | executable path の完全一致 | 2026/2027 を確実に区別（bundle id は両者 `com.adobe.AfterEffects.application` で同一、asid も同一 100022 — **executable path が install を分ける唯一の決定的証拠**） |
| OS user / login session | `ps` uid + `lsappinfo list`（sess/uid/bundleID） | uid 501 / asid 100022 / bundleId を両 instance で確認 |
| window 帰属 | WindowServer census（CGWindowListCopyWindowInfo、CLT python3） | pid ごとに layer / onScreen / name / bounds 付きで列挙。2026 は on-screen の本体 window（1710x1073、project 名入り）、2027 も同様 |

つまり **pid + start time + executable + uid/asid + window 列挙までは
transport 応答なしに OS だけで証明可能**。これは #330/#332 で導入済みの
census / `attributeAeByCensus` / `recoveryTargetPid` / `pendingLaunch`
の経路が実機でそのまま機能することの確認でもある。

### AX channel は今回 unserviceable だった

`--ax`（`MacGuiRecovery.listWindows()`、supervision と同じ read-only
経路）では、**稼働 2 時間超の 2026 instance・起動直後の 2027 instance
ともに AX が 0 window を返し `axSuspect: true`**（WindowServer census
は各 7 window）。理由はこの PoC からは確定できない（起動 transient
#322、あるいはこの実行主体の Accessibility grant 状態）。重要なのは
**AX が空でも census が pid 帰属の window を証明し続ける**こと —
「応答前 modal」を AX だけに依存して検出する設計はこの環境では
成立せず、census-first の現行設計（`axSuspect` / unaccounted window
#321）が必要であることを裏付ける。

## launch モード — 今回は fail-closed で拒否（`launch-refused.json`）

`--mode launch` は対象 install の in-scope instance が 0 の時だけ
`AfterEffects.launch` を走らせ、応答前の帰属 timeline を採取する設計。
今回は両 install に他者（ユーザーの通常作業 / 別 automation）の AE が
稼働中だったため、**設計どおり起動前に拒否**した。attach や既存
process への干渉は一切行っていない。

隔離経路（`ae-a8n test --user` / `scripts/isolated-session/`）も検討したが、
helper user `test`（uid 502）は存在するものの **GUI session が無い**
（`launchctl print gui/502` が失敗 = 未ログイン）。fast user switching
でのログインは人間の操作が必要で、この PoC の時間枠では実行不能。

## 成立範囲の結論（T001 の区切り）

**証明できた（real host、macOS）**

- 応答前の OS 帰属: pid+start+install path+uid/asid+window census は
  transport / ExtendScript 応答なしに確定可能。複数 version 同時稼働下でも
  install 単位で一意に分離できる。
- window 帰属も pid 単位で census から取れる（AX 非依存）。

**未証明のまま残る**

- 「just-launched process の応答前帰属」: owned launch が今回不可能
  （全 install に既存 instance、helper user 未ログイン）。`launch`
  モードの poll（`pendingLaunch`/`hostState`/census 時系列）は実装済みだが
  実機未実行。次に install が空いた状態か helper user ログイン後に
  `--mode launch --yes-launch` で採取する。
- 起動時 modal（crash-repair 等）の応答前検出: 再現できず。先行証拠
  `docs/evidence/g0-startup-2026-11-16/` が示すとおり modal は
  WindowServer window としては見えるが AX には出ないケースがあり、
  census-first 設計の必要性は確認済み。実際の launch 中 modal での
  timeline は未採取。
- Windows lane: **未カバー**（この機械に Windows 環境なし）。
  `windowsProcesses`（Win32_Process + creation time）と
  `windowsSameInstall` の install scope は code 上存在するが、
  PoC evidence なし。

## 再現手順

```bash
npm run build
# 観測（read-only、既存 instance がいても安全）
node scripts/poc-boot-attribution.mjs \
  --install "/Applications/Adobe After Effects 2026" \
  --install "/Applications/Adobe After Effects 2027" --ax \
  --out docs/evidence/boot-attribution-2026-11-26/observe.json
# owned launch（install が空の時だけ。既存 instance があれば拒否される）
node scripts/poc-boot-attribution.mjs --mode launch \
  --install "/Applications/Adobe After Effects 2026" --yes-launch
```
