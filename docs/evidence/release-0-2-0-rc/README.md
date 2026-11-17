# release-0-2-0 リリース候補 (RC) 記録

作成: 2026-11-17。`release-0-2-0` の ticket 統合（#145/#146/#147/#148）と
version bump が完了した時点の候補を固定する。**これはリリースではない** —
`main` への release PR、tag、npm stage、2FA approve は人間の release 手順
（`docs/releasing.md`）に従う。

## 候補の固定

| 項目 | 値 |
| --- | --- |
| version | `0.2.0` |
| branch | `release-0-2-0` |
| freeze SHA | `9f340fa3033eb0b62eff274cbddd5ad65d6fca1b`（PR #153 merge commit。tree は `cf088aa` と同一） |
| package bytes | `ido-bata-ae-a8n-0.2.0.tgz`（379,694 bytes） |
| tarball shasum (sha1) | `5b714ead630bde227fe1df99f63c19708d635035` |
| tarball integrity (sha512) | `sha512-WNQmTO6m4FJpQS9Zi15yBoAuQfOdW/QmuEQnSalV8QrDusQJUqdf+h6Wq3buhb5weWsD9r70F3khOuzVplw1Kw==` |

`npm pack` は同一 tree で再現する（`docs/releasing.md`）。hash が違う tarball
はこの候補ではない。

## 含まれるもの

- #106 / PR #106（`f281267`、#105 macOS dual-process fix）と #124 / PR #132
  （`a584614`、`readinessTimeoutMs`）は freeze SHA の ancestor であることを
  `git merge-base --is-ancestor` で確認済み。ae-test が pin している
  `0.1.0-alpha.2` には両方とも含まれない。
- #127 dispatcher transport、#145 authorization/instance pin、#146 static
  extension の dispatcher 統合、#147 lifecycle CLI、#148 packed-consumer
  受入 harness（PR #149–#152）。

## 検証状況（verification level）

| 経路 | レベル | 証拠 |
| --- | --- | --- |
| package / API / dispatcher fake lane | `automated test` + `fake/mock only` | CI（check / windows / verify / verify-windows / release-tooling-windows）green。`check-dispatcher-acceptance.js` fake lane が pack→clean install→全 scenario を pass |
| dispatcher transport / extensions / CLI の real-host | **未検証（unproven）** | real lane は人間 activation が前提で未実施。`fake/mock only` を real-host と読み替えない |
| Startup folder 実行 | **未検証（unproven）** | macOS / Windows とも実機未確認 |
| Windows real-host（新規経路） | **未検証** | Windows 実機を現在利用できない。実装は停止せず、未検証として記録する |

## Mac 実機受入手順（人間が実施）

前提: macOS、After Effects 2026（26.x）インストール済み、Node（repo の
`mise install` 済み toolchain）、scripting の「Allow Scripts to Write Files
and Access Network」を許可できること。編集・render を行うため **明示した
使い捨て fixture `.aep`** を用意すること（開いている project には触れない）。

```sh
git clone https://github.com/ido-bata/ae-a8n && cd ae-a8n
git switch --detach 9f340fa3033eb0b62eff274cbddd5ad65d6fca1b
npm ci && npm run build

# 1. 配布候補を pack し、hash が上表と一致することを確認
npm pack
shasum -a 1 ido-bata-ae-a8n-0.2.0.tgz   # → 5b714ead630bde227fe1df99f63c19708d635035

# 2. channel を prepare（人間の activation はまだ）
node dist/cli.js dispatcher prepare
# → 表示される activate.jsx のパスを控える

# 3. AE を起動し、File > Scripts > Run Script File で activate.jsx を実行
#    （script 書き込み許可のダイアログが出たら人間が承認）

# 4. heartbeat を確認（instance id が出る）
node dist/cli.js dispatcher status

# 5. consumer 受入 real lane を実行（pack→clean install→全 scenario。
#    人間の activation 待ちは A8N_ACCEPTANCE_WAIT_MS で調整可・既定10分）
node scripts/check-dispatcher-acceptance.js --project /absolute/path/fixture.aep
```

期待結果: `RESULT: real-host pass`。記録は `docs/consumer-acceptance.md` §4
のテンプレートに従い、dispatcher scenario が `verified on real host` に
到達したこと、到達しなかった step と理由を残す。`RESULT: blocked` や
real lane skip は**未実施**であり pass ではない。

補足: script-invocation 経路（既定 transport）の real-host 受入は別経路で
`check-consumer-smoke.js` が担う。dispatcher は opt-in であり、起動しない
限り既存挙動に影響しない。

## Windows real-host 未検証の扱い

現在 Windows 実機を利用できないため、新規経路（dispatcher CLI /
extensions / acceptance harness）の Windows real-host 証拠は**存在しない**。
これは実装の blocker ではなく、release 記録上の未検証項目として明示する。
Windows での確認が可能になった時点で §「Mac 実機受入手順」と同じ手順
（`--project` fixture と人間 activation を Windows で行う）を実施し、
結果を本ディレクトリまたは Issue #75 の gate 記録へ追記する。

## 残る release 手順（人間）

1. `release-0-2-0` → `main` の release PR を作成し、explicit human
   authorization で merge する。
2. `main` head に `v0.2.0` tag を打って push → publish workflow が stage
   （publish はしない）。
3. npm で人間が 2FA approve（`npm stage approve`）。
4. 公開後、version と `dist.integrity` を ae-test へ共有し、pin 更新
   ticket で新 SHA の real-host 受入をやり直す。
