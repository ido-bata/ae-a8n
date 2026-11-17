# In-AE dispatcher transport（opt-in）

Tracking: [#127](https://github.com/ido-bata/ae-a8n/issues/127)。前提となる proof: [#98](https://github.com/ido-bata/ae-a8n/issues/98) / `docs/inprocess-proof.md`。実行モデル: [ADR-0003](adr/0003-ae-execution-modes.md)、`specs/execution-model/spec.md`。

**検証レベル: `automated test` + `fake/mock only`。実機 AE での受入は未検証（unproven）であり、本 transport の capability は `verified-real-host` を名乗らない。**

## これは何か

`script-invocation`（既定: `AfterFX.exe -r` / `osascript DoScriptFile` を毎回起動する経路）に対し、**人間が一度だけ AE 内で有効化した ES3 dispatcher** が `host/a8n-host.js` の named-operation dispatch table をそのまま使ってリクエストを処理する transport。Apple Events・`DoScript`・GUI 前面化・呼び出しごとの OS automation を通常経路から外すための opt-in である。

明示的に選んだ時だけ使われる。`LaunchOptions.transport` を省略すれば従来どおり `ScriptInvocationTransport`。dispatcher が応答しなくても script-invocation へ自動 fallback しない。

## 有効化（初回は必ず手動）

1. Node 側で channel を準備する。`AfterEffects.launch({ transport: "in-ae-dispatcher" })` は channel dir（既定 `~/.ae-a8n/dispatcher`）を自動で用意し、`<channelDir>/activate.jsx` を生成する。
2. **人間が**、起動済みの AE で **File → Scripts → Run Script File** を選び `activate.jsx` を実行する。これが第一の activation 経路であり、自動化しない。
3. dispatcher は `app.scheduleTask` で定期的に `<channelDir>/inbox/*.request.json` を poll し、claim（`.claimed` へ rename）→ token/id/method/deadline 検証 → named method 実行 → `<channelDir>/outbox/*.result.json` へ atomic publish する。
4. `<channelDir>/state.json` が heartbeat として書かれる。Node 側はこれが新しい間だけ「応答中」とみなす。

同一 AE 内で二重に有効化しようとすると `__a8nDispatcherTask` ガードにより拒否される。

## Startup への設置（任意・実機未検証）

per-user の `Scripts/Startup` に `a8n-dispatcher.jsx` を置くと AE 起動時に自動有効化される設計だが、**startup 実行そのものは実機未検証（unproven）**。macOS の `~/Library/Preferences/Adobe/After Effects/<メジャー.マイナー>/Scripts/Startup`、Windows の `%APPDATA%\Adobe\After Effects\<メジャー.マイナー>\Scripts\Startup` に配置される。

API からは `DispatcherTransport.installStartupScript()` / `uninstallStartupScript()`。自分が生成した marker を持つファイルだけを上書き・削除し、無関係なファイルは拒否する。グローバルな scripting 権限や TCC 設定は一切変更しない。権限ダイアログが出た場合の承認は常に人間が行う。

## 無効化

- dispatcher 自体は AE を終了しない。`ae.close()` / `driver.stop()` は ownership が `attached`（証明不可）のため `quit: false` で返る。
- channel を止めるには `state.json` の `instance` が変わるまで待つか、AE を再起動する。Startup 設置済みなら `uninstallStartupScript()` で除去する。
- `<channelDir>` は mode `0700`、request/result は `0600` で作られる。POSIX で group/other から読める dir・symlink は拒否される。

## Node 側の契約

- `kind: "in-ae-dispatcher"`、リクエストごとに一意な id、channel token（`channel.json`、64hex）を envelope に注入。
- **同時 in-flight は 1 件**。2 件目の `invoke` は `ScriptNotSentError`。
- dispatcher の応答は id が一致した時だけ session outbox へ橋渡しされる。
- `verifiesDestination = true` のため、probe は `session.adopt`、probe 以降の全 call は `session.require` マーカーを伴う。dispatcher は probe に応答した**同一の AE エンジンインスタンス**でのみ後続要求を実行する（host の `__a8nSessions` store による per-instance 強制）。これは「どのプロセスか」の証明ではなく、「probe に答えたエンジンと同じエンジンか」の保証に留まる。
- **timeout は `UNKNOWN`**。リクエストは削除も再送もしない。再送すると二重実行になり得るため、呼び出し側は結果不明として扱う。
- stale（deadline 超過）・id 不一致・token 不一致・未知 method は dispatcher が `ok:false` で拒否し、**実行しない**。

## 診断

- `ae.capabilities()` は dispatcher 選択時、全 capability の verification を `automated-fake` 以下に丸め、`dispatcher-transport-unverified` diagnostic を出す。`host.executionMode` は `local`、`target.ownership` / `nonInterference` は `unknown` / `unproven`。
- heartbeat が止まると `available()` が false になり、`launch()` は activation 手順を示す `HostUnavailableError` で失敗する。
- channel に残った `.request.json` は「届いたが応答が無い/未 claim」要求。outbox に同名 `.result.json` が無ければ未実行または結果未着と判断できるが、**timeout 後に結果が後から来る可能性を排除できない**点に注意（これが UNKNOWN の理由）。

## 既知の限界（unproven）

- 実機 AE での activation・`app.scheduleTask` の polling 間隔・負荷時の挙動・Startup 自動実行はすべて未検証。
- token は同一 OS ユーザーの別プロセスに対する強い認証ではない。channel dir の privacy が実質の防御。
- dispatcher は「どの AE プロセスが受け取ったか」を証明しない。ownership・non-interference の証拠にはならない。
- 複数 AE インスタンスが同一 channel を見る可能性があり、その場合の振る舞いは未定義（先着 1 件が claim）。
