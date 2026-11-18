# トラブルシューティング — 隔離セッション (#62, T074)

`ae-a8n doctor / setup / test / recover` が拒否・停止したときの判断木。
まず `doctor`（read-only）で現状を確認し、`checks[]` の `code` で以下の
枝に降りる。コードの意味は `specs/isolated-ae/contracts/cli.md` §5、
許可まわりは `specs/isolated-ae/contracts/permissions.md`。

## 判断木

```text
doctor が blocker を出した
├─ A8N-ENV-*        → 環境（OS/Node/AE の有無）。マシン側の問題。docs/quickstart.md
├─ A8N-SESSION-001  → --user のアカウントが存在しない。ユーザーを作るか名前を確認
├─ A8N-SESSION-002  → 対象ユーザーが GUI ログインしていない
│                     → fast user switching で一度ログイン。logout しない
├─ A8N-SESSION-003  → 対象が console session
│                     → console で動かしたいなら local intent（引数なし doctor）
│                     → 隔離したいなら別 --user を指定
├─ A8N-SESSION-004  → 実行中に uid/ASID/console owner が変わった
│                     → 対象ユーザーの再ログイン・uid 再利用を疑う。job をやり直す
├─ A8N-PERM-001/002 → 画面収録/アクセシビリティ未許可
│                     → 対象ユーザーの画面で System Settings から許可 → doctor
├─ A8N-PERM-003/007/008 → AE のスクリプト/ファイル/ネットワーク許可 or 承認未証明
│                     → AE 設定でフォルダ許可。-1708 モーダルは人間が解消
├─ A8N-PERM-004    → Adobe サインインが必要
│                     → 対象ユーザーの AE でサインイン（資格情報は保存されない）
└─ A8N-PERM-005/006 → channel key/dir が他アカウントから読める/書ける
                      → パーミッションを絞る。自動修正はしない
```

## 症状別の早見表

| 症状 | まず疑う | 確認 | 直し方 |
| --- | --- | --- | --- |
| setup が途中で止まる | needs-human ステップで人間待ち | 表示された desktop/画面 | fast user switching で対象ユーザーへ。終わったら setup 再実行（冪等） |
| `-1743` がプロンプト無しで続く | Automation 拒否が記憶済み、または responsible process が bundle 無し | 実行主体が Terminal.app の子か | `tccutil reset AppleEvents <bundle-id>` を対象ユーザー側で → 再プロンプト |
| `-1712` timeout | AE のモーダル/サインイン/Welcome | 対象ユーザーの画面 | 人間がモーダルを解消。**権限問題ではない・自動再送しない** |
| `-1708` | AE スクリプト信頼の未承認 | AE 設定 → スクリプトとエクスプレッション | driver の読むフォルダを許可 |
| OS アップデート後に全部拒否 | TCC grant の無効化・AE バージョン変更 | doctor 全項目 | permissions.md のマトリクスに沿って再許可。版差は verification.md |
| ユーザーが logout した | GUI セッション消失 | `A8N-SESSION-002` | 再ログイン。実行中 job は stale になるのでやり直し |
| AE のモーダルで test が hang | 対象 session の modal | `ae-a8n recover` / doctor | 人間が対象画面で解消。timeout script は再送されない（UNKNOWN） |
| doctor は通るが test が失敗 | session 分離ではなくコマンド側 | run の report.json | `ae-a8n report --run <id>` で結果を読む |
| stale job / orphan helper が残る | 中断した run | `ae-a8n recover --run <id>`（まず `--dry-run`） | recover が解放できるものだけ解放。unowned AE は kill しない |

## 原則

- **doctor は read-only**。変更が要るときは `setup`。診断だけなら
  doctor を繰り返す。
- **再送しない**。timeout/UNKNOWN の job を手動で二度送らない —
  成功したか分からない実行を重ねるのが一番危ない。
- **console に逃げない**。物理デスクトップでの実行は隔離の否定。
  別ユーザーの画面にプロンプトが出たら、そこへ行くのが正しい対処。
