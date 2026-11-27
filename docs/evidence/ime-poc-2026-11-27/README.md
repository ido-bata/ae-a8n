# IME / CGEvent PoC — 2026-11-27 (issue #379 technical feasibility)

Issues: #379 (parent #344, program #337). Scope of this run: the
**non-AE-dependent** items — API-level CGEvent delivery semantics, TIS
input-source readback/select, clipboard snapshot, CDP feasibility, and an
owned witness-process harness. **No After Effects was launched or touched**
by this PoC (an owned AE 2027 instance belonging to another worker's
`poc-panel-ax-vehicle` run and a foreign AE 2026 were live throughout;
census respected, zero AE interaction).

Verification level: **verified on real host** for everything recorded
below, scoped to the owned `ime-witness` AppKit process on macOS
27.2.1 (build 26B131), uid 501 Aqua session (asid 100021), entered via
`launchctl asuser 501` from a background session. Nothing here is AE
evidence; AE-dependent items are deferred to the runbook
(`docs/ime-input-realhost-poc.md`).

## Environment notes

- The console user was **actively using the machine** during the run
  (focus cycled Ghostty → Vivaldi → ChatGPT → Muse within seconds).
  Session-stream (HID/session tap) posting was therefore only attempted in
  sub-second verify→post windows; several posts escaped to foreign apps
  when focus moved mid-sequence. See "Incidents" below — this is itself
  evidence for the spec §5.3 focus-proof requirement.
- All helpers compiled from `scripts/isolated-session/*.swift` on
  `release-0-7-0` with `swiftc -O` (macOS 27.2.1 SDK toolchain).

## Task 1 — CGEventPostToPid feasibility

Helper: `input-post to-pid <pid> ...` (`event.postToPid`).

| Probe | Result |
| --- | --- |
| `to-pid` `key down/up --key shift` while witness **unfocused** | `flagsChanged` NSEvents **delivered** (witness2.log seq 0–1, `appActive:false`) |
| `to-pid` `type --text "abc"` / `post-text` while **unfocused** | **zero delivery** — no keyDown logged |
| `to-pid` `type --text "de"` while **verifiably focused** (input-focus read → witness frontmost, posts <1 s later) | keyDown NSEvents **delivered** (`appActive:true`, witness2.log seq 2–3) |
| `to-pid` `key press --key c` / `--key g` (real keycodes) | **no delivery observed** in any attempt (inconclusive — focus raced; unicode-string events in the same batch did arrive once) |

**Findings:**

1. `CGEventPostToPid` is **not a non-global channel**. Keyboard delivery is
   gated on the target app being active/frontmost — the same focus
   requirement the spec's session-stream class already carries. It
   therefore cannot replace the §5.3 three-step focus proof; at best it is
   a *pid-scoped variant of the same focused-delivery problem*.
2. `flagsChanged` events pass to unfocused apps — modifier state can leak
   cross-app via `to-pid`; cleanup tracking must treat this channel as
   capable of residue even when "nothing happened".
3. IME pass-through for `to-pid`: **unverified** — no stable
   focused+Japanese-IME window could be held on this active console.
   Deferred to the runbook (needs a quiet console or isolated session).

Level: `verified on real host` for delivery gating (own process);
`unverified` for IME pass-through.

## Task 2 — session/HID tap CGEvent posting + text insertion

Two helper variants were compared:

- `input-post` (shipped): `CGEvent(keyboardEventSource: nil, ...)`
- `input-post-combinedsession.swift` (probe): same but
  `CGEventSource(stateID: .combinedSessionState)`

| Probe | Result |
| --- | --- |
| session tap, nil source, `type`/`key` | keyDown NSEvents **not delivered at all** in focused windows tested |
| session tap, combinedSessionState source, `type --text "ka"` while focused | keyDowns delivered with `chars`/`charsNoMods` populated, `firstResponder: WitnessTextView`, `keyWindow/appActive: true` (witness3/4 logs) |
| session tap, combinedSessionState, `key press --key a` | delivered once (witness3), absent in later raced attempts — flaky under focus churn |
| HID tap (`--tap hid`) | **inconclusive** — focus was lost before posts landed (witness4) |
| **text insertion / IME** | **zero `insertText`/`setMarkedText`/`didChange` in every log** — across session tap, unicode-string and keycode events, ABC and Hiragana input sources |

**Findings:**

1. Nil-source CGEvents are unreliable for keycode events; a real
   `CGEventSource` (`.combinedSessionState`) is required for consistent
   delivery. The shipped `input-post.swift` uses `nil` — **candidate fix
   for a follow-up ticket** (not changed here; helpers are #372's scope).
2. Even when keyDown NSEvents verifiably reach the focused text view,
   `super.keyDown → interpretKeyEvents` produced **no text insertion and
   no marked text** on this witness. `characters` and
   `charactersIgnoringModifiers` were both populated, so the events are
   well-formed at the NSEvent level. Root cause undetermined — candidates:
   (a) `launchctl asuser`-spawned binaries lack full text-input-service
   registration (`NSTextInputContext` may not be fully active), (b) a
   missing NSEvent field AppKit requires, (c) witness-specific issue.
   **The witness should be rebuilt as a proper `.app` bundle launched via
   `open` for the definitive test** — see runbook §W0.
3. Because insertion never engaged, **no IME composition signal was
   observed** — Tier-1b remains `unverified`. The raw keyDowns carried
   `chars:"k"/"a"` etc. with `hasMarkedText:false` throughout, consistent
   with (but not proof of) the unicode-string path bypassing the IME.

Level: `verified on real host` for event *delivery* semantics;
`unverified`/`inconclusive` for insertion and IME pass-through.

## Task 3 — Japanese IME prep

- TIS readback inside the Aqua session (`input-source list/current`):
  `com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese` ("Hiragana",
  `TISTypeKeyboardInputMode`) is **installed, enabled, selectable**.
- `input-source select` switched ABC → Hiragana and back with
  `requested == observed` both ways (see `input-source-observations.json`).
- Prior evidence `docs/evidence/realhost-2026-11-27/README.md` Task 3
  recorded the same source installed+selected via `defaults read
  com.apple.HIToolbox` on the same host.
- At PoC start the *selected* source was ABC (Hiragana installed but not
  active); restored to ABC at end — user-global state left as found.

Level: `verified on real host` (TIS level). Composition behavior:
`unverified` (see Task 2).

## Task 4 — clipboard

`input-clipboard snapshot --stash <path>` succeeded in-session:
1 flavor (`public.utf8-plain-text`), sha256 digest, 2570 bytes, stash file
mode 600 (receipt: `clipboard-snapshot-receipt.json`; stash contents
intentionally not committed). `write`/`restore` untested — they mutate
the user's pasteboard; deferred to runbook under the shared-state gate.

Level: `verified on real host` for snapshot/read path only.

## Task 5 — CDP feasibility

See `cdp-feasibility.md`: **supported, per-extension scoped** — `.debug`
file + `PlayerDebugMode=1` → per-surface `http://127.0.0.1:<port>/json/list`
CDP endpoint while the surface's CEPHtmlEngine runs. Proven mechanism on
this host by ty-plus's own E2E and live `DevTools listening` log lines.

Level: `verified on real host` (mechanism + prior live evidence on this
host); the ae-a8n fixture's own `.debug` emission is `unverified` until
the fixture ticket lands.

## Incidents (disclosed)

Session-stream CGEvent posts escaped to foreign apps when console focus
moved between the verify read and the post (~sub-second races on an
active desktop): confirmed deliveries include `aXY`-class character
sequences toward Ghostty and short strings toward ChatGPT. No destructive
combos were sent (letters/unicode/escape only); nothing was submitted or
saved. This is precisely the failure mode spec §5.3 exists to prevent and
is why the runbook mandates an isolated session or a quiet console for
session-stream items.

## Files

- `ime-witness.swift` — the witness AppKit probe (v4: logs keyDown/
  flagsChanged/insertText/setMarkedText/unmarkText/didChange with
  focus+marked-text state; FOCUSME-file reactivation).
- `input-post-combinedsession.swift` — input-post variant with
  `CGEventSource(stateID: .combinedSessionState)` (delivery fix probe).
- `witness*.log` — raw JSONL event logs from the runs above.
- `input-source-observations.json`, `clipboard-snapshot-receipt.json`,
  `cdp-feasibility.md`.
