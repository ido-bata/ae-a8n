# スクリプト信頼承認の粒度を実測する（Issue #125）

AE 2026 (26.5) は信頼されていない場所のスクリプトを `DoScriptFile` で `-1708`
拒否し、設定 → スクリプトとエクスプレッション での人間の承認を求める
（実測: `docs/offstage-macos.md` §10.10）。承認の**粒度**（フォルダ単位か、
スクリプトファイル単位か、bundle 単位か）は未解決で、consumer が呼び出しごとに
新しい `sessionRoot/staging/` を使う以上、粒度しだいで無人実行の成立可否と
 driver の staging 設計が変わる。

この文書は、実機の Mac でその粒度を**非破壊に**測る手順である。測定には
`scripts/script-trust-probe.mjs` を使う。probe は AE の偏好ツリーを
**読み取りだけ**で走査し、ファイルのパス・サイズ・mtime・SHA-256 と、
`.txt` 偏好ファイル内のスクリプト／セキュリティ系 `"key" = "value"` を
記録する。AE・TCC・偏好ファイルへの書き込みは一切行わない。唯一の書き込みは
人間が指定した snapshot/diff JSON であり、走査対象の内側への出力は拒否する。

## 何を測るか

承認が下りたとき AE がディスクに何かを記録するなら、それは偏好ツリーのどこかに
現れるはずである。probe の既定の走査対象（macOS）:

- `~/Library/Preferences/Adobe/After Effects/` 以下すべて
  （`<ver>/Adobe After Effects <ver> Prefs.txt`、`…環境設定.txt`、
  `…-indep-*.txt` など。日本語環境ではファイル名がローカライズされるため、
  名前ではなくツリー全体を走査する）
- `~/Library/Preferences/` 直下で名前に `after effects` を含むファイル
  （`com.adobe.AfterEffects*.plist` 等。plist はハッシュのみ）

対象外（必要なら `--root <dir>` で追加する）:

- `~/Library/Application Support/Adobe/` — 許可リストがここにある可能性は
  低いが、diff が空だった場合の第二候補
- Windows のレジストリ — probe は未対応。Windows で測る場合は
  `HKCU\Software\Adobe\After Effects\<ver>` を人間が `reg query` で前後比較する

## 手順

AE を**終了した状態**から始める（AE は終了時に偏好ファイルを上書きするため、
実行中の snapshot は書き込み前の状態を写す）。

```sh
# 1. before snapshot（consumer を走らせる前）
node scripts/script-trust-probe.mjs snapshot --out /tmp/a8n-trust/before.json

# 2. consumer を1回実行し、AE の承認ダイアログで人間が承認する
#    （例: ae-test の isolated real-host consumer、または最小の
#     AfterEffects.launch + openProject 1回）

# 3. AE を終了させてから after snapshot を取る
#    （consumer が AE を閉じない場合は、人間が AE を quit する）
node scripts/script-trust-probe.mjs snapshot --out /tmp/a8n-trust/after.json

# 4. diff
node scripts/script-trust-probe.mjs diff /tmp/a8n-trust/before.json /tmp/a8n-trust/after.json
```

`--out` を省略すると JSON は stdout に出るだけである。snapshot は機微になり
うるパスや値を含みうるので、測定したマシンの外に持ち出さない。

### 粒度を分ける追加実験

1 回の before/after で「承認が何かを記録したか」は分かるが、粒度そのものは
次の操作で分ける:

- **フォルダ単位か**: `sessionRootA/staging` を承認した後、別の
  `sessionRootB/staging`（別パス）で consumer を実行する。ダイアログが
  再び出るかどうか。
- **スクリプトファイル単位か**: 同じ `staging/` 内で、新しい
  `<id>.entry.jsx`（呼び出しごとに別名）が承認なしで走るかどうか。
  driver は意図的に呼び出しごとに entry 名を変えている
  （`src/driver/bootstrap.ts` の `entryScriptPath`）。タイムアウトした
  スクリプトが次の要求を読んで二重実行するのを防ぐためであり、
  ファイル単位の承認なら呼び出しごとに承認が要ることになる。

## 結果の読み方

| diff の結果 | 解釈 | 設計への帰結 |
| --- | --- | --- |
| 変更ファイル 0 件 | 許可は偏好ツリーに記録されていない。`--root` で `~/Library/Application Support/Adobe` 等を足して再測、または AE が起動中のみメモリに持つ可能性 | 記録場所の特定が先。粒度はダイアログ挙動の実測のみで答える |
| 変更ファイルあり、prefs キー差分なし | 許可は別形式（plist・バイナリ）で記録された可能性。`--all-keys` で再 snapshot、または当該ファイルを人間が直接確認 | キー名が既定パターン外なら `--key-pattern` を広げる |
| prefs キー差分に**フォルダパスが1件**追加され、別 sessionRoot の staging では再承認が要った | **フォルダ単位**。1 フォルダにつき 1 承認 | sessionRoot が呼び出しごとに変わる consumer には不向き。driver が安定した staging 場所（例: 固定の per-user フォルダ）を使う設計変更を検討。セッション分離要件（`docs/offstage-macos.md`）との兼ね合いを別途判断 |
| prefs キー差分に**スクリプトファイルパスが列挙**され、同じフォルダ内の新しい entry 名でも再承認が要った | **スクリプト単位**。呼び出しごとの別名 entry と相性が悪い | entry 名を安定化する必要があるが、二重実行防止（`bootstrap.ts` のコメント参照）と衝突する。request 識別をファイル名以外（例: 内容・連番ディレクトリ）で行う設計変更が要る |
| 1 回の承認で同一フォルダ内の新規 entry も別フォルダも走る | **それより粗い単位**（AE バージョン単位・ユーザ単位など） | 現行の「staging を1フォルダにまとめる」設計で十分。追加の設計変更は不要 |

ダイアログの文言（「フォルダを追加」なのか「スクリプトを許可」なのか）と
diff の内容が一致するかも記録すること。食い違う場合は両方を Issue #125 に
コメントする。

## 安全性

- probe は `stat` / `readdir` / `readFile` のみを使い、走査対象へは一切
  書き込まない。`--out` が走査対象の内側を指す場合は拒否する。
- snapshot が記録するのはパス・サイズ・mtime・SHA-256 と、`.txt` 偏好
  ファイルのスクリプト／セキュリティ系キーのみ。`--all-keys` は全キーを
  記録するためローカル情報を多く含みうる。必要な時だけ使う。
- AE の承認操作そのものは人間が行う。probe は承認・拒否・設定変更を
  一切代行しない。

## 関連

- Issue #125（この測定の問い）
- `docs/offstage-macos.md` §10.10（隔離セッションでの同じ未決事項）
- `docs/evidence/g0-startup-2026-11-16/`（G0 起動プローブの実測。
  `Pref_SCRIPTING_FILE_NETWORK_SECURITY` の実在を確認済み）
- `src/driver/bootstrap.ts`（staging に集約する現行設計とその理由）
