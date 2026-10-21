# Changelog

## Unreleased

Verified on macOS against After Effects 2026 (26.5x89, ja) and on Windows 11
(26.5x89, en) on 2026-10-21 (`docs/verification.md`, `docs/windows-verification.md`).
Windows: launch/install discovery (#17), process ownership (#40) and the session
marker (#44) are merged; menu commands, `hostEnvironment` and Undo/Redo were run
on a real host (#47).

### Added

- Menu commands (#45): `ae.menuCommand(nameOrId)` → `MenuCommand.execute()`,
  `ae.undo()`, `ae.redo()`. A run reports the active composition's layers
  before and after, with `added` / `removed` by layer id, and records the
  change in the trace (`menu.execute.scene`). Commands an AEGP plugin
  registers run synchronously through `app.executeCommand`. Only a numeric
  id is sent; no script text. Owned sessions only (`HostNotOwnedError`).
- `LaunchOptions.hostEnvironment`: process-scoped variables set inside AE
  (`$.setenv`) for native plugins to read with `getenv` (#45). Owned
  sessions only.
- Building a scene for a test: `project.createComp()`, `comp.addTextLayer()`,
  `comp.openInViewer()`, `comp.selectLayers()`, `layer.setEnabled()`,
  `layer.transform()`, `layer.shapePaths()` (#45).
- The fake host models text and shape layers, layer ids and selection, the
  active item, registered menu commands with undo/redo, and `$.getenv` /
  `$.setenv`.

### Changed

- `LayerInfo` carries `id`, `enabled`, `selected` and `type`, from
  `comp.layers()` too (part of #23); `enabled` is no longer optional.
- `@ido-bata/ae-a8n/testing` (unstable): `FakeLayer` takes `(name, position)`
  and numbers itself from its comp; `FakeProject.items` is an item collection
  with `addComp`, not an array.

## 0.1.0-alpha.1

Changes since 0.1.0-alpha.0. Verified on macOS against After Effects 2026
(26.5x89); Windows not run. Published through npm Staged Publishing
(`next` dist-tag) and approved by a person with 2FA.
Each item below was reproduced on that host before the change and
re-run after it (`docs/verification.md`).

### Breaking

- `PropertyInfo` is a union on `kind` (`"value" | "no-value" |
  "custom-value" | "group"`) and, for `"value"`, on `valueType`; `value` is
  present only when `kind` is `"value"` (#18, #21). Code that read
  `info.value` as a number has to narrow first:
  `if (info.kind === "value" && info.valueType === "OneD") info.value`.
- `Parameter.get()` and `set()` return `ParameterValue` (`number | readonly
  number[]`) instead of `number`, because colours, points and 3D points
  are arrays (#21). They always were at runtime; alpha.0 typed them as
  `number`. Numeric parameters still read and write plain numbers.
- `Parameter.get()` on a property group rejects with
  `PropertyHasNoValueError`; in alpha.0 it resolved `undefined` (#18).
- `Parameter.set()` / `info(value)` validate the shape on the host before
  writing and reject a mismatch with `ParameterValueError` instead of AE's
  own error (or, for `[]` on a single-number property, instead of AE
  silently storing 0) (#21).

- `openProject` rejects a relative path with a `TypeError` before sending
  anything (#34); it used to reach After Effects, which resolved it against
  its own working directory and failed with `AfterEffectsError` "project
  file not found" even with the file in the caller's directory. Paths are
  not resolved for you.

### Added

- `effect.parameters()` lists every property, including ones without a
  value (`ADBE Tint-0004`, Levels' histogram, Curves, Compositing Options);
  in alpha.0 one such property failed the whole call (#18).
- `PropertyKind`, `PropertyHasNoValueError` (#18).
- `ValueType`, `ValueProperty`, `ParameterValue`, `ParameterValueError`;
  `PropertyInfo.valueType` (After Effects' `PropertyValueType` name);
  `set()` accepts arrays for points, 3D points and colours (#21).
- `AfterEffects.project()` returns the project open now without opening
  anything, e.g. after a timed-out `openProject` (#22).
- Per-call `timeoutMs` on `openProject`, `renderFrame` and `project`;
  `OperationOptions`, `OpenProjectOptions` (#22).
- Bridge: a failure payload may carry `kind` (additive).


### Docs

- Skill and README corrected from the Mac agent lab (#27).
- Example commands use absolute project paths (#34).

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
