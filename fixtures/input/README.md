# IME input fixtures (`fixtures/input/`)

`specs/ime-input/spec.md` §4・§8 の「Fixture code」に対応する、テスト所有の観測用 surface 群。
実機 After Effects + 実日本語 IME での検証は後続 ticket（`needs-human`）であり、ここにあるコードの
verification level は **`implemented`**（構造は `test/input-fixtures.test.ts` で自動検証）です。

## 配置と命名

| Path | Surface | Tier | 観測 channel |
| --- | --- | --- | --- |
| `cep/` | self-reporting CEP extension（`cep-composition` + `cep-custom-drawn` の 2 surface） | 1a / 2 | DOM composition event + DOM value / key event + draw state |
| `scriptui/extension.ts` | ScriptUI palette（retained `edittext` の readback oracle） | 2 | ExtendScript 経由の committed value readback |

- fixture は **観測専用**。値の直接設定（DOM `value` 代入、ExtendScript property 書き込み、
  UIA `ValuePattern.SetValue` 相当）は IME evidence にしない（spec §4.2）。fixture 内に
  direct-set → 報告の経路は存在しない。
- Surface id・channel 名は result record の `surface` / `channel` field と一致させる。

## Result record format

全 fixture は **JSON Lines**（1 行 1 record）で結果を出力する。CEP 側は Node bridge
（`cep/lib/report.js`）が `appendFileSync` で書き、ScriptUI 側は extension method の
戻り値が record になる。出力先は bridge が決める（既定: OS temp dir、
`window.__A8N_INPUT_FIXTURE_RESULT__` で上書き可）。

```json
{
  "v": 1,
  "fixture": "ae-a8n-ime-input",
  "surface": "cep-composition",
  "ts": "2026-11-27T00:00:00.000Z",
  "kind": "compositionupdate",
  "channel": "composition-event",
  "tier": "1a",
  "provesOsIme": false,
  "verification": "implemented",
  "data": { "data": "にほん" },
  "domValue": "にほん"
}
```

Field 規則:

- `kind`: `surface-ready` / `compositionstart` / `compositionupdate` / `compositionend` /
  `input` / `keydown` / `keyup` / `draw-state`。
- `channel`: 観測経路。`composition-event`（Tier-1a の DOM composition）、`dom-value`
  （`input` event の committed value 観測）、`key-event`、`draw-state`、
  `extendscript-readback`（ScriptUI fixture の戻り値）。
- `domValue` / `committedValue` / `drawnText`: 値の readback は event payload とは
  **別 field** で報告する（spec §4.1「DOM value を別々に報告」）。
- `tier`: `"1a"`（CEP composition protocol）または `"2"`（ScriptUI/native/custom-drawn）。
- `provesOsIme`: **常に `false`**。fixture record は OS IME end-to-end（Tier-1b）の
  合格を主張しない。Tier-1b verdict は input runner の audit record
  （`src/input/types.ts` の `InputAuditRecord.tier1b`）が別に持つ。
- `verification`: fixture 自体の verification level。`"implemented"` 固定
  （実機未検証を明示する）。

## CEP extension（`cep/`）

- `CSXS/manifest.xml`: CEP panel extension（Host `AEFT`）。`--enable-nodejs` +
  `--mixed-context` で renderer から Node `fs` を使える前提。
- `index.html`: 2 surface を 1 panel に収める。
  - `cep-composition`（Tier-1a）: `<input>` に `compositionstart` /
    `compositionupdate` / `compositionend` / `input` listener を install し、
    各 event と DOM value を別 field で self-report する。spec §4.1 channel 1
    （fixture self-report = primary Tier-1a channel）。
  - `cep-custom-drawn`（Tier-2 custom-drawn）: `<canvas>` が key event を受けて
    自前で文字を描画する。composition は canvas では発火しないため
    `compositionObserve: "unsupported"`、value readback も `"unsupported"` を
    `surface-ready` record で正直に宣言し、観測は key event + draw state +
    capture diff（panel spec の screenshot oracle）に限定する。
- `lib/report.js`: record の sink。Node `fs` が使えれば JSONL へ append、
  使えなければ `window.A8nInputFixtureReport.buffered()` に保持する
  （後者は CDP `Runtime.evaluate` 経路 = spec §4.1 channel 2 の受け皿）。
- `lib/panel.js`: listener 群と record 組み立て。direct-set のコードパスを持たない。

導入・起動は実機 ticket 側の責務（`extensions/` への配置、Window > Extensions からの
表示）。この fixture は install も起動もしない。

## ScriptUI fixture（`scriptui/extension.ts`）

`ae-a8n extension build` で host script に組み込める consumer extension module
（`examples/extension-consumer.ts` と同じ contract）。method は全て ES3 function
expression で、状態は `$.global` に保持する。

| Method | 役割 |
| --- | --- |
| `a8nInputFixture.scriptuiOpen` | ScriptUI `palette` window + retained `edittext` を生成・表示 |
| `a8nInputFixture.scriptuiReadback` | committed value（`edittext.text`）を `extendscript-readback` channel で返す |
| `a8nInputFixture.scriptuiClose` | window を閉じて最終 readback を返す |

panel spec §5 の oracle pattern に倣い、control 参照を retain したまま ExtendScript
経由で値を読み戻す。readback は **読み取りのみ** — 書き込みは direct-set であり
fixture は提供しない。戻り値は上記 record format に従う（`surface:
"scriptui-edittext"`, `tier: "2"`, `provesOsIme: false`）。

ScriptUI には custom-drawn の text input surface が存在しない（`onDraw` で描けるが
key event を受ける control がない）ため、Tier-2 の custom-drawn 代表は CEP canvas
側に置いた。
