# Panel interaction — identification, resize, capture (B-PLATFORM shared contract)

- Parent program: [#337](https://github.com/ido-bata/ae-a8n/issues/337) (US-B1/B3/B4, Plan B)
- Ticket: [#343](https://github.com/ido-bata/ae-a8n/issues/343) — T001 (this document) + T002 read-only PoC scoping
- Related: [#342](https://github.com/ido-bata/ae-a8n/issues/342) (A-RUNTIME shares the minimal-capture and OS-boundary contract), [A-SAFETY #338](https://github.com/ido-bata/ae-a8n/issues/338) (mutation gates)
- Builds on: [gui-supervision spec](../gui-supervision/spec.md) (observation contract, GuiProbe, blocking taxonomy), [isolated-ae spec](../isolated-ae/spec.md), [ADR-0003](../../docs/adr/0003-ae-execution-modes.md), [ADR-0004](../../docs/adr/0004-native-mutation-authorization.md)
- Status: **draft for review**. Nothing named below is implied to exist yet. Verification level of every claim is stated explicitly.

## 1. Problem

A plugin author's responsive UI can only be tested by making After Effects show it at controlled sizes and photographing what is actually on screen. Today ae-a8n has:

- rich *observation* of the target's windows (AX tree + WindowServer census on macOS; Win32 census + UIA on Windows),
- a *mutation* path that can only press buttons and click points,
- a *capture* path that photographs the whole session screen for recovery evidence,

but nothing that identifies a panel as a distinct surface, resizes it, measures its real size, or captures it without leaking the rest of the screen. The first vertical slice (B-PANEL) must deliver: panel identification → real resize → actual size/state readback → target-panel capture → ae-test size/image assertions, without building a general GUI engine and without violating the safety gates that #338 is fixing.

## 2. First vertical slice scope

In scope for the slice:

1. **Target identification**: resolve "the panel" to one concrete OS surface owned by the target AE pid — a floating panel window, or a region inside the main window when docked.
2. **Real resize**: change that surface's size through OS-native means (AX attribute set on macOS; Win32 `SetWindowPos`/UIA on Windows), serialized by the same lease + audit authority as existing GUI mutations.
3. **Actual size/state check**: read back the size through an independent channel (OS geometry *and* an in-AE readback where the surface reports one). A requested size is never reported as achieved without readback.
4. **Target capture**: produce an image of that surface only, plus the untouched full-screen original when evidence requires it, with the two kept distinct (§6).
5. **Consumer contract**: expose capability/state/artifact information so ae-test (B-PANEL-TEST, ido-bata/ae-test#144) can assert size and image.

Out of scope (later slices, tracked by #344/#345/#346): text/keyboard/IME input (B-IME), workspace/dock rearrangement (B-WORKSPACE), recording (B-EVIDENCE), a general locator/re-resolution engine (B-CONSUMER), any OCR/image-based *decision* path.

## 3. Existing helper inventory

### 3.1 macOS

| Capability | What exists | Where | Level |
| --- | --- | --- | --- |
| Window census (all Spaces, per-pid) | `CGWindowListCopyWindowInfo` via CLT python3 ctypes; pid/owner/layer/onScreen/name/bounds | `src/platform/darwin/window-census.ts` | verified on real host (used by recovery; bounds+pid proven, window *names* partially redacted without Screen Recording permission) |
| AX window listing + frames | `LIST_WINDOWS_SCRIPT` AppleScript via `System Events`; title/role/subrole/frame/buttons/texts | `src/driver/gui-recovery.ts` (`MacGuiRecovery.listWindows`) | verified on real host |
| AX→census attribution | frame matching (`framesMatch`, tolerance 4px), `owned`/`foreign`/`unmatched` verdicts; refuses presses on unproven windows (#330/#332) | `src/driver/gui-recovery.ts` `assessGuiObservation` | verified on real host |
| AX element press | `PRESS_BUTTON_SCRIPT` (osascript) and `scripts/isolated-session/ax-press.swift` (`AXUIElementPerformAction`) | `src/driver/gui-recovery.ts`, `scripts/isolated-session/ax-press.swift` | verified on real host |
| Session-scoped exec | `runInSession` (`launchctl asuser` / already-inside), every GUI command runs in the target session | `src/driver/mac-session.ts` | verified on real host |
| Mutation lease + audit | `acquireGuiLease`, `auditGuiEvent`, per-session lease root | `src/platform/darwin/gui-lease.ts` | verified on real host |
| Full-screen capture | `screencapture -x -o <path>` inside the target session | `MacGuiRecovery.capture` (`src/driver/gui-recovery.ts` ~L1163) | verified on real host (recovery evidence) |
| Read-only observation API | `ae.guiState()` — window classification without pressing | `src/api/gui-state.ts` | verified on real host |
| Supervision probe | `MacGuiProbe` wraps listWindows + census into `ProbeSnapshot` | `src/platform/darwin/gui-probe.ts` | verified on real host |
| Standalone swift helpers | `list-windows.swift` (CGWindowList, on-screen only), `ax-windows.swift` (AX tree dump), `ax-prompt.swift` (AX trust), `focus-watch.swift` (foreign-session witness) | `scripts/isolated-session/*.swift` | compiled/run in isolated-session checks; AX-dependent ones need the grant |

**Not present on macOS**: any `AXUIElementSetAttributeValue` call (no `AXSize`/`AXPosition` write anywhere in the repo — confirmed by search), no `screencapture -R` region or `-l` window capture, no per-window `CGWindowListCreateImage`, no DPI/backing-scale handling, no panel-vs-window classification, no docked-panel addressing.

### 3.2 Windows

| Capability | What exists | Where | Level |
| --- | --- | --- | --- |
| Window census | Win32 `EnumWindows`/`GetWindowRect`/`IsWindowVisible`/`IsIconic`/`IsWindowEnabled`/`GetWindowThreadProcessId`, `WM_NULL` responsiveness probe, owner+modality evidence, session id | `src/platform/windows/gui-observe-script.ts` (PowerShell 5.1 + `Add-Type` P/Invoke) | implemented; real-host evidence per `docs/windows-verification.md` |
| UIA element tree | `UIAutomationClient` walk: controlType/name/automationId/enabled/texts/buttons with `BoundingRectangle` | same script + `src/platform/windows/gui-probe.ts` | implemented |
| Mutation (press/click) | `gui-act-script.ts`: `InvokePattern.Invoke()` or coordinate click from element bounds, behind lease+audit+identity re-check | `src/platform/windows/gui-act-script.ts`, `src/driver/windows-gui-recovery.ts` | implemented |
| Session scoping | agent runs inside target interactive session; `SESSION_MISMATCH` refusal | `src/platform/windows/*` | implemented |
| Host recovery | `windows-host-recovery.ts` — explicitly **no screenshot** on Windows today | `src/driver/windows-host-recovery.ts` | implemented |

**Not present on Windows**: `SetWindowPos`/`MoveWindow`/`SetWindowPlacement` (no resize), `PrintWindow`, `Graphics Capture`/`Windows.Graphics.Capture`, any screen-capture vehicle at all, DPI-awareness handling (`SetProcessDpiAwareness`), docked-panel addressing inside the main window.

### 3.3 Shared / platform-neutral

- `src/platform/contract.ts` — adapter capability model (`Capabilities`, `assertProvenIdentity`), the pattern the panel contract extends rather than bypasses.
- `src/platform/recovery-policy.ts` + `src/driver/recovery.ts` — measured dialog taxonomy, `chooseRecoveryWindow`, UNKNOWN non-resend semantics — the seed for target re-resolution and operation authorization.
- `src/platform/darwin/gui-lease.ts` — GUI mutation lease; the panel resize path must acquire the same lease family.
- `src/supervision/` — monitor lease vs GUI lease separation (spec §Durable shared state) — panel operations are GUI mutations, governed by the GUI lease, never the monitor lease.
- `host/` + ExtendScript dispatcher — the only in-AE readback channel; ScriptUI `Window.size`/`bounds` readback would come through it (see §5 oracle).

## 4. Gap analysis vs Issue #343 requirements

| Requirement | Status | Gap |
| --- | --- | --- |
| Floating/docked boundary | **partial** | Floating panels appear as separate top-level CGWindows (observed, §7). A *docked* panel has no window of its own — it is a region inside the main window's AX tree. Identification must therefore be two-mode: top-level window, or named region/pane inside the main window. Neither mode exists today. |
| Real size | **missing** | No resize mutation exists on either OS. Readback exists only as AX/census frame (points). In-AE readback (ScriptUI size) is new surface. |
| Coordinate DPI | **missing** | CGWindow/AX frames are in *points*; `screencapture` output is in *pixels*. Retina 2x and Windows per-monitor DPI are unhandled — no scale factor is recorded anywhere. |
| Target re-resolution | **missing** | `pressButton` re-verifies title/subrole/text/frame immediately before acting (good pattern); there is no handle/identity object that survives between identify→resize→capture, and HWND/pid reuse rules are not defined for panels. |
| Focus/occlusion | **partial** | Census reports `onScreen`; nothing distinguishes occluded-but-visible from fully covered, and nothing decides whether capture of an occluded panel is honest (`occluded` must be reported, not silently captured). |
| Capture leakage outside target | **missing** | Only full-screen capture exists. `screencapture -R`/`-l` (macOS) and `PrintWindow`/Graphics Capture (Windows) are unbuilt; crop-from-original must never be the primary artifact (§6). |
| Original vs crop/resize separation | **missing** | No artifact model distinguishes `original` (untouched capture) from `derived` (crop/scale). Recovery screenshots are originals only. |
| Operation authorization | **partial** | GUI lease + audit + `assertProvenIdentity` exist; the panel contract must add an explicit read-only vs mutation classification and tie enablement to A-SAFETY gates (#338), which are still open. |
| Readback over appearance | **contract only** | Recovery already follows "press ≠ success, verify after". Panel resize must report `requested` vs `observed` size and refuse to claim success on timeout/UNKNOWN. |

## 5. Oracle decision (T001)

**Representative target: a ScriptUI resizable window created by the test itself** through the existing in-AE script path (`Window("...", "palette", undefined, {resizeable: true})`).

Rationale:

- It is an AE-owned surface with a real, resizable, responsive-UI analog (ScriptUI is what panel authors' UXP/CEP predecessors resemble) and needs no third-party plugin install — deterministic in CI and on any licensed AE.
- It is *self-reporting*: the same script channel that creates it can read back `w.size`/`w.bounds`, giving an in-AE oracle independent of the OS geometry channel.
- It exercises the hard parts of the slice — identification among many AE windows, floating (ScriptUI palettes do not dock, so the slice covers the floating mode first), resize, dual-channel size readback, region capture.
- Third-party plugin panels (UXP/CEP/effect custom UI) remain the *consumer* scenario for B-PANEL-TEST; the contract (§6) is written so a plugin panel is just another `PanelTarget` with a different `locator`, not a different mechanism.

**Dimension oracle (two channels, must agree within tolerance):**
1. OS geometry: CGWindowList bounds (macOS) / `GetWindowRect`+DPI (Windows), in points, re-read after the resize settles.
2. In-AE readback: ScriptUI `w.size` where the surface provides one; otherwise the AE-reported comp/panel dimension if the locator exposes it. Disagreement beyond tolerance is a `readback-mismatch` failure, never silently rounded.

**Screenshot oracle:** region capture of the target only → pixel dimensions must equal `observedSize × backingScale` exactly; content assertion (e.g. ScriptUI renders a known solid/gradient at known size) goes to ae-test as `toMatchSnapshot` on the *derived* artifact, while the *original* is kept for provenance. A capture whose dimensions do not match the readback size is evidence of DPI/coordinate bugs, not a test pass.

## 6. Shared internal contract — "B-PLATFORM" (draft)

This contract lives inside #343 (per the ticket index) and is the coordination surface with A-RUNTIME (#342). Names are working names; public API naming is a T003 decision.

### 6.1 Target identity (`PanelTarget`)

A resolved panel is an immutable-ish descriptor, re-validated before every operation:

```
PanelTarget {
  target: { pid, processStartIdentity, session }        // proven host identity (assertProvenIdentity family)
  surface: {
    kind: "window" | "docked-region"
    windowId: CGWindowID | HWND-equivalent              // stable per window lifetime; NOT reusable across recreation
    locator: { title?, role?, subrole?, censusFrame?, axPath? }  // re-resolution hints, never sole identity
    frame: { x, y, width, height }                      // points, global screen space of the TARGET session
    coordinateSpace: { units: "points", origin: "top-left", backingScale: number | null }
    state: { visible, onScreen, occluded?, iconic?, enabled }
    attribution: "owned" | "foreign" | "unmatched" | "unproven"   // census verdict, #330 rules apply
  }
  resolvedAt, proof: { censusGeneration, axListingId? } // what the resolution was based on
}
```

Rules:

- Identity = pid + process start identity + window handle + frame re-check. Title/class are locator hints only; two AE versions share a bundle id (#330), so `attribution` must be `"owned"` (or an explicitly documented weaker tier) before any mutation.
- Handles are not durable: a re-resolution step re-runs census+AX and re-matches by handle first, locator second, frame last; ambiguity → `ambiguous-target`, never a guess.
- `docked-region` targets carry the parent window's handle plus a region locator; their geometry is relative to the parent frame and re-read each time (dock moves must not silently retarget).

### 6.2 Operation authorization

Every panel operation declares a class; the class decides the gate:

| Class | Operations | Gate |
| --- | --- | --- |
| `observe` | enumerate, resolve, measure, capture-original | existing read-only path (`ae.guiState()` family); no lease; allowed in console session for owned targets |
| `mutate-gui` | resize, move, focus, dock/undock | GUI lease + audit + `assertProvenIdentity` + `attribution==="owned"` + immediate pre-act re-verification — the `pressButton` pattern generalized |
| `mutate-session` | anything touching windows outside the target pid, workspace changes | out of slice; requires its own spec + A-SAFETY sign-off |

Additional rules:

- `mutate-gui` enablement is gated on the relevant A-SAFETY (#338) findings for resize-class mutation; until then the capability reports `unavailable`/`needs-human`, not a silent no-op.
- Deadline: every operation carries a bounded wait; timeout → `indeterminate`, original state restored-or-reported, never retried blind (UNKNOWN non-resend, ADR execution-model).
- Re-resolution before act AND after act; post-act readback compares `requested` vs `observed` and reports both.
- Foreign/ambiguous/unproven attribution → refuse before any OS mutation call, same fail-closed shape as `GuiAttributionError`.

### 6.3 Capture artifact contract

```
CaptureArtifact {
  kind: "original" | "derived"
  source: { operationId, target: PanelTarget-ref, capturedAt, session }
  geometry: { frame, coordinateSpace, backingScale, occlusion: "none"|"partial"|"full"|"unknown" }
  original?: { path, sha256, mime, pixelSize }              // untouched OS capture
  derived?:  { path, sha256, transform: "crop"|"scale"|..., params }
  unavailable?: { reason }                                  // honest absence, never empty success
}
```

Rules:

- The **original** is what the OS capture API returned for the target region (or full screen when the target cannot be isolated — then `leakage: "full-screen"` is recorded, not hidden). The **derived** artifact (crop/scale for assertions) is a separate file with its transform recorded; assertions consume derived, provenance keeps original.
- Region isolation is done at capture time (`screencapture -R`/`-l`, `PrintWindow`, Graphics Capture) — cropping an original afterwards is allowed only as a *derived* artifact and is labelled as such.
- Screenshot metadata joins target identity + timestamp + operation id + original path, per Issue #343 AC.
- Occlusion is measured (z-order/covered-region check where the OS allows) and recorded; a fully occluded target yields `occluded` evidence, not a misleading image.
- DPI: `backingScale` (macOS `NSScreen.backingScaleFactor`, Windows effective DPI) is recorded per capture; pixel size = points × scale is asserted, not assumed.

### 6.4 Capability reporting

`ae.capabilities()` gains a `panels` section: per-OS support matrix (`identify`, `resize`, `measure`, `capture-region`, `docked-region`) each with a verification level (`implemented` / `automated test` / `fake/mock only` / `verified on real host`) and gate status. Unsupported combinations are explicit — "Windows resize: not covered" is a valid, required answer.

## 7. macOS PoC findings (T002 scoping, read-only)

Environment: this machine, AE 2026 (pid 24051) and AE 2027 (pid 59955) both running in the console session; AE 2027 had an in-flight ae-a8n dispatch — **no foreign process was touched; only `CGWindowListCopyWindowInfo` (optionAll) was read.** This is `verified on real host` for *observation only*; nothing below authorizes mutation.

Observed (2026-11-2x, points, global top-left origin):

- AE 2027 main window: 1710×1074 @ (38,0); four additional 640×504 top-level windows at distinct positions plus a 500×500 window — consistent with **floating panels/palettes as separate CGWindows**.
- AE 2026 main window: 1710×1073 @ (39,1); one 500×500 window @ (0,612) layer 1; three 1710×38 strips at y=0 (menu/status chrome).
- Most AE windows reported `onScreen=0` at observation time (other Space or session state); the census correctly distinguishes this — panel capture must treat `onScreen` as a precondition check, not assume visibility.
- Window names: partially present (`"Adobe After Effects 2026 - 名称未設定プロジェクト *"`, `"名称未設定プロジェクト"`), many empty — consistent with Screen-Recording-gated name redaction. **Panel identification cannot rely on window titles alone**; role/subrole/geometry/size-class heuristics + AX path are needed.
- All observed windows are layer 0 except main-window chrome; AE panels do not get a distinguishing CGWindow layer — layer is not an identifier.

Feasibility conclusions for T002:

- **Identify (floating)**: feasible via census+AX frame attribution (existing machinery). Docked panels remain the open problem — AX tree region identification needed; ScriptUI slice defers this.
- **Resize**: implemented as `RESIZE_PANEL_SCRIPT` (`src/driver/gui-recovery.ts`) — System Events `set size` on the AX window/UI element, not the hypothesized swift `AXSize` helper; `set size` drives the same AX attribute. Identity is the census-attributed frame plus title/subrole, re-checked inside the session immediately before the set (frame tolerance 4pt). Verdicts: `RESIZED`/`CHANGED`/`NOT_FOUND`/`MISSING`/`FAILED`; `FAILED` audits `mutate` outcome `unknown` → `GuiMutationError`. Whether AE panels actually honor `set size` — **still unverified on a real host** (no owned AE launch was possible; foreign instances were not touched).
- **Measure**: census bounds re-read post-resize; in-AE `Window.size` readback is **not wired** (`readbackSource` reports `os-only`/`unavailable` honestly).
- **Capture**: `screencapture -x -o -R<x,y,w,h>` (`captureRegion`) and `-l<CGWindowID>` (`captureWindowById`) implemented; the census now parses `kCGWindowNumber` as the tenth pipe field — **verified on real host**: a read-only census run returned 253/253 windows with window numbers. `CGWindowListCreateImage` fallback not needed yet. Whether `-R` honours point units on every macOS version remains a real-host question — the artifact records PNG pixel size vs point frame so a scale mismatch is visible (`backingScale` is `null` unless pixels are an exact multiple). Region capture writes stay gated until A-SAFETY clears `mutate-gui`.
- **DPI**: bounds are points; `backingScale` is derived per capture from the PNG IHDR, never assumed.

### 7.1 Implementation findings (T003)

- Public surface: `ae.panel(locator)` + `ae.panelCapabilities()` (`src/api/panels.ts`); `Panel` is a locator, not a handle — every operation re-resolves.
- The mutation gate is wired explicitly: `panelForTarget` passes `panelMutationGate()` (`src/panels/gate.ts`) as `authorizeMutation` — the single flip point for the A-SAFETY decision recorded in `docs/gui-supervision-safety-gates.md` §「panel mutation（#343 / B-PLATFORM）」. The gate refuses every panel mutation today; the controller's own fail-closed default covers direct construction. Resize operates purely in the point coordinate space shared by AX and the census — no DPI conversion is involved, so there is no coordinate ambiguity to resolve for the mutation itself; capture-side scale ambiguity is reported via `backingScale`, never guessed.
- `capture` requires `owned` attribution; `foreign`/`unmatched`/`unproven` surfaces refuse rather than risk photographing another instance.
- Ops failures surface as `PanelError` codes, not driver error types: observation/capture failures → `unavailable`, a mutation with unknown outcome (`GuiMutationError`) → `indeterminate` (re-observe before retry), a throwing census degrades to unavailable attribution rather than crashing.
- macOS `allowConsoleSession: true` is set for panel ops (unlike recovery presses): the target is an explicitly requested, census-attributed window of the caller's own AE, and the lease/audit/identity re-checks are unchanged.

## 8. Windows coverage

**Not covered by this PoC.** Design notes only, for T002/T003:

- Census+UIA (`gui-observe-script.ts`) already yields per-window rect/class/automationId — the identification substrate exists.
- Resize candidate: `SetWindowPos` on the HWND (Win32) or UIA `TransformPattern`/`WindowPattern` where exposed; both need a new mutation script sibling to `gui-act-script.ts`, behind the same lease+audit.
- Capture candidates: `PrintWindow` (PW_RENDERFULLCONTENT) for own-process content without occlusion issues; `Windows.Graphics.Capture` for fidelity; both unbuilt. DPI: `GetDpiForWindow`/`SetProcessDpiAwarenessContext` handling required — coordinates in the census are physical pixels already, unlike macOS points.
- Docked panels: same two-mode problem; UIA `ControlView` tree regions inside the main window.

## 9. Non-goals

- No general GUI engine, locator DSL, or OCR/image-based decision path (spec prohibition inherited from gui-supervision).
- No input/IME (B-IME #344), no workspace/dock rearrangement (#345), no recording (#346).
- No mutation enablement in this ticket: T001/T002 produce contract + read-only evidence only; `mutate-gui` stays gated on A-SAFETY.
- No claims of Windows real-host verification — explicitly marked unverified.

## 10. Verification levels reached by this document

| Claim | Level |
| --- | --- |
| Helper inventory (what exists) | `implemented`+ — each row cites verified-on-real-host status from existing docs where applicable |
| macOS floating panels = separate CGWindows; docked panels not census-visible | `verified on real host` (read-only census, this machine, AE 2026+2027) |
| CGWindowID (`kCGWindowNumber`) parsed from census | `verified on real host` (read-only census, 253/253 windows carry it) |
| Contract + resolver + controller + API + negative paths | `automated test` (`test/panels.test.ts`, fixture/fake seams) |
| `RESIZE_PANEL_SCRIPT` compiles | `automated test` (`osacompile`, `test/macos-session.test.ts`) |
| Panel mutation gate | `automated test` — wired to `panelMutationGate()`, refuses all panel mutations pending the A-SAFETY entry in `docs/gui-supervision-safety-gates.md` |
| AE panels honor `set size`; `-R`/`-l` capture meets the artifact contract on a real panel | **unverified** — needs an owned AE launch, blocked same as #339 |
| Windows identification/resize/capture feasibility | **unverified** — no real Windows host in this work; API reports `unsupported` |
