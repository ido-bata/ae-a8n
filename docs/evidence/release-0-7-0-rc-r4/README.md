# release-0-7-0 RC — real-host acceptance evidence, run 4 / attempt-4 (#436)

Spec: [`specs/release-acceptance/spec.md`](../../../specs/release-acceptance/spec.md)
Run manifest: [`run-manifest.json`](run-manifest.json)
Scenario ledger: [`scenario-ledger.jsonl`](scenario-ledger.jsonl)（append-only、spec §5）
Per-session artifacts: [`sessions/`](sessions/)（trace / attempt-ledger / teardown / summary の写し）
Harness: [`harness/`](harness/)（run-3 harness を継承。public path のみ）
Metrics: [`acceptance-metrics.json`](acceptance-metrics.json)（`scripts/acceptance-metrics.js` 出力）
Environment notes: [`env/run-notes.md`](env/run-notes.md)、baseline: [`env/baseline.txt`](env/baseline.txt)

Prior runs: run-1 [`../release-0-7-0-rc/`](../release-0-7-0-rc/)、run-2 [`../release-0-7-0-rc-r2/`](../release-0-7-0-rc-r2/)、attempt-3 [`../release-0-7-0-rc-r3/`](../release-0-7-0-rc-r3/)、RC-S17 proof [`../release-0-7-0-rc-s17/`](../release-0-7-0-rc-s17/)、spawn-provenance [`../458-spawn-provenance/`](../458-spawn-provenance/)。

## Candidate identity（spec §3 — 全 attempt で同一）

| 項目 | 値 |
| --- | --- |
| commit | `fc6f6e3dea21f181225c6fec97a5400da306e2f2`（`origin/release-0-7-0` HEAD at freeze = PR #460 merge） |
| tarball | `ido-bata-ae-a8n-0.6.0.tgz` |
| tarballSha256 | `467b523be2c3bba2130f52db4fc258d099875ebcf9e4ce2e82d6531f2f75f6e4` |
| version | 0.6.0 |
| platform lane | macOS (darwin 27.2.1, arm64) |
| AE | After Effects 2027 `27.0x78` build 78 |
| fixture | `fixtures/fixture.aep` sha256 `84d5d911…96768c0`（run-1..3 と同一） |

**tarball 同一性の注記**: `git diff 60523c2..fc6f6e3` は docs/evidence のみ（attempt-3 の証跡 merge）で package bytes に差分なし。`npm pack` の sha256 が attempt-3 と一致するのはこのためであり、candidate commit は fc6f6e3 として全 ledger row に記録される。

## Environment baseline / repairs

- Baseline: AE 2026 pid 44375（user-owned foreign）のみ、AE 2027 ゼロ（`env/baseline.txt`）。入力ソース PressAndHold+Kotoeri、clipboard sha256 記録。
- **Pre-run repair 1**: `Pref_SCRIPTING_FILE_NETWORK_SECURITY` が `"0"` に drift していたため `"1"` に復旧（backup `/tmp/rc436r4/環境設定.txt.bak`）。これが無いと bridge が script file を stage できず launch が fail-fast する。run-1..3 は全て "1" で実行されており、post-run-3 の環境 drift。
- **Pre-run repair 2**: `Show Welcome Screen` `01→00`（BirthPrefs=CEggApp::BirthPrefs の有力候補として試行。**効果なし** — 後続 launch でも modal 再発。run-notes.md 参照）。
- **Incident**: ~00:24 JST に disk 圧迫の worktree cleanup で `ae-a8n.436-r4` が削除された。branch/PR/コミット済み証跡は origin に生存（user の `656c74f wip` snapshot 含む）。ledger の一部 row を喪失した経緯と復旧は `env/run-notes.md` に記録。

## BirthPrefs modal — attempt-4 の支配的環境要因

run-1..3 と同じ `CEggApp::BirthPrefs → UI_MessageBox::RunModal`（+ nested `Up_ReportErrorDialog`）が attempt-4 でも支配的に再発した。時系列:

1. 23:2x JST: `Pref_SCRIPTING_FILE_NETWORK_SECURITY="0"` を発見・復旧（上記）。
2. 23:27 JST `r4-s1-00-smoke`（pid 8007）: **launch〜renderFrame まで完全成功**したが `session.close` が quit-timeout（window `"名称未設定プロジェクト","警告"`）→ teardown `residue` → public terminate（forced）で回収。**この unclean shutdown が BirthPrefs を re-arm したと推定**。
3. 23:36–23:59 JST: r4-s1-02..06 + r3-s1-01 が連続 BirthPrefs-blocked（readiness timeout → forced terminate の cycle）。
4. ~00:00–02:2x JST: r4-s1-07..45 がほぼ全て BirthPrefs-blocked。各 cycle は RC-S17 recovery pass として ledger 記録（detect→provenance→terminate→census-gone）。
5. **02:25 JST `r4-s15-a` で突如 launch 成功**（owned pid 47511、24.7s、teardown clean）— modal が一時的に解除された window が開いた。直後の `r4-s1-46-probe` も pass。
6. 02:33–03:07 JST: S1 streak が **pass を量産**（s1-46-probe, 47, 48, 50, 51, 53, 54, 55 = 8 pass、最高連続 3）。ただし close-quit-timeout flake（#464）が s1-49/52/56 で streak を 3 度リセット。
7. ~03:10 JST `r4-s1-57` で BirthPrefs **再 armed**（close-timeout の forced terminate が再発させたと推定）。s1-58 以降は再び全て readiness timeout。

**機構の整理（証拠ベース）**: BirthPrefs modal は unclean/crashed shutdown 後に armed され、clean quit で解除される host-state と推定される（#458 の forced terminate は crash 相当 → re-arm）。armed 中は全 launch が readiness timeout となり、解除には (a) 人間 dismiss、(b) host state reset、(c) 確率的な clean window のいずれかが必要。run-3 の結論（人間 dismiss または OS/AE reset が必要）と整合。

## Scenario verdict table（spec §8）

凡例: `pass` / `fail` / `blocked` / `indeterminate` / `environment` / `not-applicable`。

| Scenario | 内容 | ledger verdicts | 判定 | 備考 |
| --- | --- | --- | --- | --- |
| RC-S1 | launch→handshake→smoke→close | fail×40, pass×8 | **fail（環境+product flake）** | 真の連続 pass は最大 **3**（s1-47/48 → s1-53/54/55）。pass: s1-46-probe, 47, 48, 50, 51, 53, 54, 55。s1-49/52/56 は `session.close` quit-timeout（#464）で streak リセット。s1-57 以降は BirthPrefs 再 armed で全て readiness timeout |
| RC-S2 | owned crash→process-gone→rebuild | fail | **fail（環境）** | launch が BirthPrefs modal で不達（r4-s2-a） |
| RC-S3 | expected modal | fail | **fail（環境）** | launch 不達（r4-s3-a） |
| RC-S4 | human-required modal | fail | **fail（環境）** | 同上（r4-s4-a） |
| RC-S5 | unknown modal quarantine | fail | **fail（環境）** | 同上（r4-s5-a、teardown residue 記録） |
| RC-S6 | AX-invisible modal 検出 | fail | **fail（環境）** | launch 不達。BirthPrefs modal 自体が AX 非 vend で自然発生（`env/run-notes.md` の sample stack） |
| RC-S7 | UNKNOWN non-resend | fail | **fail（環境）** | launch 不達（r4-s7-a） |
| RC-S8 | wrong focus / foreign window | fail | **fail（環境）** | launch 不達（r4-s8-a） |
| RC-S9 | permission denial | fail | **fail（環境）** | launch 不達（r4-s9-a） |
| RC-S10 | mid-op abort | fail | **fail（環境）** | launch 不達（r4-s10-a、readiness timeout。cleanup=residue は ledger 記録、teardown file 無し） |
| RC-S11 | AX non-vend observe-only | fail | **fail（環境）** | launch 不達（r4-s11-a） |
| RC-S12 | monitor loss / stale state | pass×1, indeterminate×3 | **pass（部分）** | r4-s12-a: foreign AE 2026（pid 44375、無変更）に detached supervisor を attach し、kill 後 `monitor-lost` + stale heartbeat を正直に報告 → **pass**。r4-s12-b/c/d は pre-kill health が `degraded`/phase `blocked` で loss 遷移を試験不能 → indeterminate（run-2 の heartbeat 不更新問題は a で解消を確認） |
| RC-S13 | op battery + budgets | fail | **fail（環境）** | launch 不達（r4-s13-a）。warm window の S1 pass から op budget は計測済み（metrics 参照: 計測済み全 op pass） |
| RC-S14 | recording overhead | blocked | **blocked** | warm window で launch 成功（owned pid 33064、teardown clean）したが `record.start` が `RecordingError: unknown capture scope: "screen"` で scenario 本体を開始できず → 正直に blocked。screen capture scope がこの環境で解決しない（権限または capability gap、要切り分け） |
| RC-S15 | multi-instance non-interference | pass | **pass** | r4-s15-a: owned AE 2027（pid 47511）+ detached supervisor（pid 51010）の共存で双方 `observed`、supervisor kill 後も owned 側 `degraded` のまま非干渉を確認 → pass（teardown clean） |
| RC-S16 | packed-consumer path | fail→environment（訂正済み） | **environment** | `check-consumer-smoke.js`: packed tarball clean-install import surface **pass**（automated test）/ real-host lane は BirthPrefs で not-run。`check-dispatcher-acceptance.js`: **fake lane pass**（fake/mock only）/ real lane **prepared**（channel staged、human `activate.jsx` 未実行 — 人間境界）。初回 row は fail で記録後、spec §11 に従い environment へ訂正 row を append（rc-RC-S16-mx0jwfua-ghog） |
| RC-S17 | anomaly recovery | pass×52 | **pass** | BirthPrefs-blocked / quit-timeout residue の各 cycle で recover-leftover sweep が provenance 確認→`AfterEffects.terminate`（permit 経路、forced）→ census-gone を 52 回実施し全て pass。foreign AE 2026 は一度も対象外 |
| RC-PLAN-B | panel/workspace/windowOps/dragDrop | fail | **fail（環境）** | repo-side 実行（packed tarball は swift helper sources 非同梱）。r4-planb-a: launch readiness timeout（pid 96416、BirthPrefs）→ RC-S17 sweep で回収 |

**Consecutive-success（spec §7）**: 10 連続 pass を満たした scenario は **0**。RC-S1 の最良は **3 連続**（s1-53/54/55）、op 単位の `session.close` trailingPass は 2。

## Metrics（`scripts/acceptance-metrics.js` → [`acceptance-metrics.json`](acceptance-metrics.json)）

- 入力: 63 session の driver attempt-ledger + trace + 14 teardown + run-manifest（**613 op attempts**、19 reproducibility groups）。
- op budgets（manifest `budgets.ops`）: **計測できた全 op で pass** — `session.launch` / `app.info` / `project.open` / `project.info` / `project.state` / `project.comps` / `comp.info` / `comp.renderFrame` / `session.quit` / `session.close`。provisional: `comp.renderFrame.evidence` / `session.authorization` / `session.probe` / `session.provenance` / `supervision.*`。
- `readiness-probe`: **unmeasured（設計どおり）** — failed `session.launch` row が 50 あり bound は成功 launch のみに適用されるため。成功 launch 14 件の実測は min 14.4s / p50 28.6s / p95 72.9s / max 72.9s（bound 180s 内）。`phasesMeasured:true`（#444 instrumentation 有効）。
- `verdict.action = deny`、理由は **safety-residue 4 件のみ**: r4-s1-00-smoke / r4-s1-49 / r4-s1-52 / r4-s1-56 の teardown が process residue を記録（全て `session.close` quit-timeout → #464 の正直な反映。各 residue は直後の RC-S17 sweep で provenance 確認のうえ public terminate で回収済み、最終 census に AE 2027 残留なし）。
- `consecutive-success: pending`（10 連続未達 — 最良は session.close の trailingPass=2、S1 scenario で 3）。`recovery-wait` / `recording-overhead` / `supervision-detection-latency` は unmeasured/provisional（計測不能を正直に報告）。
- reproducibility groups: 19 中 14 accepted。非 accepted は `session.launch`（64 attempts, 14 pass — BirthPrefs が 50 attempt を阻害）、`session.close`（14 attempts, 10 pass, trailingPass 2 — quit-timeout flake）、`session.probe`（63 attempts, 14 pass, trailingPass 0 — 後半は launch 不達で probe 未到達）、`session.recover`（49 attempts, 0 pass — BirthPrefs-blocked launch 中の launch-time recovery probe が `outcome:"refused"` を返した記録。RC-S17 sweep の terminate とは別 op）、`record.start`（S14 blocked で 2 fail）。

## Teardown verdicts（spec §10）

teardown file を持つ session は 14（metrics 集計: **clean 10 / residue 4 / unverifiable 0**）。ledger `cleanup` フィールドを含めると追加で r4-s10-a が `residue`（mid-op kill、teardown file 無し）を記録。

| session | verdict | 内容 |
| --- | --- | --- |
| r4-s1-00-smoke | **residue** | launch〜renderFrame 成功後 `session.close` が quit-timeout（window `名称未設定プロジェクト`/`警告`）→ #464。RC-S17 sweep で回収 |
| r4-s1-49 / r4-s1-52 / r4-s1-56 | **residue** | 同上の quit-timeout flake（#464、attempt-4 で計 4 件観測）。各々 RC-S17 pass として sweep 記録 |
| r4-s1-46-probe, s1-47, s1-48, s1-50, s1-51, s1-53, s1-54, s1-55, r4-s14-a, r4-s15-a | clean | owned close 成功（`ownership==="owned"` evidence 付き） |
| r4-s10-a | residue（ledger cleanup、teardown file 無し） | scenario 本体が readiness timeout で中断、calling process kill — harness が orphan cleanup を別途確認 |
| BirthPrefs-blocked の launch 不達 attempt（s1-02..45, 57..70, s2..s13, planb 等） | teardown file 無し | session 未確立。残留 host は recover-leftover sweep（RC-S17 pass×52）が provenance 確認→public terminate→census-gone で回収。**最終 census に AE 2027 残留なし**（[`env/census-final.txt`](env/census-final.txt) — run 終了時点で AE process ゼロ。foreign AE 2026 も user 側で終了済み、run 中は一度も変更していない） |

## US traceability（spec §13）

| US | 担当 scenario | 本 run の状態 |
| --- | --- | --- |
| US-A1 | RC-S1,2,3,4,5,6,12 | S1 pass×8（最良連続 3、10 連続未達）・S12 pass×1・他は環境 fail — **unverified** |
| US-A2 | RC-S2,7 | 環境 fail — **unverified** |
| US-A3 | RC-S8,9,15 | S15 **pass**・S8/S9 環境 fail — **unverified**（S15 のみ real-host 実証） |
| US-A4 | RC-S1,12,16 | S1 pass×8・S12 pass×1・S16 package surface/fake lane pass（real lane 未検証） |
| US-A5 | RC-S7,10 | 環境 fail — **unverified** |
| US-B1..B4 | RC-S14,16 + Plan B | S14 blocked（`record.start` scope 解決せず）・S16 environment・Plan B 環境 fail — **unverified** |
| （横断） | RC-S17 | **pass×52** — anomaly recovery / provenance-gated terminate は real host で実証済み |

## Findings（product defects — candidate frozen のため issue 起票のみ）

- **#464**: `ae.close({unsavedChanges:"discard"})` が real host で ~50% quit timeout（untitled project window 残存）。#443/#231 の再発。attempt-4 で 4 件観測（r4-s1-00-smoke/49/52/56）。teardown は `residue` を正直に記録し public terminate で回収 — fail-fast 機構は機能。
- BirthPrefs modal の armed/disarmed 機構は AE host 側の問題（ae-a8n 管轄外）だが、「unclean shutdown → 次回 launch blocked」の cycle が #458 の forced terminate と組み合わさると自己維持する。RC-S17 としては recoverability を実証済み。
- **観測（要切り分け）**: `record.start` が `RecordingError: unknown capture scope: "screen"` を返した（r4-s14-a、owned launch 成功後）。macOS の screen recording 権限不足か API の scope 名解決の問題かは未切り分け — S14 を blocked として正直に記録。

## Readiness assessment（#347 への入力）

- **判定: NOT READY（証拠不完全）**。契約上、全 scenario が 10 連続 pass + 全 budget 達成を要求するが、環境障害により大半が未実行。`blocked`/`indeterminate`/`environment`/環境 `fail` は pass にカウントされない（spec §11）ため、現時点で release 承認の根拠は成立しない。
- 環境復旧後の再 run で埋めるべき gap: RC-S1 streak（10 連続 — 最良 3）、S2–S11, S13 の各 scenario、S12 の残り 3 attempt の決定的 pass、S14（`record.start` scope 問題の切り分けを含む）、Plan B、consumer smoke real lane、dispatcher real lane（human `activate.jsx`）、`platforms/macos.json` 更新（pass 時のみ）。
- run-3 からの改善確認（本 run で実証済み）:
  - **#458 spawn-provenance**: BirthPrefs-blocked host の terminate が provenance 確認付きで機能 — RC-S17 pass×52、foreign AE 2026 無変更。
  - **#444**: readiness phase 分割計測が有効（`phasesMeasured:true`）、modal-blocked launch は成功に数えない設計どおり。
  - **warm window の product 健全性**: modal が一時解除された ~02:25–03:10 JST window で launch→project→comp→renderFrame→evidence→close の全 op が budget 内 pass（613 op attempts 中の成功群）、S12 monitor-loss と S15 multi-instance が real host で pass。
- product 側の観測事項（環境と独立に追跡価値あり）:
  - `session.close` quit-timeout flake（#464）— attempt-4 で 4/14 close が timeout、unclean shutdown が BirthPrefs を re-arm する cycle の引き金になっている可能性（環境側問題だが product の close 信頼性に直結）。
  - `record.start` の `unknown capture scope: "screen"`（S14 blocked の直接因）。
  - launch-time `session.recover` が BirthPrefs-blocked 中に `refused` を返すのは 49 回全て一貫 — refusal は正しいが、recoverable residue の sweep は RC-S17 が別途担保。
