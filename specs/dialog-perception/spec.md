# Dialog perception — universal surface enumeration and bounded content reading

- Issue: [#462](https://github.com/ido-bata/ae-a8n/issues/462) (prerequisite for the #337 anomaly-handling program)
- Status: **implemented** (substrate); OCR engine coverage is platform/toolchain-dependent — see §OCR contract
- Builds on: [gui-supervision spec](../gui-supervision/spec.md) (observation contract, blocking taxonomy), [gui-evidence spec](../gui-evidence/spec.md), ADR-0005, ADR-0009
- Decision record: [ADR-0009](../../docs/adr/0009-dialog-perception.md)

## Problem

Anomaly handling cannot be built per-dialog. The measured reality on real hosts (issues #321, #330, #451, #406, RC-S17 evidence under `docs/evidence/release-0-7-0-rc-s17/`) is that After Effects shows surfaces the Accessibility API cannot see at all: AX-invisible modal dialogs (the AE 2027 BirthPrefs/crash-repair modal answered AX with zero windows while the WindowServer census listed it), custom-drawn `dvaui` dialogs that vend no AX tree, and notification-style surfaces that never appear as windows. A substrate that only reads AX-visible dialogs leaves every AX-invisible anomaly unclassifiable — which is exactly the failure mode #337 exists to eliminate.

The requirement is therefore **common acquisition**: every dialog-shaped surface the OS attributes to the target pid must be enumerated through one contract, and every surface must produce an honest *reading* — content when a channel can prove it, `unreadable` when none can. Per-dialog handlers are explicitly out of scope; this spec defines the substrate they would consume.

## Capability contract

### 1. DialogSurface enumeration (union, pid-scoped)

`enumerateDialogSurfaces(state: GuiAppState)` produces the union of:

- **AX-visible surfaces** — every `GuiAppState.windows` entry the census attributes to the target pid (`isPidAttributedWindow`). Foreign and unmatched AX windows are excluded exactly as they are for blocking evidence (#330/#332): an unproven window is never this instance's surface.
- **AX-unaccounted census surfaces** — every `GuiAppState.axUnaccountedCensusWindows` row: WindowServer windows for the pid that no AX window's frame accounts for, on any Space, on-screen or parked (#451). These carry `windowNumber`, `bounds`, `layer`, `onScreen`, `name`.

The union is deduplicated by construction: a census row an AX window accounts for never appears twice. Each surface gets a stable `surfaceId`:

- `ax:<n>` — the window's 1-based position in the AX listing (the same index `pressButtonIn` addresses; kept for correlation, **not** a press handle in this substrate).
- `census:<windowNumber>` when the census row carries a window number, else `census:<n>` by enumeration order.

Surfaces are *observed*, not judged: `axAccounted: false` marks census-only surfaces. Enumeration itself never blocks, presses, or mutates — it is a pure projection of an already-honest `GuiAppState`.

### 2. DialogReading schema

One reading per surface:

```ts
type DialogReading = {
  pid: number;
  surfaceId: string;                    // matches the DialogSurface id
  source: "ax" | "pixels" | "both" | "none";
  title?: string;
  bodyText?: string;                    // truncated; full text stays in evidence
  buttons: readonly { label: string | null; bounds: Rect | null; axRef: string | null }[];
  modality: "modal" | "non-modal" | "unknown";
  confidence: "high" | "partial" | "unreadable";
  unreadableReason?: string;            // required iff confidence === "unreadable"
  evidence?: {
    capturePath?: string;               // the PNG the pixel channel produced
    ocr?: OcrSummary;                   // engine, languages, duration, timeout flag
  };
};
```

Honesty levels:

- `high` — AX channel returned structured content (texts and/or buttons) for the surface.
- `partial` — content exists but from a weaker channel: OCR text on a census-only surface, or an AX window whose tree carried almost nothing.
- `unreadable` — no channel produced content. `unreadableReason` names the measured cause: no window number, capture failed, OCR engine unavailable, OCR timed out, OCR returned empty. **`unreadable` is a first-class answer, never an exception and never silently omitted** — a surface that cannot be read is still reported.

`modality` is `modal` only on positive evidence (an AX blocking window); census-only surfaces report `unknown` — parked/off-screen rows are explicitly *not proven blocking* (#451), and this substrate does not upgrade that claim.

`source` records which channels contributed: `ax` (AX text/buttons), `pixels` (capture+OCR), `both`, or `none` (unreadable). AX surfaces are never pixel-read by default — AX already carries their content; pixel reading is reserved for surfaces AX cannot see.

### 3. Content acquisition channels

Per surface, in order of preference:

1. **AX channel** (existing): `GuiWindowInfo.title/role/subrole/texts/buttons` for pid-attributed AX windows. No new machinery.
2. **Pixel channel** (existing + new): `captureWindowById(path, windowNumber)` (`screencapture -l`, read-only, session-scoped — #343/#451) produces a PNG per census surface that carries a window number.
3. **OCR channel** (new): bounded subprocess text extraction over the captured PNG. Contract:
   - **Bounded, always.** OCR runs as a child process with a hard timeout (default 45 s, measured need ~18 s for a 1050×754 dark-UI modal on the spike below). It never runs inside the supervision monitor tick and never blocks the probe's synchronous `observe()` — readings are produced on demand by consumers (`guiState({ readings: true })`, `probe.readings()`, the recovery evidence path), each of which is already off the hot path.
   - **Engine**: tesseract via `execFile` (async, `timeout` enforced by the runtime — a hung child is killed, not awaited). Language data is resolved honestly: the runner asks `tesseract --list-langs` once and intersects with the requested set; a missing traineddata is `ok:false`, not a guess. macOS Vision was evaluated and **rejected for this substrate**: on the RC-S17 fixtures it crashes inside `VNRecognizeTextRequest` result bridging (`SwiftNativeNSArray` fatal error whenever observations exist) and `.accurate` level hangs past 40 s — measured 2026-11-28, recorded in ADR-0009.
   - **Preprocessing is the caller's evidence problem, not a silent fix**: the spike showed the raw captures OCR correctly with `jpn` traineddata at `--psm 6`; invert/upscale variants were tried and are not required. If a future capture needs preprocessing, the reading's `evidence.ocr` records what was actually run.
   - **Budget**: enumeration covers *all* surfaces (parked included — the BirthPrefs modal was `onScreen: false`), but pixel reads are capped per call (`maxPixelReads`, default 8, on-screen surfaces first). Surfaces past the cap get `unreadable`/`deferred: perception budget` — honest, never dropped.

### 4. Safety boundary

This substrate is **evidence and reading only**:

- It performs no press, no keystroke, no mutation, and takes no GUI lease. `enumerateDialogSurfaces`/`readDialogSurfaces` are read-only by construction; the only writes are evidence PNGs under the caller's evidence directory.
- An AX-invisible surface therefore gains *content* but **no new press authority**. Press eligibility remains exactly the existing contract: measured `auto-safe` class + pid-attributed AX window + in-lease identity re-check. A `DialogReading` — however confident — is never an input to `chooseAction`/`chooseRecoveryWindow`.
- Visual-class press on AX-invisible dialogs is explicitly **out of scope** and requires a separate A-SAFETY decision (per #462 and ADR-0009). Until that decision exists, an OCR-read dialog is reported, classified by humans/policy, and never clicked.
- OCR text is *untrusted content*: it is evidence for classification, not an instruction channel. Nothing in this substrate parses OCR output into actions.

### 5. Wiring

- **Supervision probe**: `GuiProbe` gains an optional `readings(): Promise<readonly DialogReading[]>`. `MacGuiProbe` implements it by delegation to an injected async dep; the monitor's `observe()` tick is unchanged — readings are pull-based, never per-tick. A probe without the dep answers `[]` (readings unproven, not "no dialogs").
- **Recovery evidence**: `CensusWindowCapture` (#451) gains an optional `reading`. When the recovery is constructed with `dialogOcr` options, each successfully captured census window is OCR'd *after* the recovery decision — the synchronous list→decide→press ordering is untouched, and the none-path (the only path that produces census captures) has no press to interleave with. The reading lands in `RecoveryOutcome.censusCaptures[].reading`, which the attempt trace and attempt-ledger already record.
- **`ae.guiState()`**: gains `options.readings?: boolean`. When set, the observation additionally runs the full perception pipeline (capture + bounded OCR) and attaches `dialogReadings` to the report. The default stays the cheap AX+census observation — unchanged latency and honesty.
- **Attempt ledger**: no schema change. `guiState` and `session.recover` attempts are already traced ops; readings ride inside their `result`/`actual`, so `attempt-ledger.jsonl` records them with the same `attemptId` correlation (spec `release-acceptance` §5).

## Non-goals

- Per-dialog handlers (BirthPrefs, disk-space warnings, crash repair) — this substrate classifies surfaces generically; dialog-specific policy remains in `dialog-taxonomy`/expected-modals.
- Press/mutation on AX-invisible or OCR-only surfaces — separate A-SAFETY ruling required.
- Foreign-process dialog observation — scope is the session/owned host pid, same as every other observation path.
- OCR as a *detection* path — surface existence is proven by AX∪census before any pixel is read; OCR only fills in content. This preserves the gui-supervision spec's prohibition on screenshot/OCR as primary detection.
- Notification surfaces that are not WindowServer windows of the pid (e.g. the disk-space warning, likely a notification, not a window) — a different surface family, tracked separately if needed.

## Verification

- **Automated test** (`test/dialog-perception.test.ts`): union enumeration, surface-id stability, reading schema/honesty levels, `unreadable` causes, OCR timeout/kill semantics via injected exec, pixel-read budget, probe `readings()` passthrough, guiState deep mode.
- **Fixture spike** (real captures, `docs/evidence/release-0-7-0-rc-s17/`): BirthPrefs/crash-repair modal `window-9279.png`/`window-9716.png` (1050×754, dark UI, Japanese) — tesseract `jpn` fast, `--psm 6` → coherent Japanese dialog text incl. the three choice labels, ~18 s. Parked 1000×1000 captures (`window-9280/9736`) → empty output, honestly `unreadable`-grade. Menu-strip captures → noisy partial text, correctly `partial` at best. macOS Vision → rejected (crash/hang, above). Evidence note: `docs/evidence/dialog-perception/ocr-spike.md`.
- **Real host**: deferred — current host lane is owned by the RC worker; dialog readings on a live modal are unverified (`fake/mock only` + fixture level for this slice).
