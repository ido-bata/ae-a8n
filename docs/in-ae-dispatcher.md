# In-AE dispatcher transport（opt-in）

Tracking: [#127](https://github.com/ido-bata/ae-a8n/issues/127)。前提となる proof: [#98](https://github.com/ido-bata/ae-a8n/issues/98) / `docs/inprocess-proof.md`。実行モデル: [ADR-0003](adr/0003-ae-execution-modes.md)、`specs/execution-model/spec.md`。

**検証レベル: dispatcher scenario（handshake・編集・render・extension call・認可/instance pin 拒否・pinned reconnect・安全終了）と `Scripts/Startup` 自動 activation は macOS AE 26.5.3（`26.5.3x9`）で `verified on real host`（2026-11-17、packed-consumer real lane）。Windows real-host は未検証であり、この記録は全 platform の保証を意味しない。`ae.capabilities()` が報告する検証レベルの丸めは従来どおり。**

## これは何か

`script-invocation`（既定: `AfterFX.exe -r` / `osascript DoScriptFile` を毎回起動する経路）に対し、**人間が一度だけ AE 内で有効化した ES3 dispatcher** が `host/a8n-host.js` の named-operation dispatch table をそのまま使ってリクエストを処理する transport。Apple Events・`DoScript`・GUI 前面化・呼び出しごとの OS automation を通常経路から外すための opt-in である。

明示的に選んだ時だけ使われる。`LaunchOptions.transport` を省略すれば従来どおり `ScriptInvocationTransport`。dispatcher が応答しなくても script-invocation へ自動 fallback しない。

## 有効化（初回は必ず手動）

1. Node 側で channel を準備する。`AfterEffects.launch({ transport: "in-ae-dispatcher" })` は channel dir（既定 `~/.ae-a8n/dispatcher`）を自動で用意し、`<channelDir>/activate.jsx` を生成する。
2. **人間が**、起動済みの AE で **File → Scripts → Run Script File** を選び `activate.jsx` を実行する。これが第一の activation 経路であり、自動化しない。
3. dispatcher は `app.scheduleTask` で定期的に `<channelDir>/inbox/*.request.json` を poll し、claim（`.claimed` へ rename）→ token/id/method/deadline 検証 → named method 実行 → `<channelDir>/outbox/*.result.json` へ publish する。publish は同一 dir の `.part` staging + rename を優先する（rename 3 回失敗時のみ in-place write に fallback — 後述）。
4. `<channelDir>/state.json` が heartbeat として書かれる。Node 側はこれが新しい間だけ「応答中」とみなす。

同一 AE 内で二重に有効化しようとすると `__a8nDispatcherTask` ガードにより拒否される。

## CLI lifecycle（#147）

機械化できる部分は `ae-a8n dispatcher` が担う。**activation（AE 内での Run Script File）だけが人間の操作**で、それ以外の準備・確認・登録・解除は CLI が正確に案内する。

```sh
ae-a8n dispatcher prepare [--channel-dir <dir>]    # channel 作成 + activate.jsx 生成（冪等）
ae-a8n dispatcher status  [--channel-dir <dir>]    # heartbeat を正直に報告
ae-a8n dispatcher startup install|remove \
    --ae-version <v> | --install-dir <path>        # per-user Scripts/Startup への登録・解除
```

- `prepare` / `status` は `--json` で contract envelope（`schemaVersion`/`status`/`exitCode`/`nextActions`/`facts`）1 文書を出す。人間向けには同じ事実を短いテキストで出す。
- `prepare` の `nextActions` が「次に人間がやること」（Run Script File の対象パス、status での確認、スクリプト書き込み許可の同意）を列挙する。
- `status` は heartbeat の `instance` / `aeVersion` / 最終 tick からの経過時間 / 登録 extension method を報告する。**無応答は `blocked`（exit 3）、heartbeat 陳腐化は `unknown`（exit 6）であり、どちらも pass ではない**。
- `startup install|remove` は `--ae-version`（例 `26.5`）か `--install-dir`（macOS のみ、`.app`/install dir から version を導出）を要求する。他プラットフォームで installDir からの version 導出は未実装であり、Windows の Startup 実行自体が未検証（unproven）であることを出力も明記する（macOS では Startup 実行を実機確認済み）。
- `launch()` が dispatcher 不在で失敗する `HostUnavailableError` も、これらのコマンドと docs を次の手として示す。
- `ae-a8n doctor` との関係: doctor は script-invocation 経路と環境の診断であり、dispatcher の生死は `ae-a8n dispatcher status` が見る。doctor の blocker が無くても dispatcher が未 activation なら launch は案内付きで失敗する。

## Startup への設置（任意・macOS 実機検証済み / Windows 未検証）

per-user の `Scripts/Startup` に `a8n-dispatcher.jsx` を置くと AE 起動時に自動有効化される設計。macOS AE 26.5 では 2026-11-17 に起動時自動 activation と heartbeat 生成を実機確認済み。Windows の Startup 実行は未検証（unproven）。macOS の `~/Library/Preferences/Adobe/After Effects/<メジャー.マイナー>/Scripts/Startup`、Windows の `%APPDATA%\Adobe\After Effects\<メジャー.マイナー>\Scripts\Startup` に配置される。

API からは `DispatcherTransport.installStartupScript()` / `uninstallStartupScript()`、CLI からは `ae-a8n dispatcher startup install|remove`。自分が生成した marker 行を持つファイルだけを上書き・削除し、無関係なファイルは拒否する。グローバルな scripting 権限や TCC 設定は一切変更しない。権限ダイアログが出た場合の承認は常に人間が行う。

## 無効化

- dispatcher 自体は AE を終了しない。`ae.close()` / `driver.stop()` は ownership が `attached`（証明不可）のため `quit: false` で返る。
- channel を止めるには `state.json` の `instance` が変わるまで待つか、AE を再起動する。Startup 設置済みなら `ae-a8n dispatcher startup remove`（API では `uninstallStartupScript()`）で除去する。除去は将来の AE 起動にだけ効き、稼働中の dispatcher は AE 再起動まで応答し続ける。
- `<channelDir>` は mode `0700`、request/result は `0600` で作られる。POSIX で group/other から読める dir・symlink は拒否される。

## Node 側の契約

- `kind: "in-ae-dispatcher"`、リクエストごとに一意な id、channel token（`channel.json`、64hex）を envelope に注入。
- **同時 in-flight は 1 件**。2 件目の `invoke` は `ScriptNotSentError`。
- dispatcher の応答は id が一致した時だけ session outbox へ橋渡しされる。
- `verifiesDestination = true` のため、probe は `session.adopt`、probe 以降の全 call は `session.require` マーカーを伴う。dispatcher は probe に応答した**同一の AE エンジンインスタンス**でのみ後続要求を実行する（host の `__a8nSessions` store による per-instance 強制）。これは「どのプロセスか」の証明ではなく、「probe に答えたエンジンと同じエンジンか」の保証に留まる。
- **timeout は `UNKNOWN`**。リクエストは削除も再送もしない。再送すると二重実行になり得るため、呼び出し側は結果不明として扱う。
- stale（deadline 超過）・id 不一致・token 不一致・未知 method は dispatcher が `ok:false` で拒否し、**実行しない**。
- result publish は atomic-or-fail ではない。dispatcher は `.part` staging + rename を優先するが、rename が 3 回失敗すると in-place write に fallback する（ExtendScript の制約上 atomic-only にできない）。driver は malformed/partial な result file を parse 失敗として読み飛ばし続けるため、torn read は latency にしかならず、持続的な partial write は timeout → `UNKNOWN`・非再送に収束する — native-channel/v1 intake の「atomic publish or fails」と outcome は同じ fail-closed 側に落ちるが、publish semantics 自体は意図的に異なる（`ae-devtools` `specs/ae-capability-coverage/contracts/native-channel.md` §5 は plug-in intake の契約であり、この dispatcher transport を拘束しない）。

## 診断

- `ae.capabilities()` は dispatcher 選択時、全 capability の verification を `automated-fake` 以下に丸め、`dispatcher-transport-unverified` diagnostic を出す。`host.executionMode` は `local`、`target.ownership` / `nonInterference` は `unknown` / `unproven`。
- heartbeat が止まると `available()` が false になり、`launch()` は activation 手順を示す `HostUnavailableError` で失敗する。
- channel に残った `.request.json` は「届いたが応答が無い/未 claim」要求。outbox に同名 `.result.json` が無ければ未実行または結果未着と判断できるが、**timeout 後に結果が後から来る可能性を排除できない**点に注意（これが UNKNOWN の理由）。

## 既知の限界（unproven）

- Windows での activation・`app.scheduleTask` の polling 間隔・負荷時の挙動・Startup 自動実行は未検証（macOS AE 26.5.3 では activation・通常負荷下の scenario・Startup 自動実行を確認済み）。
- token は同一 OS ユーザーの別プロセスに対する強い認証ではない。channel dir の privacy が実質の防御。
- dispatcher は「どの AE プロセスが受け取ったか」を証明しない。ownership・non-interference の証拠にはならない。
- dispatcher instance は「probe に答えたエンジンと同じ dispatcher か」の識別であり、プロセス同一性の証明ではない。instance が変われば別の AE（または再起動後の同じ AE）として扱う。

## 対象インスタンスの束縛（#145）

複数の AE が同一 channel を見る場合に備え、要求は宛先 dispatcher instance を名指しする:

- `launch()` は heartbeat の `instance` を読み、その session はその instance に束縛される。`{ kind: "in-ae-dispatcher", instance: "<id>" }` で過去の `ae.capabilities()` / `ae-a8n dispatcher status` が報告した instance に pin でき、異なる instance が応答した場合は `launch()` が拒否する（再接続時の対象識別）。
- 以後の全要求は `target` フィールドで束縛 instance を名指しする。dispatcher は `target` が自分と異なる要求を claim せず inbox に残す（本来の宛先が処理する）。`target` を持たない要求は従来どおり実行される。
- heartbeat が別 instance を報告し始めたら、transport は要求を書く前に `ScriptNotSentError` で拒否する。別 AE の dispatcher に誤配送しない。
- `ae.capabilities()` の `target.dispatcherInstance` / `host.id`（`dispatcher:<instance>`）がこの識別子を報告する。

## 操作認可（authorization grant、#145）

所有権・接続対象・操作認可は別の権限である。dispatcher session は常に `attached`（quit 権限なし）だが、`launch()` の `authorization` で操作クラスごとに明示的に認可できる:

```ts
AfterEffects.launch({
  transport: { kind: "in-ae-dispatcher", channelDir, instance },
  authorization: {
    extensionMethods: ["myext.ping"], // または true で宣言済み全 method
    menuCommands: true,
    hostEnvironment: true,
  },
});
```

- grant が無い（または該当 scope を含まない）非所有 session の `ae.call` / `menuCommand().execute()` / `hostEnvironment` は `HostNotOwnedError` で拒否される。拒否メッセージは不足している scope と付与方法を示す。
- grant は呼び出し側の同意を記録する caller-side の gate であり、AE host が独立に認証・認可するものではない（host 側の検査は従来どおり channel token）。grant は所有権を変更せず、quit を許可しない。`close()` は従来どおり owned のみ AE を終了する。
- grant は launch 時に snapshot され（caller が後から配列を変更しても効かない）、trace（`session.authorization` event）・`ae.capabilities()` の `target.grantedOperations` に記録され、session と共に終わる。再接続・別 instance への pin 変更では再度の認可が必要。
- `unknown` ownership（対象未証明）には grant は効かない。`attached`/`owned` が証明されるまで特権操作は拒否される。

## Static extension の有効化（#146）

`ae-a8n extension build` が生成した host script（header + registration prelude + shipped host）は、dispatcher transport でもそのまま使える。`launch({ hostScript, transport: "in-ae-dispatcher" })` で consumer が明示した静的拡張が channel に stage され、dispatcher activation 時に登録内容が固定される。通常の RPC から任意 JSX を評価する疑似メソッドは存在しない。

- `prepare()` は effective host script（`hostScript` 指定時はその byte 列、省略時は shipped `host/a8n-host.js`）を `<channelDir>/a8n-host.js` として配置し、`channel.json` に `hostScript: { sha256, methods, registration }` を記録する。`registration` は method 名+source の fingerprint で、同名でも body が違えば別物として検出できる。
- `activate.jsx` は従来どおり `<channelDir>/a8n-host.js` を eval する。生成物は header/prelude を含むため、activation 時に `__a8n.extensions` へ登録され、`__a8n.extensionsRegistration` に fingerprint が残る。
- heartbeat（`state.json`）は activation 時に固定された `extensionMethods`（実際に登録された method 名、sorted）と `extensionsRegistration` を報告する。dispatcher の寿命内で拡張集合は変わらない。
- `launch()` は staged manifest と heartbeat の登録集合を照合し、不一致なら `HostUnavailableError` で拒否する。**実行中の拡張変更は暗黙に採用されない**。復旧は AE 再起動後の再 activation（同一 AE 内での二重 dispatcher は host が拒否する）。
- `ae.extensionMethods()` / `ae.call` / `ae.capabilities()` が公開するのは heartbeat が報告した実登録集合であり、staged file の宣言ではない。`ae.call` には従来どおり `authorization.extensionMethods` の grant が必要で、hash/header の一致は実行権限の証明ではない。
- #146 以前の host で activation された dispatcher（heartbeat に拡張 field が無い）は、拡張を stage した session からは「証明できない」として拒否される。拡張なしの session とは従来どおり接続できる。

## 複数 dispatcher の競合ポリシー

同一 channel に複数の AE dispatcher が同時に応答し得る場合:

- `target` を持つ要求は名指しされた instance のみが claim するため、**誤配送は起きない**。heartbeat（`state.json`）は last-writer-wins で instance が入れ替わり得るが、それは pin 判定と `#assertTargetCurrent` の fail-closed 拒否にのみ使われ、配送先を変えない。
- ただし heartbeat が不安定な間は pin 不一致・instance 変更検知で `launch()` / `invoke()` が拒否し得る。**証明できない場合は拒否する**のが契約であり、正しい対応を推測して送らない。
- 複数 AE を同時に使う場合は AE ごとに別 `channelDir` を指定することを推奨する（`{ kind: "in-ae-dispatcher", channelDir }`）。
- `target` を持たない要求（旧 version の writer や外部ツール）は従来どおり先着の dispatcher が claim する。対象束縛の保証は `target` 付き要求にのみ適用され、混在 version での誤配送までは防げない。
