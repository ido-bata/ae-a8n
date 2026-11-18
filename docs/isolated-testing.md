# 隔離テスト環境の使い方（macOS helper user）

`ae-a8n test` / `setup` が使う「隔離セッション」の運用手順。目的は
**操作者のデスクトップと作業中の After Effects に触れずに**、別 OS
ユーザーの GUI セッション内で AE を動かして検証すること。

前提となる許可モデルは
[specs/isolated-ae/contracts/permissions.md](../specs/isolated-ae/contracts/permissions.md)、
実測の根拠は [offstage-macos.md](offstage-macos.md)。この文書は「人間が
何を・どの画面で・なぜやるか」を書く。自動化できない手順を自動化したと
書かない。

## 1. helper user（対象 OS アカウント）

- macOS に **テスト専用の第2ユーザー**を作る（例: `ae-test`）。
  管理者権限は不要。Apple ID 連携はテスト内容に応じて判断する
  （サインインが必要な検証をするなら、そのユーザーで一度サインインする）。
- helper user は **ログインしたまま** にする。fast user switching で
  切り替えられる状態が「セッションが生きている」状態。logout すると
  GUI セッションが消えて `A8N-SESSION-002` になる。
- 対象ユーザーのホームは普段使わない場所でよい。After Effects と
  テスト対象プロジェクトだけを置く。

## 2. 初回セットアップの流れ

```bash
npx @ido-bata/ae-a8n doctor --user ae-test   # 何も変更しない診断
npx @ido-bata/ae-a8n setup --user ae-test    # resumable。途中で止まっても再実行で続く
npx @ido-bata/ae-a8n test --user ae-test -- <検証コマンド>
```

`setup` の各ステップは3種別のどれか:

- **automatic** — ツールが実行（ディレクトリ作成、設定ファイル等）
- **needs-human** — OS/Adobe の同意が必要。理由と正確な操作が表示され、
  人間がやる。ツールは代行しない
- **skipped** — すでに完了済み

止まったら表示された blocker の `code` を
[troubleshooting.md](troubleshooting.md) で引く。

### 2.1. tarball 同梱の検証 fixture（リポジトリを持たない環境向け）

npm から入れたパッケージだけで「隔離セッションが本当に効いたか」を
確かめるには、tarball 同梱の fixture を helper session 内で実行する。
fixture（`examples/isolated-test.ts`）はまず **自分が期待した helper
user として動いているか**を検証し、一致した時だけ AE の最小 smoke
（launch → version → handshake → project → close）を行う。

helper user は別 OS アカウントなので、インストール先は helper から
読める場所に置く（`/Users/Shared` 配下など）:

```bash
npm install --prefix /Users/Shared/ae-a8n-fixture @ido-bata/ae-a8n@next
ae-a8n doctor --user ae-test
ae-a8n setup --user ae-test
ae-a8n test --user ae-test -- \
  "$(which node)" \
  /Users/Shared/ae-a8n-fixture/node_modules/@ido-bata/ae-a8n/examples/isolated-test.ts \
  --expect-user ae-test
```

- `$(which node)` は controller 側で展開され、helper session の PATH に
  依存しない絶対パスとして job に入る
- package の import はファイル自身の位置から self-reference で解決
  される。NODE_PATH や symlink、checkout は不要
- `--expect-user` が実際の user と違えば AE に触れる前に exit 3。
  「隔離されず console user で動いた」実行を成功と誤認しない
- AE が見つからない環境では skip（exit 0）。skip は PASS ではない
  （[consumer-acceptance.md](consumer-acceptance.md) の検証レベル参照）
- §4.5 以降の `scripts/isolated-session/*` はリポジトリの開発 harness
  であり、npm パッケージには含まれない。packaged 側の対応物は
  `ae-a8n doctor` / `setup` / `recover` の各コマンド

## 3. 人間がやる画面（順不同に起こりうる）

| 画面 | 出る場所 | やること |
| --- | --- | --- |
| 「ターミナルが System Events を制御したい」 | **helper user のデスクトップ** | 「許可」。denied 済みなら `-1743` がプロンプト無しで続くので、後述の reset 手順へ |
| 「After Effects がスクリプトを実行しようとしています」系（`-1708`） | helper user の AE | AE → 設定 → スクリプトとエクスプレッション で、driver が読ませるフォルダを許可 |
| Adobe サインイン / ライセンス | helper user の AE | 人間がサインイン。一度だけ。資格情報はツールに保存されない |
| 画面収録・アクセシビリティ | helper user の「システム設定 → プライバシーとセキュリティ」 | 該当アプリ（Terminal 等）を ON |

**重要**: プロンプトは helper user の画面にしか出ない。fast user
switching（Ctrl+→ / メニューバー）で helper user に切り替えて押し、
終わったら通常のターミナルに戻って `setup` を再実行 or `doctor` で確認。
**ログアウトはしない**（セッションが消える）。

## 4. よくあるエラー識別子

| code / 症状 | 意味 | 次の一手 |
| --- | --- | --- |
| `A8N-SESSION-002` | helper user の GUI セッションが無い | fast user switching で一度ログインし、セッションを維持する |
| `A8N-SESSION-003` | 対象が console session | 別ユーザーを `--user` に指定。console は対象にできない |
| `A8N-SESSION-004` | 実行中に session identity が変わった | helper user の logout/login・uid 再利用を疑う。job をやり直す |
| `A8N-PERM-001` / `002` | 画面収録 / アクセシビリティ未許可 | helper user の画面で System Settings から許可 → doctor 再実行 |
| `A8N-PERM-003` / `007` / `008` | AE のスクリプト/ファイル/ネットワーク許可、または承認状態が未証明 | AE の設定でフォルダ許可。`-1708` が出ているならモーダルを人間が解消 |
| `A8N-PERM-004` | Adobe サインインが必要 | helper user の AE でサインイン（資格情報は保存されない） |
| `-1743`（Apple Event） | Automation 権限なし、または responsible process が bundle 無し | 実行主体が Terminal.app の子か確認。denied 済みなら `tccutil reset AppleEvents <bundle-id>` を **helper user 側で**実行して再プロンプト |
| `-1712`（Apple Event timeout） | イベントは届いたが AE が応答しない = モーダル/サインイン/Welcome が出ている | helper user の画面でモーダルを人間が解消。権限問題ではないので再送しない |
| `-1708` | AE のスクリプト信頼が未承認 | AE 設定でスクリプトフォルダを許可 |

Apple Event のエラー番号の意味と「権限問題ではない」切り分けは
[permissions.md](../specs/isolated-ae/contracts/permissions.md) §4。

## 4.5. 権限プローブ（helper user セッション内で実行）

> **repo harness と packaged CLI の境界**: この節と §4.6 の
> `scripts/isolated-session/*.mjs` は **この repository の開発・検証用
> harness** であり、npm package には同梱されない。packaged consumer が
> 使うのは `ae-a8n doctor` / `setup` / `test` / `recover` だけで、
> それらの出力は repo パスや source checkout を要求しない。
> packaged 側の対応物は: grant の再測定 = 対象 session 内での
> `ae-a8n doctor`、shared root の残り物の検査 = `doctor` / `recover`
> の read-only 報告（packaged に prune は無い — 削除契約が未定義のため。
> `specs/isolated-ae/contracts/cli.md` §6 参照）。

TCC grant は responsible process（テストコマンドを動かす app bundle、
通常は helper user の Terminal.app）に紐づく。だからプローブは
**helper user のセッション内で、テストと同じ実行経路で**実行する。
controller 側で実行しても別人の grant を測るだけで意味がない。

```bash
node scripts/isolated-session/run-in-isolated-session.mjs \
  --user ae-test --substrate terminal -- \
  node scripts/isolated-session/permission-probe.mjs
```

出力は JSON 1件。`permissions.*.state` は `granted | denied | unproven`
の3値で、**測れなかったものは決して PASS にならない**。

- `screenRecording` / `accessibility`: preflight API のみ。prompt は出ない。
- `automationSystemEvents`: `System Events` への Apple Event を1本送る。
  未許可なら **helper user の画面に同意 dialog が出る** — それは grant
  経路が動いている証拠であり、denied が続く場合は permissions.md §4 の
  `-1743` 対応（該当 service/app だけ `tccutil reset`）へ。
- `aeScriptFileNetwork`: helper user の AE prefs
  `Pref_SCRIPTING_FILE_NETWORK_SECURITY` を version ごとに読む。

プローブのあとに consent を得る順序は grant → probe → resume:
人間が helper user の画面で許可し、通常のターミナルに戻ってプローブを
再実行する。`unproven` が残る場合は interpreter 不在等の環境要因を疑う
（Command Line Tools の python3 が必要）。

### 4.5.1. guided grant/check ループ（grant-check）

probe は測るだけで request はしない。consent を取る側は
`grant-check.mjs` — 同じく helper user セッション内で実行する:

```bash
node scripts/isolated-session/run-in-isolated-session.mjs \
  --user ae-test --substrate terminal -- \
  node scripts/isolated-session/grant-check.mjs [--wait-ms 300000]
```

動作:

1. まず全 permission を probe し、**既に granted のものは request しない**。
2. 未許可のものだけ OS の request を上げる — Screen Recording は
   `CGRequestScreenCaptureAccess`（System Settings がその desktop に開く）、
   Accessibility と Automation→System Events は検証済みの
   `ax-grant.command` helper が dialog を出す。
3. dialog が出る **desktop（どのユーザーの画面か）を request 前に
   stderr へ表示**する。helper user の desktop へは fast user switching
   で移る — logout はしない。
4. 2 秒ごとに再 probe し、全て granted か `--wait-ms` 経過まで待つ。

出力 JSON の `permissions.*.state` は `granted | denied | unproven`、
`pending` に残ったもの、`requests` に実際に上げた request が入る。
`aeScriptFileNetwork` と Adobe sign-in は AE の UI 内の人間手順なので
request せず、instruction だけを報告する。このループは dialog を
押さず、TCC.db を書かず、credential を保存しない。
`setup` の `macos.screen-recording` / `macos.accessibility` /
`macos.automation-system-events` step の action がこの手順を指す。

## 4.6. 残った状態の検査と掃除（status / prune）

中断した run や死んだ agent が共有ディレクトリ（既定
`/Users/Shared/ae-a8n`）に残したものは、run を起こさずに検査できる。

```bash
node scripts/isolated-session/run-in-isolated-session.mjs status \
  --user ae-test [--root /Users/Shared/ae-a8n] [--json]
node scripts/isolated-session/run-in-isolated-session.mjs prune \
  --user ae-test [--dry-run]
```

`status` が報告するもの:

- 対象セッション（uid / asid / kind）と console の持ち主。不明は
  「未ログイン」ではなく「ここからは確認できない」として出る。
- 実行中の After Effects と session-agent プロセス。agent の banner
  （`results/agent.json`）は起動の証拠であり、生存の証明ではない —
  生死はプロセス一覧側で判断する。
- jobs/ の各エントリの状態: `pending`（agent がまだ取れる）、
  `stale`（deadline 経過または deadline 無しで二度と実行されない）、
  `cancelled`、`finished`（result あり・未回収）、`malformed`、
  `untrusted`（所有・mode が信用できない）、`unknown`（job を発行して
  よい account が不明）。
- findings: `job-stale`、`job-pending-no-agent`、`result-orphaned`、
  `ae-already-running` など、操作者が対処すべき項目。

`prune` が消せるのは「この account が所有し、かつ二度と仕事を生まない
か消費しない」ものだけ: 中断した publish の `.tmp`、stale/cancelled
な job とその cancel token、job を失った cancel token、stale な
result `.tmp`。実行中かもしれない fresh な `.tmp`、pending/malformed/
finished/untrusted な job、result・log・banner は**絶対に消さない**。
プロセスの kill、ユーザーデータの削除、timeout job の再送もしない。
`--dry-run` で対象だけ確認できる。他人が所有するファイルは報告だけで
触らない。

## 5. resume の考え方

- `setup` は冪等。人間の操作を挟んで止まっても、同じコマンドを再実行
  すれば済んだ分は `skipped` になる。
- `doctor` は常に read-only。`setup`/`test` が拒否したときの一次確認は
  必ず `doctor` から。
- `recover` は中断した run の状態を検査し、解放できるものだけを解放する。
  動いている AE を force kill したり、ユーザーのデータを消したりはしない。

## 6. やってはいけないこと（ツールも人間も）

- helper user のパスワードや Adobe 資格情報をスクリプト・設定・ログに
  書かない。
- `TCC.db` の直接編集、SIP の変更、無関係な TCC grant の reset。
- console（操作者自身）のセッションで helper user 向けの job を実行する
  — それは隔離ではなく、拒否される。
