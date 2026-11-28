# RC-S17 — AX-invisible anomaly end-to-end acceptance (#453)

Spec: [`specs/release-acceptance/spec.md`](../../../specs/release-acceptance/spec.md)（RC-S17 row、本 run で追加）
Issue: [#453](https://github.com/ido-bata/ae-a8n/issues/453) / parent program [#337](https://github.com/ido-bata/ae-a8n/issues/337) Plan A
PR: [#457](https://github.com/ido-bata/ae-a8n/pull/457)

## Candidate identity（spec §3）

| 項目 | 値 |
| --- | --- |
| commit | `e0712c4b7d6ab371a2a127cc944496f4c2353a6c`（`origin/release-0-7-0` HEAD、#451/#452/#450 merge 済み） |
| tarball | `ido-bata-ae-a8n-0.6.0.tgz`（`npm pack` from the worktree） |
| tarballSha256 | `dd578f498b6d0b404b1e02167882efdb2429dda606077908f47ee12f696634fd` |
| version | 0.6.0 |
| platform lane | macOS (darwin 27.2.0, arm64)、console session uid 501 |
| AE | After Effects 2027 `27.0x78`（live subject）+ After Effects 2026（reproduction attempt） |
| consumer | packed tarball を `/tmp/rc453/consumer` に install し `@ido-bata/ae-a8n` import + `ae-a8n supervise` CLI（packed `dist/cli.js`） |
| harness | [`harness/`](harness/)（rc-r2 harness を継承。public path のみ） |

## Verification level

**`verified on real host`** — packed candidate bytes を実機の AE 2027 / AE 2026 に対して実行。全て公開経路（`AfterEffects.*`、`ae.*` 相当の公開 export、`ae-a8n supervise` CLI、census/screencapture の read-only 観測）。modal への入力・AppleScript mutation・signal・dismiss は一切なし。fake/mock は不使用。

## Subjects

| pid | install | launched by | state |
| --- | --- | --- | --- |
| 18577 | AE 2027 | AppleScript（run 外・provenance 無し） | `CEggApp::BirthPrefs → UI_MessageBox::RunModal` で 17:22 JST から modal-blocked（`env/birthprefs-modal-stack-18577.txt`: 68/68 samples main thread） |
| 37622 | AE 2026 | **本 run の `AfterEffects.launch`**（`open` 経由、spawn 記録あり） | 同じ BirthPrefs modal stack（79/79 samples）— **anomaly が install を跨いで再現** |

## 実行タイムライン（JST）

### Phase A — live subject pid 18577 の観測と fail-closed 確認（attempt `rc-RC-S17-mx08oadi-fcwd`、verdict `indeterminate`＝phase-scoped）

| step | durationMs | 結果 |
| --- | --- | --- |
| census-process-session | 901 | pid 18577 生存、uid 501、Aqua session |
| windowserver-census | 271 | pid 18577 に **6 windows、onScreen 0**（全て `layer:0, onScreen:false`） |
| gui-observation-listWindows | 3,074 | `axSuspect:true`（理由文が #406 non-vending 形状を明示）、`axUnaccountedCensusWindows` 6 行、AX windows=0 |
| census-window-captures | 7,620 | session.png + `captureWindowById` × 6（window-9279..9284.png、全て実画像） |
| attach-attempt | 31,056 | `AfterEffects.attach({target:{pid:18577}})` → `HostQuarantinedError`、readiness `probe-failure`（phase `extendscript-response`）、`session.recover` は `A8N-AE-004` で refused |
| supervise status | ~17 | session root に supervision.json 無し → exit 6 `unknown`（`unavailable` を正直に報告） |
| library-terminate-refusal | 2 | `AfterEffects.terminate` → `no launch provenance … never signalled` |
| supervise terminate [--force] | ~3,000×2 | exit 4 `refused`（provenance gate が force に先行） |
| post-observation-census | 1,620 | pid 18577 無変更で生存 |

判断根拠: provenance を持たない host を signal しないのが正しい fail-closed であり、拒否自体が RC-S17 の「認可済み安全離脱」の**否定側証拠**。観測は attach session を確立できないため、公開 export の `MacGuiRecovery`/`windowServerCensus`/`captureWindowById` で行った（`ae.guiState()` は attested target 必須のため使用不可 — この境界自体を記録）。

### Phase B — provenance-bearing host での再現試行（attempt `rc-RC-S17-mx093v1p-bydq`、verdict `indeterminate`）

| step | durationMs | 結果 |
| --- | --- | --- |
| launch-ae2027 | 123,328 | `HostQuarantinedError`（`app.info` 118.9s timeout）。**spawn された process は 0** — `process-census` phase が preexisting=[18577] を検出し `open` を skip（`spawn.process-census` 791ms のみ、`open-request`/`pid-observe` phase 無し）。新規 provenance-bearing host は作れない |
| supervise status/terminate (2027 root) | — | exit 6 / exit 4（同じく provenance 無しで refuse） |
| launch-ae2026 | 203,578 | **`HostLeftRunningError`**: pid 37622 を spawn したが readiness probe（`app.info`）が 159.9s で不達。プロセスは running のまま |
| final-census | 1,556 | 18577 + 37622 の 2 台が modal-blocked で残留 |

**再現成功（install 横断）**: pid 37622 の `sample` は 18577 と同一 stack（`CEggApp::BirthPrefs → dvaui UI_MessageBox::RunModal`、79/79）。BirthPrefs modal は AE 2027 固有ではなくマシン/prefs レベルの事象。

### Phase C — durable supervision と全公開 exit 経路（attempt `rc-RC-S17-mx098euu-fyld`、verdict `fail`）

| step | durationMs | 結果 |
| --- | --- | --- |
| start-supervisor-37622 | 4 | `startDetachedSupervisor`（公開 export）→ monitor pid 67905 |
| supervise-status-poll | 955 | `phase:blocked, health:degraded` — blocking window `<unobservable window>`（`WindowServer reports 6 window(s) not visible to AX`、code `A8N-SEC-001`、tier `unknown`）。5min startup grace（#322）経過後に分類 |
| supervise terminate / --force (37622) | ~3,000×2 | exit 4 `refused` — **driver が spawn した host でも provenance が無ければ terminate できない** |
| AfterEffects.terminate(37622, force) | 1 | `no launch provenance … never signalled` |
| AfterEffects.rebuild(37622) | 1 | `rebuild requires proven process loss, but supervision reports phase "blocked" with host state "none"` |
| AfterEffects.resume(37622) | 0 | `no launch provenance … no host to resume` |
| observe-37622 | 11,127 | `axSuspect:true`、census 6 windows / onScreen 0、`axUnaccountedCensusWindows` 6、session.png + window PNG ×6 |
| supervisor/status for 18577 | 3 / 7,177 | 別 session dir に detached supervisor（pid 83994）→ 同じく `phase:blocked, health:degraded`、同じ nextActions |
| final-census | 424 | 両 subject 生存（residue、下記 teardown） |

**nextActions（#451 の誘導が実機で機能）**: `supervision.blocked`（bounded-wait、deadline 付き）に加え `session.terminate`（`allowed:false, reason.code:"requires-permission"`）が発行され、action 文は "it refuses without launch provenance" と明記 — 誘導どおり terminate を試行し、実際に refuse されるところまで確認。

## Attempt ledger 対応（`scenario-ledger.jsonl`、spec §5.2）

| attemptId | phase | verdict | 内容 |
| --- | --- | --- | --- |
| `rc-RC-S17-mx08oadi-fcwd` | A | indeterminate | 検出 + 全 exit 経路の refuse（unowned subject） |
| `rc-RC-S17-mx099dq8-t8p` | B-1 | indeterminate | **backfilled**: 2027 launch while 18577 alive（harness crash 後に artifact から復元） |
| `rc-RC-S17-mx093v1p-bydq` | B-2 | indeterminate | 2027 launch（preexisting gate で spawn 不能）+ 2026 launch → BirthPrefs 再現 |
| `rc-RC-S17-mx099dqg-fqds` | C-1 | fail | **backfilled**: supervisor + exit refusals + observation（harness crash 復元） |
| `rc-RC-S17-mx098euu-fyld` | C-2 | fail | durable supervision `blocked` + 全公開 exit 経路の refuse を再実行・記録 |

op-level ledger は各 `<sessionRoot>/attempt-ledger.jsonl`、trace は `trace.jsonl`、supervision は `supervision.json` にある。harness の `push().filter` bug で 2 run が recordAttempt 前に crash したが、session artifacts から `harness/backfill.mjs` で復元（notes に BACKFILLED と明記、再実行・改竄なし）。

## Issue の 6 ステップに対する判定

| # | 要求 | 結果 |
| --- | --- | --- |
| 1 | 検出 | **達成**。`axSuspect` + census 証拠（公開 export）、readiness failure の `probe-failure`/`timeout` 分類、detached supervisor による durable `phase:blocked`（A8N-SEC-001 `<unobservable window>`） |
| 2 | 分類 | **達成**。AX-invisible / census-unaccounted / tier `unknown` / `A8N-SEC-001` として正直に分類。pressable class 無し（AX が window を vend しないため measured press 不可 — 設計どおり quarantine 側） |
| 3 | 復旧 or 安全離脱 | **未達（product gap → #458）**。復旧は measured class が無く不可能（正しい）。安全離脱は **provenance が readiness probe 成功後にしか書かれないため全経路 refuse**。spawn した host ですら終了不能 |
| 4 | readiness | **未達**。blocked instance が install を占有し続けるため後続 launch は全て失敗（2027: preexisting gate、2026: 37622 が新たに占有） |
| 5 | 後続 op | **未達**。readiness が通る host が存在しない |
| 6 | teardown | **residue**（下記）。clean には程遠いが、residue の理由は product gap であり偽装なし |

## 判定: **fail（環境要因を含むが、主因は product gap #458）**

- 環境側: BirthPrefs modal は人間の dismiss が必要で automation の管轄外。rc-r2 と同じ環境障害が継続・再発（しかも install 横断で再現することが新たに判明）。
- product 側: **検出・分類・証拠 capture・nextActions 誘導・fail-closed refuse は全て正しく動いた**（#451/#452 の実機確認を兼ねる）。しかし「readiness 未通過で残った host を公開経路で終了する手段が無い」ため chain は完走不能。これは RC-S17 が炙り出した本質的 gap であり、[#458](https://github.com/ido-bata/ae-a8n/issues/458) として起票。
- 検証水準の正直な記述: 上記の全ては `verified on real host`。復旧成功・safe-exit 成功・readiness 復帰・後続 op 成功は **unverified**（到達不能だった）。

## Guarantee boundary（spec §9 の観点）

- 実証済み: census/AX 観測の正直さ（axSuspect が "clean" を偽装しない）、readiness failure の phase 分割 + observation、detached supervisor の durable `blocked` 分類、nextActions の `session.terminate` 誘導、terminate/rebuild/resume の provenance fail-closed、attempt/op ledger の完全性。
- 未実証（到達不能）: provenance 保持 host での terminate→rebuild→readiness 復帰→後続 op。これは #458 解消後に再試行が必要。
- 境界の副次発見: `ae.guiState()`/`ae.supervisionState()` は session 確立済み host にしか使えず、**probe に答えない host の観測は session 外の公開 export（`MacGuiRecovery` 等）に依存する**。consumer が「attach すらできない blocked host」を観測する正規経路は detached supervisor + `supervise status` であり、それは機能した。

## Environment / foreign non-interference

- pid 18577: run 終始 read-only 観測のみ（census / `sample` / `MacGuiRecovery.listWindows` / `capture` / `captureWindowById` / `supervise status`）。入力・signal・dismiss なし。最終 census で生存を確認。
- pid 37622: 本 run が spawn した唯一の新規 process。終了経路が無いため residue として残置（SIGKILL 禁止ルール遵守）。
- foreign AE: run 中に外部起動なし（最終 census は 18577/37622 + crashpad/CEP helper のみ）。
- detached supervisor 2 プロセス（pid 67905→37622, 83994→18577）は証拠確定後に SIGTERM で正常終了させた（node process であり AE ではない。AE process への signal はゼロ）。停止後の `supervise status` は `health:monitor-lost` を正直に報告することを確認済み。

## Teardown verdict: **residue**

| item | state |
| --- | --- |
| AE 2027 pid 18577 | modal-blocked で残留（foreign/unowned、公開経路で終了不能 — #458） |
| AE 2026 pid 37622 | modal-blocked で残留（driver-spawned だが provenance 無し、同上） |
| detached supervisors 67905 / 83994 | 証拠確定後に SIGTERM で停止済み。最終 `supervise status` は `phase:blocked, health:monitor-lost`（最後の証明済み状態 blocked、現在の GUI 状態は unknown）を正直に報告 |
| fixture.aep | 変更なし（sha256 前後一致を harness が検証） |
| session roots | `sessions/` 配下に全 artifact 保全（trace / attempt-ledger / supervision / artifacts/*.evidence.json） |

Safety-relevant residue なし（non-owned process への signal・press・consent 変更はゼロ）。機能 residue は #458 の影響そのもの。

## Files

- `scenario-ledger.jsonl` — scenario attempt ledger（spec §5）
- `sessions/` — per-session roots（trace.jsonl / attempt-ledger.jsonl / supervision.json / artifacts / screenshots）
- `env/` — baseline, gui-state, supervise status/terminate envelopes, supervision snapshots, sample stack
- `fixtures/fixture.aep` — rc-r2 と同一 fixture（sha256 `84d5d911…`）
- `harness/` — 実行 script（`lib.mjs`, `s17-phase-{a,b,c}.mjs`, `backfill.mjs`）
