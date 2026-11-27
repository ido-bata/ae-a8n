# Real-host PoC — 2026-11-27 (program #337 residual)

Issues: #339 residual (owned-launch pre-response attribution), #357 (B-PANEL
mutation gate PoC), #379 prep (IME feasibility peek).

Verification level: **verified on real host** for everything recorded here,
except where a step says `fake/mock only` or `implemented`. Nothing below
was presented as working against real AE.

## Environment correction (important)

The task brief stated "ZERO AfterFX processes". That census used
`pgrep -fl AfterFX`, which does **not** match the real binary name
(`After Effects`). Correct census: `pgrep -fl "After Effects"` or the
repo's own `psProcesses()` executable-path match. At run start:

- AE 2026: **foreign instance running** (pid 49400, later restarted to
  84367 by external automation — an Aulymo_v04 `DoScriptFile` was in
  flight). Never touched by mutation; read-only AX/census observation only.
- AE 2027: zero instances → owned-launch lane was viable.

## Task 1 — owned-launch boot attribution (#339 residual)

`boot-attribution-launch-2027.json`: `scripts/poc-boot-attribution.mjs
--mode launch --install "/Applications/Adobe After Effects 2027" --yes-launch
--ax` — **succeeded**. Owned launch pid 92467, attribution timeline
(pid+start+executable+uid/asid+WindowServer census) captured BEFORE the
ExtendScript response, session closed cleanly (`quit:true`, ownership
`owned`). AX listing returned 0 windows (`axSuspect:true`) — see Task 2 for
why that is structural, not transient.

`boot-attribution-launch.json`: the same script against AE 2026 —
**refused as designed** (foreign instance present). Fail-closed verified
on real host.

## Task 2 — panel mutation gate PoC (#357)

`scripts/poc-panel-mutation.mjs` + `scripts/poc-panel-extension.mjs`
(new, this branch): launches owned AE 2027 with a consumer extension host
(`ae-a8n extension build`) that creates a ScriptUI `resizeable` palette
window (`poc.panelShow/Info/Close`), then exercises:

- production `ae.panel(locator).identify()/measure()` — observe class;
- production `resize()/restore()` — **refused by `panelMutationGate()`**
  (recorded; gate still fail-closed, verified on real host);
- the same `PanelController` via `panelForTarget()` with an
  `authorizeMutation: () => ({allowed:true})` test seam — everything else
  production (owned attribution, frame re-verify, lease, audit).

**Result: `identify()` cannot resolve any panel — AE vends zero windows to
the AX enumeration the resolver walks** (`0 window(s) observed`,
PanelError not-found). Four owned launches + the foreign AE 2026 all show
`AXChildren=[AXMenuBar]`, `AXWindows=0`, `UI elements=[AXMenuBar]`.
Controls prove AX itself works (ChatGPT exposes AXWindow). Activation,
`AXEnhancedUserInterface`, `AXManualAccessibility`, and `open`-activate
none changed it. This is the same `axSuspect` phenomenon as #321/#322 but
total, not modal-scoped.

`ax-focused-window-resize.json` + probe sources (`axprobe2.swift`,
`axsetsize.swift`, `axprobe.scpt`, `axresize-system-events.scpt`): the
decisive follow-up on a still-running owned instance (pid 172, left by a
readiness-timeout launch, later proven responsive via attach):

- `AXFocusedWindow` DOES resolve real AE windows (AXLayoutArea/
  AXFloatingWindow panels; the 1710x1074 main window after init).
- System Events `set size` on that element: **-1712 AppleEvent timeout,
twice** — the production vehicle cannot complete on AE.
- Direct `AXUIElementSetAttributeValue(kAXSizeAttribute)`: **resize
  1710x1074→1200x800 and restore→1710x1074 both succeeded**; CGWindowList
  census confirmed the restored frame exactly. AX points == census points
  (no DPI conversion) — unblock condition (c) measured.

Honest scope: the resized element was the MAIN window (the only AX-
reachable one while focused), not a floating ScriptUI panel — floating
panels are AX-reachable only via AXFocusedWindow when they hold focus.

## Task 3 — IME feasibility (#379 prep)

`defaults read com.apple.HIToolbox`: Kotoeri RomajiTyping input mode
(`com.apple.inputmethod.Japanese`) is installed AND currently selected.
Japanese input source is available on this host. No input events posted.

## Cleanup / safety record

- All owned AE 2027 instances quit: PoC sessions via `ae.close()`
  (`quit:true`, ownership `owned`); the readiness-timeout leftover (pid
  172) via graceful `tell application <bundle> to quit` after verifying
  sole ownership — `AfterEffects.terminate` refused (no persisted launch
  provenance for the failed launch; reported, not force-killed).
- Final census: only foreign AE 2026 (pid 84367) remains — untouched.
- No TCC prompts were triggered or pre-granted. AX permission is already
  granted to this session's responsible process (AXIsProcessTrusted=true,
  ChatGPT/Vivaldi AX trees readable).

## Reproduce

```bash
npm run build
node scripts/poc-boot-attribution.mjs --mode launch \
  --install "/Applications/Adobe After Effects 2027" --yes-launch --ax \
  --out docs/evidence/realhost-2026-11-27/boot-attribution-launch-2027.json
node scripts/poc-panel-mutation.mjs \
  --install "/Applications/Adobe After Effects 2027" \
  --out docs/evidence/realhost-2026-11-27/panel-mutation-poc.json
swiftc -O docs/evidence/realhost-2026-11-27/axsetsize.swift -o /tmp/axsetsize
# /tmp/axsetsize <owned-pid> <w> <h>  — AXFocusedWindow AXSize set
```

## Follow-up — 2026-11-27 ~16:52 (#406 implementation branch)

`window-ops-state-ae2026.json` / `window-ops-state-ae2027.json`: the
`window-ops` helper's `state` subcommand (compiled from
`scripts/isolated-session/window-ops.swift` on branch `406`) run
read-only against the two AE instances alive at that moment:

- AE 2026 pid 84367 (foreign, running since 15:46): **4 AX windows
  vended**, `focusedWindow` populated, `axTrusted: true`,
  `focusedWindowIndex: 3`.
- AE 2027 pid 21047 (launched 16:47, outside the PoC): **12 AX windows
  vended**, `focusedWindow` populated, `axTrusted: true`,
  `focusedWindowIndex: 12`.

**This contradicts the absolute reading of Task 2's "AE vends zero
windows".** Both instances now enumerate normally. The zero-window
observations in this directory were all taken either (a) during
pre-response boot attribution, or (b) on owned launches that hit
readiness timeouts — i.e. instances that had not completed startup.
The non-vending state therefore looks **startup-phase-dependent, not an
absolute AE property**: a fully running AE vends AXLayoutArea/
AXFloatingWindow windows exactly as #304 measured. `AXFocusedWindow`
remains the only window reachable *while an instance is still in that
non-vending phase* — which is precisely when supervision needs it.

Consequence for #406: the `focusedOnly` observe path is still the right
contract (it works in both states and degrades honestly), but the issue
premise should be re-read as "AE can vend zero AX windows during early
startup / under some launch paths", not "AE never vends AX windows".

## Follow-up 2 — #357 second session (~19:40–20:15 JST, issue #357 continuation)

`scripts/poc-panel-ax-vehicle.mjs` (new, this branch) + the panel
extension (`scripts/poc-panel-extension.mjs`, carried over from
`realhost-poc`) + `ax-focused-set.swift` (new probe: JSON `state` /
`resize` / `move` on the app's `AXFocusedWindow` element). Three owned
AE 2027 launches (pids 28596, 80322, 89193, 58115 — the last is the
run that matters), foreign AE 2026 (pid 72456, externally driven)
observed read-only via census only. Full record:
`panel-ax-vehicle-poc.json` (the LAST run's document — earlier runs'
step logs are summarized below; the JSON holds the decisive run).

### What the earlier runs of this session established

- **Non-vending is not purely startup-phase.** Two fully-started owned
  launches (28596: responsive at ~34 s; 80322) polled `window-ops
  state` for 5 min and 2 min respectively — `windows: []` throughout,
  including ~1 min *after* `open` activation. System Events
  `UI elements` likewise returned only `AXMenuBar`. `AXFocusedWindow`
  kept working the whole time (palette, then main window after
  activation). The #406 "fully running AE vends windows" instances
  must have differed in some other way — most plausibly **the app
  having been frontmost/active** (see below).
- `frontmostPid` stayed a foreign pid on those runs — AE was never
  the active app even after `open` (activation moved
  `AXFocusedWindow` to the main window but did not make it frontmost
  in the WindowServer sense the helper reads).
- `ae.panel().identify()` → `not-found` on all runs (fail-closed,
  correct). `focusedOnly` `state()` resolved the focused palette to
  census `windowNumber` on run 1 — the observe contract works on real
  host. `focusedOnly` mutations refuse by design.

### The decisive run (pid 58115) — vehicle proven on the palette

Ordering mattered: this run drove the focused-element mutations
*before* the enumeration poll, while the palette was still
`AXFocusedWindow`. `frontmostPid` became the owned pid during the
mutation sequence, and the AX enumeration began vending shortly
after — consistent with the hypothesis that **AE populates its AX
window tree once the app has been active/frontmost**, not on a fixed
startup timer.

- **Focused vehicle (`AXFocusedWindow` + direct
  `AXUIElementSetAttributeValue`)**: identity = census row
  (windowNumber 2790, `120,96 400x324`, `onScreen:true`) matched the
  focused element's AX frame exactly. `resize` 400x324→560x440
  (`axError 0`), ScriptUI self-report `size 560x416` (ScriptUI reports
  content size; the 24 px delta is window chrome), census bounds
  `560x440`; `restore`→400x300; `move` +90/+60 → AX `210,156`, census
  `210,156 400x300`; move-back → `120,96 400x300`. All three channels
  agree; AX points == census points (no DPI transform).
- **Enumeration vehicle (production `windowOpsForTarget` +
  `authorizeMutation` seam, i.e. the real `WindowOpsController` →
  `window-ops act`)**: once vendored, `state()` resolved the
  **unfocused** palette (`resolution:"ax-windows"`, windowNumber
  2790, `attribution:"owned"`, `frontmost:true`) and `resize`/`move`/
  `restore`/`restore-position` all returned `performed` with
  postcondition-verified frames — again cross-checked against census
  and ScriptUI readback. **Unfocused windows ARE mutable through the
  enumeration vehicle** — the focused-only limitation applies solely
  to the `AXFocusedWindow` path.
- **Enumeration timing**: first vendored sample at ~15 s after
  `panelShow`+mutations with `frontmostPid` already = owned pid;
  after `open` activation the listing grew to 4 windows (main
  `AXLayoutArea/AXDialog` + strips). Exact trigger (frontmost vs.
  first AX write vs. elapsed time) is **not isolated** — recorded as
  an open question, not claimed.
- **Channel divergence**: System Events `UI elements` saw only
  `AXLayoutArea,AXLayoutArea,AXMenuBar` (2 windows) while the
  AXUIElement `AXWindows`/`AXChildren` path (window-ops helper) listed
  4 — and `ae.panel().identify()` still returned `not-found` because
  its LIST_WINDOWS_SCRIPT path + census attribution did not match.
  The two enumeration channels are NOT equivalent on AE; the
  window-ops/AXUIElement path is the one that works.
- **focusedOnly while unfocused**: `state()` → `not-found` ("only the
  focused window is AX-reachable — an unfocused window cannot be
  resolved through this path"); `resize` → `refused`. Correct
  fail-closed behavior, verified on real host.
- **Negative**: foreign census `windowNumber` (owned by the foreign
  AE 2026, pid 72456) → `not-found`/`unproven` refusal. No
  wrong-target resolution.
- Cleanup: `ae.close()` → `quit:true`, `ownership:"owned"`; postflight
  census empty. No TCC prompts.

### Verdict for #357 / #358

- Unblock condition **(b)** ("`set size` が実際に panel に効く"):
  **answered, negatively for the spec'd vehicle and positively for a
  different one.** System Events `set size` timed out (-1712) and its
  enumeration sees almost nothing; direct
  `AXUIElementSetAttributeValue` on both the `AXFocusedWindow` element
  and enumerated `AXWindows` entries resizes/moves/restores a real
  floating ScriptUI palette with three-channel agreement.
- Unblock condition **(c)** (coordinate uniqueness): **confirmed** —
  AX frame == CGWindowList bounds == ScriptUI geometry offset by the
  24 px title bar, all in global display points.
- Unblock condition **(a)** (A-SAFETY class decision): **still open —
  human/A-SAFETY authority required.** This evidence is the input to
  that decision; `panelMutationGate()`/`windowOpsMutationGate()` are
  unchanged and still refuse (verified in-run).
- Remaining unknowns for #358: exact AX-vending trigger (frontmost
  correlation, not proven causal); System Events vs AXUIElement
  enumeration divergence root cause; `ae.panel()` identify path needs
  the census-first/AXUIElement resolution (window-ops style) rather
  than LIST_WINDOWS_SCRIPT; docked-region panels untested; minimize/
  zoom variants untested; Windows lane out of scope.
