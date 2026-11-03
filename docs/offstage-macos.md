# macOS: 別OSユーザーのセッションで隔離実行する（#49）

**状態: 実装済み・実機受入は未完了（人間の手順待ち）。**
通常の `AfterEffects.launch()` は変えていない。隔離はオプトイン。Windowsには適用しない。

到達した検証レベル（2026-11-02 このMacで実測）:

| 項目 | 状態 |
| --- | --- |
| offstage の配布物・CLIの監査と実行確認 | `verified on real host` |
| 別ユーザーのAquaセッションの生成・操作 | `verified on real host`（test uid 502 / asid 107488。コンソール所有者は uid 501 のまま） |
| 隔離セッションでのAe起動 | `verified on real host`（AE 26.5.0 が test セッションで起動した。§10.9 のとおり Ae がスクリプト実行を拒否するため readiness probe は未通過） |
| 隔離E2Eパイプライン全体（セッション特定 → 別ユーザのTerminalで起動 → 実行 → 結果をコンソール側へ） | `implemented`＋**`fake/mock only`**。§10.11 のとおりパイプライン自体は実機で通るが、最後のAe呼び出し（`app.info`）で止まっており、**E2Eは1件も完走していない** |
| Apple Events の配送先が対象ユーザーのAeであることの実測 | `verified on real host`（§10.9: `count documents` が `0`、TCCの拒否 `-1743` ではない） |
| GUIフォールバックによるダイアログクローズ | `UNVERIFIED`（test セッションの AX 許可が未了。実Aeのモーダルでの実測は未実施） |
| フォーカスの通常ユーザーへの干渉 | `implemented`＋**フォーカスとカーソル移動は実測 0 件**。キー入力は**未監視**なので 0 件とは断定しない |

「fake/mock only」を「動作する」とは書かない。上の表のとおり、未検証は未検証と書く。
**§10.9 のとおり、残り Ae 自身の「スクリプト実行の許可」（GUI での人が操作）と test セッションの Accessibility 許可が下りれば実機受入に進める。それまでは macOS 隔離経路は `implemented`＋`fake/mock only` のままである。**

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
- `isInsideSession`: uid と asid の**両方**が一致しない对方的セッションはForeign。

`src/driver/script-invocation.ts`:

- プロセス一覧を `ps -axo pid=,uid=,lstart=,comm=` で取り、**uid で絞り込む**。
- macOS でも `verifiesDestination` を true に（セッションマーカーで「応答したインスタンス」が自分のprobeの物だと証明できる）。
- `osascript` の DoScriptFile は**対象セッションの中で**実行する。宛先不明なら拒否。
- `recoveryTargetPid()`: **probe が応答する前に**、この transport が出したホストの pid を返す。macOS の `DoScriptFile` は **Ae をオンデマンド起動する**ので、`launch()` は何も起動せず、Ae は最初の DoScriptFile で現れる。所有権（`#owned`）は probe 成功後の `confirmLaunched()` でしか立たないため、起動モーダルで probe がタイムアウトすると pid を知れず、GUI 復旧が「ホストプロセス無し」で終わって**生きた Ae を放置していた**。起動開始後に現れ、起動前に動いていなかった Ae が**ちょうど 1 個**ならその pid を返す（0個・2個以上はclaimerしない）。**所有権そのものは従来どおり probe の証明を要求する**（quit は fail-closed のまま）。

`src/driver/gui-recovery.ts`（新規）と `src/driver/recovery.ts`（新規）:

- Accessibility を先に、座標は**対象セッションのAXフレーム**から得る。対象セッションの画面情報はAX（そのセッション内で取得）であり、物理ディスプレイではない。
- 押せるボタンは `OK / Cancel / Close / Dismiss` のみ。押せない時は**報告だけ**。
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
- 現在 Ae の**標準ダイアログ**（ライセンス・警告等）を実機で開いて閉じられるかどうかは未検証。

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

1 回目で原因が分かった: macOS の `DoScriptFile` は Ae をオンデマンド起動し、`#owned` は probe 成功後の `confirmLaunched()` でしか立たないため、probe が落ちると pid を知れなかった。これを `recoveryTargetPid()` で直した（§4）。所有権の証明自体は緩めていない。

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
