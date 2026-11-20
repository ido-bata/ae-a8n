# Changelog

## 0.5.0

Patch-level release on the `release-0-5-0` train: ExtendScript host
script hardening merged after 0.4.0 (#265), plus the additive
`AfterEffects.attach` API (#269). The bridge contract is unchanged.

### Added

- **`AfterEffects.attach(options)`** (#269): an explicit attach-only path
  to an already-running After Effects. The default script transport is
  built attach-only — its `launch()` selects a census target and has no
  path to process creation — so a caller that only wants to connect can
  never spawn a second AE (the #99 double-launch defect). Target
  selection is fail-closed: `AttachTargetError` with `reason`
  (`not-found` / `ambiguous` / `wrong-session` / `unknown-target` /
  `unresponsive` / `unsupported`), no resend or retry. On Windows the
  script lane refuses (every delivery is an `AfterFX.exe -r` spawn);
  attach there uses `transport: "in-ae-dispatcher"` or a supplied
  transport. `launch()` / `resume()` / `close()` semantics are unchanged.

### Fixed

- **Attach-only hardening from release review** (#272): a refused attach
  or adoption no longer leaves the transport "launched", so a retry
  cannot fall through to the process-creating invoke path; a public
  `target.pid` that the selected transport cannot enforce is refused
  instead of silently ignored; on macOS a pinned attach requires the
  target to remain the single in-scope instance (delivery addresses the
  app bundle, not a pid); and attach-mode delivery re-proves the attached
  process immediately before each call so an exited target fails closed
  rather than letting `tell application` start a replacement. The host's
  direct-write result fallback now removes a partially published result
  file when the write reports failure.
- **Host script I/O validation** (#265): the ExtendScript host now
  rejects invalid result-file writes, honours `Project.close`
  cancellation instead of reporting success, and pre-validates text
  arguments, closing holes where a failed write or a cancelled close
  could be mistaken for a completed call.
- **Close-failure simulation narrowed to result writes** (#265): test
  fixtures no longer mask request-path failures, keeping the
  fake-host/real-host parity claim honest.

### Verification

- `verified on real host`: packaged consumer smoke
  (`scripts/check-consumer-smoke.js`, packed tarball → clean install →
  launch → handshake → project → diagnostics → close) passed against
  After Effects 2027 `27.0x78` on macOS arm64, and the same tarball
  completed a read-only attach smoke against a running AE 2027 on
  Windows (`ownership: attached`, quit=false). Evidence recorded on
  ae-a8n#99.
- The native-channel path remains `fake/mock only` (unchanged from
  0.4.0; real-host gate tracked by ae-devtools#223).

## 0.4.0

This is the `release-0-4-0` train: the opt-in native-channel mutation
path (`NativeProbe` intake against the ae-devtools plug-in channel) plus
the delivery-model and test-alignment work merged after 0.3.0.

**Verification boundary.** Everything the native-channel path does is
verified against a fake C++ intake (`probe_test --channel-server`) and
shared wire-case fixtures only — **fake/mock level, not real After
Effects**. Real-host verification of this path remains gated on
ae-devtools #223 and is not claimed here. The 0.3.0 real-host evidence
(packaged local E2E on macOS and Windows) covers unchanged code paths
and still stands on its own.

### Added

- **Native-channel client** (#238): `prepareNativeChannel`,
  `publishNativeRequest`, `awaitNativeResult`,
  `readNativeChannelState`, `defaultNativeChannelDir`,
  `updateNativeChannelAuthorization`, `nativeOperationRequiresConsent`,
  `reconcileItemComment` and the associated types are exported from the
  package root. Requests/results use the `ae-devtools/native-dispatch/v1`
  file contract with atomic publish, session/ownership checks, and
  `UNKNOWN` (never resent) semantics on missing or timed-out results.
- **Mutation consent and authorization** (#245, #247, #248, #249,
  #254, #256): the channel mints a `consentKey` alongside the request
  token; consent-gated mutations (currently `AEGP_SetItemComment`)
  receive a per-request HMAC-SHA256 proof over canonical scope
  (operation, request id, session, args, target) only after an explicit
  `NativeMutationAuthorization` grant covers session/operation/target/
  args. Uncovered mutations throw `ScriptNotSentError` before anything
  is published; `updateNativeChannelAuthorization` revokes or narrows
  future authority. Canonicalization and HMAC are pinned byte-for-byte
  by the shared `native-consent-vectors.json` fixture synced from
  ae-devtools `release-0-5-0` (`scripts/sync-consent-vectors.mjs`),
  including lone-surrogate rejection. Grant `args` patterns are partial
  deep matches, restricted to the consent-canonical domain.
  `reconcileItemComment` classifies read-back as `state-consistent` /
  `state-inconsistent` / `unobservable` — consistency is not causal
  proof of execution. ADR-0004 records the trust model: same-OS-user
  processes are inside the channel trust boundary; the MAC binds scope
  and proves key possession, not a particular code path.
- **Fault-injection interop coverage** (#256): all 14 shared
  `wireCases` run against the real C++ intake, including the
  `setcomment-error` and `null-itementry` fault modes from ae-devtools
  PR #352.

### Changed

- **Package metadata**: `package.json`, `A8N_VERSION` and
  `package-lock.json` now agree on `0.4.0`; the lockfile version had
  drifted at `0.2.0-beta.1` since the 0.2.0 prerelease.

### Fixed

- **Unserializable mutation args** (#243): arguments outside the
  consent-canonical domain are rejected as `ScriptNotSentError` before
  publication instead of producing an unverifiable request.
- **GitHub rulesets test** (#240): expectations track the
  `release-gate` required check.
- **Fixture sync** (#254): `sync-consent-vectors.mjs` fetches the exact
  base64 blob so `\uXXXX` escapes survive; fixture files are marked
  `-text` to prevent CRLF drift on Windows.

### Documentation

- **Dispatcher publish semantics** (#242): `docs/in-ae-dispatcher.md`
  now states that result publish is rename-preferred with an in-place
  fallback, why that converges to the same fail-closed `UNKNOWN`
  outcome as the native-channel contract, and that native-channel §5
  does not govern this transport.

## 0.3.0

Published as `latest` under an owner-approved limited guarantee: the
local script-invocation automation path is verified on real hosts on both
macOS and Windows (packaged-consumer E2E, 2026-11-18); the opt-in
dispatcher and isolated backend remain experimental — their unverified
scope is stated under "Not proven" and tracked in the open issues. This is
the `release-0-3-0`
train: the isolated-session hardening and packaged-consumer work merged
after 0.2.0, plus the delivery-model repair that reopened a release
branch after `release-0-2-0` closed. As a `0.x` version it is an
early-development release; the unverified scope — dispatcher and isolated
backend paths — is stated under "Not proven" rather than encoded in the
version number.

### Added

- **Packaged shared-root inspection** (#199): `ae-a8n doctor` and
  `recover` now report read-only diagnostics for the isolated-session
  shared root — stale jobs, orphaned results, interrupted publish
  temporaries and the agent banner — using the same trust rules as the
  repository harness (trusted uid from the agent banner, console-owner
  fallback, never the caller's uid). Packaged prune is intentionally not
  provided.
- **Isolated-session acceptance fixture** (#62): `examples/isolated-test.ts`
  ships in the tarball and verifies it really runs as the helper account
  (`--expect-user`, exit 3 before touching AE on mismatch) before running
  the minimal AE smoke. `docs/isolated-testing.md` §2.1 documents the
  runnable quickstart for npm consumers without a repository checkout.
- **GitHub Packages mirror** (#117): `scripts/github-packages-sync.js` +
  `github-packages.yml` mirror every npmjs-published version to
  npm.pkg.github.com with sha1 verification, idempotent skip, dist-tag
  reconciliation to npmjs pointers, and per-version probing (verified live:
  all five versions mirrored, `latest`/`next` match npmjs).
- **Guided grant/check loop** (#57): `grant-check.mjs` requests only
  missing permissions inside the helper session and re-probes until
  granted, with dialog routing printed before any request.

### Security

- **Session identity re-proof** (#59/T035, PR #194): every Apple Event
  send and every GUI recovery action re-reads the target session
  (uid/asid/kind/console owner) and refuses on mismatch, session loss or
  console flip.
- **Shared directory continuous proof** (#59/T036, PR #208): the session
  agent re-validates the sticky/writable contract of jobs/results/logs on
  every poll and refuses symlinked or decayed directories instead of
  silently repairing them mid-flight.
- **Job/result trust rules** extended in the packaged inspector to mirror
  the harness: lstat-only, real `.job.json`/`.result.json` matching,
  60-second temporary publish window, fail-closed ownership/mode checks.

### Changed

- **Delivery model repair** (#210/#215): `release-0-3-0` opened after the
  `release-0-2-0` merge left ticket PRs integrating into `main`;
  `release-gate.yml` (`pull_request_target`) will accept only the
  canonical train recorded in the `RELEASE_TRAIN` repository variable
  once it reaches `main`.

### Not proven in this version

- Windows real-host evidence for the dispatcher path, extension calls and
  `ae.call` remains absent. On the *script-invocation* transport, Windows
  local E2E passed on packaged 0.3.0 (AE 2027 / 27.0, 2026-11-18, two
  consecutive runs: owned launch, comp/layer/render, owned quit). On the
  isolated backend `ownership()` stays `unknown` and the package will not
  quit After Effects it did not start — that limitation is unchanged.
- The isolated-session end-to-end run on a real helper account has not
  completed; the new fixture exists but its real-session PASS is pending
  (#57 T026, #62 T076).
- AE 26.5 script-trust approval granularity is still unmeasured (#125).


## 0.2.0

Staged for the `next` dist-tag; `latest` stays on `0.1.0-alpha.0`. This is
the `release-0-2-0` train — the opt-in in-AE dispatcher transport with
static consumer extensions, its lifecycle CLI, and the packed-consumer
acceptance harness, on top of the isolated testing, capability handshake,
GUI recovery and session-marker work merged since `0.1.0-alpha.2`. As a
`0.x` version it is an early-development release: the API may change
before 1.0.0, and the scope without Windows real-host evidence is stated
under "Not proven in this version" rather than encoded in the version
number. A `latest` promotion still requires the cross-platform evidence
gate (#75).

### Added

- **In-AE dispatcher transport** (`transport: "in-ae-dispatcher"` selection,
  opt-in only): a human activates `activate.jsx` once per After Effects
  process and the dispatcher answers named operations over private channel
  files — no per-call OS automation, no silent fallback to script
  invocation. Ownership stays `attached`/unproven, timeouts stay UNKNOWN and
  are never resent, instance pinning refuses a different After Effects, and
  double activation is refused (`docs/in-ae-dispatcher.md`, ADR-0003).
- **Static extensions through the dispatcher** (#146): consumers declare
  extension modules, `ae-a8n extension build` produces the effective host
  script, and `AfterEffects.launch({ hostScript, authorization:
  { extensionMethods: true } })` exposes only the methods the dispatcher
  actually registered — verified against the heartbeat at launch and
  re-checked before every call. Staged-vs-active mismatches refuse the
  session; changes require reactivation (`specs/isolated-ae/contracts/extensions.md`).
- **Dispatcher lifecycle CLI** (#147): `ae-a8n dispatcher prepare`,
  `status`, `startup install|remove` — channel preparation, honest heartbeat
  reporting (`blocked`/`unknown` are never passes), and per-user
  `Scripts/Startup` registration that refuses foreign files and states that
  AE's execution of the entry is unproven.
- **Packed-consumer acceptance harness** (#148, #155):
  `scripts/check-dispatcher-acceptance.js` installs the packed tarball into a
  clean project, builds a consumer-side extension fixture through the packed
  CLI, and runs the dispatcher scenarios — handshake, editing, PNG render,
  extension call, authorization/pin refusals, UNKNOWN non-resend, safe
  shutdown — in a fake lane (always) and a human-gated real lane (`--project`
  fixture required; no heartbeat is `blocked`, never a pass). The real lane
  stages the extension host script into a dedicated `--channel-dir` (or a
  per-run temporary one), prints the matching `activate.jsx`, reuses a live
  heartbeat instead of asking for a second activation, and reports a
  machine-readable `A8N_RESULT` JSON where `blocked` exits 3 — never a pass.

### Fixed

- macOS could spawn two `After Effects` processes on launch and fail closed
  with `HostNotOwnedError` (#105, fixed by #106 via LaunchServices).
- `AfterEffects.launch` accepts `readinessTimeoutMs` (#124).

### Not proven in this version

- **Windows real-host evidence for the new paths is absent.** The
  dispatcher CLI, extensions, Startup execution and acceptance harness
  passed the packed-consumer real lane on macOS AE 26.5.3 (`26.5.3x9`,
  2026-11-17): handshake, edit, PNG render, extension call,
  authorization/instance-pin refusals, pinned reconnect and safe close,
  with `Scripts/Startup` auto-activation observed. No Windows real-host
  run exists for them.
- Extension methods via `hostScript` / `ae.call` are verified on real host
  only through the dispatcher path on macOS AE 26.5.3; on the default
  script-invocation transport they remain `fake/mock only`.
- Everything below `verified on real host` stays unproven against real AE —
  see `docs/consumer-acceptance.md` §4 for the recording format.

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

#### Found by the pre-release review of the release diff

The review (`docs/evidence/review-2026-11-11/`) found 7 high and 65 medium
findings. These are the high ones and the mediums fixed here; the rest are
tracked in #93 and #94.

- A CLI option that forgot its value swallowed the next option:
  `setup --channel --dry-run` set the channel to `--dry-run` and left the dry
  run off. A value that starts with `--` is now a usage error; an explicit
  `--flag=value` still allows one.
- A recovery that quarantined the host (an unclassified blocking window) was
  rethrown as a plain timeout, inviting exactly the retry the quarantine
  exists to prevent. It now reaches the caller as `HostQuarantinedError` with
  `A8N-SEC-001`.
- The Windows key-file ACL accepted a domain account that merely shared the
  owner's name (`CONTOSO\alice` for the local `alice`, two different
  principals). Only the machine's or the domain's own qualifier is accepted.
- `ae-a8n recover` on a `--host` target ran `tasklist` on the controller and
  reported the controller's process state as the host's. Recovery now reads
  the host's state through the channel, or refuses with `A8N-JOB-007`.
- The test runner read the quarantine record before taking the target lock, so
  a run that quarantined in between could still be entered. The lock is taken
  first and the record is read under it.
- An agent executor that throws now publishes `unknown` — the command may have
  run — instead of `failed`, which invited a retry.
- `resolveComms` refuses `--key-file` without `--channel` even when the hosts
  file could supply a channel; the guard meant to do this was unreachable.
- A key-load refusal reports its own diagnostic code (`A8N-PERM-005` for an
  ACL failure) instead of always `A8N-JOB-003`.
- A call abandoned before it reached After Effects is reported as not sent
  through the public error layer; it used to become a generic failure.
- The Windows steps in `ci.yml` and `publish.yml` ran under pwsh, which does
  not stop at a failing native command, so a broken first `node --check`
  passed behind a green second one. They run under `bash -e`. The full
  Windows suite is now a required check on `main`, as its comment claimed.
- `check-packed-package.js` accepts a CRLF shebang line, so a Windows build
  no longer fails the release gate on the line ending alone.
- `recover` validates the run id in a quarantine record before using it as a
  path, and a quarantine record that cannot be written no longer aborts the
  run report — the notice says the next run is not guarded.
- The isolated-session helper refuses a non-numeric or non-positive
  `--timeout` instead of turning its deadline into `NaN`.

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
