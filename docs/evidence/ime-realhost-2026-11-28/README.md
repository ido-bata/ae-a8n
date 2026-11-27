# IME input real-host PoC — 2026-11-28 (issue #379, runbook W0–W3 results)

Runbook: `docs/ime-input-realhost-poc.md` (steps W0–W5). Host: macOS
27.2.1 (build 26B131), uid 501 console session (asid 100021), console
unmanned (HIDIdleTime > 18 min at start, 04:32 JST). Isolated-session lane
UNAVAILABLE (`offstage session status --user test`: account has no GUI
session) → all work ran on the console session with per-post focus proof.

Foreign instance present throughout: AE 2026 pid 4536 (Aulymo automation,
`DoScriptFile` in flight). Census re-checked before every mutation; zero
input/mutation/quit was ever directed at it. Owned apps used: witness
bundle (pid 44467, quit after W0–W3), TextEdit (pid 59805 → 80073, own
scratch doc `/tmp/ime379/t.txt`, quit after tests).

Helpers: `swiftc -O` builds of `scripts/isolated-session/{input-post,
input-focus,input-source,input-clipboard,input-mouse,window-ops}.swift`
plus two PoC-only probes written for this run (`/tmp/ime379/ax-read.swift`
— AX attribute reader for `AXValue`/`AXSelectedText`; not committed,
reproducible from this description). All posting helpers ran via
`launchctl asuser 501` into the Aqua session.

## Environment notes

- `input-source current` at baseline: **Kotoeri Hiragana already selected**
  (user-global state; restored to Hiragana at end = baseline, no drift).
- `input-focus read` worked directly from the Background session AND via
  `launchctl asuser 501`; AX trust present for the responsible process.
- Focus on this host is *volatile*: Vivaldi (pid 8225) and Finder stole
  frontmost status mid-run at least twice. Every post was preceded by a
  <1 s `input-focus read`; one early batch (`type "ZZZ"`) raced and its
  destination is unverified — letters only, nothing submitted (see
  "Incidents").

## W0 — witness .app bundle — PARTIAL

- Built `ime-witness.app` (v4 source unmodified,
  `docs/evidence/ime-poc-2026-11-27/ime-witness.swift`) with minimal
  `Info.plist`, launched via `open -a … --args <log> 1800`.
- `input-focus read` resolved `AXWindow[0]/AXScrollArea/AXTextArea` as the
  focused element — the bundled app vends proper AX (unlike bare
  `launchctl asuser` binaries).
- **Oracle result: keyDown NSEvents arrive** (session tap, HID tap,
  to-pid, unicode-string and keycode events — `witness-session.log`),
  **but `insertText`/`setMarkedText`/`didChange` NEVER fire and AXValue
  stays empty** — even for events that verifiably insert in TextEdit.
- Conclusion: the witness's ad-hoc NSTextView does not fully engage
  `NSTextInputClient` (same hypothesis as prior PoC (a), now confirmed
  for a bundled app too). The witness remains a valid *delivery* oracle
  only; TextEdit + the real fixtures are the *insertion* oracles.
  Recorded as a witness limitation, not an input-path failure.

## W1 — session-stream real text insertion — VERIFIED ON REAL HOST

Vehicle: `input-post` (combinedSessionState source, PR #414).

| Post | Target | Result |
| --- | --- | --- |
| `type --text "WW" --tap session` | TextEdit focused | `AXValue` gained `WW`, cursor advanced (`w1-*` reads) |
| `key press --key e --tap session` | TextEdit focused | `e` inserted, cursor 4→5 (`w1-keypress-e.json`) |

Both unicode-string (`type`) and real-keycode (`key press`) CGEvents
produce real text insertion through the session tap when focus is proven
<1 s before posting.

## W2 — IME pass-through, session tap — VERIFIED ON REAL HOST

Input source: `com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese`
(selected via `input-source select`; prior=ABC for W1, baseline=Hiragana).

| Step | Evidence | Result |
| --- | --- | --- |
| `type --text "konnitiha" --tap session` (unicode events) | `w2-typed-mid.json` | literal `konnitiha` inserted — **unicode-string events BYPASS the IME** |
| `key press` k-o-n-n-i (stale ABC context) | `w2-ime-mid.json` | literal `konni` — context predated the TIS switch |
| focus cycle (Finder→TextEdit) then `key press` k-o | `w2-ime-refocus.json` | **`こ` hiragana — IME engaged** |
| `key press` n-n-i-t-i-h-a | `w2-ime-full-mid.json` | **`こんにちは` composed** |
| `key press space` | `w2-ime-space.json` | conversion ran; candidate `😀` selected by IME (emoji prediction candidate) |
| `key press return` | `w2-ime-commit.json` | `😀` committed |
| `key press` n-i-h-o-n, space, return | `w2-nihon-*.json` | `にほん`→`人` kanji candidate committed |

**Operational finding (important for the contract):** after
`input-source select`, an already-established text-input context keeps
the OLD source — the first post-TIS batch bypassed the IME until the
target's context was re-established (app focus cycle). `ime-mode select`
operations must be followed by a focus re-verify/re-cycle before posting
counts as IME evidence.

**Vehicle finding:** only real-keycode `key press` events traverse the
input-method stack. `type`/`post-text` unicode-string events insert
literally and are direct-entry, never IME evidence (consistent with spec
§4.2).

## W3 — CGEventPostToPid — focus-gated confirmed; IME-transparent when delivered

- Unfocused delivery NOT reproduced: with Finder verifiably frontmost,
  `to-pid <TextEdit> key press t-a + space + return` and
  `to-pid type "GG"` produced zero change (`w3b-*`, `w3c-*`). One earlier
  apparent success (`QQ` while Vivaldi read as frontmost,
  `textedit-clip.json` era) is attributed to a frontmost-transition
  window — AX frontmost and NSApp-active can diverge for a beat.
  **Conclusion unchanged from prior PoC: to-pid is NOT a non-global
  channel; keyboard delivery is gated on the target being active.**
- Focused to-pid DOES traverse the IME: `to-pid <TextEdit> key press`
  `sayounara` while TextEdit frontmost produced `証なら`
  (`w3-topid-ime-mid.json`) — hiragana/kanji, not literal romaji.
- Safety property worth recording: to-pid can only reach the target pid —
  it cannot hit a foreign app even under focus races (unlike session
  tap). Delivery still requires the target active, so it is a
  *safer-but-equally-gated* variant, not a bypass.

## Incidents / honest gaps

- `type "ZZZ" --tap session` once raced focus (destination unverified;
  letters only, no submit keys — same class as prior PoC incident,
  mitigated by <1 s focus proof afterwards).
- TextEdit retained a stuck Kotoeri candidate window (AXDialog) after the
  emoji conversion; `escape` via session tap did not clear it and one
  `key press m` pair produced `っm`. Document restarted for the clean
  unfocused tests. Lesson recorded: conversion state must be cancelled
  before reusing a context (runbook W2 abort clause covers this).
- W4/W5 (AX marked-text on CEF/ScriptUI, Tier1a/Tier2 fixtures, clipboard
  round-trip) — completed later the same day on owned AE 2027; see below.

## W4/W5 — owned AE 2027 (pid 98744 → relaunched 41964), 06:01–06:17 JST

Owned AE 2027 `27.0x78` driven through the ae-a8n bridge
(`/tmp/ime379/ae-session.mjs`, host script `a8n-input-fixture.jsx`) plus
the same `input-post`/`input-mouse`/`window-ops` helpers. Foreign AE 2026
(pid 4536) untouched throughout; census re-checked before every mutation.
Owned AE quit cleanly via `ae.close()` after each run; only the foreign
instance remains.

### Focus mechanics discovered (applies to all AE panel surfaces)

- `CGEvent` session-tap keys reach AE **only the app's key window**. AE
  keeps key focus on the main window (`AXFocusedWindow` = project window)
  until a real click lands inside a palette/CEP panel.
- **`--delay-ms 60` between keyDown and keyUp is required.** Instant
  down/up pairs are silently dropped by AE/ScriptUI (~60–100% loss:
  `hello`→`eo`, `abcde`→`""`). With 60 ms every press committed.
- CEP panels expose **no AX text element** (`input-focus read` →
  `AXUnknown`); the DOM `<input>` is only reachable via real click +
  CDP/fixture observation. ScriptUI palettes DO vend AX
  (`AXTextField`, `AXFocused=1`, live `AXValue`).

### Tier-2 ScriptUI edittext — VERIFIED ON REAL HOST

Fixture `a8nInputFixture.scriptuiOpen` (palette + retained edittext,
`fixtures/input/scriptui/extension.ts`). Real session-tap keys with
Kotoeri Hiragana selected committed Japanese IME text; readback via
`a8nInputFixture.scriptuiReadback` (`extendscript-readback` channel):

- `rbfinal.json`: `committedValue = "eozqqこんにちはこんにちはテスト日本"`
  (ASCII + `konnitiha`/`konni`+space+return → こんにちは,
  `testuto` → テスト, `nihon`+space+return → 日本).
- Live composition observable through `AXValue` mid-typing (romaji tail
  `…テストにほn` visible before conversion) — see `scriptui-ax-final.txt`
  and the poll log in `scriptui-tier2-log.txt`.
- `AXSelectedText` returns `kAXError -25212` on this control — marked
  text is NOT exposed via AXSelectedText; `AXValue` carries the live
  composition state instead. `AXNumberOfCharacters` returns 0
  (unsupported on this control).
- Screenshot: `scriptui-edittext-ja.png`.

### Tier-1a CEP composition — VERIFIED ON REAL HOST (both channels)

Fixture `fixtures/input/cep` opened via Window ▸ Extensions ▸
"ae-a8n IME Input Fixture" (CEPHtmlEngine pid 49771, CDP
`127.0.0.1:47890` live, `--enable-nodejs --mixed-context`).

- **Channel 1 (fixture self-report, primary)**: `lib/report.js` node-fs
  sink → `$TMPDIR/ae-a8n-ime-input/report.jsonl` (copy:
  `cep-report.jsonl`, 30 records). Full lifecycle captured:
  `compositionstart` → `compositionupdate`/`input`
  (`insertCompositionText`, `isComposing:true`, `domValue` tracked per
  keystroke `cえpてst`) → space conversion `知恵test` → `compositionend`
  → committed DOM value `知恵test`.
- **Channel 2 (CDP observation)**: `Runtime.evaluate`-installed listeners
  recorded the identical event stream plus final value — see
  `tier1a-cdp-session.txt`. `Input.*` CDP methods were NOT used for input
  (spec §4.2 boundary respected; CDP was observe/evaluate only).
- Focus: real session-tap click into the DOM input at its screen
  position (~(420,165) pt inside the 640×504 panel at (100,76)); only
  then `document.hasFocus()`/`activeElement` report the field. CDP
  `el.focus()` alone does not grant OS keyboard focus.

### Clipboard round-trip — VERIFIED ON REAL HOST

`input-clipboard snapshot --stash` → `write --text
"clipboard-test-123"` → real `cmd+a`/`cmd+v` session-tap presses into the
CEP input → DOM value became exactly `clipboard-test-123` →
`restore --stash` → re-snapshot digest `46b866e7…` identical to the
pre-test snapshot. Shared-state save/restore gate passed.

### Fixture bug found & fixed

`fixtures/input/cep/CSXS/manifest.xml` XML comment contained `--`
(`--enable-nodejs`) which broke XPATH parsing in CSXS logs; comment
reworded (no `--` inside comments). Manifest `Geometry` is 380×420 but
the live panel opened at 640×504 — recorded as an observation, not a
defect (CEP host controls final size).

### Incidents this session

- `window.close()` via CDP hard-unloaded the CEP extension; the
  Extensions menu item would not relaunch it (`CEPHtmlEngine ends,
  unload extension`, no respawn). Required an owned-AE restart —
  `AutoVisible` did NOT re-show the panel on relaunch; the menu item
  worked again on the fresh instance.
- `window-ops act --op resize|maximize` on the CEP panel failed with
  `AXError -25200` (panel not AX-resizable); `move`/`focus` worked.
- Several early letter batches (`abc`,`xyz`,`pqr`,`mno`,`fgh`,`jkl`,
  `qwe`) were posted while the CEP panel lacked OS key focus — they
  went to AE's key window (main window / ScriptUI palette). Letters
  only, no submit keys; owned instance only, foreign AE untouched.

## Verification levels reached (W4/W5)

| Item | Level |
| --- | --- |
| Tier-2 ScriptUI edittext OS-IME commit + readback | `verified on real host` |
| Tier-1a CEP composition events + committed value (self-report + CDP) | `verified on real host` |
| AX live composition state on ScriptUI `AXValue` | `verified on real host` (this control) |
| AX marked text via `AXSelectedText` | `unsupported` on ScriptUI edittext (-25212); CEF panel not AX-visible at all |
| Clipboard round-trip + restore digest | `verified on real host` |
| `CGEventPostToPid` into AE panels | `unverified` (not re-tested this session; W3 TextEdit result stands) |
