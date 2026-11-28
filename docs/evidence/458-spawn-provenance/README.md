# #458 spawn-phase provenance — real-host verification

Issue: [#458](https://github.com/ido-bata/ae-a8n/issues/458) / PR: [#459](https://github.com/ido-bata/ae-a8n/pull/459)
Candidate: worktree `ae-a8n.458`、`npm run build` 産物の `dist/` を直接 import（packed tarball ではない。version 表記は 0.6.0 + 未 release commit）。
Host: macOS (darwin 27.2.0, arm64)、console session uid 501、AE 2027 `27.0x78` / AE 2026。

## Verification level

**`verified on real host`** — modal-blocked launch の再現から terminate → rebuild → readiness 復帰 → follow-up op → teardown まで、公開経路のみで完走。fake/mock 不使用。

## 前提: RC-S17 residue の処理

| pid | install | 処置 | 結果 |
| --- | --- | --- | --- |
| 18577 | AE 2027（AppleScript launch、provenance 無し） | `kill 18577`（SIGTERM、19:45 JST） | **約 4 分後に自然終了**（19:49 頃確認で gone）。modal-blocked でも SIGTERM は有効だったが遅延が大きい |
| 37622 | AE 2026（RC-S17 で driver spawn、fix 前で provenance 無し） | `kill 37622`（SIGTERM、19:46 JST） | 同様に遅延後に終了。最終確認 19:49 頃 gone |

SIGKILL は不使用。SIGTERM が効いたことで両 install が launch 可能になり、modal 再現を伴う end-to-end 検証が可能になった。

## 実行タイムライン（JST）

### 1. spawn-phase provenance の実機記録（19:50）

- `AfterEffects.launch({ sessionRoot: session-launch-2027, readinessTimeoutMs: 120000 })`（`launch-2027.mjs`）。
- AE 2027 が pid **17579** として spawn（19:50:43）。**2 秒後の 19:50:45 に `launch-provenance.json` が `phase: "spawned"` で出現** — probe 回答前の spawn 時点記録が実機で確認できた。
- BirthPrefs modal が再発し readiness probe（`app.info`）が 104s timeout → `HostLeftRunningError`（A8N-AE-005）。trace seq6 `session.provenance ok {phase:"spawned",pid:17579}`、seq7 `session.launch error` に `pendingLaunch` + readiness observation（census 7 windows / AX unaccounted）を記録。

### 2. `terminate --force` が spawned host を終了（19:53）

- `terminateSessionHost({ permit: "terminate-owned-host", force: true })`（API 経由、後に CLI でも同経路）:
  - census 再証明: `pid 17579 still names the recorded After Effects` + sibling 無し → `alive`
  - graceful（osascript `tell application … to quit`）→ AE が `-128`（ユーザによってキャンセル）で拒否
  - force（SIGKILL）→ 12.2s で `outcome:"terminated", method:"forced", disappearanceProven:true`
  - supervision `blocked`/`process-gone` を lease 下に記録、`nextActions` は rebuild を指す
- **途中で実在 bug を発見・修正**: `terminate.ts` の `defaultSleep` が `setTimeout().unref()` しており、census poll の sleep 中に event loop が空になり process が report 無しで exit 0 していた（#340 由来の latent bug。provenance gate を通過する実機 terminate は本 issue が初）。ref'd timer に修正済み。

### 3. `rebuild` が spawned provenance を受理し再 launch（19:58）

- `AfterEffects.rebuild({ sessionRoot })` → supervision `process-gone` + census gone + provenance を全 gate 通過し、新 AE pid **67404** を spawn。新たに `phase:"spawned"` provenance を上書き記録。
- BirthPrefs modal が再度発生 → readiness timeout → `HostLeftRunningError` で rebuild は正直に失敗（成功を偽装しない）。

### 4. 2 台目の spawned host も terminate 可能（20:01）

- 同じく `phase:"spawned"` の provenance（pid 67404）に対し terminate → 今度は **graceful（osascript quit）が 3.3s で成功**、`outcome:"terminated", method:"graceful"`。census で消失証明、supervision `process-gone` 記録。

### 5. readiness 復帰と chain 完走（20:03）

- 3 回目の `AfterEffects.launch`（`session-launch-2027b`）→ **BirthPrefs modal は再発せず** readiness 通過（35.8s で LAUNCH-OK）。前段の graceful quit / SIGTERM で AE が prefs を正常終了時に書き戻し、modal 条件が解消したと推定（modal 自体は AE/OS 側事象で本 repo の管轄外）。
- follow-up op: `ae.version()` → `27.0x78`（49.2s）。`ae.close({unsavedChanges:"discard"})` → clean close（55.9s）、provenance は設計どおり除去、`teardown-*.json` に teardown 証拠。
- **全 AE main process が消え、residue ゼロ**。

## 確認できたこと / できなかったこと

- ✅ spawn 時点 provenance の実機書き込み（2 世代分）
- ✅ `phase:"spawned"` record に対する terminate の全 gate（permit → provenance → live census pid+start 再証明 → no-sibling → graceful-first → force → 消失証明 → supervision 記録）
- ✅ rebuild が spawned provenance を「driver が spawn した host の記録」として受理
- ✅ graceful / forced 両 method の実機動作
- ✅ readiness 復帰後の follow-up op・clean close・provenance 除去
- ⚠️ `supervise terminate` CLI の `--force` 経路は API と同一 body（`terminateSessionHost`）だが、CLI 経由の force 実行自体は sleep bug 修正前に silent exit する事象を確認したのみで、修正後の CLI force 完走は未実施（API 経路で同一関数を検証済み。CLI は薄い wrapper）。
- ⚠️ pid 18577（AppleScript launch）・37622（fix 前 spawn）は provenance を持たず、本 fix では遡及修復できない — SIGTERM による環境清掃で対処。docs/sessions.md に境界を明記済み。

## Files

- `launch-2027.mjs` / `rebuild-2027.mjs` / `launch-2027-b.mjs` — 実行 script
- `session-launch-2027/` — launch→modal→terminate(force)→rebuild→modal→terminate(graceful) の session root（trace.jsonl / supervision.json / launch-provenance.json / attempt-ledger.jsonl）
- `session-launch-2027b/` — readiness 復帰後の成功 launch（teardown 証拠含む）
- `session-37622/` — fix 前 residue に対する spawned provenance fixture での `already-gone` → `process-gone` 記録の検証（fixture は driver spawn の事実に基づく内容。terminate 判定経路の実機確認用）
