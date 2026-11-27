# GUI / render evidence index（`ae-a8n.gui-evidence/v1`）

正本 spec: [`specs/gui-evidence/spec.md`](../specs/gui-evidence/spec.md)（#337 / tracking #346）。
本書は consumer（ae-test#145、ae-devtools#426）向けの contract notes。実装 ticket: #377（schema）、#380（stills）、#381（record lifecycle）、#382（macOS recorder）、#383（recording authorization）、#385（render-evidence join + consumer handoff）。

## 1. index の場所と読み方

- index は `<sessionRoot>/artifacts/evidence-index.json`（schema id `ae-a8n.gui-evidence/v1`）。`ae.artifactsDir` と同じ directory に置かれる。
- consumer は **ファイルを直接読んでよい**。in-process で読む場合は `ae.evidence.document()` が同じ document を返す（毎回 disk から load するので、外部で書き換えた内容もそのまま見える）。
- index が無いことは正常な初期状態。`ae.evidence.document()` は `null` を返し、error ではない。

## 2. 2 channel の共存（§3）

| channel | 何を主張するか | artifact kind の例 |
| --- | --- | --- |
| Channel S（screen） | OS capture が撮った画面そのもの | `screen-still`, `screen-recording` |
| Channel R（render） | AE の render 経路が出した成果物 | `render-frame`, `render-sequence` |

- 画面録画は render 結果を代替せず、render 出力は GUI 操作の成功を代替しない。consumer は両 channel を**別の claim** として引用する。
- render artifact は `scope`（display）や `leakage` を持たない — それらは Channel-S の概念。逆に screen-still は render の正しさを主張する field を持たない。
- 同一 operation が両 channel の証拠を持つ場合、index の `operations[].evidenceRefs` に両方の artifact/segment id が union で入り、`operations[].coverage` が `"both"` になる。

## 3. render artifact の記録（E4 / #385）

`comp.renderFrame(frame, options)` が成功すると:

1. 出力 PNG が `EvidenceArtifact`（`kind: "render-frame"`）として index の `artifacts[]` に入る。**copy ではなく reference** — `path`（artifactsDir 相対の POSIX path）+ `sha256` + `bytes` を記録し、実ファイルは producer が置いた場所に残る。
2. render op の `operations[]` 行に `requestId`（driver が mint した envelope id。trace row の `args.requestId` から相関）と `evidenceRefs` が bind される。
3. 補助 trace row `comp.renderFrame.evidence` が `result.evidenceId` を持って trace に書かれる — trace → artifact の walk はこの行から始める。
4. `session.artifactsDir` 直下の render 出力（`<prefix>.<frame5+.png>` 命名）を sweep し、index 未登録のものを `render-frame` として登録する。連番グループは `render-sequence` rollup（`path: "."`、`sha256: null` + `sha256Error` に member frames 参照）としても記録される。これは render-queue 出力や、binding を経由しなかった書き込みを拾う経路で、`ae.evidence.discoverRenderOutputs()` で明示的に再実行もできる。

失敗時（render が例外を投げた場合）は artifact を作らず、`gaps.uncapturable` に理由を記録し、operation row は `coverage: "none"` + `uncovered` に理由を持つ。render 自体の例外はそのまま呼び出し側に返る — evidence は render を壊さない。

## 4. `ae.evidence` — consumer handoff surface

| member | 戻り値 | 意味 |
| --- | --- | --- |
| `document()` | `GuiEvidenceIndexDocument \| null` | index 全体。`null` = 未生成 |
| `setConsumerRefs(refs)` | `{ error? }` | caller が持つ `testId`/`runId`/`suite` を index の `consumerRefs` に echo。**ae-a8n は test identity を捏造しない**（§5.3 rule 5）— 渡されたものだけを保存する |
| `consumerRefs()` | `EvidenceConsumerRefs \| null` | 保存済み `consumerRefs` |
| `consumerArtifacts()` | `ConsumerArtifact[]` | `artifacts[]` の ae-test `Artifact` 形への投影（§5） |
| `joinOperation(requestId)` | `OperationEvidenceJoin \| null` | same-run join の結果（§6）。`null` = index 無し |
| `discoverRenderOutputs()` | `{ added, error? }` | artifactsDir sweep の手動実行 |

## 5. ae-test `Artifact` mapping（B-TEST / ae-test#145 向け）

ae-test の contract は `Artifact { name, path, bytes, kind: "render"|"trace"|"attachment"|"diff" }`。`ae.evidence.consumerArtifacts()` は index の各 artifact を次のように写す:

| index `kind` | ae-test `kind` |
| --- | --- |
| `render-frame`, `render-sequence` | `"render"` |
| `trace` | `"trace"` |
| 上記以外（`screen-still`, `screen-recording`, recovery 系など） | `"attachment"` |

- `name` は artifact id、`path` は `<sessionRoot>/artifacts/` からの相対 path（`absolutePath` も併記）、`bytes` は index の値。`sha256` が取れなかった artifact（例: `render-sequence` rollup）は `bytes: null` 相当で `sha256Error` に理由が入る。
- **`session.artifactsDir` の discoverability は維持される**。render 出力は従来どおり `ae.artifactsDir` 配下に置かれ、ae-test の `collectRenders(session.artifactsDir, ...)` は index を知らなくても拾える。index は同じ directory にある「参照表」であって、成果物を別 tree に copy しない（§5.5）。render artifact の `path` が指す実ファイルも同じ場所にある。
- `consumerRefs` に test/run の id を渡したい consumer は、test 開始時に `ae.evidence.setConsumerRefs({ testId, runId })` を呼ぶ。以後 index を読む側は `consumerRefs` で run を逆引きできる。

## 6. same-run join / T003（§5.3 rule 3-5）

`ae.evidence.joinOperation(requestId)` は index document に対して次を検査し、`sameRun.verified` と `checks[]`（各 check の `ok`/`detail`）を返す:

- `operation-row`: その requestId の operation row が存在するか
- `render-channel`: `render-frame`/`render-sequence` artifact が `operationIds`/`evidenceRefs` で bind されているか
- `screen-channel`: 同一 run の recording segment が render の時刻 window を cover し、**closed**（`endEpochMs` 確定）か。open segment は暫定で verified にしない
- `session-identity`: artifact と segment の session block（pid / processStartIdentity / sessionId / sessionKind）が一致するか — 別 process・別 run の証拠を同一視しない
- `coverage`: operation の `coverage` が render 側の証拠を含むか

検証できない場合は `verified: false` と、落ちた check の `detail` が返る。**unverified を verified と偽らない**のが contract の要点。requestId・時刻 window・session identity のどれか一つでも欠ければ join は unverified。

## 7. verification level

- index schema / artifact 記録 / join / mapping: **`automated test`**（`test/render-evidence.test.ts` 他、fake host + fixture PNG で green）。
- fake After Effects 上の `comp.renderFrame` → index 配線: **`fake/mock only`**。real AE での render + 録画 same-run 実証は **`unverified`** — freeze 後の包括実機受入（#346 T003 の実機側）に委ねる。
