# macOS: 別OSユーザーのセッションで隔離実行する（#49）

**状態: 実装済み・実機受入は未完了（人間の手順待ち）。**
通常の `AfterEffects.launch()` は変えていない。隔離はオプトイン。Windowsには適用しない。

到達した検証レベル:

| 項目 | 状態 |
| --- | --- |
| offstage の配布物・CLIの監査と実行確認 | `verified on real host`（2026-11-02 このMacで実測） |
| 別ユーザーのAquaセッションの生成・操作 | `UNVERIFIED`（別ユーザーのログイン待ち。loginwindow / 高速ユーザー切替は人間の手順） |
| 隔離セッションでのAe起動 | `UNVERIFIED` |
| Apple Events の配送先が対象ユーザーのAeであることの実測 | `UNVERIFIED` |
| GUIフォールバックによるダイアログクローズ | `fake/mock only`（実機のネイティブダイアログで AX 動作は確認済み。Aeのダイアログは未確認） |
| フォーカスの通常ユーザーへの干渉 0 | `UNVERIFIED`（計測器は用意済み。隔離セッションの実行待ち） |

「fake/mock only」を「動作する」とは書かない。上の表のとおり、未検証は未検証と書く。

## 1. offstage の調査（実測）

### 配布物の実体

- 当初 Issue に書かれた `@viraatdas/offstage` は **npm で404**（2026-10-31 に unpublishedPapier、tombstone のみ）。GitHub `viraatdas/offstage` も404。取得できる配布物は無い。
- 同じプロジェクトが **`@exla/offstage`** として再配布されている（npm latest 0.4.1、published 2026-10-31、maintainer は viraatdas、MIT、repo は `exla-ai/offstage`）。以下はすべてこの現行版の話。
- 参照: <https://www.npmjs.com/package/@exla/offstage>

監査で確認したこと（`npm pack` して展開し、`dist/` を読む）:

- 依存は `zod, execa, plist, commander, fast-xml-parser, @modelcontextprotocol/sdk` のみ。`preinstall` / `postinstall` は**無い**（インストール時に勝手に動くスクリプトは無い）。
- bin は `offstage` と `offstage-mcp`。CLIは `doctor / route / run / probe / welcome / session / fleet`。
- macOS 26/27 を対象に、`swiftc` で `offstage-sessiond`（Swift製デーモン）をビルドして、ヘルパーアカウントの `LaunchAgents/dev.offstage.sessiond.plist` として入れる。`LimitLoadToSessionType = Aqua`、`launchctl bootstrap gui/<uid>`。
- デーモンのソケットは `~/.offstage-run/<uid>.sock`（0660、`getpeereid` で接続元のuidを照合）。**ヘルパー同士で互いのセッションを操作できない**。
- `.pkg` / `.dmg` / `hdiutil` は拒否する（機械を変更する操作はしない）。

### TCCデータベースとSIP（.taskの明示的な確認項目）

- offstage が **TCC.db を直接書くのは `offstage session setup` のときだけ**。書き込みのは Screen Recording と Accessibility の2行（デーモンの `csreq` を添えた `INSERT OR REPLACE`）。
- その pre-seed は **SIP の filesystem protection が off のときだけ**実行される（`preseed = csreq.hex !== undefined && sip !== 'on'`）。SIP が on なら pre-seed はスキップされ、`csrutil status` を読むだけになる。
- **SIP を無効化するコードは無い**（`csrutil disable` は何处にも無い。読むのは `csrutil status` だけ）。
- したがって **SIP を切り、TCC.db を手で触る必要は無い**。既定の経路は、ヘルパーセッション内で人間|System Settings が2回承認する（Screen Recording と Accessibility）だけ。
- **このリポジトリの自動処理は TCC.db に一切書き込まない。SIPも変更しない。** 承認は人間が行う（§8）。

TCC は**実行するユーザーごと・バイナリごと**の記録である。ヘルパーセッションの中で走るテストが `osascript` を使う場合、Accessibility の承認は**ヘルパー側のユーザーに対して**必要になる（コンソール側のユーザーでの承認では足りない）。

### 現在のCLI（既存ランナーが記録していた呼び方の検証）

旧ランナーが記録していた `offstage run --lane session -- <command>` は**現行版でも有効**。実測（2026-11-02, `@exla/offstage@0.4.1`）:

```
$ offstage run --help
Usage: offstage run [options] <command...>
Options:
  --cwd <dir>     repository root to run against (default: current directory)
  --lane <lane>   force a lane (headless | session | container)
  --timeout <ms>  wall-clock budget in milliseconds
  --headed        ask for a headed run; goes to the container lane, never your screen
  --user <name>   helper account for the session lane (default: the configured one)
  --json          emit the LaneResult envelope as JSON
```

```
$ offstage session status
✗ session lane unavailable: account "computeruse"
  fix: offstage session setup --user computeruse --create
exit=69

$ offstage run --lane session -- /bin/echo hello
→ session lane (forced; the router chose headless)
SKIPPED  session lane  0ms  exit none
  the substrate was unavailable, so nothing ran anywhere
  - Lane "session" is unavailable, so nothing was executed. offstage does not
    fall back to your real screen.
exit=69
```

**これが本研究で確認した最も重要な事実: offstage は substrate が無ければ *どこにも* 実行しない。コンソールセッションへのフォールバックは無い。** exit 69 は「どこにも実行されなかった」ことを意味する。

`offstage session` には、対象セッションの枠内で完結する操作がある: `screenshot` / `input` / `click` / `type` / `key` / `apps` / `launch` / `open` / `quit` / `gather` / `share` / `status`。入力は `CGEvent.post(tap: .cgSessionEventTap)` で、**自分のセッションがコンソールセッション（`kCGSSessionOnConsoleKey`）なら注入を拒否する**。

### MCP

`offstage-mcp` は `offstage_doctor / _route / _run / _probe / offstage_session_status / _launch / _screenshot / _input / _apps / _quit / _gather`（+ read-only な fleet 系）を公開する。`offstage_session_status` の説明は「setup は `sudo` と端末を必要とするので、**人間が実行する**もの」と明記している。**MCPには「sudo 実行」「TCC書き込み」「アカウント作成」を行うツールが無い。** 人間の手順として扱う。

## 2. 隔離の設計

### 2.1 offstage を使う経路（既定）

```
┌ コンソールセッション（いつものユーザー）        ┌ ヘルパーセッション（別ユーザー）
│  run-in-isolated-session.mjs                  │  offstage-sessiond (LaunchAgent, Aqua)
│    └ offstage run --lane session --user test  │    └ ソケット ~/.offstage-run/<uid>.sock
│         └ ジョブを書く / 結果を読む            │    └ ここでコマンドが起動する
```

- 起動されるAe・送られるApple Events・撮られる画面・入力されるキーとクリックは、すべて**ヘルパーセッション**の中で起きる。
- コンソールセッションには何も届かない。

### 2.2 ネイティブ経路（グローバルインストールを使わない fallback）

`scripts/isolated-session/session-agent.mjs` を**ヘルパーセッションの中で**起動し、`dispatch.mjs` がジョブファイルを書いて結果を読む。グローバルインストール 없이動く fallback であり、GUI操作（screenshot / click / key）は持たない。

### 2.3 どちらの経路でも守られること

`scripts/isolated-session/session-rules.mjs`（副作用なし・ユニットテスト済み）:

- 対象ユーザーが GUIセッションを持っていない / Aqua でない / コンソールを所有している → **拒否**。
- どのユーザーのAeでも起動している → **拒否**（Adobeの「同時に使えるのは1 OSユーザー」制約）。**プロセスを強制終了しない。**
- 結果が「依頼したセッション」を名乗っていない → **信頼しない**。

## 3. Adobe のライセンス方針

Adobe公式（別OSアカウント × 同一PC）: 追加のデバイスアクティベーションには**カウントされない**が、**同時に使えるのは1 OSユーザーだけ**。初回サインインはユーザーごと。

したがって:

- 通常ユーザーとテストユーザーで **Aeを同時に使わない**。ランナーはAeがどこかで動いていると拒否する。
- 別デバイスの**自動ログアウトは絶対に選ばない**。`RECOVERY_BUTTONS` に `Deactivate` / `Sign Out` は無く、署名・ライセンス系のウィンドウは**一切押さない**（`isHumanOnlyWindow`）。
- サインイン情報・パスワード・トークンはログにもリポジトリにも残さない。`ae-e2e.mjs` のレポートにも入らない。
- ライセンス上限やサインイン要求が出たら停止し、**人間が判断する**。

## 4. ae-a8n のセッションスコープ（ライブラリ側の変更）

`src/driver/mac-session.ts`（新規）:

- `launchctl print gui/<uid>` から `asid` と `session`（Aqua / Background / …）を読む。
- `lsappinfo list` から各アプリの `pid` / `uid` / `asid` を読む（セッションIDの同定）。
- `runInSession` / `spawnInSession`: 自分のセッションなら直接実行、別セッションなら `launchctl asuser`（root 時のみ）。**宛先のセッションが不明でuidが違う場合は送らない**（"Nothing was sent."）。
- `isInsideSession`: uid と asid の**両方**が一致しない对方的セッションはForeign。

`src/driver/script-invocation.ts`:

- プロセス一覧を `ps -axo pid=,uid=,lstart=,comm=` で取り、**uid で絞り込む**。
- macOS でも `verifiesDestination` を true に（セッションマーカーで「応答したインスタンス」が自分のprobeの物だと証明できる）。
- `osascript` の DoScriptFile は**対象セッションの中で**実行する。宛先不明なら拒否。

`src/driver/gui-recovery.ts`（新規）と `src/driver/recovery.ts`（新規）:

- Accessibility を先に、座標は**対象セッションのAXフレーム**から得る。対象セッションの画面情報はAX（そのセッション内で取得）であり、物理ディスプレイではない。
- 押せるボタンは `OK / Cancel / Close / Dismiss` のみ。押せない時は**報告だけ**。
- **コンソールセッション（人間が画面を見ているセッション）では GUI 動作を一切しない**（`MacGuiRecovery` が例外で拒否）。隔離セッションでしか復旧しない。
- スクリーンショットは対象セッションの中で `screencapture -x -o` で撮る。

`src/driver/driver.ts`:

- タイムアウト後、復旧しても**元のリクエストは送り直さない**。そのリクエストの結果を待つ（`recoveryGraceMs`）。送り返すとレンダーや書き出しが二重に走る。

## 5. 失敗時の安全性

| 事象 | 挙動 |
| --- | --- |
| 隔離セッションが切れる | ジョブは結果を持たない。ランナーは「どこにも実行されなかった」と報告して終了 |
| Aeが固まる | タイムアウト。復旧の試しは dialog に対してのみ。元の操作は送らない |
| ExtendScript が応答しない | タイムアウト → GUIフォールバック → それでもだめなら TimeoutError |
| 閉じられないダイアログ | Escape を試す。駄目なら報告して諦める。**通常ユーザーのデスクトップでは何もしない** |
| 権限不足 | AX / screencapture が失敗したら記録して中断。**TCC.db は触らない** |
| Adobe 認証要求 | 検出したら**一切押さない**。人間に委ねる |
| 他ユーザーのAeと競合 | 事前チェックで拒否（複数起動も拒否） |
| 所有者が不明 | fail closed。触らない |

## 6. 実機受入ゲート（順に、証拠を残す）

1.  humans: `npm i -g @exla/offstage` → `offstage session setup --user test`（sudo・要端末・**人間が実行**）→ 高速ユーザー切替で `test` でログイン → ヘルパーセッション内で Screen Recording と Accessibility を承認 → Adobe ID のサインイン（**人間が実行**）。
2. `offstage session status` が「available」になること。`offstage session apps` でヘルパーのセッションにプロセスが見えること。
3. `offstage session screenshot` が**ヘルパーの画面**を撮ること（コンソール画面でないこと）。
4. 隔離セッションで `AfterEffects.launch()` → version / ownership / 描画 / close まで通ること。`ownership()` の証拠に**別ユーザーのセッション**が含まれること。
5. モーダル → 対象セッションのスクリーンショット → 対象セッション内のボタン押下 → Aeの応答復帰 → 元の呼び出しが二重実行されていないこと。
6. コンソール側で `focus-watch.swift` を回し imposition 中の**通常ユーザーのフォーカスカーネル・カーソル位置・入力の不存在**を記録。干渉が1回でも出たら、再現テストと修正を入れる。
7. セッション切断 / 固着 / 権限不足 / 認証要求のいずれでも、**コンソールへのクリック・osascript再送・強制終了がない**こと。

ゲートを通る前はDraft PRのまま。失敗を隠して「対応済み」とは書かない。

## 8. 人間が実行すること（この Mac で必要な手順）

このMacの現在地: `test` (uid 502) のアカウントは存在するが **GUIにログインしていない**（`launchctl print gui/502` → `Could not find domain for user gui: 502`）。よって隔離セッションは存在せず、このリポジトリの自動処理では作れない（`launchctl asuser 502` も root 必須で "Operation not permitted"）。

1. `npm i -g @exla/offstage`
2. 端末で `offstage session setup --user test`（パスワード入力。**root スコープのスクリプトが事前に全文表示される**。TCC pre-seed は SIP が on なのでスキップされる）。`--create` は既存の `test` アカウントがあるので付けない。
3. 高速ユーザー切替で `test` ユーザーとしてログインする（Setup Assistant が出たら進める）。ログイン後、コンソールに戻る。
4. `test` セッションの中で、Screen Recording と Accessibility の承認ダイアログが **2回** 出るので許可する（対象は `offstage-sessiond`）。出ない場合は `offstage session status` を見て不足している方を許可する。
5. `test` ユーザーで Adobe にサインインする（**人間が**。通常ユーザーでAeを使っていない時に行う）。
6. `offstage session share --user test /Users/rebui/work/ae-a8n`（ヘルパーがリポジトリを読めるようにする。`~` は 0750 で、共有しないと読めない）。

その後、`scripts/isolated-session/ae-e2e.mjs` を隔離セッションで走らせる:

```sh
node scripts/isolated-session/run-in-isolated-session.mjs \
  --user test \
  --report /Users/Shared/ae-a8n/e2e-report.json \
  -- node /Users/rebui/work/ae-a8n/scripts/isolated-session/ae-e2e.mjs \
       --pkg /Users/Shared/ae-a8n/pkg \
       --report /Users/Shared/ae-a8n/e2e-report.json
```

## 9. 既知の限界

- セッション分離であって**機械分離ではない**。同じカーネル・同じディスク・同じGPU。VM相当のセキュリティ境界ではない。
- ヘルパーは `0750` の `~` の外側にある。テストコードと fixture は `offstage session share` で読ませる必要がある。
- AX は Ae の**メインウィンドウ**を返さない（実測: Aeは AX 上で 0 windows。`CGWindowList` には出ている）。そのため GUI フォールバックは Ae 本体ではなく**ネイティブダイアログ**を対象にする。
- Escape キーではネイティブダイアログが閉じない（実測）。AX のボタン押下が現実的な経路。
- 現在 Ae の**標準ダイアログ**（ライセンス・警告等）を実機で開いて閉じられるかどうかは未検証。
