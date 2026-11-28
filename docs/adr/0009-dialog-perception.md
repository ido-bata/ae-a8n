# ADR 0009 — Dialog perception substrate: union enumeration, bounded OCR, evidence-only

- Status: accepted
- Date: 2026-11-28
- Issue: [#462](https://github.com/ido-bata/ae-a8n/issues/462) (program [#337](https://github.com/ido-bata/ae-a8n/issues/337))
- Spec: [`specs/dialog-perception/spec.md`](../../specs/dialog-perception/spec.md)
- Relates to: [ADR-0005](0005-session-supervision.md), [gui-supervision spec](../../specs/gui-supervision/spec.md) §Observation, [#451](https://github.com/ido-bata/ae-a8n/issues/451) (census-unaccounted windows), [#343](https://github.com/ido-bata/ae-a8n/issues/343) (`captureWindowById`)

## Context

The anomaly-handling program needs one substrate that can *see* every dialog After Effects can show, not per-dialog handlers. Measured on real hosts: AE 2027's modal dialogs can be completely AX-invisible (zero AX windows while the WindowServer census lists them — #321, #451, RC-S17), custom-drawn dialogs vend no AX content, and some surfaces (disk-space warnings) may not be windows at all. The existing pipeline already proves surface *existence* through the AX∪census union; what was missing is a uniform *content reading* contract and an OCR channel for surfaces AX cannot describe.

Two constraints shaped the design:

1. **OCR must never threaten the monitor.** A prior Vision attempt hung; the supervision tick is ~2 s. Any OCR path must be a bounded subprocess off the event loop's critical path.
2. **Reading is not authority.** The repo's safety model grants press only to measured `auto-safe` AX-addressable classes. Content acquired by pixels must not silently widen that.

## Decision

1. **One enumeration, two channels.** `DialogSurface` = pid-attributed AX windows ∪ `axUnaccountedCensusWindows` (#451), deduplicated by frame accounting. Surfaces are evidence objects; classification stays in `dialog-taxonomy`.
2. **`DialogReading` is honest by schema.** `confidence: "unreadable"` with a named `unreadableReason` is a first-class result; `modality` stays `unknown` for census-only surfaces (parked ≠ proven modal, per #451).
3. **OCR = bounded tesseract subprocess.** `execFile` with runtime-enforced timeout (default 45 s), language set resolved from `tesseract --list-langs`, invoked only on demand — never inside `MacGuiProbe.observe()` or the monitor tick. Vision framework is **rejected**: measured on the RC-S17 fixtures it crashes inside result bridging whenever observations exist and hangs at `.accurate` (2026-11-28 spike; see spec §Verification).
4. **Evidence-only boundary.** The substrate captures pixels and reads text; it presses nothing and takes no lease. Press eligibility is unchanged. Visual-class press on AX-invisible dialogs requires a separate A-SAFETY ruling and is a non-goal here.
5. **Pull-based wiring.** Readings surface through `GuiProbe.readings()?`, `ae.guiState({ readings: true })`, and `RecoveryOutcome.censusCaptures[].reading` (opt-in `dialogOcr`); all are traced ops, so the attempt ledger records them with no schema change.

## Why these choices

- **Union enumeration reuses proven machinery** (`GuiAppState`, `isPidAttributedWindow`, `axUnaccountedCensusWindows`) instead of inventing a third window source — the census is already pid-accurate where AX is not (#330).
- **Tesseract over Vision** is an empirical result, not a preference: Vision failed twice on this host (hang, then crash-on-results), while tesseract+jpn produced coherent dialog text on the exact fixture that motivated the issue.
- **Opt-in/pull-based OCR** keeps the default observation path fast; the ~18 s-per-window cost is paid only when a consumer explicitly asks for readings or the recovery evidence path is enabled.
- **`unreadable` as data** preserves the repo's honesty taxonomy: an unobservable surface is reported as such, never guessed into a class.

## Consequences

- OCR-dependent readings are only as good as the host's tesseract installation and traineddata; a missing `jpn` traineddata degrades Japanese dialogs to `unreadable`/garbage honestly (engine+languages are recorded in `evidence.ocr`).
- `gui-supervision` spec's "OCR prohibited as primary detection" is preserved: detection remains AX∪census; OCR fills content only.
- A future A-SAFETY decision may promote pixel-read dialogs toward press eligibility; until then `DialogReading` must never feed `chooseAction`.
- Notification-style surfaces that are not pid windows remain out of scope; if the disk-space warning proves to be one, it needs its own surface family.
