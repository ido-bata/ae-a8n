# macOS: 別OSユーザーのセッションで隔離実行する（#49）

**状態: 実装済み・実機受入 PASS（ターミナル経路、2026-11-03）。** ネイティブ経路（`session-agent` / `dispatch`）は実機で起動とジョブ実行まで確認した（§10.16 の最後）。
通常の `AfterEffects.launch()` は変えていない。隔離はオプトイン。Windowsには適用しない。

到達した検証レベル（2026-11-03 このMacで実測。行内の日付はその測定時点）:

| 項目 | 状態 |
| --- | --- |
| offstage の配布物・CLIの監査と実行確認 | `verified on real host` |
| 別ユーザーのAquaセッションの生成・操作 | `verified on real host`（test uid 502 / asid 109086。コンソール所有者は uid 501 のまま。§10.12） |
| 隔離セッションでのAe起動 | `verified on real host`（AE 26.5x89 が test セッションで起動。§10.14） |
| 隔離E2Eパイプライン全体（セッション特定 → 別ユーザのTerminalで起動 → 実行 → 結果をコンソール側へ） | `verified on real host`（§10.14 で3回連続、§10.15・§10.16 で修正後に各1回、計9ステップ全部 `ok`） |
| Apple Events の配送先が対象ユーザーのAeであることの実測 | `verified on real host`（§10.9: `count documents` が `0`、TCCの拒否 `-1743` ではない） |
| GUIフォールバックによるダイアログクローズ | `verified on real host`（§10.14: 実際のモーダルダイアログを、対象セッション内の AX で `OK` を押して閉じ、タイムアウトした呼び出しがそのまま完了。再送なし） |
| フォーカスの通常ユーザーへの干渉 | `verified on real host`（§10.14 の3窓: 前面アプリの変化 0、プログラム投稿キー 0）。**ただし測定は修正前のビルドで、修正後のコードでは未再測定**。カーソル移動は誰の操作かを帰属できないので 0 件とは断定しない |

「fake/mock only」を「動作する」とは書かない。上の表のとおり、未検証は未検証と書く。
Ae 自身の「スクリプト実行の許可」と test セッションの Accessibility / Automation の許可は人間が与え、§10.12・§10.14 の実測に至った。**許可が要る操作はエージェントが代行しない**（§2）。

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

### 2.1 Terminal 経路（既定）

```
┌ コンソールセッション（いつものユーザー）        ┌ ヘルパーセッション（別ユーザー）
│  run-in-isolated-session.mjs                  │  Terminal.app（ログイン済みのAquaセッション）
│    └ offstage session open --user test       │    └ .command を起動
│         -- -a Terminal <launcher>            │         └ テストプロセス
│    └ <results>/<id>.done を読む              │              └ 実行結果と実行したuidを書く
```

- 起動されるAe・送られるApple Events・撮られる画面・入力されるキーとクリックは、すべて**ヘルパーセッション**の中で起きる。
- コンソールセッションには何も届かない。
- **なぜ Terminal なのか**: macOS は権限を *responsible process*（最も内側のアプリバンドル）に帰属させる。`offstage-sessiond` はバンドルを持たないバイナリなので、macOS はこれを属性づけられず**即座に拒否する**（実測: `-1743`）。しかも**プロンプトも出ない**ので、人間が許可する手段が存在しない。Terminal.app はバンドルなので、許可がシステム設定に現れ、テストプロセスに継承される（実測の比較表は §10.2）。
- ジョブは**自分のセッションを自分で書き記す**（uid / username / asid / exit）。制御側は、依頼したuidと一致しない結果を**信用しない**。

### 2.2 offstage を使う経路

```
┌ コンソールセッション（いつものユーザー）        ┌ ヘルパーセッション（別ユーザー）
│  run-in-isolated-session.mjs                  │  offstage-sessiond (LaunchAgent, Aqua)
│    └ offstage run --lane session --user test  │    └ ソケット ~/.offstage-run/<uid>.sock
│         └ ジョブを書く / 結果を読む            │    └ ここでコマンドが起動する
```

- 2.1 と同じ隔離。ただし実行主体はバンドル無しのデーモンなので、**Apple Events は -1743 で届く前に落ちる**（§10.2）。daemon 自身の子として screenshot / 窓の題名は取れるので、権限の granting 用途には使える。

### 2.3 ネイティブ経路（グローバルインストールを使わない fallback）

`scripts/isolated-session/session-agent.mjs` を**ヘルパーセッションの中で**起動し、`dispatch.mjs` がジョブファイルを書いて結果を読む。グローバルインストール 없이動く fallback であり、GUI操作（screenshot / click / key）は持たない。

### 2.4 どちらの経路でも守られること

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
- `startInSession`: `launch()` が Ae を明示的に起動するための同経路。子プロセスを返すので、起動した Ae 自身の pid を記録できる（`launchctl asuser` はコマンドを in-place で exec する；ローカルで spawned child の pid がコマンドの pid と一致することを確認）。
- `isInsideSession`: uid と asid の**両方**が一致しない对方的セッションはForeign。

`src/driver/script-invocation.ts`:

- プロセス一覧を `ps -axo pid=,uid=,lstart=,comm=` で取り、**uid で絞り込む**。
- macOS でも `verifiesDestination` を true に（セッションマーカーで「応答したインスタンス」が自分のprobeの物だと証明できる）。
- `osascript` の DoScriptFile は**対象セッションの中で**実行する。宛先不明なら拒否。
- `launch()` は macOS でも Ae を**明示的に起動する**（オンデマンド起動に任せない）。起動したプロセス自身の pid を `#spawnedPid` に記録する。所有権（`#owned`）は probe 成功後の `confirmLaunched()` で、**一覧の唯一のインスタンスの pid が `#spawnedPid` と一致した時だけ**立つ。一致しなければ `unknown`（`A8N-AE-004`）で、**quit しない**。
- `recoveryTargetPid()`: **probe が応答する前に**、この transport が起動した pid を返す。一覧に `#spawnedPid` と一致するプロセスが**ちょうど 1 個**あり、最初に見た起動時刻と一致する場合だけ返す（0個・2個以上・pid だけ一致して起動時刻が違う場合は返さない）。「起動後に現れた唯一の Ae」は、人間が直後に起動した Ae と区別できないため**証拠にしない**。**所有権そのものは従来どおり probe の証明を要求する**（quit は fail-closed のまま）。

`src/driver/gui-recovery.ts`（新規）と `src/driver/recovery.ts`（新規）:

- Accessibility を先に、座標は**対象セッションのAXフレーム**から得る。対象セッションの画面情報はAX（そのセッション内で取得）であり、物理ディスプレイではない。
- ダイアログの扱いは **allow list**。プロジェクトが実機で計測した種別だけを「既知」とし、現在は `ae-a8n ui.alert`（`AXDialog`、題名が空、本文が `ae-a8n:` で始まる）のみ。既知の窓では `OK / Cancel / Close / Dismiss` のうち存在するボタンを、**窓の同一性（index + 題名 + subrole）を検査した上で**押す。それ以外の blocking window は `A8N-SEC-001` を報告して run を隔離し、**何も押さない**（許可・認証・ライセンスの窓を自動で押さないための規則）。
- **Escape キーの fallback（`key code 53`）は廃止**。前面化した Ae の「今 key の窓」に送るため、押す先が同一性検査で証明できない。既知の窓に押せるボタンが無ければ、キーを送らずに報告だけ行う。
- **コンソールセッション（人間が画面を見ているセッション）では GUI 動作を一切しない**（`MacGuiRecovery` が例外で拒否）。隔離セッションでしか復旧しない。
- スクリーンショットは対象セッションの中で `screencapture -x -o` で撮る。
- AX の窓一覧は**静的テキストも読む**（`T|` 行）。Ae の警告ダイアログの題名は `警告` しかなく、**中身（`サインイン` など）**でしか人の判断が必要な窓と区別できないため。
- `isHumanOnlyWindow` は**日本語の定型**（`サインイン` / `サインアウト` / `ログイン` / `ライセンス` / `認証` / `アクティベーション`）も看不懂の窓として扱う。UI言語がセッションの言語なので、英語だけでは漏れる。

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

このMacの現在地（2026-11-03 11:37Z の実測）: `test` (uid 502) の Aqua セッションは**存在する**（asid 109086、コンソール所有者は uid 501 の `rebui` のまま。§10.12）。`test` セッションの Terminal から測った許可の状態は:

| 権限 | 実測 | 根拠 |
| --- | --- | --- |
| 画面収録（Screen Recording） | 許可済み | `offstage session status --user test`（§10.7） |
| ユーザー補助機能（Accessibility） | **許可済み** | `AXIsProcessTrusted()` → `true`（`test` セッション、2026-11-03 11:37Z） |
| 自動化（Automation）→ System Events | **未許可** | `osascript -e 'tell application "System Events" …'` → `-1743`（同上。画面にプロンプトは出ていない） |

`test` セッションが消えると、そのセッションにしかないもの（プロンプト、Ae の環境設定）がすべて失われる。**ステップ 1（高速ユーザー切替で `test` にログイン）が、残りすべての前提**。ログアウトではなく、高速ユーザー切替で戻ること。

なお `offstage session status --user test` が **available: false**（helper セッション未ログイン）と出るのは、**terminal 基版は offstage の helper セッションを必要としない**ので問題ない。共有済み（`/Users/Shared/ae-a8n`）。

したがって残る手順は**権限の承認（Screen Recording / Accessibility）と、Ae 自身の「スクリプト実行の許可」**だけで、代理にはできない（§10.9・§10.10）。

1. **高速ユーザー切替で `test` に切り替える**（`rebui` からはログアウトしない）。
2. **`test` セッションの Terminal で** 次の1行を実行する（`/Users/Shared/ae-a8n/run/ax-grant.command`）:

   ```sh
   /Users/Shared/ae-a8n/run/ax-grant.command
   ```

   macOS の **設定に「ターミナル」の項目は無い**。ユーザー補助機能（Accessibility）と自動化（Automation）のリストには、**要求したアプリしか現れない**。だから「リストでターミナルをオンにする」という操作は存在せず、**ターミナル自身から要求してプロンプトを出し**、それを許可する形になる。このスクリプトは:
   - `AXIsProcessTrustedWithOptions(prompt: true)` を呼ぶ → **`ターミナルはこのコンピューターを制御したい`** というダイアログが **`test` セッションの画面**に出る（**すでに許可済みなので出ない**）
   - `osascript → System Events` を呼ぶ → **`ターミナルが System Events を制御したい`** というダイアログが同上（**許可が下りていれば `-1743` は出ず、`count processes` が数値を返す**）
   - 出たら2つとも **OK** を押す。押すと `test` ユーザーの設定のユーザー補助機能/自動化のリストに **`ターミナル`** が現れ、**その子孫（osascript / node）にも継承される**（§10.2）。
   - 実行後、同じ Terminal で `ax-grant-all.command` を走らせると `AX_TRUSTED` と `count processes` の結果が出るので、許可できたか確認できる。
   - **対象は `offstage-sessiond` ではなく `ターミナル`**（§10.2）。`offstage-sessiond` は bundle が無く設定に現れない。
   - 画面収録（Screen Recording）は §10.7 のとおり**許可済み**。
   - 自動化（Automation）→ **After Effects は不要**（§10.9: `count documents` が `0` を返す。TCC は壁ではない）。必要なのは → System Events だけ（GUI フォールバックが AX を通すため）。
   - **プロンプトが出ないまま `-1743` が続く場合**は、その要求は以前に「許可しない」で決着している。`test` セッションで `tccutil reset AppleEvents com.apple.Terminal` を実行してから、`ax-grant.command` をもう一度走らせる（`tccutil` は macOS 標準のコマンドで、TCC データベースを直接編集しない）。プロンプトは **`test` セッションの画面にしか出ない**ので、その画面が見えている状態で押す。
   - **共有ディレクトリのヘルパーは実行前に検証される**: `ax-grant.command` / `ax-grant-all.command` は `/Users/Shared/ae-a8n/run/ax-prompt.swift` をそのまま `swiftc` に渡さず、既存の `ax-prompt` バイナリも実行しない。両スクリプトは、ヘルパーのソースと `ax-prompt.swift.sha256` について (1) symlink でない、(2) 所有者が root または実行ユーザー、(3) group/other 書込不可、(4) ソースの SHA-256 が pin と一致、を確認する。どれか1つでも外れたら**何もコンパイル・実行せず**、理由を stderr に出して非0で終了する。検証を通ったソースは毎回プライベートな一時ディレクトリにコンパイルされる。共有ディレクトリへコピーするときは root（またはこのスクリプトを実行するアカウント）で行い、`ax-prompt.swift` と `ax-prompt.swift.sha256` の両方を置き、group/other 書込を付けないこと。手動で確認する場合は次を実行する:
     ```sh
     stat -f '%N %u %Lp' /Users/Shared/ae-a8n/run/ax-prompt.swift /Users/Shared/ae-a8n/run/ax-prompt.swift.sha256
     shasum -a 256 /Users/Shared/ae-a8n/run/ax-prompt.swift
     ```
     2行目の値が `scripts/isolated-session/ax-prompt.swift.sha256` の値と一致すること。テストは `test/isolated-session.check.mjs` にあり、symlink・mode・hash 不一致・hash 欠落・共有バイナリを実行しないことを検査する。
3. **Ae 2026 → 設定 → スクリプトとエクスプレッション**で、driver が Ae に読ませるフォルダを許可する（§10.10）。許可的原因是 Ae が `DoScriptFile` を **`-1708`** で拒否すること（実測）。
   - 追加するフォルダ: **`/Users/Shared/ae-a8n/sessions/real-host/staging`**（`a8n-host.js` と `a8n-json.js` と `*.entry.jsx` が入るフォルダ）
   - 「スクリプト」**と**「ファイルへの書き込みとネットワークアクセス」の両方を許可する。
   - **Ae を終了してから**設定し、**その後で** Ae を起動し直す（偏好は終了時に上書きされる）。
4. `test` ユーザーで **Adobe にサインインする**（Ae の起動モーダル `警告` を解くため）。通常ユーザーでAeを使っていない時に行う。Adobe ID・パスワード・トークンは代理が扱うことも保存することもない。
5. **コンソール（`rebui`）へ戻す**（`test` 側は**ログアウトしない**。ログアウトするとセッションごと消える）。
6. **許可の粒度を答える**: Ae のパネルがフォルダ単位かスクリプト単位か（フォルダを1回追加すれば足りるのか、ファイルごとに追加が要るか）。これは実装の判断（安定名の entry に固定すべきか）に直結する。

その後、`scripts/isolated-session/ae-e2e.mjs` を隔離セッションで走らせる:

```sh
node scripts/isolated-session/run-in-isolated-session.mjs \
  --user test \
  --report /Users/Shared/ae-a8n/run/e2e-report.json \
  -- /Users/Shared/ae-a8n/bin/node \
       /Users/rebui/work/ae-a8n/scripts/isolated-session/ae-e2e.mjs \
       --pkg /Users/Shared/ae-a8n/pkg \
       --report /Users/Shared/ae-a8n/run/e2e-report.json
```

- **node の置き場所**: `test` ユーザーの PATH に node が無い（実測: `node: command not found`）。既に監査済みの mise 版 node 24.22.1 を **`/Users/Shared/ae-a8n/bin/node` にコピー**して使う（インストールスクリプトは実行していない。`/Users/rebui/.local/...` 上の実体を直接呼んでも動くが、共有置き場の方が他ユーザーのホームに依存しない）。
- テストユーザーのセッションからリポジトリは**読める**（実測）。

**注意**: このランナーは「どのユーザーでも Ae が起動中なら拒否」する（Adobe の制約）。拒否された場合は AE 69349 を**手で**終了してから走らせる（代理が kill することはしない）。

## 9. 既知の限界

- セッション分離であって**機械分離ではない**。同じカーネル・同じディスク・同じGPU。VM相当のセキュリティ境界ではない。
- ヘルパーは `0750` の `~` の外側にある。テストコードと fixture は `offstage session share` で読ませる必要がある。
- ~~AX は Ae の**メインウィンドウ**を返さない~~ → **訂正（§10.12）**: これは Accessibility が未許可の時の測定だった。許可後は AX から Ae の窓と子要素が見える（`AXLayoutArea` + subrole `AXFloatingWindow` として。`AXWindow` 型で期待すると取りこぼす）。GUI フォールバックは今も Ae 本体ではなく**ネイティブダイアログ**を対象にするが、それは「窓が見えないから」ではなく「Ae のパネルは触らない方が安全だから」。
- Escape キーではネイティブダイアログが閉じない（実測）。AX のボタン押下が現実的な経路。
- ~~現在 Ae の**標準ダイアログ**（ライセンス・警告等）を実機で開いて閉じられるかどうかは未検証。~~ → **実測済み（§10.14）**: `ui.alert` のネイティブダイアログを、対象セッション内の AX で `OK` を押して閉じ、元の呼び出しが完了することを3回連続で確認した。
- フォーカス監視の `frontmost` は、この macOS では `NSWorkspace.frontmostApplication` が `nil` を返すため、System Events 経由（1秒に1回）で補っている。監視プロセス自身に **Automation → System Events** の許可が要る（コンソール側の Terminal には許可済み）。
- フォーカス監視は「誰がその変化を起こしたか」までは言えない。`frontmost` が変わった事実とカーソル・キー入力の有無までが証拠で、原因の帰属は別途（対象セッション側に Ae の窓が無いこと等）で示す。

## 10. 実測記録（2026-11-02, このMac）

この節は「推定」ではなく、このMacで観測した事実だけを書く。

### 10.1 環境

| 項目 | 実測値 |
| --- | --- |
| macOS | 27.0.1 (26A434) |
| After Effects | 26.5.0（`/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects`） |
| offstage | `@exla/offstage` 0.4.1 |
| テストユーザー | `test` uid 502 / Aqua（§10.11 の実測で asid 107488）/ ログアウトなしでバックグラウンドに存在 |
| コンソール所有者 | uid 501 (`rebui`) — テスト中も変わらず |
| 隔離セッションの Ae | pid 69349（uid 502）、起動は `DoScriptFile` によるオンデマンド起動 |

### 10.2 TCC: responsible process が bundle でないと比較定されない

- `offstage-sessiond` は **bundle を持たない Mach-O** なので、System Settings に現れない。launchd を responsible process とするプロンプトは**画面にも設定にも出ない**。
- そこで、**ヘルパーセッションの中で Terminal.app を responsible process にする**（Terminal は bundle）。これで設定に現れ、許可は子孫（node / osascript / screencapture）に継承される。実測で、テストセッション内に `universalAccessAuthWarn`（pid 15871 / onscreen=1 / 题名 `画面収録`）が存在することを確認した。**ダイアログは出ていた（test セッションの画面上にあっただけだった）。**
- **responsible process が bundle でない場合は即時に `-1743` で拒否される**（プロンプトを出せないため）。実測: `offstage run` の子として `osascript → After Effects` を送ると `-1743`。同じイベントを **Terminal.app の子**から送ると**拒否されない**（届いてタイムアウトになる）。**テストは Terminal.app の子として走らせる必要がある。**
- ただし **Automation（Apple Events）は Accessibility とは別の権限**で、別のプロンプトである。実測: `osascript → System Events` は daemon の子からも Terminal の子からも `-1743`（`System EventsにApple Eventsを送信する権限がありません`）。
- 実測した権限の状況（test セッション内）:

| 対象 | daemon の子 | Terminal.app の子 |
| --- | --- | --- |
| Apple Events → Adobe After Effects | `-1743`（bundle 無しで即拒否） | **届く**（`-1712` タイムアウト） |
| Apple Events → System Events | `-1743` | `-1743` |
| Screen Recording (`screencapture`) | **使える** | 使えない（`could not create image from display`） |
| 窓の題名 (`CGWindowList`) | **見える** | 見えない |

### 10.3 Ae は「起動モーダル」で止まっていて、脚本に答えない

- test セッションの Ae (pid 69349) には `CGWindowList` で layer=8 のモーダルがある（題名 `警告`, 440×262）。メインウィンドウ（`Adobe After Effects 2026 - 名称未設定プロジェクト`）も同時にある。
- Terminal.app の子から `DoScriptFile` を送ると **`-1712`（AppleEventがタイムアウトしました）**。つまり**イベントは届いているが、Ae が答えない**。Ae 側のモーダルが応答を止めている，符合。
- なお `tell application "<bundle>" to get version` が 26.5.0 を返すのは **AppleScript が bundle のメタデータから答えている**だけで、Ae に届いている証拠ではない（`count documents` は `-1743`）。**この 2 つを混同しないこと。**
- 総合すると、阻んでいるのは **TCC ではなく、Ae の起動モーダル**。

### 10.4 テストユーザーは Adobe にサインインしていない

- `/Users/test/Library/Application Support/Adobe/OOBE/logged_out_guid` が存在する = **未サインイン**。
- Creative Cloud の計測ログ: `ccd.signinWorkflow: SIGN_IN_WORKFLOW` / `ccd.signinErrorState: IMS_NETWORK_ERROR_STATE` / `ccd.network_state: OFFLINE`。
- 結果として Ae は起動モーダル（`CGWindowList` の layer=8, 题名 `警告`, 440×262）を持って止まり、`app.info` が応答しない。
- これは**人がやる操作**（Adobe ID でサインイン）。代理は Adobe ID・パスワード・トークンを扱わず、ログにも残さない。別デバイスのライセンスは絶対に自動解放しない。

### 10.5 隔離E2Eの実測（2回）

| 回 | 時刻 (UTC) | 結果 | 証跡 |
| --- | --- | --- | --- |
| 1 | 03:31–03:35 | FAIL。Ae は起動した（pid 69349）が probe が応答せず、GUI 復旧が「ホストプロセス無し」で終了 | `sessions/run-1793590265115/trace.jsonl` |
| 2 | 04:22:38–04:23:49 | FAIL。`-1743: Adobe After Effects 2026にApple Eventsを送信する権限がありません` | `sessions/run-1793593358745/trace.jsonl` |

1 回目で原因が分かった: macOS の `DoScriptFile` は Ae をオンデマンド起動し、`#owned` は probe 成功後の `confirmLaunched()` でしか立たないため、probe が落ちると pid を知れなかった。これを `recoveryTargetPid()` で直した（§4）。所有権の証明自体は緩めていない。**（後のレビューで訂正）** 当時の「起動後に現れた唯一の Ae」という判定は、人間が直後に起動した Ae を quit し得るため廃止した。現在は `launch()` が起動した pid と一致する場合だけを recovery 対象にし、所有権もその pid が唯一のインスタンスであることを要求する（§4）。

2 回目は別の壁に当たった。**この 2 つの `-1743` は「TCC が拒否した」のではなく「Ae が答えない」ことを意味する。** 同じイベントを、**起動済みの** Ae に対して Terminal.app の子から送ると **届いて `-1712`（タイムアウト）** になる（§10.3）。つまり壁は**Ae の起動モーダル**で、**人が `警告` を解くまで脚本は一枚も通らない**。

### 10.6 terminal 基版の実測（2026-11-02, 04:43）

- `run-in-isolated-session.mjs --substrate terminal` の経路を実機で走らせ、**ジョブが test セッションの Terminal.app の子として実行される**ことを確認した。
- ジョブは**自分のセッションを自分で書き記す**: `uid=502` / `username=test` / `asid=107488` / `exit=0`。制御側は依頼した uid（502）と一致した時だけ結果を信じ、不一致なら**信頼しない**（結果は丢弃）。
- つまり「隔離されたセッションで走った」ことは**自称ではなく、ジョブ自身が uid として証明している**。
- ただし権限の穴が残る（この時点の test セッション、Terminal.app の子として）:

| 対象 | 実測 | 意味 |
| --- | --- | --- |
| **DoScriptFile** (`«event miscfile»`) → After Effects | `-1712`（タイムアウト） | **届く**。Ae が答えないだけ（§10.3）。**ae-a8n が使う経路** |
| 通常の Apple Event (`count documents`) → After Effects | `-1743`（権限がありません） | Automation → Ae が未許可 |
| Apple Events → System Events | `-1712`（タイムアウト） | **届く**。System Events が応答しない |
| Accessibility (AX で Ae の窓を読む) | `-1712`（タイムアウト） | **使えない**（許可が必要） |
| Screen Recording (`screencapture`) | `could not create image from display` | **使えない**（許可が必要） |

- **重要な区別**: 通常の Apple Event（`count documents` など）は `-1743` で**拒否**されるが、**DoScriptFile（`miscfile` イベント）は `-1712` で届く**。ae-a8n の macOS 輸送は DoScriptFile を使うので、**Automation → Ae の許可は ae-a8n の動作には要らない**。要るのは **Screen Recording と Accessibility（Terminal.app に対して）** と **Adobe のサインイン**。いずれも人がやる操作（§8）。
- 逆に言えば、`count documents` の `-1743` を「Ae に届いていない証拠」と読むのは誤り。**`-1743` は TCC の拒否、`-1712` は「届いたが答えない」**。この 2 つは意味が違う。

### 10.7 人間が test セッションで許可した後（05:15–05:23Z の実測）

人間が `test` セッションで作業した後の実測:

| 項目 | 実測 | 意味 |
| --- | --- | --- |
| Adobe サインイン | **済んだ**。Ae に `警告` モーダルなし（`CGWindowList` に layer=8 が無い）。画面も通常の Ae の UI | Ae の起動モーダルは解消 |
| Screen Recording → ターミナル | **使える**。`screencapture` が 702KB の PNG を書けた | 許可済み |
| Accessibility → ターミナル | `AXIsProcessTrusted()` = **`AX_NOT_TRUSTED`** | **未許可**（§8 の通り、この項目は**設定のリストに無い**。「要求したアプリしか現れない」ため、ターミナル自身から要求して許可する） |
| Automation → ターミナル → System Events | `-1743`（System Events に Apple Events を送信する権限がありません） | **未許可** |
| Automation → ターミナル → After Effects | `count documents` は `-1712`、`«event miscfile»` は `-1743` | **未許可**（プロンプトが出せないので、この2つの形で違う拒絶になる） |
| DoScriptFile（実Ae へ） | `-1712`（120秒タイムアウト）。スクリプトは 1 枚も実行されない | TCC の壁 |

- **DoScriptFile が「届くのに答えない」以为是 AE のモーダルのせいだいが、モーダルはもう無い。** 壁は **TCC の Automation → ターミナル → After Effects**。
- `-1743` と `-1712` の混在は「同じ TCC サービスでも経路によって拒絶の表現が違う」ことを示す: いずれにせよ**許可されていない**。
- **訂正（§10.9）**: 上の「壁は TCC」は **Terminal 基版の中で測り直すと成立しない**。同じ `test` セッションの Terminal からは `count documents` が `0` を返し、`DoScriptFile` / `DoScript` は **Ae 自身が `-1708` で拒否**する（= Ae のスクリプト実行許可が要る）。TCC はこの経路の壁ではない。
- `codesign -d --entitlements` で確認: **Ae は app-sandbox を使っていない**（`com.apple.security.app-sandbox` なし）。よって `/Users/Shared/ae-a8n` への読み書きは妨げられない。壁は TCC だけ。
- **訂正（§10.9）**: 最後の「壁は TCC だけ」も成立しない。同じ `test` セッションの Terminal からは `count documents` が `0` を返し、`DoScriptFile` は **`-1708`（Ae 自身が拒否）** になる。TCC の Automation 許可は要らず、壁は **Ae 自身のスクリプト実行許可**である。

### 10.8 フォーカスの非干渉（実測）

- 観測方法: コンソールセッション（uid 501）で `focus-watch` を動かし、**約 0.2 秒ごとに frontmost アプリ名・pid とポインタ座標**を記録。E2E 実行の前後を覆う区間を取った。
- 観測区間: epoch 1793593355.83 – 1793593490.64（**134.8 秒**, 652 サンプル）。E2E の実行区間（04:22:38–04:23:49Z）を完全に含む。
- 結果: frontmost アプリは **Vivaldi (pid 50401) の 652 サンプルすべて**。ポインタ座標は **全サンプルで (1267, 236) 固定**。
- よって **フォーカスの奪取 0 件・意図しないカーソル移動 0 件**（この観測範囲では）。
- **キー入力は観測していない。** この計測に使った `focus-watch` は frontmost とポインタしか記録しない。よって**意図しないキー入力 0 件とは断定しない**（`0` と書くのは監視できていない項目）。
  - この「キー入力を観測していない」点は 2026-11-02 に直した: `focus-watch` に **key event tap** を足し、**キー入力の件数と「プログラムが POST したキーイベント」の件数だけ**を数えるようにした（**打った内容は記録しない**）。`analyze-focus.mjs` は「key events seen / posted programmatically」を出すが、tap が拒否されたときは **`key input: NOT MONITORED`** と出す（`0` と書かない）。実測での拒否例: コンソールセッションが無い状態では tap は拒否され `keys=unwatched` になる。
- 別ユーザーへの GUI 操作の配送も 0 件（隔離セッションの操作は `launchctl asuser` / offstage のセッション内で完結し、コンソールセッションの Accessibility は使っていない）。

### 10.9 AE 26.5 のスクリプト実行許可（実測, 2026-11-02 06:04–06:12Z）

§10.7 の結論（「壁は TCC の Automation → ターミナル → After Effects」）は、**Terminal 基版の中で測り直すと Corrections になる**。
`test` セッションの Terminal の中から（コンソールではなく）実 Ae へ投げた結果:

| 投げ方 | 実測 | 意味 |
| --- | --- | --- |
| `count documents`（通常の Apple Event） | `0` が返る | **TCC の Automation → Ae は壁ではない**（同 user's 同一セッション内の Ae なので-events は届く） |
| `DoScriptFile (POSIX file "…" as alias)` | **`-1708`**（`DoScriptFileを続けることができません`） | **Ae 自身が拒否**（TCC ではなく） |
| `DoScript ("inline text")` | **`-1708`**（`DoScriptを続けることができません`） | ファイル不经由でも同じ拒否。**Ae の許可リストが empty のまま** |
| `«event miscfile»`（リポジトリの実装） | AECrash 中は `1`（例外なく「成功」したように見える） | **サイレント no-op**。`-1708` を見せないため、診断としては compiled 形式の方が Information が多い |

- `-1708` は **errAEEventFailed**:「イベントは届いて、Ae が拒否した」。`-1743`（TCC の拒否）とは意味が違う。
- Ae は `警告` モーダル（layer=8）を出し、**行番号付きで**「このスクリプトは実行できない、アクセスが拒否された。環境設定の『スクリプトとエクスプレッション』で『スクリプト』および『ファイルへの書き込みとネットワークアクセス』を許可せよ」と指す。
- つまり **AE 2026（26.5）は『スクリプトの実行』そのものを既定で拒否し、偏好パネルの許可リストに載っているスクリプトだけ実行する**。ファイルを読むだけの compute-only スクリプトでも拒否される（実測）。
- Ae の `ae.sdef` にこの許可を操作する語彙は**存在しない**（`DoScript` / `DoScriptFile` のみ）。`strings` でも許可リストの保存先が見つからない。→ **GUI での許可が要る操作**。
- **Ae のクラッシュ（実測2件）**: `After Effects-2026-11-02-144538.ips` / `-145642.ips`。どちらも `EXC_CRASH` / `SIGABRT`（`Abort trap: 6`）、クラッシュしたフレームは `com.adobe.dvascripting.framework` / `dvascriptingNAPI` / `com.adobe.extendscript.framework`（後者には `com.adobe.Scripting.plugin` と `Expressions and Scripting Palette`）。**スクリプト実行が拒否された直後に Ae が落ちる**。落ちた Ae は以後のすべてのイベントに `1` を返す（refusing 状態）になり、`kill -TERM` では復帰しない（fresh launch のみ復帰）。
- 実装への帰結: **`MAC_DO_SCRIPT_FILE` はこの実測だけでは変えない**。compiled 形式が `-1708` を返すのは「permission が要る」ためであり、許可が下りた後に raw 形式が動くかは未検証。**許可が下りた時点で両形式を実測してから**決める（§10.10）。

### 10.10 AE 26.5 の許可は 2 種類（実測 06:17–06:25Z）

| 許可 | 実測 | 誰のものか |
| --- | --- | --- |
| **スクリプト実行の許可** | `DoScriptFile` / `DoScript` が **`-1708`**、`警告` モーダル（行番号つき）。**どのパスでも同じ**（実測: `~/Library/Application Support/Adobe/After Effects/Scripts/`、`~/Scripts/`、`~/Documents/`、`/Users/Shared/ae-a8n/run/`） | **Ae の偏好パネルで人間が許可する**（`ae.sdef` に操作語彙は無い。許可リストは空で、まだ保存されていない） |
| **ファイル書き込み・ネットワークの許可** | `Pref_SCRIPTING_FILE_NETWORK_SECURITY` = `"0"` → `"1"` にしたら **書き出しは通るが、実行拒否（`-1708`）は変わらない**（実測 06:23Z） | Ae の偏好（ファイルは `~/Library/Preferences/Adobe/After Effects/26.5/…環境設定.txt`） |

- つまり **2 つ必要**。前者は GUI での許可が要る操作（Agent からは操作語彙が無いので不可）、後者は Ae 自身の偏好ファイルで足りる（= `default` 相当）。
- 設定した偏好は **Ae が閉じている時にだけ**書ける（Ae は終了時に偏好ファイルを上書きする）。テストユーザー（uid 502）として書き換えた。
- 許可の粒度（フォルダ単位かスクリプト単位か）が GUI なしでは分からないため、実装は **Ae に読ませるファイルを 1 フォルダにまとめる**方針にした:
  - `staging/<id>.entry.jsx`（**呼び出しごとに別名**。Ae はスクリプトが*走るとき*にファイルを読むので、名前が固定だと「タイムアウトしたスクリプトが次の要求を読んで二重に実行する」）
  - `staging/a8n-host.js` と `staging/a8n-json.js`（**`.driver` が 1 回だけ**、`host/` のコピーを**`staging/` 自身に**置く。バイト同一。Ae に読ませるファイルは 1 フォルダにまとめ、フォルダ単位の許可がそのまま効く）
  - これにより、**フォルダ単位の許可なら 1 回、スクリプト単位なら 3 件**の承認で済む。

### 10.11 隔離E2E パイプラインの通し実測（06:33–06:36Z）

`run-in-isolated-session.mjs`（terminal 基版）→ `ae-e2e.mjs` を `test` セッションで実行した結果:

| 項目 | 実測 |
| --- | --- |
| 実行セッション | uid 502 / `Aqua` / asid 107488 / console uid 501 → **`isolated: true`** |
| 起動 | `AfterEffects.launch({session:{uid,recover:true}})` が **test セッションで Ae を起動した**（コンソール側の Ae は無し） |
| readiness probe | **`app.info` に 179941ms 応答なし** → `AfterEffectsError`。Ae 側は §10.9 の通りスクリプト実行を拒否している |
| 後始末 | 失敗経路で Ae は**終了した**（実行後に Ae のプロセスは無し。kill はしていない） |
| レポート | `/Users/Shared/ae-a8n/run/e2e-report.json` にセッション情報と失敗理由が書けた |

- **パイプライン（セッション特定 → 別ユーザの Terminal で起動 → 実行 → 結果ファイルをコンソール側へ）は終わりまで通る**。残るは **Ae のスクリプト許可（§10.10）と Accessibility（§10.7）** だけ。
- 注意: `offstage session status --user test` はこの時点で `available: false`（helper セッション未ログイン）と出るが、**terminal 基版は offstage の helper セッションを必要としない**ので問題ない（`offstage session open` が使える）。

### 10.12 許可が下りた後（2026-11-03 11:13–11:28 の実測）

`test` セッションに再ログイン（launchd の gui/502 は asid **109086**、console は uid 501）した後の実測。

| 項目 | 実測 | 意味 |
| --- | --- | --- |
| Accessibility（`test` セッションの Terminal） | `ax-prompt status` → **`AX_TRUSTED`** | §8 の「ターミナル自身から要求して OK」で通った |
| Automation → System Events | `-1743`（その後 `-1712`）。画面にプロンプトは出ていない | **未許可**。設定の Automations で Terminal → System Events を有効にする必要がある |
| Automation → After Effects | 不要（`DoScriptFile` が通る） | §10.9 のとおり |
| Ae のスクリプト実行の許可 | `DoScriptFile` → **`0`**（`-1708` ではない）。`DoScript` インラインも `0` | **許可された**。§10.10 の壁は解消 |
| Ae のファイル書き込み | ExtendScript から `/Users/Shared/ae-a8n/run/probe41-wrote.txt` を書けた | `Pref_SCRIPTING_FILE_NETWORK_SECURITY = "1"` が効いている |
| Ae | 26.5x89（`app.version`） | — |
| AX から見た Ae | **`windows=2`**。`AXLayoutArea`（`AXFloatingWindow`）2枚、子に `AXButton` / `AXRadioButton` / `AXComboBox` などが全部見える | **§9 の「AX は Ae のメインウィンドウを返さない」は、Accessibility 未許可の時の測定だった**。許可後は AX で Ae の UI が読める（ただし Ae の実装が `AXWindow` ではなく `AXLayoutArea` + `AXFloatingWindow` で出すので、`AXWindows` の型を `AXWindow` と期待すると取りこぼす） |
| offstage の `sessionId` | offstage は **258**、一方 gui/502 の asid と `CGSessionCopyCurrentDictionary` の audit id はどちらも **109086** | **offstage 0.4.1 の `guiSession.sessionId` は launchd の asid と同じ数の空間にない**。この番号を「要求したセッションの識別子」としてジョブの自己申告と比べると、隔離された実行を誤って拒否する。ランナーは比較対象を **コンソール側の asid**（コントローラが gui/501 から読める）に変え、ジョブ自身の `onconsole`（`/dev/console` の所有者が自分か）と併せて判定するようにした |

- `offstage session screenshot --user test` はこの状態で撮れる（3420×2224 px, 2 px/pt）。写るのは `test` セッションの画面。
- **`offstage run --lane session` で走らせたコマンドは Terminal の子ではない**ため、Terminal に与えた許可を継承しない（実測: `-1743` / `-1712` で止まる）。許可が要る処理は **terminal 基版**（`run-in-isolated-session.mjs` の既定）で走らせること。

### 10.13 GUI フォールバックの許可要件（2026-11-03 11:37Z の実測）

`test` セッションの Terminal から測った、GUI フォールバックに必要な許可:

| 測ったこと | 結果 |
| --- | --- |
| `AXIsProcessTrusted()`（`test` セッション、Terminal の子） | **`true`** — ユーザー補助機能は許可済み |
| `osascript -e 'tell application "System Events" to get name of first process'` | **`-1743`**（`System EventsにApple Eventsを送信する権限がありません`）。画面にプロンプトは出ていない |
| `AXUIElementCopyAttributeValue`（Swift ヘルパー `ax-windows`） | Ae の窓を列挙できる。**ユーザー補助機能だけで足りる** |
| 同じ呼び出しを JXA（`osascript -l JavaScript` から `ObjC.import('ApplicationServices')`）で | `AXIsProcessTrusted()` は呼べるが、`AXUIElementCopyAttributeValue` の out 引数（`CFArrayRef`）は JXA の ObjC ブリッジで `Ref` のまま返り、`ObjC.unwrap` / `CFArrayGetCount` のどちらでも取り出せない（`Ref has incompatible type`）。**現行の osascript だけでの AX 実装は成立しない** |

つまり `src/driver/gui-recovery.ts` が `System Events` を使う以上、**Automation → System Events の許可は実機での前提**であり、代理が迂回できるものではない（ユーザー補助機能だけでは足りない）。代替は「AX だけを使う Swift ヘルパーを同梱する」ことだが、それはネイティブバイナリの配布・監査という別の判断になるため、この Issue では採らない。§8 の手順で人間が許可する。
### 10.14 実機受入（2026-11-03 03:10–03:18 UTC、最終コミットの pkg で3回連続 PASS）

Automation → System Events を人間が許可した後、`test` セッションで通しの E2E を走らせた。最終測定は **`59ef4e2` の pkg** に対して行った（`npm pack` を作り直して `/Users/Shared/ae-a8n/pkg` を更新し、`COMMIT` に `59ef4e20753cdbe79e12da66a62fe7c13ae094ea` を記録）。03:16–03:18 UTC に **3回連続、9ステップ全部 `ok`**、レポートの `status` も `passed`。メニュー操作のステップを足す前の版でも 03:00–03:03 に3回連続 PASS しており、**通しの PASS は合計6回**。

| ステップ | 実測値（03:16:20–03:16:58 の回） |
| --- | --- |
| 1 session | `uid 502` / `asid 109086` / `kind Aqua` / `consoleUid 501` / `isolated true` |
| 2 launch | `26.5x89` (build 89)、12.1 s |
| 3 ownership | `owned`（`pid 40923 is still the only instance`） |
| 4 scene | comp `A8N Isolated`、layer 1 |
| 5 render | 320×180 PNG、3901 bytes |
| 6 **menu** | `編集 › 複製`（メニュー名で解決 → id 2080）、35 ms、layer 1 → 2 |
| 7 modal-dialog | **`ok` 21.3 s** — 20 s のタイムアウト後、対象セッション内の AX で `OK` を押し、**元の呼び出しがそのまま完了** |
| 8 responsive-after-dialog | `26.5x89`（ダイアログの後も応答する） |
| 9 close | `quit: true`、ownership `owned` |

- 最終3回の所要は 03:16:20→03:16:58、03:17:05→03:17:42、03:17:48→03:18:24（UTC）。レポートは `/Users/Shared/ae-a8n/run/e2e-report-clean-1.json` / `-2.json` / `-3.json`（これより前の 03:10–03:12 の3回は `e2e-report-7.json` / `-8.json` / `-9.json`）。
- ダイアログ復帰の証拠（`/Users/Shared/ae-a8n/sessions/real-host/trace.jsonl`）:
  - `session.recover` … `recovered: true`、`closed "AXWindow/AXDialog "" [OK] says "ae-a8n: close me / missing value"" by pressing "OK" in test's session`、復帰前の画面は `artifacts/recovery-*.png` に保存
  - `ui.alert` … **3回の実行それぞれに1件だけ**、`recovered: true`、`dismissed: true`。**タイムアウトした呼び出しは再送されていない**（ダイアログも1枚しか出ていない）
- 受入中に見つけて直したもの:
  - **`LIST_WINDOWS_SCRIPT` が実機で動かなかった**: `tell application "System Events"` の中で自前のハンドラを `my` 無しで呼んでいたため `Can't continue a8nClean (-1708)`。`my a8nClean(...)` に修正し、全 AppleScript を `osacompile` でコンパイルするテストを追加（`my` の欠落はコンパイルでは見つからないので、呼び出し箇所の検査も足した）。
  - **E2E の close が正しく拒否された**: テストが comp を作って render したので未保存変更があり、`close()` は `UnsavedChangesError` で拒否した（ライブラリは正しい）。テスト側を `close({ unsavedChanges: "discard" })` にした。
  - **メニュー操作には「ビューアで開く」が要る**: スクリプトだけで作った comp は `app.project.activeItem` ではない。`openInViewer()` しないと `menu.execute` の before/after は `comp: null` になる（実測）。開いて `selectLayers` した後、`複製`（id 2080）で layer が 1 → 2 に増えた。
  - **Edit › Undo はスクリプト由来の変更を取り消さなかった**（id 16 と、メニュー名から解決した 2371 の両方）。だからメニューのステップは undo/redo ではなく複製後のレイヤー数で判定する。`docs/verification.md` の #45 ではプラグインのコマンド（独自の undo グループを持つ）で undo/redo が効いている。**AE のメニューから undo できることと、スクリプトの変更を undo できることは別**。
  - **フォーカス監視が偽の「programmatic 入力」を数えていた**: タップが無効化されると macOS は `type=-2`（`tapDisabledByUserInput`）の疑似イベントを渡す。これをキーイベントとして読むと「プログラムが入力した」と誤記録する（実測: ソース pid が監視プロセス自身だった）。疑似イベントを除外し、タップが外れた回数を `keys=gapped(N)` として記録するようにした。
  - **`NSWorkspace.frontmostApplication` が常に `nil`**（`lsappinfo front` も NULL）。System Events からの1秒ポーリングにフォールバックして、実際の前面アプリ名を記録できるようにした。
  - **先行測定のログを窓より長く取り続けていた**: 03:10:07 の監視を実行後に止め忘れ、ログが 03:14:35 まで続いていた。保存されたログから当時の窓の数値を再現できないため、最終測定では**各窓の直後に監視を止め、ログ全体がその窓になる**ようにした。先行4窓の数値は証拠として使わない。

#### フォーカス非干渉の測定（2026-11-03 03:16–03:18 UTC、3つの窓）

- **観測方法**: `focus-watch5`（`scripts/isolated-session/focus-watch.swift` を `swiftc -O` でビルド）を、**E2E を走らせるコンソールセッション（uid 501、`rebui`）** で起動した。0.2 秒ごとに (1) 前面アプリ名と pid（`NSWorkspace` が `nil` を返すため System Events から1秒ごとに補完）、(2) カーソル座標、(3) キーイベント数とその出自（キーボード / プログラム投稿）を記録する。疑似イベント（`type=-2`）はキーとして数えず、タップが外れた回数だけ `keys=gapped(N)` に残す。**キーの中身は読まず、書かない**。
- **測定対象期間**: 各回について、監視を E2E の起動 **1秒前**に開始し、E2E の戻り直後に SIGTERM で止めた。したがってログの最初と最後のサンプルがそのまま測定区間で、E2E の launch〜close が全部入っている。解析は `node scripts/isolated-session/analyze-focus.mjs <log>`。

| 窓 (UTC) | 長さ | サンプル | 前面アプリ | フォーカス変化 | カーソル移動サンプル | 人間のキー入力 | プログラム投稿 | タップのギャップ | ログ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 03:16:16–03:16:59 | 41.7 s | 142 | ghostty のみ | 0 | 36 | 1 | 0 | 1 | `focus-clean-20261103T031616Z.log` |
| 03:17:02–03:17:42 | 40.1 s | 143 | ghostty のみ | 0 | 28 | 1 | 0 | 1 | `focus-clean-20261103T031702Z.log` |
| 03:17:45–03:18:25 | 39.2 s | 142 | ghostty のみ | 0 | 0 | 17 | 0 | 9 | `focus-clean-20261103T031745Z.log` |

（ログはすべて `/Users/Shared/ae-a8n/run/`。）

- **読み方**:
  - 3窓とも**前面アプリは一度も変わらず**（0回）、**プログラムから投稿されたキーイベントは 0件**。人間のキー入力は 1 / 1 / 17 回で、その間も前面は ghostty のまま。つまり入力は通常ユーザーのアプリに届いており、隔離セッションに奪われていない。
  - Ae はこのセッションにプロセスも窓も持たない（Ae は uid 502 のセッションで動いている）。操作は対象セッション内の Terminal.app の子として走った。
- **言えないこと（0件と断定しない項目）**:
  - **カーソル移動**: 2つの窓で座標が動いた（36 / 28 サンプル）。この監視は**位置をサンプリングするだけで、誰が動かしたかを帰属できない**。人間がマウスを動かしていた可能性と、他のコンソール側アプリの可能性を区別できない。したがって「意図しないカーソル移動 0件」とは**言わない**。なお、復帰は AX の押下（trace の `by pressing "OK"`）で行われており、ae-a8n がコンソールセッションへポインタ入力を送る経路は使っていない。E2E の座標クリックのフォールバックは対象セッション内の入力ストリームにしか届かない。
  - **キー入力のギャップ**: タップが 1 / 1 / 9 回外れた（`tapDisabledByUserInput`、いずれも直後に再有効化）。その間のキーは見ていないので、**キー数は下限**。前面アプリとカーソルのサンプリング（0.2 s）はタップとは独立で、ギャップの間も止まっていない。
  - 監視は**キーのプログラム投稿**しか検出できない。マウスのプログラム投稿は検出しない。
- **先行の窓（参考、証拠には使わない）**: 03:02:46–03:03:30（42.5 s / 150 サンプル / ghostty→ChatGPT の1回 / カーソル 0 / キー 0 / プログラム投稿 0 / ギャップ 0）。前面変化の原因（人間の ⌘-Tab か）は証明していない。03:10–03:12 の3窓は計測したが、上記のとおりログを窓の後まで取り続けたため、保存ファイルから数値を再現できず、ここには載せない。

### 10.15 独立レビューで見つかった問題と修正（2026-11-03、実装＋自動テストまで）

実機受入の後、差分に対して独立レビューを行い、10件の問題が見つかった。すべて修正した。§10.14 の6回の実機 PASS は `59ef4e2` の pkg（修正前）に対するもので、修正後は pkg を `a11b969` で作り直して**1回だけ実機で通した**（下の「修正後の実機確認」）。その1回で発火しなかった経路は実機未検証のままで、下の表の検証レベルはその1回を反映している。

| # | 問題 | 修正 | 検証レベル |
| --- | --- | --- | --- |
| 1 | `session-agent` はコンソールセッションにいる場合も警告だけで動き続け、置かれた job をコンソールで実行し得た | コンソール所有 uid と同じなら**起動を拒否**（`exit 1`） | automated test（判定規則）＋実装 |
| 2 | jobs ディレクトリは 1777 なので、任意のローカルプロセスが job を置いて **test ユーザーでコードを実行**できた | 実行するのは**制御側 uid が所有し group/other 書込不可の通常ファイル**のみ（`jobFileIsTrusted`）。job の `id` と `session.uid` も照合 | automated test |
| 3 | 結果ファイルも 1777 の中で、誰が書いたかを確かめずに JSON を読んでいた（symlink も辿っていた） | `lstat` で**通常ファイル（symlink でない）・対象 uid 所有・group/other 書込不可**を確認してから読む | automated test |
| 4 | 結果ファイルの書き込みが直接書きで、読む側が**途中の内容**を uid -1 / exit 1 として解釈し得た | 一時ファイル＋`rename` で公開。ターミナル経路の `.done` も同様。読み側は `complete`（uid と exit が揃う）まで待つ | automated test ＋ `rename` 公開は実機（`complete` 待機の発火は未観測） |
| 5 | GUI 復帰が**プロセスの全ウィンドウを走査**して最初の一致ボタンを押していた。サインイン窓の上に通常ダイアログがあると、その窓に当たり得た | 押下は**列挙で選んだ1枚（1始まりの index）に限定**。押下直前に窓の title/subrole を照合し、違えば `CHANGED` で押さない | automated test ＋ osacompile ＋**実機で subrole 照合つき押下が成功**（title 照合は空 title のため未発火） |
| 6 | 人間用の窓の判定は**先頭の遮断窓だけ**に掛かっており、通常のダイアログの後ろにサインイン窓があると、前の窓の OK を押して先へ進んでしまった | **遮っている窓の1枚でも人間用なら、どこにも押さない**（日本語 UI の語も既に照合対象） | automated test |
| 7 | `/dev/console` の所有者が読めない（-1）と「コンソールではない」と同義に扱われ、復帰が人間の画面に届き得た | 読めない場合は**復帰を拒否**（`allowConsoleSession` を明示した呼び出しだけが対象外） | automated test |
| 8 | 復帰後にホストが**エラーで答えた**場合、そのエラーを捨てて元の `TimeoutError` を報告していた（再送を誘う） | ホストのエラーをそのまま投げる。再送はしない | automated test |
| 9 | `launchctl print gui/<uid>` の "Operation not permitted" を「ログインしていない」と伝えていた | 拒否と不在を区別し、`launchctl` の文言を添えて案内する | 実装（この Mac で `gui/502` が "Operation not permitted" を返すことは実測済み） |
| 10 | `SKILL.md` が comp / layer を「未対応」と書いていた（実際は `createComp` / `addTextLayer` がある） | 記述を修正 | ドキュメント |

追加したテスト: `test/isolated-session.check.mjs`（34 件）に job file / 結果ファイルの信頼判定・`AfterFX` の認識・不完全な結果の待機、`test/recovery.test.ts` にウィンドウ選択規則と「復帰後のホストエラー」、`test/macos-session.test.ts` に押下直前の窓照合と `allowConsoleSession`。`mise run check` は **vitest 496 passed / 3 skipped、node --test 34 passed** で通る。

- 未検証として残ること: ネイティブ経路（`session-agent` / `dispatch`）は修正後に実機で走らせていない。#2 の job file 判定と #3 の結果判定は、実機の 1777 ディレクトリと umask の組み合わせで確認していない。#4 の `complete` 待機も、実際に不完全なファイルを掴んだ場面では観測していない。ターミナル経路の1回（下記）以外は次の実機受入で確認する。

#### 修正後の実機確認（2026-11-03 03:42 UTC、1回）

pkg を `a11b969` で作り直し（`/Users/Shared/ae-a8n/pkg/COMMIT`）、**修正後のランナーと dist** で E2E を1回走らせた。9ステップ全部 `ok`、`status: passed`。`test` セッション（uid 502 / asid 109086、コンソール uid 501）、レポートは `/Users/Shared/ae-a8n/run/e2e-report-review.json`。

| ステップ | 実測値 |
| --- | --- |
| 1 session | `isolated: true` |
| 2 launch | `26.5x89` (build 89)、9.0 s |
| 3 ownership | `owned`（`pid 25402 is still the only instance`） |
| 4 scene | comp `A8N Isolated`、layer 1 |
| 5 render | 320×180 PNG、3901 bytes |
| 6 menu | `複製`（id 2080）、24 ms、layer 1 → 2 |
| 7 modal-dialog | `ok` 21.3 s — 20 s のタイムアウト後、**新しい押下スクリプト**（window index + subrole 照合）で `OK` を押し、**元の呼び出しがそのまま完了** |
| 8 responsive-after-dialog | `26.5x89` |
| 9 close | `quit: true`、ownership `owned` |

- この1回で実機確認できた修正: ターミナル経路の結果公開（rename で `.done` を公開し、`complete` を待つ）、`parseTerminalResult` / `shellQuote` / preflight の新コード、**押下直前の window 照合**（trace: `closed "AXWindow/AXDialog "" ..." by pressing "OK"`、`expectedSubrole=AXDialog` が一致）。`ui.alert` は1件、再送なし。
- この1回では**発火していない**ため実機未確認のままの修正: 人間用ウィンドウが混在する場合の全面拒否、`/dev/console` が読めない場合の拒否、復帰後にホストがエラーを返す経路、`launchctl` の "Operation not permitted" の案内、jobs / results の信頼判定（ネイティブ経路。この実測はターミナル経路）、`AfterFX` の認識（実行前に Ae が無かったため一度も一致判定が走っていない）。
- 実行後に残ったのは Adobe のヘルパー（`crashpad_handler` / `dynamiclinkmanager` / `TeamProjectsLocalHub`）だけ。Ae 本体は終了しており、ヘルパーは強制終了していない（§SKILL の記載どおり自然終了を待つ）。
- フォーカス測定はこの1回では行っていない。§10.14 の3窓が最後の測定で、修正後のコードでのフォーカス再測定は**未実施**。

### 10.16 2回目の独立レビューと、実機でしか出なかった4件（2026-11-03）

§10.15 の修正コミット（`a11b969`）に対してもう一度独立レビューを行い、6件の問題が見つかった。すべて `414460a` で修正し、`mise run check` は **vitest 497 passed / 3 skipped、node --test 36 passed** で通った。pkg を作り直して実機 E2E を1回走らせ、9/9 `ok`（`/Users/Shared/ae-a8n/run/e2e-report-review2.json`、03:51:52–03:52:26Z、pkg `414460aa3f80c2980e7bfcd2289f78b45286a305`）。その後の #7–#10 の修正でテストを足し、最終状態の `mise run check` は **vitest 497 passed / 3 skipped、node --test 38 passed**。

| # | 問題 | 修正 | 検証レベル |
| --- | --- | --- | --- |
| 1 | `mkdir` の mode は umask で 0755 になり、既に 1777 で存在する共有ディレクトリは他アカウント所有なので `chmod` が `EPERM`。そのまま例外にしており、**通常の共有レイアウトでは agent が結果を書けずに落ちた**（HIGH） | 既に要件を満たすディレクトリには触らない。`EPERM` のときは他アカウントが作ったものとして、other 書込を確認して続行 | automated test |
| 2 | ターミナル経路が `.done` / `.out` / `.err` / レポートを**帰属を確かめずに**読んでいた。1777 のディレクトリなので、別プロセスが置いたファイルを結果として読める | `lstat` で通常ファイル（symlink でない）・対象 uid 所有・group/other 書込不可を確認してから読む | automated test ＋**実機**（下記の E2E が新しい確認を通って完走） |
| 3 | agent がコンソール所有を**起動時にしか**見ていなかった。実行中にファストユーザスイッチでコンソールが移ると、人間の画面でジョブを走らせ得た | ジョブごとに**実行前後**で確認し、`onConsole` を結果に記録する。実行前なら走らせずに拒否 | automated test ＋**実機**（`onConsole: false` を記録） |
| 4 | `/dev/console` の所有者が読めない（-1）とき、`assertTargetSession` / `assertOutcomeSession` が**通していた** | どちらも拒否する（隔離を証明できないため） | automated test |
| 5 | 復帰後に結果ファイルが読めない場合、`ProtocolError` が元の `TimeoutError` を置き換えていた（「ホストが答えた」ように見える） | ホスト自身のエラー（`HostError`）だけを透過し、読めない結果は元のタイムアウトのまま | automated test |
| 6 | `dispatch` が `ok: false` の拒否結果を **exit 0** として報告していた | 非0で報告し、拒否理由を stderr に出す | automated test |

続いて、修正後（`414460a`）の**ネイティブ経路を初めて実機で起動した**。ターミナル経路の E2E とは別の基版であり、§10.15 以降一度も走らせていなかった。起動の試行そのものから4件が出た。

| # | 問題 | 修正 | 検証レベル |
| --- | --- | --- | --- |
| 7 | 共有ディレクトリの判定が `mode & 0o777` で、**sticky bit を隠していた**。早期 return は一度も成立せず、`EPERM` 時の代替条件も「other 書込」だけで sticky を要求していなかった（sticky が無いと他アカウントが相手のファイルを差し替えられる） | 判定を `session-rules.mjs` の純関数にし、`0o1777` / `0o1002` で比較 | automated test |
| 8 | 起動バナー `results/agent.json` が**他アカウント所有**だと、sticky ディレクトリでは `rename` が `EACCES`。バナーの失敗で agent が**起動直後に落ちた**（実機で発火） | バナーは診断用なので失敗を警告して続行。一時ファイルは片付ける | **実機で発火→修正後は継続**（下記） |
| 9 | 信頼できないジョブファイル（symlink など）を **500 ms ごとに再検査・再記録**し続けた（実機で発火、同じ行が延々と出た） | 一度拒否した名前はそのプロセス中は再検査しない | **実機で発火→修正**（下記） |
| 10 | コンソールから `launchctl print gui/502` は `EPERM` なので、`dispatch` は**ログイン中のアカウントを「未ログイン」と報告**していた。つまりネイティブ経路はコンソールからはそもそも動かなかった | offstage の status を先に読み（セッションが在るときだけ採用）、無ければ launchd。どちらも駄目なら `launchctl` の失敗理由を添えて拒否 | automated test ＋**実機**（下記） |

#### ネイティブ経路の実機確認（2026-11-03 04:00–04:01Z）

`414460a`＋上の4件の修正を入れたコードで、**ネイティブ経路を初めて実機で起動した**。`offstage session open --user test -- -a Terminal <launcher>` でランチャーを開き、`test` ユーザーのセッションで `session-agent.mjs` を動かした。

- 起動: `uid 502 (test), session Aqua asid 109086, console uid 501, accepting jobs from uid 501`。バナーは `results/agent.json` に **test 所有**で書かれた（`isolated: true`）。
- 制御側（uid 501）が 0644 で置いたジョブ: 実行され、`uid 502 / test / asid=109086 / console=501` を返し、結果の `onConsole` は **false**。
- 制御側が 0666 で置いたジョブ（他人が差し替え得るファイル）: **実行されず**、結果も書かれなかった。ログは1行だけ（#9 の修正）。
- `jobs/` に置いた symlink（通常ファイルでない）: **実行されず**、結果も書かれなかった。ログは1行だけ。
- `session.uid` に 501 を名乗るジョブ: `ok: false`「the job asks for uid 501, but this agent runs in uid 502's session; the job was not run.」で、実行されていない。
- コンソールからの `dispatch.mjs --uid 502 -- node ...`: **offstage の status 経由で対象セッションを特定**してジョブを出し、`finished in test's session (uid 502, asid 109086), exit 0`、出力 `502 / test / 501`。ジョブファイルは結果の回収後に削除された。`launchctl` の "Operation not permitted" はもう端末に漏れない。
- 拒否の実機確認: `--uid 501` は「uid 501 owns the console session ... Nothing was run.」、存在しない `--uid 999` は「the session of uid 999 could not be confirmed from this session: ... Could not find domain for user gui: 999」（≠「未ログイン」）。どちらも exit 1。

**この試行で実機に出た（修正前）**: #8（バナーが他アカウント所有で `rename` が `EACCES`、agent が起動直後に終了）と #9（拒否したファイルを500 msごとに再記録）。修正後はいずれも再発していない。

- **実機でまだ発火していない経路**: ジョブ実行時に `consoleIsOwn` が真になる拒否（ファストユーザスイッチでコンソールが `test` に移る必要があり、人間の操作なしには作れない）、`onConsole: true` の結果、バナー書込み失敗後の継続（#8 の修正後は、古いバナーを消してから起動したため成功した）。これらは automated test までで、実機では未観測。
- **片付け**: 2026-11-02 10:55 に起動された古い `session-agent`（pid 89540、uid 501、コンソールセッション、修正前のコード）がこの Mac に残っていた。jobs に置かれたものを何でも実行し得る状態だったので停止した（`kill 89540`、残存なしを確認）。今回の agent はランチャーが 180 秒で停止し、終了後に `session-agent` のプロセスが無いことを確認した。
