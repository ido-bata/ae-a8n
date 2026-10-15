# Changelog

## 0.1.0-alpha.0

First published version (`next` dist-tag). Verified on macOS against After
Effects 2026 (26.5x89); Windows not run.

Compared with the pre-release branches this was built from (ido-bata/ae-a8n
#7, #8), real-host verification changed:

### Breaking

- `AfterEffects.close()` returns `CloseResult` (`{ quit, ownership, reason? }`)
  instead of `void`, quits After Effects only when the session owns it, and
  rejects with `UnsavedChangesError` rather than discard unsaved changes
  unless called with `{ unsavedChanges: "discard" }`.
- `AfterEffects.openProject()` rejects with `UnsavedChangesError` over unsaved
  changes unless called with `{ unsavedChanges: "discard" }`.
- `AeDriver.stop()` returns `StopResult` and follows the same rules.
- `./testing` no longer exports `FakeRenderQueue`, `FakeRenderQueueItem`,
  `FakeOutputModule`, `FakeFileFormat` (they modelled an API After Effects
  does not have). `FakePendingFrame` is new.

### Added

- `AfterEffects.ownership()`, `HostOwnership`, `UnsavedChangesError`,
  `CloseResult`, `StopOptions`, `StopResult`, `InvokeOptions`.
- `HostTransport.invoke(entry, options?)` takes an `AbortSignal`; optional
  `confirmLaunched()` and `ownership()`.

### Fixed (each found on a real host)

macOS install discovery and launcher; atomic result publication; build
number; the host's JSON codec on a cold start; `Object.prototype` members in
ExtendScript; composition lookup; one-frame rendering via `saveFrameToPng`;
`close()` waiting for the process to exit; call deadlines covering the
invocation; never abandoning an AppleEvent mid-script; script errors no
longer leave a modal dialog in After Effects.
