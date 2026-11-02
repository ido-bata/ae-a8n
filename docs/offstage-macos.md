# macOS: 別OSユーザーのセッションで隔離実行する（#49）

**状態: 実装済み・実機受入は未完了（人間の手順待ち）。**
通常の `AfterEffects.launch()` は変えていない。隔離はオプトイン。Windowsには適用しない。

到達した検証レベル（2026-11-02 このMacで実測）:

| 項目 | 状態 |
| --- | --- |
| offstage の配布物・CLIの監査と実行確認 | `verified on real host` |
| 別ユーザーのAquaセッションの生成・操作 | `verified on real host`（test uid 502 / asid 258。コンソール所有者は uid 501 のまま） |
| 隔離セッションでのAe起動 | `verified on real host`（AE 26.5.0 が test セッションで起動した。ただし起動モーダルで応答せず） |
| Apple Events の配送先が対象ユーザーのAeであることの実測 | `UNVERIFIED`（test セッションの Automation 許可が未了で -1743。実測できていない） |
| GUIフォールバックによるダイアログクローズ | `UNVERIFIED`（test セッションの AX 許可が未了。Aeのダイアログは AX に現状出ない） |
| フォーカスの通常ユーザーへの干渉 | `implemented`＋**フォーカスとカーソル移動は実測 0 件**。キー入力は**未監視**なので 0 件とは断定しない |

「fake/mock only」を「動作する」とは書かない。上の表のとおり、未検証は未検証と書く。
**テストユーザーの Adobe サインインが未了のため、Aeの起動モーダル（`警告`）は人間の手で解く必要がある。**

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

このMacの現在地（2026-11-02）: `test` (uid 502) のアカウントは存在し、**高速ユーザー切替でログイン済みの Aqua セッション（asid 258）**がある。`offstage session status --user test` は **session lane available**。デーモン `offstage-sessiond` (pid 15768) も応答する。共有済み（`/Users/Shared/ae-a8n`）。

したがって残る手順は**権限の承認と Adobe のサインイン**だけで、代理にはできない。

1. **高速ユーザー切替で `test` に切り替える**（`rebui` からはログアウトしない）。
2. `test` セッションの画面で、保留中の TCC プロンプトを許可する:
   - **画面収録**（Screen Recording）— 保留中のプロンプト（題名 `画面収録`）が既に画面にある。
   - **ユーザー補助機能**（Accessibility）。
   - **自動化**（Automation）: `ターミナル` → `Adobe After Effects 2026`、および `ターミナル` → `System Events`。これが無いと DoScriptFile が `-1743` で失敗する（実測済み）。
   - 対象は `offstage-sessiond` ではなく **`ターミナル`**（§10.2）。`offstage-sessiond` は bundle が無く設定に現れない。
3. `test` ユーザーで **Adobe にサインインする**（Ae の起動モーダル `警告` を解くため）。通常ユーザーでAeを使っていない時に行う。Adobe ID・パスワード・トークンは代理が扱うことも保存することもない。
4. **コンソール（`rebui`）へ戻す**（`test` 側は**ログアウトしない**。ログアウトするとセッションごと消える）。

その後、`scripts/isolated-session/ae-e2e.mjs` を隔離セッションで走らせる:

```sh
node scripts/isolated-session/run-in-isolated-session.mjs \
  --user test \
  --report /Users/Shared/ae-a8n/e2e-report.json \
  -- node /Users/rebui/work/ae-a8n/scripts/isolated-session/ae-e2e.mjs \
       --pkg /Users/Shared/ae-a8n/pkg \
       --report /Users/Shared/ae-a8n/e2e-report.json
```

**注意**: このランナーは「どのユーザーでも Ae が起動中なら拒否」する（Adobe の制約）。拒否された場合は AE 69349 を**手で**終了してから走らせる（代理が kill することはしない）。

## 9. 既知の限界

- セッション分離であって**機械分離ではない**。同じカーネル・同じディスク・同じGPU。VM相当のセキュリティ境界ではない。
- ヘルパーは `0750` の `~` の外側にある。テストコードと fixture は `offstage session share` で読ませる必要がある。
- AX は Ae の**メインウィンドウ**を返さない（実測: Aeは AX 上で 0 windows。`CGWindowList` には出ている）。そのため GUI フォールバックは Ae 本体ではなく**ネイティブダイアログ**を対象にする。
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
| テストユーザー | `test` uid 502 / Aqua asid 258 / ログアウトなしでバックグラウンドに存在 |
| コンソール所有者 | uid 501 (`rebui`) — テスト中も変わらず |
| 隔離セッションの Ae | pid 69349（uid 502）、起動は `DoScriptFile` によるオンデマンド起動 |

### 10.2 TCC: responsible process が bundle でないと比較定されない

- `offstage-sessiond` は **bundle を持たない Mach-O** なので、System Settings に現れない。launchd を responsible process とするプロンプトは**画面にも設定にも出ない**。
- そこで、**ヘルパーセッションの中で Terminal.app を responsible process にする**（Terminal は bundle）。これで設定に現れ、許可は子孫（node / osascript / screencapture）に継承される。実測で、テストセッション内に `universalAccessAuthWarn`（pid 15871 / onscreen=1 / 题名 `画面収録`）が存在することを確認した。**ダイアログは出ていた。(test セッションの画面上にあっただけだった)**
- ただし **Automation（Apple Events）は Accessibility とは別の権限**で、別のプロンプトである。実測: `osascript → System Events` は `-1743`（`System EventsにApple Eventsを送信する権限がありません`）。

### 10.3 テストユーザーは Adobe にサインインしていない

- `/Users/test/Library/Application Support/Adobe/OOBE/logged_out_guid` が存在する = **未サインイン**。
- Creative Cloud の計測ログ: `ccd.signinWorkflow: SIGN_IN_WORKFLOW` / `ccd.signinErrorState: IMS_NETWORK_ERROR_STATE` / `ccd.network_state: OFFLINE`。
- 結果として Ae は起動モーダル（`CGWindowList` の layer=8, 题名 `警告`, 440×262）を持って止まり、`app.info` が応答しない。
- これは**人がやる操作**（Adobe ID でサインイン）。代理は Adobe ID・パスワード・トークンを扱わず、ログにも残さない。別デバイスのライセンスは絶対に自動解放しない。

### 10.4 隔離E2Eの実測（2回）

| 回 | 時刻 (UTC) | 結果 | 証跡 |
| --- | --- | --- | --- |
| 1 | 03:31–03:35 | FAIL。Ae は起動した（pid 69349）が probe が応答せず、GUI 復旧が「ホストプロセス無し」で終了 | `sessions/run-1793590265115/trace.jsonl` |
| 2 | 04:22:38–04:23:49 | FAIL。**`-1743: Adobe After Effects 2026にApple Eventsを送信する権限がありません`**（Automation 許可が未了） | `sessions/run-1793593358745/trace.jsonl` |

1 回目で原因が分かった: macOS の `DoScriptFile` は Ae をオンデマンド起動し、`#owned` は probe 成功後の `confirmLaunched()` でしか立たないため、probe が落ちると pid を知れなかった。これを `recoveryTargetPid()` で直した（§4）。所有権の証明自体は緩めていない。

### 10.5 フォーカスの非干渉（実測）

- 観測方法: コンソールセッション（uid 501）で `focus-watch` を動かし、**約 0.2 秒ごとに frontmost アプリ名・pid とポインタ座標**を記録。E2E 実行の前後を覆う区間を取った。
- 観測区間: epoch 1793593355.83 – 1793593490.64（**134.8 秒**, 652 サンプル）。E2E の実行区間（04:22:38–04:23:49Z）を完全に含む。
- 結果: frontmost アプリは **Vivaldi (pid 50401) の 652 サンプルすべて**。ポインタ座標は **全サンプルで (1267, 236) 固定**。
- よって **フォーカスの奪取 0 件・意図しないカーソル移動 0 件**（この観測範囲では）。
- **キー入力は観測していない。** `focus-watch` は frontmost とポインタしか記録しない。よって**意図しないキー入力 0 件とは断定しない**（`0` と書くのは監視できていない項目）。
- 別ユーザーへの GUI 操作の配送も 0 件（隔離セッションの操作は `launchctl asuser` / offstage のセッション内で完結し、コンソールセッションの Accessibility は使っていない）。
