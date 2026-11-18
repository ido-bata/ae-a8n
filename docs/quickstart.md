# クイックスタート: npm から使う一般ユーザー向け導入手順（#128）

対象読者: `@ido-bata/ae-a8n` を npm で入れて、自分のマシンの After Effects を
スクリプトから動かしたい人。開発者専用の隔離セッション手順ではなく、
**ローカルの script-invocation 経路**（`AfterEffects.launch()`）の話。

隔離セッション（`ae-a8n test` / `setup` / `--user` / `--host`）の手順は
[docs/isolated-testing.md](isolated-testing.md)（helper user の運用）、
[specs/isolated-ae/quickstart.md](../specs/isolated-ae/quickstart.md)、
[docs/offstage-macos.md](offstage-macos.md) を参照。詰まった時は
[docs/troubleshooting.md](troubleshooting.md) の判断木から。そちらは「他人の
デスクトップに触れない」ことを目的にした別モードで、保証の強さが違う。

## 全体の流れ

```text
npm install → ae-a8n doctor → 人間による許可 → 初回 launch → version 確認 → close
```

各段階で止まったら、その段階の「詰まった時」を読んでから先へ進む。
**doctor は何も変更しない**: AE の起動・終了、TCC・SIP・AE 設定・同意状態の
変更、権限の自動承認は一切行わない。読めなかった事実は推測せず
`unproven`（証明できていない）として報告する。

## 1. インストール

```bash
npm install @ido-bata/ae-a8n@next
```

Node 22 以上が必要。`@next` dist-tag の公開済み最新版は `0.1.0-alpha.2`。
`0.2.0` は `next` 向け公開予定の早期リリース（`0.x`、`latest` は
`0.1.0-alpha.0` のまま）。in-AE dispatcher 経路は macOS AE 26.5.3 で
実機検証済み・Windows は未検証。公開後は
`npm view @ido-bata/ae-a8n@next version` で確認する。詳細は README の
早期リリース注記。

## 2. 初期診断

```bash
npx @ido-bata/ae-a8n doctor
```

引数なしの `doctor` は **local intent** で動く: 対象は「いまこのコマンドを
実行している自分のセッション」なので、隔離セッション用の
「コンソールセッションと分離されているか」系のチェックは出ず、
**すでに起動している After Effects は blocker ではなく info**
（`A8N-AE-009`）として報告される。ローカル起動は動作中の AE に
`attached` で接続するのが正常なため。

```bash
npx @ido-bata/ae-a8n doctor --json   # stdout に JSON 1 文書だけ
npx @ido-bata/ae-a8n doctor --user ae-test   # 隔離セッション intent（session チェック有効）
```

終了コード: `0` = blocker なし、`3` = blocker あり。warning や info
（`unproven` の報告を含む）は失敗にしないが、必ず目を通すこと。

ローカル導入で doctor が見る主な項目:

| コード | 重大度 | 意味 |
| --- | --- | --- |
| `A8N-ENV-003` | blocker | After Effects が見つからない |
| `A8N-AE-006` | blocker | AE のスクリプティングコンポーネントがインストール内に無い（macOS で実測。AE 2027 で発生） |
| `A8N-PERM-003` | blocker | 「スクリプトによるファイル/ネットワークアクセス」が OFF（macOS の `Pref_SCRIPTING_FILE_NETWORK_SECURITY = "0"`） |
| `A8N-PERM-007` | warning | 上記設定値が読めなかった = 許可状態は `unproven`（推測しない） |
| `A8N-PERM-008` | warning | スクリプト実行の承認（トラスト）状態は `unproven`。承認粒度（フォルダ単位かファイル単位か）は #125 で計測中 |
| `A8N-AE-007` | warning | スクリプティングコンポーネントはファイルの存在までしか証明できない。AE が実際にロードするかは起動してみるまで `unproven` |
| `A8N-AE-008` | info | ユーザー別 `Scripts/Startup` フォルダの状態。存在は起動時実行の証明ではない |
| `A8N-AE-009` | info | AE がすでに起動している。ローカル起動はそれに接続する |

Windows では ExtendScript コンポーネントの配置・スクリプト承認・
Startup フォルダ相当の実行は**未検証**であり、doctor はそれらを
`unproven` として報告する（macOS の挙動を仮定しない）。

## 3. 人間がやる許可（doctor は代行しない）

macOS でスクリプト実行に必要な関門は **2〜3 個**あり、別々に効く:

1. **スクリプティングコンポーネント**（AE 本体の構成要素）
   Creative Cloud で AE を修復/再インストール。`A8N-AE-006` が出たらこれ。
2. **ファイル/ネットワークアクセス許可**
   AE の **Settings → Scripting & Expressions → "Allow Scripts to Write Files
   and Access Network"** を ON。OFF のままだと最初の呼び出しがタイムアウト
   する（`A8N-PERM-003`）。
3. **スクリプトの実行承認（トラスト）**
   AE 26.5+ は未承認の場所の `DoScriptFile` を `-1708` で拒否し、モーダルを
   出す。初回起動時に AE が促すので、その場で承認する。**承認の粒度
   （フォルダ単位かファイル単位か）は未計測**（#125）なので、新しい
   セッションディレクトリごとに再度求められる可能性がある。
   `sessionRoot` をプロジェクトごとに 1 つに固定するとプロンプトを減らせる。

Windows での同等の手順は未検証。詰まったら doctor の `unproven` 報告と
`remedy` をそのまま人間向け手順として使う。

## 4. 初回起動

```ts
import { AfterEffects } from "@ido-bata/ae-a8n";

const ae = await AfterEffects.launch();
const info = await ae.info();   // または ae.version()
console.log(info);
await ae.close();
```

- `launch()` は readiness probe が通るまで待つ。既定の予算は
  **180 秒**（`READINESS_TIMEOUT_MS`）。コールド起動がこれを超えることが
  ある（実測で約 171 秒の例あり、余裕は小さい）。タイムアウトするなら
  `AfterEffects.launch({ readinessTimeoutMs: 300_000 })` のように延ばす。
- 起動済みの AE があれば `attached`（既存プロセスに接続）、無ければ
  `owned`（このセッションが起動）。`ae.ownership()` で確認できる。
- `sessionRoot` を省略すると一時ディレクトリが使われる。ステージング
  フォルダの承認を安定させたい場合はプロジェクト配下など固定パスを渡す
  （空白を含まないパスにすること）。

## 5. 終了

```ts
await ae.close();                            // 未保存変更があれば拒否される
await ae.close({ unsavedChanges: "discard" }); // 自分が作った変更を捨てる時だけ
```

- `close()` は `owned` の時だけ AE を終了する。`attached` では
  `{ quit: false, reason }` を返し、**ユーザーが開いていた AE を
  勝手に落とさない**。
- 未保存の変更は既定で破棄しない（`UnsavedChangesError`）。他人の
  プロジェクトを開いた場合は特に、コピーを開くこと。

## 6. アンインストール / 無効化

- パッケージを外す: `npm uninstall @ido-bata/ae-a8n`。
  `~/.ae-a8n/`（CLI の状態・実行記録）と一時セッションディレクトリは
  残るので、不要なら手動で消す。
- AE 側の許可を戻す: Scripting & Expressions の
  "Allow Scripts to Write Files and Access Network" を OFF に戻す。
  スクリプト承認の記録は AE 側の設定なので、AE の設定画面から確認・解除する。
- このパッケージは AE の設定・TCC・SIP を一切変更しないので、
  「無効化」= パッケージを呼ばない or 上記 pref を OFF、で足りる。

## 7. 再起動後の再接続

- Mac/PC を再起動した後は、そのまま `AfterEffects.launch()` を呼べばよい。
  AE が残っていなければ新規に `owned` で起動し、残っていれば `attached`。
- `attached` のまま作業を続ける場合、前回セッションの `sessionRoot` とは
  別の一時ディレクトリになる。永続的に使うなら `sessionRoot` を固定する。
- うまくいかない時はまず `ae-a8n doctor` を再実行する。権限や AE の
  バージョンが変わっていれば `unproven`/`blocker` として出る。

## 8. in-AE dispatcher モード（opt-in・macOS 実機検証済み / Windows 未検証）

既定の script-invocation に加えて、**人間が AE 内で一度だけ有効化する dispatcher 経路**がある（`transport: "in-ae-dispatcher"`）。呼び出しごとの OS automation を通常経路から外す opt-in で、dispatcher が応答しなくても script-invocation へ fallback しない。

```sh
npx @ido-bata/ae-a8n dispatcher prepare   # channel と activate.jsx を用意（冪等）
# → 起動済みの AE で File > Scripts > Run Script File → activate.jsx（人間の操作）
npx @ido-bata/ae-a8n dispatcher status    # 接続確認。blocked/unknown は pass ではない
```

```ts
const ae = await AfterEffects.launch({ transport: "in-ae-dispatcher" });
```

- dispatcher session は常に `attached`（所有権を証明できない）で、**`ae.close()` は AE を終了しない**。操作には `authorization` の明示 grant が要る。
- 起動時の自動有効化は `dispatcher startup install`（per-user `Scripts/Startup`。macOS AE 26.5 では起動時自動 activation を実機確認済み。Windows は未検証）。
- `ae-a8n doctor` は script-invocation 経路と環境の診断。dispatcher の生死は `dispatcher status` が見る。
- 詳細と契約は [docs/in-ae-dispatcher.md](in-ae-dispatcher.md)。

## 9. 詰まった時

- doctor の各チェックには `remedy`（人間向けの直し方）が付く。
  `--json` で `checks[].evidence` を見れば、何を読んでそう判断したかが分かる。
- `unproven` は「悪い」ではなく「測れなかった」。推測で成功扱いには
  しない設計なので、unproven が残る場合は実際に launch して確かめる。
- タイムアウトや `-1708`（スクリプト拒否）が出たら §3 の許可を確認。
- 詳しい検証状況は [docs/verification.md](verification.md)、
  実行モードの設計は [docs/adr/0003-ae-execution-modes.md](adr/0003-ae-execution-modes.md)。
