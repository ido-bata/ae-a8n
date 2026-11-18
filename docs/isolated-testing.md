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
