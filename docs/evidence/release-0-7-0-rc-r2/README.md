# release-0-7-0 RC — real-host acceptance evidence, run 2 (#436)

Spec: [`specs/release-acceptance/spec.md`](../../../specs/release-acceptance/spec.md)
Run manifest: [`run-manifest.json`](run-manifest.json)
Scenario ledger: [`scenario-ledger.jsonl`](scenario-ledger.jsonl)（append-only、spec §5）
Per-session artifacts: [`sessions/`](sessions/)（trace / attempt-ledger / teardown / summary の写し）
Harness: [`harness/`](harness/)（run-1 harness を継承。public path のみ: `AfterEffects.launch/attach/rebuild/terminate` + `ae.*` + packed tarball / repo checkout）
Metrics: [`acceptance-metrics.json`](acceptance-metrics.json)（`scripts/acceptance-metrics.js` 出力）

Run 1 の証拠は [`../release-0-7-0-rc/`](../release-0-7-0-rc/)。run 1 は AE 2027 BirthPrefs modal で環境ブロックされ NOT READY 判定。本 run は blocker 解消後の再実行（attempt 2）であり、**同一の環境障害が run 中盤で再発**した（下記）。

## Candidate identity（spec §3 — 全 attempt で同一）

| 項目 | 値 |
| --- | --- |
| commit | `3acacf715a0d296b80d04bcd9b11a226417194c3`（`origin/release-0-7-0` HEAD at freeze、#443/#444/#445/#448 merge 済み） |
| tarball | `ido-bata-ae-a8n-0.6.0.tgz` |
| tarballSha256 | `2cf892709a7536bcad916f510279602da201b37645c85fc1a25fae4930a750b7` |
| version | 0.6.0 |
| platform lane | macOS (darwin 27.2.1, arm64) |
| AE | After Effects 2027 `27.0x78` build 78（owned install） |
| fixture | `fixtures/fixture.aep` sha256 `84d5d911…96768c0`（run-1 と同一 fixture、manifest と一致を検証済み） |

## Environment baseline / foreign non-interference

- **Foreign AE 2026**（user-owned、pid 39218 at start）: run 終盤に user 側で終了し、後半に新 pid 62487 で再起動された。interaction は **read-only observation のみ**（census + detached supervisor の monitor-only 観測）。mutation・attach・signal・quit AppleEvent は一切なし。最終 census（`env/census-final.txt`）で AE 2026 のみ残存、AE 2027 の残留プロセス無し。
- 入力ソース: PressAndHold + Kotoeri（`env/baseline.txt`）。clipboard sha256 baseline 記録済み。
- owned AE 2027 の残留は各 attempt 後に census 確認し、modal-blocked で残ったプロセスは executable path（`After Effects 2027.app/Contents/MacOS/`）を個別検証した pid 宛に SIGKILL で除去（queue script の `killOwnedAE`、全 kill を log 出力）。foreign AE 2026 は path が異なるため非対象。

## 実行タイムラインと環境障害（重要）

1. **freeze 前 probe**: run-1 の BirthPrefs modal blocker は解消済みを確認（launch handshake 65.6s 成功、discard close 成功）。
2. **S1 streak loop（r2-s1-01..15）**: warm window で 2 件の真正 pass を取得 — `r2-s1-02`（全 step 成功）と `r2-s1-05`。ただし `r2-s1-05` は後に **vacuous pass と判明・撤回**（下記「Ledger correction」）。
3. **product 観測（環境と独立）**:
   - `r2-s1-01`/`r2-s1-03`: `session.close` が 60s で quit timeout（`app.quit` 不応、process residue）— run-1 の warm-01/03 と同型の flake が再発。teardown は `residue` を正直に記録（acceptance-metrics の safety-residue deny 2 件の出所）。
   - `r2-s1-04`: `project.info` probe fail（"did not answer the probe of this session"）。
   - `r2-s1-06..15`: 前 attempt の dirty attached AE（pid 58607）の残留により `project.open` が `UnsavedChangesError` で連続 refuse。harness を `{unsavedChanges:"discard"}` + `ownership()==="owned"` assert に修正して以降は真の owned/attached を区別。
4. **~16:2x JST（r2-s1-16 以降）BirthPrefs modal が再発**: `sample` stack が run-1 と同一 — main thread が `CEggApp::BirthPrefs → dvaui Messagebox → UI_MessageBox::RunModal` で停止し、その内側に `U.dylib Up_ReportErrorDialog`（AEDoScriptFile の error-report dialog）がネスト（`env/birthprefs-modal-stack-r2.txt`）。modal window は census 上 visible だが `onScreen:false`・layer 0 で、AX からは dismiss 不能。**人間の dismiss が必要**だが本 session では対話操作不可のため、以降の全 launch-dependent scenario は環境ブロックとして記録。modal の dismiss・key injection は行っていない。
5. #444 instrumentation の実効確認: launch 不達 attempt の readiness は `phase:"extendscript-response"`, `reason:"timeout"`, detail `"a modal invisible to the accessibility layer cannot be ruled out"` として phase 分割記録されており（run-1 の `budget-unmeasured:readiness-probe` deny は解消、後述）、modal 可能性を正直に報告している。

## Scenario verdict table（spec §8）

凡例: `pass` / `fail` / `blocked` / `indeterminate` / `not-applicable`。`fail` の大半は launch readiness の環境 timeout であり、product の scenario 本体は未実行。ledger 上の verdict をそのまま分類する（verdict 偽装なし）。

| Scenario | 内容 | ledger verdicts | 判定 | 備考 |
| --- | --- | --- | --- | --- |
| RC-S1 | launch→handshake→smoke→close | fail×17, pass×2, indeterminate×1（correction） | **fail（環境+product flake）** | 真の連続 pass は最大 1（s1-02）。s1-05 pass は vacuous で撤回。close quit-timeout×2・project.info probe fail×1 は product 観測として要追跡 |
| RC-S2 | owned crash→process-gone→rebuild | fail | **fail（環境）** | launch が BirthPrefs modal で不達（r2-s2-a） |
| RC-S3 | expected modal | fail | **fail（環境）** | launch 不達（r2-s3-a） |
| RC-S4 | human-required modal | fail | **fail（環境）** | 同上（r2-s4-a） |
| RC-S5 | unknown modal quarantine | fail | **fail（環境）** | 同上（r2-s5-a、teardown residue 記録） |
| RC-S6 | AX-invisible modal 検出 | fail | **fail（環境）** | launch 不達。BirthPrefs modal 自体が AX 非 vend で自然発生（`env/birthprefs-modal-stack-r2.txt`） |
| RC-S7 | UNKNOWN non-resend | fail | **fail（環境）** | launch 不達（r2-s7-a） |
| RC-S8 | wrong focus / foreign window | fail | **fail（環境）** | launch 不達（r2-s8-a） |
| RC-S9 | permission denial | fail | **fail（環境）** | launch 不達（r2-s9-a） |
| RC-S10 | mid-op abort | fail | **fail（環境）+ 記録薄い** | launch 不達。scenario error は osascript `-128 user canceled` を含む（r2-s10-a） |
| RC-S11 | AX non-vend observe-only | fail | **fail（環境）** | launch 不達（r2-s11-a） |
| RC-S12 | monitor loss / stale state | indeterminate×3, blocked×1 | **indeterminate（環境）** | foreign AE 2026 を対象に detached supervisor（#295 public path）を 4 回試行。supervisor は spawn・monitor acquire するが **heartbeat が一度も更新されず**（`health:"monitor-lost"` が pre-kill から成立）monitor-loss を試験不能 → 正直に indeterminate。r2-s12-c は foreign AE 不在で blocked、r2-s12-d は AE 2026 復帰後も同じ heartbeat 不更新で indeterminate。run-1 では同経路が pass しており、環境依存の退行の可能性あり（要追跡） |
| RC-S13 | op battery + budgets | fail | **fail（環境）** | launch 不達。ただし warm window の attempt から op budget は計測済み（metrics 参照） |
| RC-S14 | recording overhead | fail | **fail（環境）** | launch 不達 |
| RC-S15 | multi-instance non-interference | fail | **fail（環境）** | launch 不達 |
| RC-S16 | packed-consumer path | fail（real lane）/ pass（package surface・fake lane） | **fail（環境）** | `check-consumer-smoke.js`（`A8N_SMOKE_SKIP_REAL_HOST=1`）: packed tarball の clean-install import surface **pass**（verification level: automated test）。real-host lane は readiness timeout で fail（環境）。`check-dispatcher-acceptance.js --prepare-only`: **fake lane pass**（6 checks 全成功、packed package + fake host）/ real lane **prepared**（channel staged、human `activate.jsx` 未実行 — 人間境界として記録） |
| Plan B | panel/workspace/windowOps/dragDrop | fail | **fail（環境）** | repo-side 実行（packed tarball は swift helper sources 非同梱）。launch readiness で fail（r2-planb-a） |

**Consecutive-success（spec §7）**: 10 連続 pass を満たした scenario は **0**。RC-S1 の最良は 1 連続（s1-02）、その他全て未達。

## Metrics（`scripts/acceptance-metrics.js` → [`acceptance-metrics.json`](acceptance-metrics.json)）

- 入力: 34 session の driver attempt-ledger + trace + teardown + run-manifest（227 op attempts）。
- op budgets（manifest `budgets.ops`）: **計測できた全 op で pass**（session.launch / app.info / project.open / project.info / project.state / project.comps / comp.info / comp.renderFrame / session.quit / session.close）。
- **`budget-unmeasured:readiness-probe` は解消**（run-1 の唯一の deny 理由だった instrumentation gap が #444 で修正済み）。readiness-probe は `phasesMeasured:true` で phase 分割計測され、成功 launch のみが bound 対象（modal-blocked launch は成功に数えない設計どおり）。
- `verdict.action = deny`、理由は **safety-residue 2 件のみ**: `r2-s1-01`/`r2-s1-03` の teardown が process residue を記録（close quit-timeout で AE 残留 → 後で SIGKILL 除去済み、最終 census 無残留）。これは product の close flake の正直な反映であり、環境障害ではない。
- `consecutive-success: pending`（10 連続未達）。`recovery-wait`/`recording-overhead`/`supervision-detection-latency` は unmeasured/provisional（計測不能を正直に報告）。

## Ledger correction（spec §11 honesty）

`rc-RC-S1-mx02t7qg-2eul`（r2-s1-05）は `pass` と記録されたが **撤回済み**。launch が応答不能な leftover AE 2027（pid 58607、前 attempt の dirty attached process）に `ownership=attached` で attach し、以降の scenario 本体が vacuous に成功しただけで owned path は未実行だった。`indeterminate` の correction attempt（`rc-RC-S1-mx02xyb9-1wmj`）を append 済み。script を修正（`ownership()==="owned"` 必須化 + `project.open` に `unsavedChanges:"discard"`）し、以降の attempt は attached/dirty 環境を正しく fail として記録している。

教訓（run-1 と同型）: launch が `attached` を返し得る以上、scenario script は ownership を assert しないと vacuous pass を生む。

## Teardown verdicts（spec §10）

| session | verdict |
| --- | --- |
| s1-02（唯一の真正 pass）他、正常 close できた session | clean |
| r2-s1-01 / r2-s1-03 | **residue**（close quit-timeout → process 残留、後で SIGKILL 除去） |
| r2-s5-a 他 teardown=residue 記録の session | residue（modal-blocked AE が teardown 時点で残存、queue cleanup で除去） |
| launch 不達で session 未確立の attempt | teardown file 無し（評価対象外、ledger に記録） |

Safety residue（自動 fail 条件）: teardown 記録上は **2+ 件の residue**（上表）。全て事後に census 確認のうえ SIGKILL で除去済みで、**最終 census に AE 2027 残留は無し**（`env/census-final.txt`）。foreign AE 2026 は無変更。

## US traceability（spec §13）

| US | 担当 scenario | 本 run の状態 |
| --- | --- | --- |
| US-A1 | RC-S1,2,3,4,5,6,12 | S1 に pass 実績1件・S12 indeterminate・他は環境 fail — **unverified** |
| US-A2 | RC-S2,7 | 環境 fail — **unverified** |
| US-A3 | RC-S8,9,15 | 環境 fail — **unverified** |
| US-A4 | RC-S1,12,16 | S1 pass×1・S12 indeterminate・S16 package surface/fake lane pass（real lane 未検証） |
| US-A5 | RC-S7,10 | 環境 fail — **unverified** |
| US-B1..B4 | RC-S14,16 + Plan B | 環境 fail — **unverified** |

## Human actions required（blocker）

1. **AE 2027 の BirthPrefs modal を人間が確認・dismiss する**（run-1 と同一症状が再発。`sample` stack 保存済み: `env/birthprefs-modal-stack-r2.txt`。visible だが `onScreen:false` で AX dismiss 不能）。dismiss 後に RC を再実行すれば環境起因 fail は解消する見込み。AE 2027 再起動/OS 再起動でも消える可能性あり。
2. `check-dispatcher-acceptance.js` real lane: channel prepared 済み（出力の `activate.jsx` path は一時 dir で既に消滅 — 再実行時に新たに stage される）。AE 復旧後に activate.jsx を AE 内で 1 回実行 → `--prepare-only` 無しで再実行。
3. （観測事項・任意）`session.close` の quit-timeout flake（s1-01/s1-03）と detached supervisor heartbeat 不更新（S12 indeterminate×3）は環境と独立に追跡価値あり — run-1 では S12 が pass していたため、環境差分か product 退行かの切り分けが必要。

## Readiness assessment（#347 への入力）

- **判定: NOT READY（証拠不完全）**。契約上、全 scenario が 10 連続 pass + 全 budget 達成を要求するが、環境障害により大半が未実行。`blocked`/`indeterminate`/環境 `fail` は pass にカウントされない（spec §11）ため、現時点で release 承認の根拠は成立しない。
- 環境復旧後の再 run で埋めるべき gap: RC-S1 streak（10 連続）、S2–S11, S13–S15, Plan B の各 scenario、S12 の heartbeat 問題の切り分け、consumer smoke real lane、dispatcher real lane（human activate.jsx）、`platforms/macos.json` 更新（pass 時のみ）。
- run-1 からの改善確認（本 run で実証済み）:
  - #444: readiness phase 分割 + modal 不可視の正直な報告 → `budget-unmeasured:readiness-probe` deny 解消。
  - #443: close の fail-fast は teardown residue を正直に記録する形で機能（quit-timeout で即座に residue 判定、60s 待機後に正しく報告）。
  - harness 側: `ownership()==="owned"` assert + `unsavedChanges:"discard"` で vacuous pass と dirty-attached 誤爆を排除（s1-05 撤回・s1-06..15 の連鎖 fail を記録）。
- product 側の観測事項（環境と独立に追跡価値あり）:
  - `session.close` が稀に quit timeout（60s）を返し process residue を残す（s1-01, s1-03 — run-1 warm-01/03 と同型、再発性あり）。
  - detached supervisor の monitor heartbeat がこの環境で一度も更新されない（S12 indeterminate×3 — run-1 では pass。osascript/System Events probe の環境依存を疑う）。
  - BirthPrefs modal が unclean shutdown 後に再発する（run-1, run-2 で 2 回観測 — AE 2027 自体の問題であり ae-a8n の管轄外だが、launch readiness が正しく fail として分類・記録されることは確認済み）。
