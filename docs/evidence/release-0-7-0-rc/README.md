# release-0-7-0 RC — real-host acceptance evidence (#436)

Spec: [`specs/release-acceptance/spec.md`](../../../specs/release-acceptance/spec.md)
Run manifest: [`run-manifest.json`](run-manifest.json)
Scenario ledger: [`scenario-ledger.jsonl`](scenario-ledger.jsonl)（append-only、spec §5）
Per-session artifacts: [`sessions/`](sessions/)（trace / supervision / teardown / summary の写し）
Harness: [`harness/`](harness/)（public path のみ: `AfterEffects.launch/attach/rebuild/terminate` + `ae.*` + packed tarball / repo checkout）

## Candidate identity（spec §3 — 全 attempt で同一）

| 項目 | 値 |
| --- | --- |
| commit | `a67a95633775485f35104030534051e68e4c63c1`（`origin/release-0-7-0` HEAD at freeze） |
| tarball | `ido-bata-ae-a8n-0.6.0.tgz` |
| tarballSha256 | `b390d033b094f3a9edbbe97cf6636b8fb2c3e191dca6d18da676d7e286196edf` |
| version | 0.6.0 |
| platform lane | macOS (darwin 27.2.0, arm64) |
| AE | After Effects 2027 `27.0x78` build 78（owned install） |
| fixture | `fixtures/fixture.aep` sha256 `84d5d911…96768c0`（manifest と一致を毎 run 検証） |

## Environment baseline / foreign non-interference

- **Foreign AE 2026**（user-owned、pid 7966 at start）: 本 run からの interaction は **read-only observation のみ**（census 走査 + detached supervisor の monitor-only 観測）。mutation・attach（host script 配送を伴う）・signal・quit AppleEvent は一切行っていない。
- **注記**: foreign AE 2026 は run 終盤（~15:0x JST）に終了した。終了と同時に user 側 automation の osascript（pid 7126, DoScriptFile）も消えており、user workload の正常終了と整合する。26.5 系の新規 crash report は存在しない。owned AE 2027 の zombie 除去は全て 2027 path/pid を個別検証した pid 宛であり、2026 には非対象。
- 入力ソース: PressAndHold + ABC（`AppleSelectedInputSources`）。clipboard sha256 baseline 記録済み。
- owned AE 2027 の残留プロセスは各 run 後に census で確認し、残ったものは `AfterEffects.terminate`（provenance 証明済み）または SIGKILL で除去した（下記「環境障害」参照）。

## 実行タイムラインと環境障害（重要）

1. **13:28–13:49 JST（正常時間帯）**: cold first-launch が readiness 180s を超過（`s001-smoke`、fail 記録）→ 直後の attach は 14.7s で成功。以降 warm launch が安定（handshake 17–42s）。
2. `s1-warm-01` fail（close が `UnsavedChangesError`）、`s1-warm-02` **pass**（7 steps 全成功、348s）、`s1-warm-03` fail（close が 60s timeout、`app.quit` 不応、"名称未設定プロジェクト" window 残存 → teardown `unverifiable`）。
3. **~14:00 JST `s1-warm-03` の owned AE を SIGKILL で除去した直後から、AE 2027 の全 launch が `BirthPrefs` 段階の modal dialog で停止**する障害が発生。以降の全 launch attempt（s1-cold-01, s3, s4, s5, s7, s10, s2, s6, s13, s1-repro-01, s8, s9, …）が readiness timeout で fail し、起動した AE は bridge 不応のまま残留（都度除去）。
4. 診断（全て公開情報源・read-only）:
   - `sample` stack: main thread が `CEggApp::BirthPrefs → dvaui Messagebox → UI_MessageBox::RunModal` で停止。**AX window 0 個・activate 不可・画面上 window も無し**（AX 非 vend の modal。RC-S6 の #321 shape が自然発生した形）。
   - prefs 初期化（`27.0` + plist を backup 退避→復帰）は **無効**。
   - binary 直起動でも同一 modal で再現。prefs 非依存・決定的。
   - 最有力仮説: unclean shutdown 後の recovery/通知系 modal が Space/表示状態の都合で dismiss 不能に滞留。**人間による window 確認・dismiss が必要**（本 session では画面共有・対話操作が不可）。
5. この障害により **AE 2027 を必要とする scenario は環境要因で実行不能**となった。各 attempt は ledger に `fail`（launch step の readiness breach）として記録済み — product 側の readiness 拒否・teardown・証跡は正しく動作している（timeout で誤魔化さず fail、残留 AE を census で検出）。

## Scenario verdict table（spec §8）

凡例: `pass` / `fail` / `blocked` / `environment` / `not-applicable`。`environment` は「環境要因で lane が実行不能」を示し、ledger 上は launch 失敗 `fail` として記録、本表で原因分類を明示する（verdict 偽装なし）。

| Scenario | 内容 | ledger verdicts | 判定 | 備考 |
| --- | --- | --- | --- | --- |
| RC-S1 | launch→handshake→smoke→close | fail, fail, **pass**, fail, fail, fail, fail, fail | **fail（環境）** | pass は warm-02 の 1 連続のみ。close 系 flake（UnsavedChangesError / quit timeout）2 件は product 観測として要追跡。cold-launch 180s 超過も観測 |
| RC-S2 | owned crash→process-gone→rebuild | fail | **fail（環境）** | launch が BirthPrefs modal で不達 |
| RC-S3 | expected modal | fail | **fail（環境）** | 同上（s3-a） |
| RC-S4 | human-required modal | fail | **fail（環境）** | 同上（s4-a） |
| RC-S5 | unknown modal quarantine | fail | **fail（環境）** | 同上（s5-a） |
| RC-S6 | AX-invisible modal 検出 | fail | **fail（環境）** | launch 不達。なお BirthPrefs modal 自体が AX 非 vend で自然発生していた（診断根拠） |
| RC-S7 | UNKNOWN non-resend | fail | **fail（環境）** | launch 不達 |
| RC-S8 | wrong focus / foreign window | fail | **fail（環境）** | launch 不達（foreign AE 2026 activate のみ試行、mutation なし） |
| RC-S9 | permission denial | fail | **fail（環境）** | launch 不達。TCC grant は存在、denial 誘発は公開 API では不可（設計判断を notes に記録） |
| RC-S10 | mid-op abort | fail | **fail（環境）+ 記録薄い** | 子 process kill 設計のため ledger record が最小（summary に注記あり）。orphan cleanup は別途確認 |
| RC-S11 | AX non-vend observe-only | fail | **fail（環境）** | launch 不達 |
| RC-S12 | monitor loss / stale state | fail, **pass** | **pass（1 attempt）** | detached supervisor（#295 public path）を foreign AE 2026 pid に read-only 観測させ、SIGKILL → 30s TTL 経過後 `monitor-lost` を正直に報告することを実機確認。**consecutive 10 未達**（1 pass のみ） |
| RC-S13 | op battery + budgets | fail | **fail（環境）** | step duration は warm-01..03 から採取済み（manifest `budgets.ops` に反映） |
| RC-S14 | recording overhead | fail | **fail（環境）** | launch 不達 |
| RC-S15 | multi-instance non-interference | indeterminate | **indeterminate（環境）** | zombie AE に attach し `recoveryTarget()` 不在で中断 — owned path 未実行として正直に記録 |
| RC-S16 | packed-consumer path | fail（real lane）/ pass（package surface） | **fail（環境）** | `check-consumer-smoke.js`: packed tarball の clean-install import surface + `resolveInstall()` は **pass**（`A8N_SMOKE_SKIP_REAL_HOST=1` で確認）。real-host lane は readiness timeout で fail（環境）。dispatcher acceptance: fake lane **pass** / real lane **prepared**（human `activate.jsx` 未実行 — 人間境界として記録） |
| Plan B | panel/workspace/windowOps/dragDrop | pass→**retracted**, fail | **fail（環境）** | planb-a は zombie AE に attach したため **pass を撤回**（ledger に correction attempt 追記）。全 GUI op が「no owned process attested」で refuse — owned path 未実行。planb-b は launch readiness で fail（環境）。repo-side 実行（packed tarball は swift helper sources 非同梱のため GUI helper は checkout からのみ解決） |

**Consecutive-success（spec §7）**: 10 連続 pass を満たした scenario は **0**。RC-S12 は 1 pass、RC-S1 は最良 1 連続。環境障害により streak は成立しなかった。

## Metrics（`scripts/acceptance-metrics.js` → [`acceptance-metrics.json`](acceptance-metrics.json)）

- 入力: 16 session の driver attempt-ledger（125 op attempts）+ teardown verdicts + run-manifest。
- op budgets（manifest `budgets.ops`、feature 名 key）: **計測できた全 op で pass**（session.launch / project.open / project.info / project.state / project.comps / comp.info / comp.renderFrame / session.quit / session.close / app.info）。
- `verdict.action = deny`、理由は **`budget-unmeasured:readiness-probe` のみ** — trace.jsonl が readiness を named phase に分割していない既知の instrumentation gap（spec §6 phase granularity 未実装）。製品の budget breach ではない。
- `consecutive-success: pending`（10 連続未達）、`recovery-wait`/`recording-overhead`/`supervision-detection-latency` は provisional/unmeasured（計測不能を正直に報告）。

## Ledger correction（spec §11 honesty）

`rc-RC-PLAN-B-mwzzqp9y-j3f4`（planb-a）は `pass` と記録されたが **撤回済み**。launch が応答不能な orphan AE 2027（pid 54250/34063）に attach し `ownership=attached` となり、全 GUI op が「no owned After Effects process attested」で refuse された — owned GUI-op path は一度も実行されておらず、pass 条件が vacuous に満たされただけである。script を修正（`ownership()==="owned"` を必須化）し planb-b で再実行 → launch readiness で fail（環境障害）。ledger には `anomaly: "false-pass"` の correction attempt を append 済み。

教訓: launch が `attached` を返し得る以上、scenario script は ownership を assert しないと vacuous pass を生む。今回の RC では他の pass 記録（s1-warm-02, s12-b）は owned/非 launch 経路で真正。

## Teardown verdicts（spec §10）

| session | verdict |
| --- | --- |
| s1-warm-01 / s1-warm-02 / s1-warm-03(後半) / s002-attach / cleanup-warm03 | clean |
| s1-warm-03（SIGKILL 除去分） | **unverifiable**（process area unverifiable — 正直な記録） |
| launch 不達の全 session | teardown file 無し（session 未確立 = 評価対象外、ledger に記録） |

Safety residue（自動 fail 条件）: **無し** — 全 owned プロセスを census 確認のうえ除去済み。foreign AE 2026 は無変更。

## US traceability（spec §13）

| US | 担当 scenario | 本 run の状態 |
| --- | --- | --- |
| US-A1 | RC-S1,2,3,4,5,6,12 | S12 pass(1) / 他は環境 fail — **unverified** |
| US-A2 | RC-S2,7 | 環境 fail — **unverified** |
| US-A3 | RC-S8,9,15 | 環境 fail — **unverified** |
| US-A4 | RC-S1,12,16 | S1 に pass 実績あり・S12 pass・S16 は consumer smoke 結果待ち |
| US-A5 | RC-S7,10 | 環境 fail — **unverified** |
| US-B1..B4 | RC-S14,16 + Plan B | 環境 fail 見込み — **unverified** |

## Human actions required（blocker）

1. **AE 2027 の BirthPrefs modal を人間が確認・dismiss する**（別 Space/非表示の可能性。`sample` で main thread が `BirthPrefs→Messagebox::RunModal` にあることを確認済み）。dismiss 後に RC を再実行すれば環境起因 fail は解消する見込み。
2. `check-dispatcher-acceptance.js` real lane: channel prepared 済み。AE が復旧したら `activate.jsx` を AE 内で 1 回実行 → `--prepare-only` 無しで再実行。
3. （任意）AE 2027 の再起動/OS 再起動でも modal が消える可能性あり。

## Readiness assessment（#347 への入力）

- **判定: NOT READY（証拠不完全）**。契約上、全 scenario が 10 連続 pass + 全 budget 達成を要求するが、環境障害により大半が未実行。`blocked`/`environment`/`fail` は pass にカウントされない（spec §11）ため、現時点で release 承認の根拠は成立しない。
- 環境復旧後の再 run で埋めるべき gap: RC-S1 streak、S2–S11, S13–S16, Plan B の各 scenario、consumer smoke real lane、metrics 集計（`scripts/acceptance-metrics.js`）、`platforms/macos.json` 更新（pass 時のみ）。
- product 側の観測事項（環境と独立に追跡価値あり）:
  - `ae.close({unsavedChanges:"discard"})` が稀に `UnsavedChangesError` / quit timeout を返す（warm-01, warm-03）— supervision が拾うべき dialog 系の可能性。
  - cold first-launch の readiness が 180s を超過（s001）— phase 別 bound の内訳は trace に記録済み。
  - detached supervisor の monitor-loss 報告は正しく動作（RC-S12 pass）。
