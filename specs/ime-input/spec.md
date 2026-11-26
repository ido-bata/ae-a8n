# GUI input and IME — CEP composition vs OS-level IME (B-IME)

- Parent program: [#337](https://github.com/ido-bata/ae-a8n/issues/337) (US-B2/B3, Plan B)
- Ticket: [#344](https://github.com/ido-bata/ae-a8n/issues/344) — T001/T002/T003 (this document is the T001/T002 research + contract deliverable)
- Related: [#343](https://github.com/ido-bata/ae-a8n/issues/343) (B-PANEL — supplies `PanelTarget` identity and the operation-class/gate model this spec reuses; Draft PR #349, **not merged** — only its contract concepts are depended on, no code), [#338](https://github.com/ido-bata/ae-a8n/issues/338) (A-SAFETY input/mutation gates), [#342](https://github.com/ido-bata/ae-a8n/issues/342) (A-RUNTIME shares the OS boundary), consumers: B-CONSUMER (ido-bata/ae-devtools#426), B-TEST (ido-bata/ae-test#145)
- Builds on: [panel-interaction spec](../panel-interaction/spec.md) (operation classes `observe`/`mutate-gui`/`mutate-session`, `PanelTarget`, mutation lease + audit + fail-closed attribution), [gui-supervision spec](../gui-supervision/spec.md) (observation honesty, UNKNOWN non-resend), [ADR-0004](../../docs/adr/0004-native-mutation-authorization.md), [docs/gui-supervision-safety-gates.md](../../docs/gui-supervision-safety-gates.md)
- Status: **draft for review**. Nothing named below is implied to exist yet. Every claim carries an explicit verification level.

## 1. Problem

A plugin author's text field — most importantly a CEP panel's search box or Japanese-input field — can only be tested the way a user types into it: uncommitted conversion text appears, candidates are chosen, the result is committed or cancelled. Today ae-a8n has **no input capability at all**: no key posting, no IME awareness, no clipboard, no focus management beyond incidental side effects of `System Events`/`mouse_event` clicks used for dialog recovery. Setting a DOM value or an ExtendScript property directly proves nothing about real input, and the Issue explicitly forbids crediting CDP/DOM-value shortcuts as an OS-IME pass.

The slice must establish, per OS: what "real input" can be delivered, what can be observed about composition, and which claims remain unproven without a real host.

## 2. Scope

In scope for this stage (research + contract; implementation tickets follow):

1. **The CEP-vs-OS-IME distinction** as a first-class contract (§4): two independent evidence channels, two independent result records.
2. **Input operation taxonomy**: focus, key down/up, modifiers, sequential vs direct text entry, selection/replace/delete, clipboard, mouse click/drag/scroll/hover, IME mode select — each classified by operation class and safety gate (§5–§6).
3. **Per-OS capability matrix** with mechanism candidates and honest verification status (§7).
4. **Safety gates**: mutation authorization, `PanelTarget` identity reuse, focus re-verification, key/button residue cleanup, clipboard restore, bounded waits, UNKNOWN non-resend (§5).
5. **Verification plan**: what is provable now (contract, fakes, fixtures, helper code at `implemented`) vs what requires a real host (§8).

Out of scope:

- Workspace/dock rearrangement (#345), recording (#346), general locator/re-resolution engine (B-CONSUMER), any OCR/image-based input *decision* path (prohibited by gui-supervision spec).
- File drag-and-drop payloads, menu/file-picker automation — real-use-case slices under #345's umbrella, not this ticket.
- Third-party CEP/UXP panel support *claims*: the contract is written so any text surface is a `PanelTarget` with a different locator, but only self-owned fixture panels are in the first slice's verification scope.
- Any enablement of global input without the authorization gate in §5.4.

## 3. Existing helper inventory

Searched `src/`, `scripts/isolated-session/`, `host/` on `release-0-7-0` for `CGEvent`, `SendInput`, `keyDown/keyUp`, `composition`, `clipboard`, `pasteboard`, `AXFocused`, `frontmost`, `IME`, `inputMethod`, `AXValue`, `TSF`. Findings:

### 3.1 macOS

| Capability | What exists | Where | Level |
| --- | --- | --- | --- |
| Window/AX census + frame attribution | `CGWindowListCopyWindowInfo` + AX tree walk reading role/subrole/title/desc/**`AXValue`** | `src/platform/darwin/window-census.ts`, `src/driver/gui-recovery.ts`, `scripts/isolated-session/ax-windows.swift` | verified on real host (observation) |
| AX press / coordinate click | `AXUIElementPerformAction`, `System Events click at {x,y}` — already a real *mouse* mutation path | `scripts/isolated-session/ax-press.swift`, `gui-recovery.ts` (`CLICK_AT_SCRIPT`) | verified on real host |
| Session-scoped exec | `runInSession` (`launchctl asuser` / already-inside) | `src/driver/mac-session.ts` | verified on real host |
| GUI lease + audit | `acquireGuiLease`, `auditGuiEvent` | `src/platform/darwin/gui-lease.ts` | verified on real host |
| Key-event *observation* only | `CGEventTapCreate` listening for `keyDown`/`flagsChanged` — a witness tap, **not** a posting path | `scripts/isolated-session/focus-watch.swift` | compiled/run in isolated checks; tap itself is read-only |
| Frontmost/focus facts | `frontmost` flag in `guiState()`; `NSWorkspace.frontmostApplication`, System Events `frontmost` | `src/api/gui-state.ts`, `focus-watch.swift` | verified on real host (observation) |

**Not present on macOS**: no `CGEventCreateKeyboardEvent`/`CGEventPost` anywhere, no `CGEventPostToPid`, no modifier-flag posting, no `NSPasteboard`/`pbcopy` use, no `TISSelectInputSource`/input-source enumeration, no `kAXFocusedUIElement`/`AXSelectedText`/`AXSelectedTextRange` reads, no marked-text/composition-string read, no IME candidate-window classification. `AXValue` *is* already read in the AX walk, so committed-value readback for AX-exposed fields is the cheapest observation channel — but whether a given control's `AXValue` reflects in-progress composition is **unverified**.

### 3.2 Windows

| Capability | What exists | Where | Level |
| --- | --- | --- | --- |
| Window census + UIA tree | Win32 `EnumWindows` + UIA control tree (role/name/bounding rect, `ValuePattern` *read* only) | `src/platform/windows/gui-observe-script.ts`, `gui-probe.ts` | implemented; real-host evidence per #282/#324 |
| UIA press / coordinate click | `InvokePattern.Invoke()`, `SetCursorPos`+`mouse_event` fallback — the only existing input mutations | `src/platform/windows/gui-act-script.ts` | automated test; real-host per gui-recovery evidence |
| Session scoping | helper runs as child of the in-session agent; session proof before acting | `gui-act-script.ts` header | verified on real host (recovery) |

**Not present on Windows**: `SendInput`/`keybd_event` appear **only in comments** stating the observer never calls them; no `SendInput` posting exists. No UIA `ValuePattern.SetValue` (and per §4.3 it must never count as IME evidence anyway), no `SetFocus`/`SetForegroundWindow` mutation, no clipboard cmdlet/P-Invoke use, no TSF (`ITfInputProcessorProfileMgr`, `ITfContextComposition`) anywhere, no `GetGUIThreadInfo`/focused-element read beyond what UIA happens to expose. UIPI/integrity-level interaction with `SendInput` is unstudied.

### 3.3 Cross-cutting

- `src/platform/contract.ts` `Capabilities` — adapter capability model; input capabilities must surface here (and in the `ae.capabilities()`/panel-style section per panel spec §6.4), each with a verification level and gate status.
- `src/driver/gui-recovery.ts` + `src/driver/windows-gui-recovery.ts` — the lease→audit→identity-recheck→act→verify→audit pattern input ops must generalize, not bypass.
- `host/` ExtendScript — the only in-AE readback channel (e.g., a fixture ScriptUI control's `text`/`value` property). It is a *readback* channel; writing a value through it is a direct-set and never IME evidence.
- CEP: **no CEP-specific code exists**. `capabilities.ts` has an `ExecutionClass` enum value `"cep"` (transport classification only, ADR-0001 lists "CEP panel + Node socket" as a *deferred* transport). AE's CEP panels are CEF/Chromium surfaces inside the AE process tree; whether remote debugging (CDP) can be enabled on AE's CEF is **unknown** — this is a T001 investigation item, not an assumption.

## 4. The two input channels — contract boundary

This is the load-bearing distinction of the ticket. "Composition" exists at two layers and the evidence must never be blurred:

### 4.1 Tier 1a — CEP composition protocol (in-panel DOM channel)

Scope: DOM `compositionstart` / `compositionupdate` / `compositionend` events, DOM `input` events, and the element's DOM value **inside a CEP panel's Chromium context**.

Observation channels, in order of preference:

1. **Fixture self-report** — the test-owned CEP extension's own JS installs DOM listeners and reports events through the extension's own bridge (Node side of the extension → fixture result). This is fully under our control, needs no OS permission, and is the primary Tier-1a channel. It observes *what the panel saw*, which is exactly what a plugin author cares about.
2. **CDP (Chrome DevTools Protocol)** — `Runtime.evaluate` listeners or `Input.imeSetComposition`/`Input.insertText` *for observation setup only*. Feasibility on AE's CEF is **unverified**: it requires a remote-debugging endpoint on the CEF subprocess, which AE does not document exposing. T001 must record the investigation result; if unavailable, the channel is `unsupported`, not silently skipped.
3. **OS accessibility marked text** — `AXValue`/selected-text reads may or may not expose the in-progress composition string on a CEF control. **Unverified**; recorded as best-effort only.

A Tier-1a pass proves: *the panel's DOM received composition events and reached a committed DOM value under whatever input was actually delivered*. It does **not** by itself prove the OS IME ran — DOM composition events also fire for CDP-synthesized composition and some non-IME paths.

### 4.2 Tier 1b — OS IME end-to-end (platform input channel)

Scope: key events that traverse the **platform text-input/IME stack** — on macOS the active input method (Hiragana/Kana/etc. via the WindowServer input pipeline), on Windows TSF with an installed IME (e.g., MS-IME Japanese) — producing uncommitted → conversion → candidate-selection → commit/cancel, verified by committed value and/or observable screen change.

Only this tier may be reported as "OS IME works". Explicitly **forbidden as Tier-1b pass evidence** (issue FR):

- CDP `Input.insertText`, `Input.imeSetComposition`, `Input.dispatchKeyEvent` without OS-level delivery;
- DOM `value`/`textContent` assignment, ExtendScript property writes, CEP `evalScript` writes;
- UIA `ValuePattern.SetValue`;
- clipboard write + paste *as the sole input mechanism* (paste is a legitimate *operation class* — §6 — but a pasted string is not evidence that typing/IME works; a test may use paste for setup and must label the assertion accordingly);
- `System Events keystroke` **only if** it is later proven to bypass the input-method stack — today its IME behavior is unverified, so it is neither credited nor debited until measured (§7).

Tier-1a and Tier-1b results are recorded **separately** (issue AC). A combined report says e.g. "Tier1a composition observed: yes; Tier1b OS IME commit: unverified/failed" — never a merged "IME works".

### 4.3 Tier 2 — ScriptUI / AE-native / custom-drawn surfaces

Real key input (same OS channel as Tier-1b where the surface accepts it) plus **committed result**: the control's value via in-AE readback (fixture retains the control reference, same oracle pattern as panel spec §5) or an observable screen change (panel capture diff per the panel spec artifact contract). Internal composition observation is **explicitly non-required** at this tier (issue FR); surfaces that expose no AX/DOM text are still testable via capture-diff.

## 5. Operation classes and safety gates

Input reuses the panel spec's class model; input adds one new *scope* dimension because keystrokes are delivered through session-wide streams on both OSes.

### 5.1 Classes

| Class | Operations | Gate |
| --- | --- | --- |
| `observe` | read focused element/`AXFocusedUIElement`/UIA focus, read `AXValue`/DOM value/selected text, subscribe fixture composition events, capability query, census/frontmost check | existing read-only path; no lease |
| `mutate-gui` — *target-scoped* | focus request on the proven target, key down/up, modifiers, sequential/direct text entry, selection/replace/delete, mouse click/drag/scroll/hover **delivered to the target** | GUI lease + audit + `assertProvenIdentity` + `attribution==="owned"` + `PanelTarget` re-resolution immediately before posting (the `pressButton` pattern generalized) |
| `mutate-gui` — *session-stream* | key/text/modifier posting through the OS-wide input stream (macOS HID/session event tap; Windows `SendInput`) — reaches **whatever is focused**, so it is only safe after focus proof | all of the above **plus** `requiresGlobalInputAuthorization` (§5.4) and focus-holder re-verification inside the lease immediately before each post |
| `mutate-gui` — *shared-state* | clipboard write, IME/input-source mode select | all of the above **plus** mandatory save-and-restore of prior state (§5.5) and `requiresGlobalInputAuthorization` where the state is user-global |
| `mutate-session` | input affecting windows outside the target pid, workspace-level changes | out of slice; own spec + A-SAFETY sign-off |

### 5.2 Target identity

Every input op resolves a `PanelTarget` (panel spec §6.1): pid + process start identity + window/element handle + frame/focus re-check, `attribution==="owned"` required before any posting. For `docked-region`/non-window surfaces (ScriptUI controls inside the main window), the target is the *element path* within the proven window — the locator carries `axPath`/UIA automation id, and focus proof substitutes for frame proof where geometry is meaningless. Ambiguity → `ambiguous-target`, never a guess. Handles are re-resolved per op; nothing input-related is durable across calls.

### 5.3 Focus contract (the input-specific invariant)

Session-stream input has no address — it goes to the focused element of the foreground app. Therefore every session-stream op is a three-step proof, all inside the mutation lease:

1. **Pre**: resolve target → verify attribution → acquire/verify focus on the intended element (AX `kAXFocused`/`AXMain`, UIA `SetFocus` where exposed, or a verified click) → read back *who actually holds focus* (macOS `AXFocusedUIElement` on the app element / `kAXFocusedWindow`; Windows `GetGUIThreadInfo` + UIA focused element).
2. **Act**: post the event(s); between posts of a sequence, focus is re-checked at bounded intervals — a focus change mid-sequence aborts the op, it does not "finish typing into the new focus".
3. **Post**: read back the committed value / observable result; report `requested` vs `observed`, never claim success on timeout.

If the target cannot be made foreground/focused (e.g., another app holds it and focus-stealing is not authorized), the op refuses *before posting* — typing into whatever happens to be focused is the failure mode this contract exists to prevent. Frontmost-app state is restored afterwards where we changed it.

### 5.4 Global-input authorization

Session-stream posting and shared-state mutation are **global in effect** even when aimed at our target: on a shared console session they can land in a foreign app if focus proof is wrong, and on any session they disturb the user's real input. Rules:

- A `requiresGlobalInputAuthorization` capability is reported per OS/session kind; it is `unavailable`/`needs-human` until A-SAFETY clears the input gate and the caller passes an explicit authorization token/scope (dedicated session id or "this PanelTarget only, this operation class").
- Dedicated/isolated sessions (uid-asid / host-and-user proven per `sessionIdentity`) relax the *human-consent* requirement to an isolation check — the session is already proven non-interfering — but never relax target identity or cleanup.
- Shared/attached sessions additionally require the session to be the caller's own GUI session (the `local` probe intent path), matching how panel `mutate-gui` treats console sessions in the panel spec §7.1.
- Authorization is per-operation-class, recorded in the audit event, and never implied by a prior grant.

### 5.5 Cleanup contract

Every input op runs under a `finally` that guarantees:

- **Key/button residue**: every `keyDown` is paired with `keyUp` in the same lease scope (tracked pressed-set, released in reverse order); modifier flags are cleared; no stuck-key state may survive an exception, timeout, or cancellation — issue FR "キー/ボタン押下残留をcleanup".
- **Composition residue**: a pending (uncommitted) composition is resolved explicitly — commit or cancel per the op's declared semantics — and the *resulting* state is reported; an op never leaves an invisible half-typed string unreported.
- **Shared state**: clipboard prior contents (promised flavors where the OS allows) and prior IME/input-source mode are restored; restore failure is reported, not hidden.
- **Focus**: focus/frontmost state we changed is restored where practical; where restore fails it is reported as evidence.
- **Bounded waits**: every step has a deadline; timeout → `indeterminate`, state restored-or-reported, never retried blind (UNKNOWN non-resend — a resent "type hello" types it twice; input ops are never auto-retried).

### 5.6 Evidence

Each op emits an audit record carrying: operationId, PanelTarget ref, operation class + scope, authorization token reference, pre/post focus holder, key/modifier sequence summary (not raw secrets — text payloads are evidence but flagged), value readback before/after, composition events observed (Tier-1a) vs OS-IME verdict (Tier-1b) kept distinct, cleanup results, and final verdict (`performed`/`refused`/`indeterminate`/`failed`).

## 6. Input operation taxonomy

| Operation | Delivery channel (candidate) | Class | Notes |
| --- | --- | --- | --- |
| `focus` | AX `AXFocused`/`AXMain` set; UIA `SetFocus`; verified click fallback | mutate-gui target-scoped | readback of actual focus holder is part of the op |
| `key` (down/up, named keys, modifiers) | macOS `CGEventCreateKeyboardEvent`+`CGEventPost`; Windows `SendInput` VK/scan | mutate-gui session-stream | modifier state tracked for cleanup |
| `type` sequential (per-char, IME-path) | same as `key`, char-by-char VK events | mutate-gui session-stream | the Tier-1b IME driver; pacing configurable, default human-ish |
| `type` direct (paste-like bulk) | clipboard write + paste keystroke; or `CGEventPostToPid` unicode string **if** verified to reach IME (unlikely — see §7) | shared-state for clipboard; session-stream otherwise | labelled `direct-entry`; never IME evidence by itself |
| `select`/`replace`/`delete` | modifier+key combos (`cmd/ctrl+a`, arrows, backspace/delete) | mutate-gui session-stream | selection state readback where OS exposes it (`AXSelectedTextRange`, UIA `TextPattern`/`ValuePattern` read) |
| `clipboard` read/write | `NSPasteboard` / Win32 clipboard or PS `Get/Set-Clipboard` | shared-state | write always save+restores; read is observe-adjacent but clipboard *contents* may be sensitive — recorded as evidence only on explicit request |
| `mouse` click/drag/scroll/hover | existing `System Events click at`/`mouse_event`; `CGEvent` mouse / `SendInput` mouse for drag+scroll | mutate-gui (click already exists for recovery; drag/scroll new) | coordinates always from the *re-verified* element frame, never remembered positions |
| `ime-mode` select/query | macOS `TISCopyCurrentKeyboardInputSource`/`TISSelectInputSource`; Windows TSF `ITfInputProcessorProfileMgr` | shared-state (mode is user-global) | requires an installed Japanese IME; `unavailable`/`needs-human` when none — honest capability, not a failure |
| `composition-observe` | fixture self-report (primary); CDP (if feasible); AX marked-text (best-effort) | observe | Tier-1a channel; per-surface `supported`/`unsupported`/`unverified` |

Public API naming is a follow-up ticket decision; working shape is `ae.input.*`/`panel.input.*` operations taking a `PanelTarget` locator, mirroring `ae.panel(locator)` from the panel spec §7.1.

## 7. Per-OS capability matrix

Verification levels: `implemented` (code exists, compiles) / `automated test` / `fake/mock only` / `verified on real host` / `unverified` / `unsupported`. "Real-host" below means an *owned* AE launch on a licensed install — the same blocker class as #339.

| Capability | macOS candidate mechanism | Windows candidate mechanism | Status today |
| --- | --- | --- | --- |
| Focus readback | `AXFocusedUIElement`/`AXFocusedWindow` on app element (new attr reads in existing swift helper family) | `GetGUIThreadInfo` + UIA focused element in existing PS observer | implementable now; unverified on real host |
| Focus request | AX `AXFocused`/`AXMain` set, or verified click | UIA `SetFocus` pattern, or verified click | implementable; `SetFocus` on arbitrary CEF/ScriptUI controls unverified |
| Key/modifier posting | `CGEventCreateKeyboardEvent` + `CGEventPost` to `kCGHIDEventTap`/`kCGSessionEventTap` via new `scripts/isolated-session/*.swift` helper run through `runInSession` | `SendInput` (`KEYEVENTF_SCANCODE`/`VK`) via `Add-Type` P/Invoke in a `gui-act-script.ts` sibling | implementable; **requires Accessibility/Input-Monitoring grant on macOS (verify), UIPI/integrity check on Windows**; real-IME pass-through unverified |
| Target-scoped key posting | `CGEventPostToPid` — *if* it delivers through the input-method stack it becomes the preferred non-global channel; if it bypasses IME it is still useful for Tier-2 real-key tests but is **not** Tier-1b evidence | none known (SendInput is session-global by design) | **unverified — T001 experiment**; do not assume either way |
| Sequential text entry | per-char `CGEvent` unicode/key events through HID tap (IME processes them) | `SendInput` VK events for romaji → TSF/IME composes | implementable; real-host only |
| Direct/bulk text entry | `NSPasteboard` write + paste keystroke; or `CGEventPostToPid` unicode string (non-IME) | clipboard + `SendInput` ctrl+V; or `KEYEVENTF_UNICODE` (bypasses IME — label accordingly) | implementable; restore contract applies |
| Selection/replace/delete | `cmd`-modified `CGEvent`s; `AXSelectedTextRange` readback | `SendInput` ctrl/shift combos; UIA `TextPattern`/`ValuePattern` read | implementable; selection readback coverage per control unverified |
| Clipboard | `NSPasteboard` (all promised flavors) via swift helper or `pbcopy`/`osascript` | Win32 clipboard P/Invoke or `Get/Set-Clipboard` | implementable; shared-state gate applies |
| Mouse drag/scroll/hover | `CGEvent` mouse events (post + drag sequences) | `SendInput` mouse events (`MOUSEEVENTF_*`) | implementable; existing click path reusable |
| IME mode select/query | `TISCopyCurrentKeyboardInputSource`, `TISSelectInputSource`, `TISCreateInputSourceList` — requires the Japanese input source enabled in System Settings | TSF `ITfInputProcessorProfileMgr.Get/ActivateInputProcessorProfile` (COM; PowerShell interop or small C# helper) | implementable at `implemented` level; **needs a real host with a Japanese IME installed — `needs-human` until then** |
| Composition observation — fixture | n/a (panel-side JS) | n/a | contract now; real-host with fixture CEP panel |
| Composition observation — CDP | CDP endpoint on AE's CEF (`--remote-debugging-port` or equivalent) | same (CEF is cross-platform) | **unverified feasibility — T001 investigation**; likely `unsupported` if AE exposes no debug endpoint |
| Composition observation — OS accessibility | `AXValue`/marked-text attributes on CEF control | UIA `TextPattern`/`ValuePattern` on CEF control | unverified; best-effort only, never sole IME evidence |
| IME candidate-window detection | candidate window belongs to the input-method process → census sees it as **foreign**; usable as "IME UI visible" evidence, not target content | same shape via Win32 census/UIA | observation-only; foreign attribution must never be mutated |

Cross-cutting honest answers required by capability reporting: "Windows `CGEventPostToPid` analog: none", "macOS TSF analog: none", "CDP on AE CEF: unverified", "Japanese IME present: needs-human probe". Unsupported combinations are explicit values, not omissions.

## 8. Verification plan

**Provable now (this ticket / follow-ups without real AE):**

- The contract itself: operation taxonomy, class/gate mapping, cleanup invariants — unit-tested against fakes (`src/testing/fake-adapter.ts` family) and the in-repo fake AE host where the fixture surface is scriptable.
- Focus-proof *logic*: given a fake focus-holder readback, the three-step proof refuses on focus change — automated test.
- Cleanup logic: pressed-set tracking, reverse-order key-up, clipboard save/restore records — automated test with fake posters.
- Capability reporting shape: per-OS matrix emitted with correct verification levels — automated test.
- Fixture *code*: the self-reporting CEP extension (manifest + JS listeners + result bridge), a ScriptUI fixture window with a retained-control readback, a custom-drawn (e.g., ScriptUI `edittext` vs custom palette) variant — `implemented`, exercised only on real host.
- Helper *code*: swift `key-post`/`clipboard`/`input-source` helpers and the PowerShell `SendInput`/clipboard/TSF-profile siblings — `implemented` + `automated test` for argument validation/script compilation (`osacompile` precedent), **not** verified delivery.

**Requires real host (owned AE launch; blocked same class as #339 until an owned launch is possible):**

- `CGEventPost` actually reaching AE's focused control; whether it traverses the input-method stack (the Tier-1b question).
- `CGEventPostToPid` semantics: IME-pass-through or bypass — decides whether a target-scoped non-global channel exists on macOS.
- macOS Accessibility/Input-Monitoring grant requirements for posting; behavior under `runInSession`.
- CDP feasibility on AE's CEF (T001 investigation; may resolve to `unsupported`).
- AX marked-text/`AXSelectedText` behavior on CEF and ScriptUI controls.
- Windows `SendInput` delivery to AE panels under UIPI; TSF MS-IME composition; UIA focus/`SetFocus`/`TextPattern` coverage on CEF and ScriptUI surfaces.
- Clipboard round-trip fidelity (formats, restore) on both OSes.
- Japanese IME presence is itself `needs-human` — a machine without one reports `unavailable`, which is a valid capability answer, not a test failure.

**Negative cases (issue T003), all automatable at contract level now, real-host later:** wrong-focus abort mid-sequence; missing AX/trust grant → refuse before posting; interruption (timeout/cancel) mid-composition → cleanup verified; foreign/ambiguous attribution → refuse; authorization absent → `unavailable` not silent no-op. These run through B-CONSUMER/B-TEST once the public contract lands.

## 9. Non-goals

- No general input DSL, selector engine, or recorded-macro playback.
- No claim that CDP composition, direct value set, or paste satisfies OS-IME — the boundary in §4 is contractual.
- No mutation enablement in this stage: helpers/contracts land gated; `requiresGlobalInputAuthorization` stays closed until A-SAFETY clears the input gate.
- No foreign-AE or foreign-app interaction; no input outside the proven target's focus; no screen-scraping input decisions.
- No Windows real-host verification claims — explicitly `unverified` until a Windows lane runs.
- No ae-test consumer implementation here (B-TEST / ae-test#145 consumes the contract later).

## 10. Traceability

| Issue element | Where addressed |
| --- | --- |
| FR Tier1a CDP composition protocol (methods, DOM value, composition events) | §4.1 — fixture self-report primary, CDP feasibility T001, AX best-effort |
| FR Tier1b OS real-key/IME mode/uncommitted/conversion/candidate/commit/cancel, independent verification | §4.2, §7 — session-stream posting, IME-mode ops, separate result records |
| FR "CDPや値直接設定でOS IME合格としない" | §4.2 forbidden-evidence list |
| FR Tier2 ScriptUI/native/custom-drawn: real key + commit/cancel + value/screen change, composition observation non-required | §4.3, §6 |
| FR platform boundary: focus, key down/up, modifiers, sequential/direct, select/replace/delete, clipboard, needed mouse | §6 taxonomy, §3 inventory |
| FR shared-env global input explicit authorization; dedicated-env isolation check | §5.4 |
| FR key/button residue cleanup | §5.5 |
| FR common API after PoC; OS diffs as capabilities | §6 note, §7 matrix, capability reporting |
| T001 PoC + record limits | §7 `unverified`/`needs-human` cells, §8 |
| T002 public API/capability, target/permission/focus re-check, input-path evidence | §5, §6, §5.6 |
| T003 real-input + composition fixtures, negative cases, B-CONSUMER/B-TEST | §8 negative cases |
| AC: Tier1a/1b separate records; Tier2 representative; unsupported = reason+scope; un-investigated ≠ impossible | §4.2, §4.3, §7 honest-answer rule |

## 11. Verification levels reached by this document

| Claim | Level |
| --- | --- |
| No key/IME/clipboard input machinery exists in repo | `implemented`-verified by source search (§3) |
| Existing observation/mutation substrate (census, AX value read, press/click, lease/audit, session exec) | `verified on real host` where cited from prior evidence; otherwise per-row |
| macOS/Windows candidate mechanisms (CGEvent, SendInput, TIS, TSF, pasteboard) | `unverified` — API-level feasibility stated, delivery unproven |
| `CGEventPostToPid` IME behavior; CDP on AE CEF; AX marked-text | `unverified` — explicit T001 experiments |
| Contract, gates, cleanup, capability shape | this document only; `automated test` arrives with the implementation ticket |
