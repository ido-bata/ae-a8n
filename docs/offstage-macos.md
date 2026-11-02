# macOS: offstage による別ユーザーGUIテスト（試験導入 / #49）

**状態：設計検証段階。macOS実機でのAe / Apple Events / フォーカス分離は未検証。**
通常の `AfterEffects.launch()` は変えていない。Windowsには適用しない。以下のランナーも、自動導入・デフォルト実行にはしない。

## なぜ必要か

`ae-a8n` がAeのExtendScript APIを通して操作できないモーダルダイアログ（プラグイン・Adobe認証・復旧・権限など）が出ると、呼び出しがタイムアウトする。エージェントが普段のmacOSユーザーに対して直接クリックやキー入力を始めると、カーソル・フォーカスを奪う。

試験対象の `@viraatdas/offstage` は **別OSユーザーのバックグラウンドAqua GUIセッション**でテストを実行する方式であり、単なるSpace/仮想ディスプレイとは異なる。

- offstage npm: https://www.npmjs.com/package/@viraatdas/offstage
- upstream GitHub: https://github.com/viraatdas/offstage （2026-11-02時点、直接取得は404。リポジトリと配布物の監査が完了するまでセットアップを自動化しない）
- 詳細要件と受入: https://github.com/ido-bata/ae-a8n/issues/49

## ライセンス上の前提

Adobe公式 https://helpx.adobe.com/download-install/apps/troubleshoot/login-issues/login-required-for-separate-os-accounts-same-computer.html は、同じマシンの別OSユーザーでのAdobe ID利用は**追加のデバイスアクティベーションにカウントされない**と明記。ただし**同時利用は1 OSユーザーだけ**。初回サインインはユーザーごとに必要。

通常ユーザーのAeとバックグラウンドユーザーのAeを同時に使わない。別ユーザーの認証画面が出ても、別デバイスのログアウトは絶対に自動選択しない。サインイン情報を設定ファイル・証跡に保存しない。

## 試験用ランナー

macOS Apple Silicon上でのみ（Node.js 22+）:

```sh
# offstageの安全性・配布元確認と、OSユーザー/権限の手動セットアップを済ませる。
# 以下は例。<test>はヘルパーが読み取れる絶対パスにする。
node scripts/offstage-ae-run.mjs -- node /absolute/path/to/ae-test.mjs
```

ランナーの役割は限定的:
1. `computeruse` のUIDと `/dev/console` のUIDを比較し、別ユーザーを要求する。
2. `ps` から見えるAE本体が**全OSユーザーで0件**でなければ拒否（バージョンを問わない）。既存Aeを強制終了しない。
3. マシン共有の `/tmp/ae-a8n-offstage.lock` を取得。残存lockを無条件に消さず、人間に確認してもらう。
4. `offstage run --lane session -- node ... --helper ...` でセッションlaneを**明示**する。offstage失敗時に元ユーザーで再実行しない。
5. ヘルパー側でもUID・コンソール・既存Aeを再検査してから、与えられたテストコマンドをshellを介さず実行する。

ランナーは **offstageのインストール、sudo、OSユーザー作成、TCC.dbの編集、Creative Cloudへのサインインを行わない**。オフラインCIでの検証は `node --test test/offstage-run.check.mjs`。

### 限界（本番利用前に解消必須）

- **既存macOSトランスポートのプロセス探索とApple Events宛先はセッション単位の安全性を証明していない。** メインユーザーが途中でAeを起動する競合や、同じbundle pathへのApple Events配送先を実機で確かめるまで、運用可能と見なさない。入口の二重検査は十分条件ではない。
- `offstage` 自体のセッション・GUI操作の正確性、TCC設定の安全性、Adobe CCログインの状態は未検証。特にoffstageがTCC DBの直接編集を要求する場合、監査・承認なしに実行しない。
- helperユーザーは別UIDでも同じMac/共有ディスク・GPUを使用する。VM並みのセキュリティ分離ではない。
- ヘルパーからテストコードとfixtureを読める必要がある。offstageの `session share` はread-onlyのため、テストの書き込みはヘルパー専用の作業ディレクトリや一時ディレクトリに分離する。
- 現在はダイアログ自動検出/クリックを追加していない。テスト失敗を一般的なOS入力操作にフォールバックさせないこと。

## 実機受入ゲート（順に、証拠を残す）

1. offstage配布物・依存・実行コード・必要なmacOS権限を監査。初期セットアップは人間が確認し実行。
2. helperアカウントのAquaセッション、`offstage session screenshot` と `offstage session input` が**物理画面に届かない**と実測。
3. Adobe IDでhelperに初回サインイン（人間が実行）。通常ユーザーのAeを終了してからテストを開始。ライセンス上限が出たら停止。
4. helper上のAeで、`AfterEffects.launch`/readiness/`ownership()`/JSX IPC/`close` を確認。**PID+UID+GUIセッションの対応とApple Eventsの実際の到達先を検証**。異常時は送信拒否できるようにしたうえでテストを続ける。
5. モーダルを開く→helper専用の画面取得→helperセッションだけにクリック/Escape→Aeの応答復帰を検証。通常ユーザーで連続文字入力・カーソル移動をしながら干渉0を記録。
6. セッション切断・Ae固着・helperユーザーのコンソール切替・ライセンスダイアログ発生のいずれでも**メインデスクトップへのクリック/osascript再送/強制終了なし**を確認。
7. 既存のWindows/macOSユニットテスト・消費側 `ae-test` とAeプラグインE2Eの回帰を確認。

このゲートを通す前はDraft PRのまま。失敗を隠して「対応済み」とは書かない。
