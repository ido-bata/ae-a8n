# Changelog

## 0.1.0-alpha.2

Published under the `next` dist-tag; `latest` stays on `0.1.0-alpha.0` until a
stable release is approved. This is the first version that carries the
isolated-testing surface on both platforms: the macOS session backend and the
Windows dedicated-host backend, behind one `ae-a8n` CLI.

Verified on macOS against After Effects 2026 (26.5x89, ja) and on Windows 11
(26.5x89, en) on 2026-10-21 (`docs/verification.md`, `docs/windows-verification.md`).
Windows: launch/install discovery (#17), process ownership (#40) and the session
marker (#44) are merged; menu commands, `hostEnvironment` and Undo/Redo were run
on a real host (#47).

On 2026-11-11 the isolated path itself ran on the Windows host twice: the
controller published a signed job over the channel, the in-session agent
started After Effects, built a comp and a text layer, rendered frame 0 and quit
the process it started (`docs/evidence/windows-2026-11-10/README.md`, update
section). That is `verified on real host` for **that basic path only**.

### Not proven in this version

Read this before treating a green run as more than it is.

- **Extension methods are `fake/mock only`.** `hostScript`, `ae.call` and
  `ae-a8n extension build` are covered by tests against the in-repo fake host.
  No `ae.call` was made on a real After Effects on either platform.
- **The Windows destination proof is `unproven`** (T090, #72). The isolated
  backend records `destinationProof: "unproven"` and
  `ownershipProof: "unproven"` in `manifest.json`, because it cannot yet show
  that a scripted quit reached the instance this run started. It never reports
  those as proven.
- **Non-interference and recovery were not exercised on Windows.** No run was
  measured while the console user was working, and no crash, kill or hung
  dialog was induced (rows 13 and 15 of the T092 matrix).
- **`ae-a8n setup` is not implemented in this version** and refuses with exit
  7. The macOS helpers it will drive exist; the CLI wiring is #56.
- **The isolated Windows backend does not start After Effects itself** in the
  sense of ownership: it sends a job to an agent that starts AE. The API-level
  `AfterEffects.launch()` ownership guarantees stay macOS-only.
- `latest` is not published from this version. The cross-platform release gate
  (T093, #75) is a prerequisite for that, not for this prerelease.

### Fixed

- A job whose result was already in the channel was reported as a timeout: the
  controller polled `results/<jobId>/result.json` while that directory did not
  yet exist, and a macOS SMB client caches "no such directory" and keeps
  answering it for about a minute after the directory appears. On the real host
  the controller gave up 57 s after the agent had published its refusal. The
  controller now creates the job's result directory before it publishes the
  job, so no poll walks through a directory the agent has not created yet.
- The polling loop now records what it saw (polls, absent, failed, slowest
  read) and says so in the timeout, treats a read that throws or never answers
  as a failed observation instead of crashing or outliving the deadline, and
  makes one last look after the deadline. A result found there is recorded as
  `lateResult` — the run stays `unknown` and quarantined, and the job is never
  re-sent.
- A result that the **first** read found after the deadline was promoted to
  the run's outcome. Publishing a job over a share can outlast a short
  timeout, so that state is reachable; the result cannot have been produced in
  time. It is now recorded as `lateResult` like any other late result — the
  run stays `unknown` and quarantined, and the job is not re-sent. Regression
  test: "does not promote a result the first read finds after the deadline".
- `ae-a8n test --host <name>` refused every run with "the Windows channel key
  is not configured" even when the channel was reachable and the agent was
  heartbeating: the adapter verified the host's key file and then signed the
  job with a key only an injected caller could supply. A remote run now signs
  with the key the host configuration names — the one the agent holds.
- A remote run with no `--user` recorded an empty writer, which the agent
  refused (`A8N-JOB-001: writer.host and writer.user are required`); that
  refusal reached the caller as a timeout, because nothing else was wrong.
  The host configuration's account is now used when the caller names none.
- `ae-a8n agent` accepts the command its own help and the Windows setup plan
  print: `--agent-id`, `--session-id` and `--version` were documented as
  having defaults but were required, so the documented form failed before it
  polled. They now default to `ae-a8n`, the measured interactive session and
  the package version.
- The same command no longer fails with `unknown option <path>`: the CLI's
  argument check read every token as a flag, so the channel root, the key file
  and the host name were refused before the agent started. Values are now
  skipped; only flag tokens are checked.
- A key or channel under a path containing a space (`C:\Users\First Last\…`)
  was refused: `icacls` echoes the path on its first line, and the parser
  treated every word after the first as part of the principal, producing a
  foreign account. The caller now hands the parser the path it asked about
  and the echo is stripped exactly. The refusal direction is unchanged: a
  grant to any account outside owner, SYSTEM and Administrators is still
  refused. Regression tests: "reads a path that contains spaces when the
  caller names it", "still refuses a foreign grant when the path has spaces".
- `scripts/check-packed-package.js` and `scripts/check-public-api.js` started
  `npm` as a bare command, which fails on Windows with `spawn npm ENOENT`;
  they now start it as `node <npm-cli.js>` on every platform (no shell).
- `scripts/check-release.js` looked for `A8N_VERSION` only in `src/index.ts`
  and failed on a tree that declares it in `src/version.ts`. It now reads
  either declaration and still fails when the two disagree with
  `package.json`.
- The ExtendScript host script no longer relies on a nested conditional
  (`a ? x : b ? y : undefined`), which AE 26.5x89's ExtendScript 4.5.6
  mis-evaluated and which made every request fail with `unknown method`.
  Found on the Windows host; `test/host-script.test.ts` pins the statement
  form.

### Added

- `ae-a8n agent --hidden`: starts the resident agent as a detached process
  created with `windowsHide` (CREATE_NO_WINDOW), so a logon entry or a
  shortcut does not leave a console window on the desktop for the life of the
  agent. Its stdout, stderr and exit state go to one append-only log
  (`%LOCALAPPDATA%\ae-a8n\logs\agent.log`, or `--log <file>`). The plain form
  keeps its console for interactive debugging.
- Extension methods (#61, `specs/isolated-ae/contracts/extensions.md`):
  `ae-a8n extension build --extension <module> --out <file>` writes a host
  script that declares a consumer's own methods; `AfterEffects.launch({
  hostScript })` runs it, and `ae.call(name, params, { timeoutMs? })` calls
  one. Every method is parsed as ES3 at build time and refused if it is not;
  a name that would replace a built-in host method is refused; an unknown
  name is refused before a request is written, with the declared names in
  the error. `acorn` is now a runtime dependency: the ES3 check is what keeps
  the feature from being an eval.
- macOS session scoping (#49): `src/driver/mac-session.ts` reads a user's
  login session (`asid`, Aqua/Background) and the apps that live in it, and
  runs a command *inside* another user's session. `ScriptInvocationTransport`
  filters the After Effects processes by uid, sends `DoScriptFile` from the
  target session, and refuses to send anything when the destination cannot be
  established.
- A GUI fallback for a host that stopped answering (#49): `MacGuiRecovery`
  finds a modal window through Accessibility in the target session, presses
  only `OK`/`Cancel`/`Close`/`Dismiss`, never a sign-in or licence window,
  and takes the screenshot of the *target* session. `MacHostRecovery` is the
  policy layer. `AfterEffects.launch({ session: { uid, recover: true } })`
  wires it in.
- `ae.showModalDialog(message)` (#49) raises a native modal dialog through
  the host, so the fallback has something to close.
- The GUI fallback refuses the console session (#49): a recovery never moves
  the cursor or takes the focus of the screen the user is looking at.
- A timed-out operation is **not** sent again after a recovery (#49): the
  driver waits for the result of the request it already sent.
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

- `verifiesDestination` is true on macOS as well as Windows (#49): the
  session marker proves that the instance which answered the probe is the
  one this session started.
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

ExtendScript's nested conditional (#61): measured on AE 26.5x89, the host's
extension-aware `dispatch` evaluated `a ? x : b ? y : undefined` with the
second test deciding the whole expression, so a built-in name found in
`methods` came back as `extensions[name]` and *every* request failed with
`unknown method`. The lookup is statements now, and a check on the shipped
host text refuses a conditional inside a conditional, because Node evaluates
the ungrouped form correctly and the fake host cannot see the difference.

### Fixed (found by the Windows CI job)

The packed-package and public-API checks started npm by name
(`execFileSync("npm", …)`). On Windows `npm` is `npm.cmd`, which Node will
not start without a shell, so the Windows job died on `spawn npm ENOENT`
before checking anything. Both now resolve the npm CLI and run it as
`node <npm-cli.js>` (scripts/npm-cli.js), the same way staging does: no
shell, no bare `npm`, no argument re-parsing. A test refuses a script that
goes back to either form.

### Fixed (found by the release gate)

The gate reads `A8N_VERSION` from the source text. This branch declares it in
`src/index.ts`; the integration line this PR merges into declares it in
`src/version.ts` and re-exports it, so the gate found nothing and failed with
`A8N_VERSION is undefined` on the pull request's merge ref. It now looks in
both files and skips one the tree does not have.
