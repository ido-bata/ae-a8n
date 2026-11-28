# IME input 実機 PoC runbook（#379 残件）

`specs/ime-input/spec.md` §8「Requires real host」の残項目を、owned AE
launch が可能になった時点で **そのまま実行できる** 手順として固定する。
技術 feasibility の事前調査結果は
[`docs/evidence/ime-poc-2026-11-27/`](evidence/ime-poc-2026-11-27/README.md)
（以下「事前 PoC」）を参照。事前 PoC で `verified on real host` になった
項目は本 runbook では再確認のみ、`unverified`/`inconclusive` の項目が本番。

対象 issue: #379（parent #344、program #337）。依存: #376（evidence
record）、#378（負例）、fixture ticket。**本 runbook は #376/#378 未統合でも
実行可能**な技術手順であり、正式な spec §7 matrix 更新は deps 統合後に行う。

## 0. 実行前提と安全境界

- **AE lane**: owned AE 2027 のみ操作可。`pgrep -fl "After Effects"` で
  census を取り、foreign AE（2026 等）がいれば read-only 観測のみ。
  owned instance は exit 時に必ず quit（`ae.close()` / graceful quit）。
  foreign AE への mutation は即 abort。
- **console session**: session-stream（HID/session tap）posting は
  **isolated session（`runInSession` / `run-in-isolated-session.mjs`）または
  無人の console** でのみ実行する。事前 PoC では active console で
  focus 競合により文字列が foreign app（Ghostty/ChatGPT）へ escape した
  — spec §5.3 の focus proof が必須である実証でもある。共有 console で
  人間が作業中なら session-stream 項目は **skip して `blocked` 記録**とし、
  `to-pid`（pid-scoped）項目のみ実行してよい。
- **AX/TCC**: posting には Accessibility trust が必要（事前 PoC では
  session の responsible process に付与済みで `input-focus read` が動作）。
  `AXIsProcessTrusted` を helper で確認してから始める。prompt を新規に
  出さない。
- **日本語 IME**: `com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese`
  （Hiragana）はこの host に installed+enabled（事前 PoC で TIS 確認済）。
  `input-source select` は user-global shared-state — 前状態を記録し
  **必ず restore** する。

## W0. witness を正規 .app bundle として作り直す（最初にやる）

事前 PoC の `ime-witness` は `launchctl asuser` 直 spawn の素 binary で、
keyDown NSEvent は届くが `insertText`/marked text が一度も発火しなかった
（`NSTextInputContext` が完全に活性化していない可能性）。実機 PoC では
**bundle 化して `open` で起動**した witness を oracle にする。

1. `ime-witness.swift`（`docs/evidence/ime-poc-2026-11-27/`）をベースに
   最小 `.app` を作る: `Contents/MacOS/witness` + `Info.plist`
   （`CFBundleExecutable`, `LSUIElement=false`）。v4 の logging はそのまま
   使える（`insertText`/`setMarkedText`/`unmarkText`/`didChange`/`keyDown`
   の JSONL + `FOCUSME` file reactivation）。
2. `open -a <bundle>` で起動（Aqua session 内）。bundle id は適当
   （例 `local.ae-a8n.ime-witness`）。
3. `input-focus read` で `AXFocusedUIElement` が witness の text area を
   指すことを確認してから各 batch を開始。focus が外れたら即 abort
   （その batch の結果は破棄）。
4. まず **ASCII + session tap `key press --key a`** で `insertText` が
   発火するかを確認 — これが witness の健全性 oracle。発火しなければ
   witness 側の問題として記録し、入力経路の結論を出さない。

## W1. CGEvent session-stream → 実テキスト挿入（Tier-1b の根幹）

前提: W0 合格、console が無人 or isolated session、focus proof 済み。

1. `input-source select --mode com.apple.keylayout.ABC`（記録: prior mode）。
2. `input-post-src key press --key a --tap session`（combinedSessionState
   source 版 — shipped helper は nil source で keycode event が不安定、
   事前 PoC Task 2）。
3. oracle: witness log に `insertText`/`didChange` で `"a"` が出ること。
   - 出る → session-stream は実キー入力として機能（`verified on real host`）。
   - 出ない → `keyDown` は届くが text input に変換されない = **helper 修正
     ticket**（event source/timestamp/first-responder 要因を切り分け）。
4. 同様に `--tap hid` でも 1 回試し、session/hid の差を記録。

## W2. IME pass-through（Tier-1b 核心）

前提: W1 で挿入が確認できていること（挿入できなければ IME 結論は出せない）。

1. `input-source select --mode com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese`。
2. focus proof → `input-post-src type --text "konnitiha" --tap session
   --delay-ms 80` → witness log で `setMarkedText`（未確定変換）→
   `key press --key space`（変換）→ `key press --key return`（確定）。
3. oracle: `setMarkedText`/`insertText` にひらがな・変換候補が現れ、
   commit 後の `contents` がローマ字ではないこと。`hasMarkedText:true`
   の記録が IME 通過の直接証拠。
4. abort 条件: sequence 途中で focus が witness 以外に移ったら残りを
   打たず abort（`indeterminate`）。composition 残留は `escape` で
   cancel してから記録。
5. `to-pid` 版も同じ入力を試す（focused 状態で）— IME を通るか bypass
   かで「target-scoped 非 global channel」の有無が決まる（事前 PoC では
   focus-gated と判明済み; IME 通過性は未検証）。
6. 終了後 `input-source select` で prior mode に restore、`current` で
   確認。

## W3. CGEventPostToPid の残件

事前 PoC 確定済み: keyboard delivery は target app の active/frontmost
に gate される（非 global channel にはならない）。残件は **focused 状態で
の IME 通過性**のみ — W2 の to-pid バッチで同時に取れる。

## W4. AX marked-text / AXSelectedText（CEF・ScriptUI）

1. fixture CEP panel（#376 fixture）を owned AE で開き、`input-focus read`
   / `ax-windows.swift` 系で focused element を取得。
2. `AXUIElementCopyAttributeValue` で `AXValue`/`AXSelectedText`/
   `AXSelectedTextRange` を composition 中・確定後に読み、witness 同様
   JSONL 記録。marked text が AX に出るかは per-surface
   `supported`/`unsupported`/`unverified` で記録（best-effort、sole
   evidence にしない）。

## W5. AE 実機 Tier1a/Tier2（fixture 必須、#376/#378 後）

1. fixture CEP extension（self-report JS + `.debug` file 同梱 — CDP
   feasibility は `cdp-feasibility.md` 参照）を owned AE 2027 で起動。
2. **Tier1a**: CDP `Runtime.evaluate` で composition listener を install
   （観測 setup のみ。`Input.*` 合成は Tier1b 証拠にしない）→ W2 と同じ
   実キー列を投げ、fixture self-report の DOM composition event と
   committed value を Tier1a record に記録。
3. **Tier2**: ScriptUI `edittext` を持つ fixture window（#357 の
   `poc.panelShow` 系）に対し同じキー列 → in-AE readback（fixture が
   control 参照を保持）または capture-diff で committed result を確認。
   composition 内部観測は不要（spec §4.3）。
4. clipboard round-trip: `input-clipboard snapshot` → `write` → paste
   （`cmd+v` 実キー）→ `restore` → 内容一致を digest で確認。共有状態
   gate（save+restore）を必ず通す。

## 記録フォーマット

- 各項目を `verified on real host` / `unsupported` / `unverified` /
  `unavailable` / `needs-human` で記録し、spec §7 matrix の該当セルを更新。
- Tier1a / Tier1b / Tier2 は **別 record**（#376 の schema に従う）。
  「IME works」の統合 verdict は出さない。
- 証跡は `docs/evidence/ime-realhost-<date>/` に witness log・focus
  read・input-source before/after・AE panel capture を置く。

## Abort 条件（共通）

- foreign AE process の census 変化・foreign app への文字列 escape を
  観測 → session-stream 全停止、`indeterminate` 記録。
- AX trust 喪失 / `AXIsProcessTrusted=false` → posting 前に refuse。
- owned AE が readiness timeout / wedge → supervision の既存契約
  （`gui-supervision-safety-gates.md`）に従い `needs-human`。

## Results — 2026-11-28 run (`docs/evidence/ime-realhost-2026-11-28/`)

W0–W5 を owned AE 2027 (`27.0x78`) で実行。foreign AE 2026 (pid 4536)
は終始 untouched、owned instance は各 run 後に `ae.close()` で quit、
input-source は baseline に restore 済み。

| Step | Result |
| --- | --- |
| W0 witness .app | `implemented` — bundle 起動・AX focus 確認できたが `insertText`/`setMarkedText` は不発（witness の NSTextView が `NSTextInputClient` を完全に engage しない制限として記録。insertion oracle は TextEdit/実 fixture が担う） |
| W1 session-stream 挿入 | `verified on real host` — `key press`/`type` とも TextEdit に実挿入 |
| W2 Kotoeri IME pass-through | `verified on real host` — keycode events のみ IME を通過（`type`/unicode events は literal 挿入 = direct-entry）。`input-source select` 後は focus re-cycle が必要 |
| W3 CGEventPostToPid | `verified on real host`（TextEdit）— active-app-gated（non-global channel ではない）、focused 時は IME 透過。AE panel 宛は `unverified` |
| W4 AX marked-text | `verified on real host`（部分）— ScriptUI `edittext` の `AXValue` が live composition を露出。`AXSelectedText` は -25212 で `unsupported`、CEP/CEF panel は AX 非公開（`AXUnknown`） |
| W5 Tier1a CEP composition | `verified on real host` — fixture self-report JSONL + CDP `Runtime.evaluate` の両 channel で compositionstart/update/end・`insertCompositionText`・committed value `知恵test` を記録 |
| W5 Tier2 ScriptUI edittext | `verified on real host` — 実キー + Kotoeri IME で `eozqqこんにちはこんにちはテスト日本` を commit、ExtendScript readback で確認 |
| W5 clipboard round-trip | `verified on real host` — snapshot→write→`cmd+v` 実キー paste→restore、digest 一致 |

Runbook 運用上の新規知見（spec §7 に反映済み）:

- **keyDown/keyUp 間 ~60 ms の delay が必須** — instant pair は AE/ScriptUI
  に drop される（`hello`→`eo` 等）。`input-post --delay-ms 60`。
- AE panel へのキー入力は **key window の focused control にのみ届く**。
  実 click で panel/palette を key window 化してから post する。
  CDP `el.focus()` は DOM focus のみで OS key focus を与えない。
- `window.close()` (CDP) は CEP extension を hard-unload し menu からの
  再 launch を拒否する — owned AE restart が必要だった。
- `input-source select` 直後の既存 text-input context は旧 source を
  保持し続ける — IME evidence には focus re-cycle + 再確認が必須。
