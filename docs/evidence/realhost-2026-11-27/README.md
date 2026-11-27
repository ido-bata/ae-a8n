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
