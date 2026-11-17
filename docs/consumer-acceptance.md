# Consumer 受入: clean install と ae-test / Aulymo 経路

親 Issue: [#99](https://github.com/ido-bata/ae-a8n/issues/99)（G4）、本 Issue [#130](https://github.com/ido-bata/ae-a8n/issues/130)。
正本: [`specs/execution-model/spec.md`](../specs/execution-model/spec.md) US4、release gate [#63](https://github.com/ido-bata/ae-a8n/issues/63) / [#75](https://github.com/ido-bata/ae-a8n/issues/75)。

一般の npm 利用者が実際に使う形 — 新規プロジェクトへの tarball install、公開 exports 経由の import、`AfterEffects` API の smoke — で受入を行う手順と、consumer repo が ae-a8n に求めるものの棚卸しをここに置く。**fake / CI の green は real-host 受入ではない**（§4 の記録形式を必ず使う）。

## 1. clean install → smoke の手順

### 1.1 自動: `scripts/check-consumer-smoke.js`

```sh
node scripts/check-consumer-smoke.js [--project /absolute/path/project.aep]
```

行うこと（この順で、すべて一時ディレクトリ内）:

1. `npm pack` で配布候補 tarball を作る（`prepack` が build を走らせる）。
2. 空の consumer project（`{"private": true, "type": "module"}` のみ）を `mkdtemp` で作り、tarball を `npm install` する。**この repo の `node_modules` は使わない。**
3. 公開 exports map 経由で import し、consumer が書く面を検査する: `A8N_VERSION` が package.json と一致、`AfterEffects.launch` / `AfterEffects.resume` / `resolveInstall` が関数として存在。この部分は AE 不要で、CI（`check` / `windows` job）で毎回 green になる。
4. `resolveInstall()` で AE を探す。見つかれば real-host smoke を実行: **launch → version → capability handshake → project → diagnostics → close**。見つからなければ `RESULT: skipped` を出して exit 0。

real-host smoke は既定で **read-only**: 開いている project と comp を報告するだけで、作成・編集・render・quit をしない（`close` はこの run が起動していない instance を quit しない）。`--project` を渡すとその `.aep` を `openProject` する（未保存変更があれば拒否される）。

`A8N_SMOKE_SKIP_REAL_HOST=1` は launch を強制 skip する escape hatch。**skip しかできず pass を捏造しない**。AE が入っているが駆動してはいけない host（検証機、CI 的な環境）で packaging 部分だけを確認するためのもの。

### 1.2 手動での再現

```sh
# repo 側で候補を作る
npm pack            # → <name>-<version>.tgz

# consumer 側（別ディレクトリ）
mkdir consumer && cd consumer
printf '{"name":"consumer","private":true,"type":"module"}\n' > package.json
npm install /path/to/<name>-<version>.tgz
node consumer-smoke.mjs   # scripts/check-consumer-smoke.js が生成する probe と同等
```

probe の中身は `scripts/check-consumer-smoke.js` 内の template literal が正本。手で書く場合も「install → import → `resolveInstall` で有無判定 → あれば `AfterEffects.launch` → `info()`/`version()`/`capabilities()`/`project()`/`diagnostics()` → `close()`」の順を守る。

### 1.3 手動 real-host smoke: `examples/smoke.ts`

```sh
node examples/smoke.ts ["$PWD/project.aep"]
```

pack 済み package を install した consumer から、あるいは repo の examples として直接実行する最小 smoke。read-only で、AE が見つからなければ skip を表示して exit 0。**exit 0 + skip 表示は pass ではない** — 記録するときは §4 のレベルを使う。

### 1.4 dispatcher 受入: `scripts/check-dispatcher-acceptance.js`（#148）

in-AE dispatcher 経路を consumer が実際に踏む受入ハーネス。`check-consumer-smoke.js` の pack→clean install に続けて、consumer 側の extension fixture を packed CLI（`ae-a8n extension build`）で build し、probe が 2 つの lane を実行する:

```sh
node scripts/check-dispatcher-acceptance.js --project /absolute/path/fixture.aep \
  --channel-dir /absolute/path/dedicated-channel
```

- **fake lane（常に実行・AE 不要）**: pack した `@ido-bata/ae-a8n/testing` の fake AE が dispatcher を内側で動かし、実 `host/a8n-host.js`・実 channel ファイルで次を検査する: capability handshake と instance 識別、comp/layer 編集、`comp.renderFrame` の PNG 成果物、static extension `ae.call` 成功・未宣言名拒否・grant 無し拒否、誤った instance pin の拒否と正しい pin での再接続、timeout=UNKNOWN 非再送、attached での安全な終了（quit しない）。証拠レベルは **`fake/mock only`** — real-host の証拠にはならない。
- **real lane（opt-in・人間 activation 前提）**: `--project` の明示 fixture が必須（開いている project や無指定の project では編集・render を行わない）。probe が channel を prepare し — consumer extension を build した packaged host script を channel 内の `a8n-host.js` として stage し、`channel.json` に manifest を記録する — `activate.jsx` のパスを表示する。human が **同じ channelDir** のその `activate.jsx` を AE で Run Script File し、heartbeat が来るまで待つ（`A8N_ACCEPTANCE_WAIT_MS`、既定 10 分）。heartbeat が来なければ `blocked` で、pass ではない。fake lane と同じ scenario を real AE で実行するが、UNKNOWN 非再送は dispatcher を人間が止められないため fake lane のみ。

#### channel・activation・結果の契約（#155）

- **同一 channel・同一 instance**: 人間が実行する `activate.jsx` と probe の `AfterEffects.launch` は必ず同じ channelDir を指す。`--channel-dir` を省略すると run ごとの一時 channel になり、事前に `ae-a8n dispatcher prepare` 等で別 channel を activate しても real lane には繋がらない（別 channel・別 instance への誤接続を防ぐため、受入は常に自分が prepare した channel を使う）。
- **再実行**: `--channel-dir` に永続 directory を指定すると `prepare()` が冪等に働き（channel token は初回のみ生成）、前回 activation した dispatcher が生きていれば heartbeat が即 fresh になり **再 activation は不要**。fresh heartbeat がある channel では lane は activate を促さずそのまま再利用する。AE を再起動した場合だけ新しい `activate.jsx` 実行が必要。
- **`--prepare-only`**: stage と activation 手順の表示だけを行い scenario を実行しない。人間が先に activate してから本実行する 2 段階の手順に使う。
- **対象 install の固定（version pin）**: dispatcher transport は AE を launch も own もしないため、`--install-dir <abs>` が固定するのは「lane が受け付ける応答の AE version」である。probe は named selection `{ kind: "in-ae-dispatcher", channelDir, installDir }`（または `aeVersion`）で launch し、heartbeat が報告する `aeVersion` と pin が、heartbeat の報告精度で一致しない場合は `HostUnavailableError` で拒否する（patch 差も `app.version` が報告すれば拒否される）。**実行ファイルの同一性は証明できない** — heartbeat は pid も install path も持たず、同 version の別 install は区別できない。install dir から version を導けない環境（非 macOS）では `--ae-version <v>` で明示 pin する（`--install-dir` とは排他）。`activate.jsx` はその install の AE プロセスでだけ実行する — 別 version の AE で activate すると version mismatch で launch が拒否され、`A8N_RESULT` に `fail` として記録される。
- **project cleanup の契約**: attached session は AE を quit せず、`ae.close({ unsavedChanges: "discard" })` はこの session が行う quit にしか効かない — **project の未保存編集は破棄されない**。real lane は close 前に `project.info().file` が `--project` fixture と一致することを確認し、一致した場合のみ `openProject(PROJECT, { unsavedChanges: "discard" })` で開き直してメモリ上の編集を捨てる（fixture ファイルは書き込まれない）。一致しない・確認できない場合は何も破棄せず、残存を `A8N_RESULT` の `cleanup` フィールドで報告する。
- **二重 activation の禁止**: `activate.jsx` は AE プロセスごとに 1 回だけ。heartbeat がある channel で再実行してはいけない（host が二重 dispatcher を拒否するが、複数 AE が同一 channel を見ると heartbeat が不安定になる）。複数 AE を同時に使う場合は AE ごとに別 channelDir。
- **cleanup**: channel directory は probe 終了後も残る（token と staged script を保持するため）。受入完了後は `rm -rf <channelDir>` で削除する。`--channel-dir` 未指定の一時 channel は OS の tmp cleaner に任せる。
- **機械判定可能な結果**: probe は最後に `A8N_RESULT <json>` を 1 行出し、wrapper は全体で `A8N_RESULT {"fake":…,"real":…}` を出す。`real` は `pass` / `fail` / `blocked` / `prepared` / `skipped` のいずれか。**exit code 0 は real lane の検証を意味しない** — `blocked` は exit 3、`fail` は exit 1、`skipped`/`prepared` は exit 0 で、JSON の `real` 値だけが lane の判定である。`real:"pass"` のみが `verified on real host` の候補になる。監査用に、scenario を実行した lane の `A8N_RESULT` は `version`（実行した candidate の package version）、`aeVersion`（heartbeat が報告した実 AE version）、`checks`（操作別の ok/FAIL 一覧）、`pngSha256`（render 成果物の hash）、`cleanup`（fixture 後始末の結果）を含む。`prepared` / `blocked` / `skipped` は scenario 未実行のためこれらを持たない。
- `A8N_ACCEPTANCE_SKIP_REAL=1` は real lane を skip するだけで pass を捏造しない。CI はこの形で fake lane のみを回す。

## 2. consumer が ae-a8n に求めるもの（棚卸し）

### 2.1 ae-test [#19](https://github.com/ido-bata/ae-test/issues/19)（isolated real-host consumer）

| 必要なもの | ae-a8n 側の提供物 | 状態 |
| --- | --- | --- |
| immutable package bytes | `@ido-bata/ae-a8n@0.1.0-alpha.2` を registry から exact pin（tarball integrity は consumer の lockfile が保持）。`next` dist-tag 配下、`latest` ではない | 提供済み（publish は #63 T083 で実施済み） |
| launch options の passthrough | `AfterEffects.launch({ sessionRoot, transport, timeoutMs, installDir, hostEnvironment, hostScript, session, recoveryGraceMs, readinessTimeoutMs })` — `src/api/types.ts` `LaunchOptions` | 実装済み。ae-test は全てそのまま forward する設計（#19 T054） |
| ownership refusal | `HostNotOwnedError`（`kind`: `attached` / `unknown`、`evidence` 付き）、`ae.ownership()` → `HostOwnership { kind, evidence, code }` | 実装済み。`attached` / `unknown` を区別して report するのは consumer 側の責務 |
| trace / report の session metadata | `TraceRecorder`（`trace.jsonl`）、launch provenance（`readLaunchProvenance`）、`ae.diagnostics()` → `SessionDiagnostics`（host state / ownership / crash reports / trace 件数 / bundleDir） | 実装済み |
| static host extension | `ae-a8n extension build --extension <module> --out <file>` → `hostScript` launch option、`ae.call(name)` / `ae.extensionMethods()` | 実装済み（alpha.2 で publish 済みの API） |
| capability handshake / diagnostics | `await ae.capabilities()` → `HandshakeResponse`（contractVersion, catalogRevision, hostId, target.ownership, availableCapabilities, diagnostics, provenance.evidenceLevel） | 実装済み（#102） |

blocked 条件（ae-a8n のコードではなく環境）: ae-test T058 の real-host E2E は isolated lane 未整備で停止中 — `test` ユーザーの GUI session 無し、helper 実行可能な Node 無し、`sudo -n` が password を要求。**account 作成・login・TCC 付与・Adobe sign-in は agent の作業ではない**（人間作業）。

### 2.2 Aulymo [#332](https://github.com/rebuildup/Aulymo_v04/issues/332) / [#333](https://github.com/rebuildup/Aulymo_v04/issues/333)（実 packaged consumer E2E）

| 必要なもの | ae-a8n 側の提供物 | 状態 |
| --- | --- | --- |
| 同上の package bytes / API | `0.1.0-alpha.2` exact pin（`bun.lock` に tarball sha512） | 提供済み |
| isolated adapter が拒否壁に使う面 | `ownership().kind === "owned"` の判定、`close({ unsavedChanges: "refuse" })`、`HostNotOwnedError`、process 終了コードは consumer 側 CLI の責務 | API は実装済み。adapter 本体（`scripts/host/isolated.ts`）は Aulymo 側 PR #375 に実装済み |
| 実機 E2E の前提 | helper GUI session（uid 502 の `test` account）、helper が実行できる Node（`/Users/Shared/aulymo-node/node`）、`sudo -A` の都度認証 | **未整備**。#332 T065 / #333 全 task がこれに blocked（2026-11-11 時点） |

Aulymo 固有の adapter・assertion・manifest/report schema は **downstream に残す**（US4）。ae-a8n に project 固有名・処理を入れない。

### 2.3 判定基準: 3 つの提供物が揃っているか

consumer 受入（G4）の前に、次の 3 点を「ある」と言えるかを確認する:

- **package bytes identity** — consumer が pin する version + registry/tarball の integrity（`npm view dist.integrity` / lockfile の sha512）が、検証した commit/tag の `npm pack` 結果と一致すること。手順は `docs/releasing.md`。
- **capability handshake** — `ae.capabilities()` が `HandshakeResponse` を返し、`target.ownership` / `nonInterference` / `availableCapabilities` / `diagnostics` が consumer の refusal 壁（例: Aulymo の `ownership === "owned"` 必須）を支えられること。
- **diagnostics** — `ae.diagnostics()` の bundle、`ae-a8n doctor` の JSON envelope、`trace.jsonl`、launch provenance が、失敗時に consumer が report へ転記できる粒度で取れること。

## 3. consumer 受入で見つかった機能欠落（ticket 候補）

**ここに挙げるものは ae-a8n 側で実装しない。** consumer 固有処理は downstream に残し、generic に必要な欠落だけを ae-a8n の ticket に変換する。現時点の候補:

- ~~**G-a: disposable project / fixture 生成 API が無い。**~~ **解決済み（#148 T1）**: 判定は「generic な `project.new` は今回も実装せず、disposable project は operator 提供の明示 fixture（`--project`）で受ける」。編集・render を伴う受入が無指定の project を触る危険を避けるため、fixture は常に人間が指定する。ae-test / Aulymo が generic な project 生成を具体的に要求した時点で別 Issue 化する。
- ~~**G-b: smoke が render / extension call を含まない。**~~ **解決済み（#148 T2–T4）**: `scripts/check-dispatcher-acceptance.js` が dispatcher 経路で handshake・編集・render（PNG 検証）・static extension `ae.call`・認可拒否・instance pin/再接続・UNKNOWN 非再送・安全終了を fake lane で自動検証し、real lane（人間 activation + `--project` fixture）で同じ scenario を実機確認する。
- **G-c: `latest` dist-tag が `0.1.0-alpha.0` のまま。** `0.1.0-alpha.2` は `next` 配下。consumer は exact pin で回避済みだが、stable/latest 昇格は #63/#75 の gate 待ち。コード変更ではなく release 判断。
- **G-d: Windows の real-host 証跡が古い / UNVERIFIED 項目が残る。** `docs/windows-verification.md` 参照。#75 の gate が candidate commit と tarball に紐付けて要求する。

## 4. 検証レベルの記録形式（偽らないためのテンプレート）

ルール: AGENTS.md の verification taxonomy に従う。`automated test`（pack 内容検査・CI green）を `verified on real host` と書かない。`fake/mock only` を「動く」と報告しない。**実機未受入の経路を `latest` として昇格しない** — real-host consumer 受入が通るまで `next` dist-tag に留め、README / CHANGELOG / 本 Issue に未検証であることを明記する。`0.x` version に prerelease suffix を必須としない（#165 の方針変更）— 未検証範囲は version 番号ではなく記述で担保する。

受入実行ごとに次の表を記録する（Issue コメント・PR・`docs/evidence/` のいずれか）:

| 項目 | 記入例 |
| --- | --- |
| date / operator | 2026-XX-XX / name |
| candidate | commit SHA / tag / branch |
| package bytes | `@ido-bata/ae-a8n@x.y.z`、tarball sha512（`npm pack` 出力 or registry `dist.integrity`） |
| platform | macOS version / Windows build、arch |
| After Effects | version / build（`app.version` / `app.buildNumber` 相当） |
| consumer | `manual smoke` / `ae-test#19` / `aulymo#332` / `aulymo#333` |
| steps run | install → import → doctor → launch → version → handshake → project → operation → close のどこまで |
| result per step | pass / fail / skipped（理由） |
| verification level reached | `implemented` / `automated test` / `fake/mock only` / `verified on real host` のどれか 1 つ |
| evidence | trace bundle（`trace.jsonl`）、`ae.diagnostics()` の `bundleDir`、consumer 側 report/manifest の hash、Issue/PR リンク |
| blocked conditions | isolated lane 未整備、TCC 未付与、modal 残存など、再現に必要な前提 |

`scripts/check-consumer-smoke.js` の出力は `RESULT: real-host pass` / `RESULT: skipped — …` を出し、末尾に到達レベルを明示する。skip 出力を「受入完了」と読み替えないこと。

`check-dispatcher-acceptance.js` は lane ごとに別々に記録する: fake lane の `RESULT: fake pass` は **`fake/mock only`**、real lane の `RESULT: real-host pass` のみが `verified on real host` の候補になる。判定は出力末尾の `A8N_RESULT {"fake":…,"real":…}` JSON で行い、real lane が `blocked`（人間 activation 無し・AE 未起動）・`skipped`・`prepared` の場合、dispatcher scenario の real-host 受入は**未実施**として扱う。exit code だけで PASS と読み替えない。
