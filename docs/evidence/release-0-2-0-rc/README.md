# release-0-2-0 リリース候補 (RC) 記録

作成: 2026-11-17。`release-0-2-0` の ticket 統合（#145/#146/#147/#148）、
#155 RC 監査・修正、macOS AE 26.5.3 実機受入、公開情報の整合を経た
候補を固定する。**これはリリースではない** —
`main` への release PR、tag、npm stage、2FA approve は人間の release 手順
（`docs/releasing.md`）に従う。

## 候補の区分: `0.2.0`（`next` 向け早期リリース）

version 番号の経緯:

- 初回 freeze は `0.2.0`（stable 番号）だったが、#155 の監査で
  `0.2.0-beta.1`（prerelease）へ再分類した。当時の根拠は「実機未検証の
  経路を提供する候補は明示的 prerelease として扱う」という
  `docs/consumer-acceptance.md` §4 の契約だった。
- `0.2.0-beta.1` は npm に stage されたが未公開のまま、#165 で方針が
  変更された: SemVer の `0.x` は初期開発段階を表し、Windows real-host
  未検証は README / CHANGELOG / package description / 本記録で明示すれば
  よく、version 名に prerelease 識別子を付ける必然性はない。`next` と
  `latest` は version と独立した dist-tag であり、`0.2.0` を `next` で
  公開しても `latest` 昇格は別の gated act のまま維持できる。
- これに伴い `scripts/check-release.js` の「prerelease 必須」制約を撤廃
  した。同 script は `publishConfig`（`tag:"next"` / `provenance:false` /
  `access:"public"`）と tag = `v<version>` の前提条件だけを検査し、
  「この version が evidence 完備か」の判断は人間の release 手順に残る。

`latest` への昇格は #75 の cross-platform evidence gate が別途必要であり、
`next` への stage とは別の行為である。

なお `0.2.0-beta.1` の staged package（stage id
`e9f74115-14e4-4119-96c4-d8a03dcf9f71`、shasum
`9ada37bce03d87998239ba8a2fdf02f83bdfe878`）は**公開しない**。
npm 側で人間が `npm stage reject` する。tag `v0.2.0-beta.1` は未公開
version を指すだけなので削除する。

## 候補の固定

| 項目 | 値 |
| --- | --- |
| version | `0.2.0` |
| branch | `main`（`release-0-2-0` 統合済み + #165 ticket PR） |
| freeze SHA | `b2c6321c96fa01f333cc9bc5b696f00fdeb31f3f`（#165 の内容確定 commit。`package.json` version・`src/version.ts`・`CHANGELOG.md`・README・quickstart・`docs/releasing.md`・`docs/consumer-acceptance.md`・`scripts/check-release.js`。runtime の差分は `A8N_VERSION` 文字列のみで、実機受入済みのロジック（`src/` 他・`host/`・`skills/`・`examples/`・`package-lock.json`）は `377c5ba` 受入 tree と同一 — `git diff 377c5ba..b2c6321 -- src host skills examples package-lock.json` は `src/version.ts` の 1 行のみ） |
| package bytes | `ido-bata-ae-a8n-0.2.0.tgz`（382,534 bytes） |
| tarball shasum (sha1) | `3afeb68ba942daaf3451df80e3c0953c3ca6b96b` |
| tarball integrity (sha512) | `sha512-NyKmrKIlm7zT4yHWPwf8VGxiW2FRBm5Dqf/IJWg1Dh04ceuk5KWLWHAEgNE5cPXc/N8vF3lQG/ny7axm25+shA==` |

`npm pack` は同一 tree で再現する（`docs/releasing.md`）。hash が違う
tarball はこの候補ではない。版番号・配布内容を変更した場合は旧 freeze
SHA・tarball hash を流用せず、必ず再 pack して再固定する。
freeze SHA は package 内容を確定した commit を指す。本記録自体の commit
は `docs/` のみの変更であり、`files`（`dist` / `host` / `skills` /
`examples` / `CHANGELOG.md`）に含まれないため tarball hash は変わらない
（`CHANGELOG.md` は `files` に含まれる点に注意 — freeze commit `b2c6321`
に含まれる版で pack すること）。

### 旧 freeze（superseded）

`0.2.0-beta.1`・#165 で破棄（npm staged・未公開）:

| 項目 | 値 |
| --- | --- |
| version | `0.2.0-beta.1` |
| freeze SHA | `d89517994a75da8b8bf5bfdb669941850629669f`（#155 公開情報整合の最終 commit） |
| package bytes | `ido-bata-ae-a8n-0.2.0-beta.1.tgz`（382,574 bytes） |
| tarball shasum (sha1) | `9ada37bce03d87998239ba8a2fdf02f83bdfe878` |
| tarball integrity (sha512) | `sha512-G3UHhl4i5YJTOb8xBoRZRCy+rrRYiURmK8xByMLRdT3IC+6HpgXN3T2jLBBDj+THK0hFAjxvsoqRHWYpBGgsGw==` |

この tarball は GitHub Actions の publish workflow で npm stage 済み
（stage id `e9f74115-14e4-4119-96c4-d8a03dcf9f71`）だが、#165 の version
変更により publish しない。監査用に値だけ残す。runtime 内容は現候補と
同一（version 文字列と配布 metadata のみ差分）。

`0.2.0-beta.1` のさらに古い freeze:

| 項目 | 値 |
| --- | --- |
| version | `0.2.0-beta.1`（前々回） |
| freeze SHA | `ef5ac414ca22d340ab956b9c5d9983ae3c26cc3d` |
| package bytes | `ido-bata-ae-a8n-0.2.0-beta.1.tgz`（382,538 bytes） |
| tarball shasum (sha1) | `c72c5898d6217ac874fbb0e74f1975863d81f5cc` |
| tarball integrity (sha512) | `sha512-aqrXAbbwNH6w9J01iM2jB3Umt3NZEc/VSpKKGVonXkEGpRIXUOI8DpqNY9DdEZBkw/mVzGs5IVyrn6FVLYEBFQ==` |

| 項目 | 値 |
| --- | --- |
| version | `0.2.0-beta.1`（実機受入を通した head） |
| freeze SHA | `377c5ba0c15574c5b12c02dd07947c7fa0665c4b`（PR #162 merge commit。real ExtendScript での dispatcher activation・`Folder.isDirectory`・`app.version` suffix の 3 件修正を含み、AE 26.5.3 実機受入を通した head） |
| package bytes | `ido-bata-ae-a8n-0.2.0-beta.1.tgz`（382,483 bytes） |
| tarball shasum (sha1) | `e1366acc89bdbea818c0e8b65e13fc65d1de26d6` |
| tarball integrity (sha512) | `sha512-xBRI4ie38h3TmaJqgLwB/u9KwH6R+Xll5WlKFmPjRO1sVGQbf1uHs/fo5euwRtdvuD3Lb4WDwRMRcJ50PSZAuA==` |

初回 freeze（`0.2.0` 番号・prerelease 再分類前）:

| 項目 | 値 |
| --- | --- |
| version | `0.2.0` |
| freeze SHA | `9f340fa3033eb0b62eff274cbddd5ad65d6fca1b`（PR #153 merge commit。tree は `cf088aa` と同一） |
| package bytes | `ido-bata-ae-a8n-0.2.0.tgz`（379,694 bytes） |
| tarball shasum (sha1) | `5b714ead630bde227fe1df99f63c19708d635035` |
| tarball integrity (sha512) | `sha512-WNQmTO6m4FJpQS9Zi15yBoAuQfOdW/QmuEQnSalV8QrDusQJUqdf+h6Wq3buhb5weWsD9r70F3khOuzVplw1Kw==` |

この tarball は `0.2.0` を名乗り Windows 未検証を明示していなかったため、
配布候補としては無効。監査用に値だけ残す。

## 含まれるもの

- #106 / PR #106（`f281267`、#105 macOS dual-process fix）と #124 / PR #132
  （`a584614`、`readinessTimeoutMs`）は旧 freeze SHA の ancestor であることを
  `git merge-base --is-ancestor` で確認済み。ae-test が pin している
  `0.1.0-alpha.2` には両方とも含まれない。
- #127 dispatcher transport、#145 authorization/instance pin、#146 static
  extension の dispatcher 統合、#147 lifecycle CLI、#148 packed-consumer
  受入 harness（PR #149–#152）。
- #155 RC 監査修正: real lane が consumer extension を stage した**同一
  channel・同一 dispatcher instance** に対して人間 activation と consumer
  操作を行うよう `--channel-dir` / `--prepare-only` / `--install-dir`
  （対象 AE install の固定）を追加し、結果を
  機械判定可能な `A8N_RESULT` JSON（`blocked` は exit 3）に整えた。
  当時 version を `0.2.0-beta.1` へ再分類したが、#165 で `0.2.0` へ
  戻した（上記「候補の区分」参照）。
- PR #160（#155 続き）: `--install-dir` が dispatcher 接続先を実際に
  固定していなかった問題を、transport selection の `installDir` /
  `aeVersion` pin（heartbeat `aeVersion` との照合、version pin であり
  実行ファイル同一性は証明しない）で修正。real lane の cleanup を
  attached session の実態に合わせ、`--project` fixture と一致する時だけ
  reopen+discard し、不一致時は残存を報告する契約に変更。
- PR #162（#155 続き・実機で判明した fake 非再現バグ）: dispatcher
  activation の分岐が IIFE トップレベルの `this.__a8n` に依存し real
  ExtendScript では常に不成立だった問題を named function 化で修正、
  real に存在しない `Folder.isDirectory` 参照を除去、`app.version` の
  build suffix（`26.5.3x9`）を version parse が受理するよう修正。
  AE 26.5.3 実機で Scripts/Startup activation → heartbeat →
  handshake / comps / project.info / extension call / close を確認。
- 公開情報整合（#155 続き）: `package.json` description・README・
  CHANGELOG・quickstart・`docs/in-ae-dispatcher.md` を実際の検証状況
  （macOS AE 26.5.3 で dispatcher scenario と Startup 実行が
  `verified on real host`、Windows 未検証、`next` 向け未公開）に
  合わせた。`check-dispatcher-acceptance.js` の lane 別 `A8N_RESULT`
  に監査 field（`version` / `aeVersion` / `checks` / `pngSha256` /
  `cleanup`）を追加 — 次回 real lane 実行から操作別結果・実 AE
  version・candidate・PNG hash・cleanup が機械可読で残る。
- #165 version 方針変更: version を `0.2.0`（`next` 向け）へ戻し、
  `check-release.js` の prerelease 必須を撤廃。`latest` 昇格 gate
  （#75）は変更なし。

## 検証状況（verification level）

| 経路 | レベル | 証拠 |
| --- | --- | --- |
| package / API / dispatcher fake lane | `automated test` + `fake/mock only` | CI（check / windows / verify / verify-windows / release-tooling-windows）green。`check-dispatcher-acceptance.js` fake lane が pack→clean install→全 scenario を pass |
| dispatcher transport / extensions の real-host（macOS AE 26.5.3 = `26.5.3x9`） | **`verified on real host`（macOS のみ）** | 2026-11-17 実施。`check-dispatcher-acceptance.js --project fixture.aep --channel-dir … --install-dir "/Applications/Adobe After Effects 2026"` が `A8N_RESULT {"fake":"pass","real":"pass"}`。real lane 全 scenario（handshake・編集・render PNG・extension call・未宣言/未認可/誤 instance 拒否・pinned reconnect）pass、接続先 instance `i1a1e9d9e20c8b2896`、heartbeat `aeVersion:"26.5.3x9"`、cleanup「fixture reopen+discard / project left open clean」、close は `quit=false`（attached）。acceptance 中に fake 非再現の実機バグ 3 件（IIFE `this`・`Folder.isDirectory`・version suffix）を発見し PR #162 で修正済み |
| Scripts/Startup folder 実行（macOS AE 26.5） | **`verified on real host`（macOS のみ）** | 同上の受入で `~/Library/Preferences/Adobe/After Effects/26.5/Scripts/Startup/a8n-dispatcher.jsx` が AE 起動時に dispatcher を自動 activation し heartbeat を生成することを確認。Windows の Startup 実行は未検証 |
| Windows real-host（新規経路） | **未検証** | Windows 実機を現在利用できない。実装は停止せず、未検証として記録する |

上記 macOS real-host 受入は freeze `377c5ba` の tree で実施した。
現 freeze `b2c6321` との差分は `src/version.ts` の version 文字列と
配布 metadata・文書のみで、runtime のロジックは同一のため証拠は
有効。ただし当時の `A8N_RESULT` には監査 field（`pngSha256` 等）が
無く、PNG 成果物 hash は記録されていない。最終候補での real lane
再実行は人間 activation が前提のため未実施 — 実施した場合は
`A8N_RESULT` の `checks` / `aeVersion` / `version` / `pngSha256` /
`cleanup` を本記録へ転記する。

## Mac 実機受入手順（人間が実施）

前提: macOS、After Effects 2026（26.x）インストール済み、Node（repo の
`mise install` 済み toolchain）、scripting の「Allow Scripts to Write Files
and Access Network」を許可できること。編集・render を行うため **明示した
使い捨て fixture `.aep`** を用意すること（開いている project には触れない）。
AE の設定が初期化されている可能性を考慮し、まず `doctor` で環境を確認する。

```sh
git clone https://github.com/ido-bata/ae-a8n && cd ae-a8n
git switch --detach <freeze SHA>   # 上表の確定値
npm ci && npm run build

# 0. 環境診断（AE の有無・scripting 権限まわりの blocker を確認）
node dist/cli.js doctor

# 1. 配布候補を pack し、hash が上表と一致することを確認
npm pack
shasum -a 1 ido-bata-ae-a8n-0.2.0.tgz   # → 記録値と一致

# 2. 受入 channel を prepare（consumer extension の packaged host script を
#    stage し、activate.jsx を生成。人間の activation はまだ）
node scripts/check-dispatcher-acceptance.js \
  --prepare-only \
  --channel-dir /absolute/path/dedicated-channel \
  --install-dir "/Applications/Adobe After Effects 2026"
# → 表示される activate.jsx のパスを控える
#   （/absolute/path/dedicated-channel/activate.jsx）

# 3. 対象 install（ここでは AE 2026）の AE を起動し、
#    File > Scripts > Run Script File でその activate.jsx を実行
#    （script 書き込み許可のダイアログが出たら人間が承認）。
#    別 version の AE（2027 等）で activate してはいけない — lane が
#    launch するのは --install-dir の install だけである。
#    activate.jsx は AE プロセスごとに 1 回だけ。heartbeat がある
#    channel で再実行しない。複数 AE を同時に使う場合は AE ごとに別
#    channel-dir。

# 4. heartbeat を確認（instance id が出る）
node dist/cli.js dispatcher status --channel-dir /absolute/path/dedicated-channel

# 5. consumer 受入 real lane を実行（pack→clean install→全 scenario。
#    人間の activation 待ちは A8N_ACCEPTANCE_WAIT_MS で調整可・既定10分）
node scripts/check-dispatcher-acceptance.js \
  --project /absolute/path/fixture.aep \
  --channel-dir /absolute/path/dedicated-channel \
  --install-dir "/Applications/Adobe After Effects 2026"
```

channel と activation の関係: 手順 2 が stage した packaged host script
（consumer extension build 済み）を channel 内の `a8n-host.js` として置き、
手順 3 の `activate.jsx` がそれを eval する。手順 5 の probe は**同じ
channelDir** に対して `AfterEffects.launch` し、heartbeat が報告する
instance に束縛される — 別 channel・別 instance への接続は extension-set
照合と instance pin で拒否される。`--channel-dir` を省略すると run ごとの
一時 channel になり、手順 2–4 で activate した dispatcher には繋がらない
（受入は常に自分が prepare した channel を使う）。再実行は同じ
`--channel-dir` を渡せば token が維持され、dispatcher が生きていれば再
activation 不要。cleanup は受入後に `rm -rf /absolute/path/dedicated-channel`。

結果契約: 出力末尾の `A8N_RESULT {"fake":…,"real":…}` JSON が機械判定の
正本。`real:"pass"` のみが `verified on real host` の候補。`blocked` は
exit 3、`fail` は exit 1、`skipped`/`prepared` は exit 0 であり、
**exit code 0 だけを PASS と読み替えない**。期待結果は
`A8N_RESULT {"fake":"pass","real":"pass"}` と
`RESULT: real-host pass`。記録は `docs/consumer-acceptance.md` §4
のテンプレートに従い、到達しなかった step と理由を残す。

補足: script-invocation 経路（既定 transport）の real-host 受入は別経路で
`check-consumer-smoke.js` が担う。dispatcher は opt-in であり、起動しない
限り既存挙動に影響しない。

## Windows real-host 未検証の扱い

現在 Windows 実機を利用できないため、新規経路（dispatcher CLI /
extensions / acceptance harness）の Windows real-host 証拠は**存在しない**。
これは実装の blocker ではなく、release 記録上の未検証項目として明示する
（#165 以降、version 番号ではなく README / CHANGELOG / package
description / 本記録の記述で担保する）。Windows での確認が可能に
なった時点で §「Mac 実機受入手順」と同じ手順（`--project` fixture と
人間 activation を Windows で行う）を実施し、結果を本ディレクトリまたは
Issue #75 の gate 記録へ追記する。`latest` 昇格にはこの証拠が必須。

## 残る release 手順（人間）

1. #165 ticket PR を `main` へ merge する（`release-0-2-0` train は
   `main` に統合済みのため base は `main`）。
2. `main` head に `v0.2.0` tag を打って push → publish workflow が
   stage（publish はしない）。
3. npm で人間が `npm stage reject e9f74115-14e4-4119-96c4-d8a03dcf9f71`
   （旧 `0.2.0-beta.1` staged package）した上で、新しい stage id を
   `npm stage view` / `download` で照合し、2FA approve
   （`npm stage approve`）→ `next` dist-tag へ公開。
4. 公開後、version と `dist.integrity` を ae-test へ共有し、pin 更新
   ticket で新 SHA の real-host 受入をやり直す。
5. `latest` への昇格は #75 の evidence gate 通過後の別判断。
