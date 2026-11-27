# @ido-bata/ae-a8n

Drive a real Adobe After Effects from Node: open a project, apply an effect,
set its parameters, render a frame to PNG — and get typed errors, a trace, and
the files back.

```ts
import { AfterEffects } from "@ido-bata/ae-a8n";

const ae = await AfterEffects.launch();
const project = await ae.openProject("/tmp/work/copy.aep");
const layer = await (await project.comp("Main")).layer("Solid 1");
const blur = (await layer.effects.apply("ADBE Gaussian Blur 2")).parameter("ADBE Gaussian Blur 2-0001");
await blur.set(60);
const frame = await (await project.comp("Main")).renderFrame(0); // { path, width, height, frame }
await ae.close({ unsavedChanges: "discard" }); // the edits above are ours to throw away
```

> **Early release (`0.x`), scoped guarantee.** `0.3.0` is published as
> `latest` under an owner-approved limited guarantee: the local
> script-invocation automation path is verified on real hosts (macOS AE
> 26.5/27 and Windows AE 2027, packaged-consumer E2E 2026-11-18), while
> the opt-in in-AE dispatcher and the isolated backend remain
> experimental with the unverified scope listed under "What is not
> proven" below. `0.4.0` adds the opt-in native-channel mutation path
> (consent-gated `AEGP_SetItemComment` and read-back reconciliation)
> verified at fake-mock level only — see "What is not proven". The API
> may change before 1.0.0.

## First run in about five minutes

1. `npm install @ido-bata/ae-a8n`
2. `npx @ido-bata/ae-a8n doctor` — read-only; it names every blocker with a
   remedy and exits `3` while any remain. On macOS the usual ones are
   After Effects' **Settings → Scripting & Expressions → Allow Scripts to
   Write Files and Access Network**, and — on AE 26.5+ — approving the
   driver's script folder when AE shows its modal.
3. Run the snippet at the top of this file, or
   `node --experimental-strip-types node_modules/@ido-bata/ae-a8n/examples/smoke.ts`
   from your project — launch, handshake, project listing, close.

What you are consenting to: the package starts After Effects only when it
is not already running, quits it **only** when this session provably owns
it, never discards unsaved work unless you pass
`{ unsavedChanges: "discard" }`, and never retries a timed-out call. The
guided multi-user flow (`doctor --user`, `test`, `recover`) is in
[docs/quickstart.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/quickstart.md);
`ae-a8n setup` is not implemented yet.

## Status

| | |
| --- | --- |
| macOS | Verified against After Effects 2026 (26.5x89, Japanese UI) on macOS 27, arm64: launch, project/comp/layer lookup, effects by match name, parameter write/read, one-frame PNG render, typed failures, timeouts, session ownership; 20 consecutive fresh-session runs. Packaged 0.3.0 additionally passed the local E2E (launch → comp → text layer → render → owned quit) on AE 2027 (27.0x78), four consecutive runs on 2026-11-18 |
| Windows | Verified against After Effects 2026 (26.5x89, English UI) on Windows 11 x64: cold launch, install discovery, process ownership and quit-only-what-this-session-started, menu commands, `hostEnvironment`, scene building, Undo/Redo, and Ae_Restro's 33-check E2E through this API (3 runs). The isolated backend also ran end to end on that host on 2026-11-11: a signed job over the channel, an in-session agent, AE started, comp and text layer built, frame 0 rendered, and the started process quit — twice. Packaged 0.3.0 passed the local E2E on AE 2027 (27.0) twice on 2026-11-18 (owned launch, render, owned quit; see [docs/evidence/windows-2026-11-18](https://github.com/ido-bata/ae-a8n/blob/main/docs/evidence/windows-2026-11-18/)). See [docs/windows-verification.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/windows-verification.md) and [docs/verification.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/verification.md). ARM64 and non-English UIs not run |
| In-AE dispatcher (opt-in) | macOS AE 26.5.3 (`26.5.3x9`): the packed-consumer real lane passed on 2026-11-17 — handshake, comp/layer edit, PNG render, static extension call, authorization and instance-pin refusals, pinned reconnect, attached safe close — and `Scripts/Startup` auto-activation was observed. No Windows real-host run exists |
| Node | 22 or later (developed on 24) |

What has been checked, and how, is in [docs/verification.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/verification.md).

What is **not** proven in `0.3.0`, so a green run is not read as more
than it is:

- **Windows real-host evidence for the dispatcher paths is absent.** The
  opt-in in-AE dispatcher transport (`transport: "in-ae-dispatcher"`,
  `ae-a8n dispatcher`, `ae-a8n extension build` through the dispatcher),
  its lifecycle CLI, Startup execution and the acceptance harness have
  real-host evidence on macOS AE 26.5.3 only; no Windows real-host run
  exists for them. The Windows script-invocation claims above were
  measured on packaged 0.3.0 itself (2026-11-18); the dispatcher rows
  remain macOS-only.
- Extension methods via `hostScript` / `ae.call` on the default
  script-invocation transport remain `fake/mock only` on real After
  Effects; they are verified on real host only through the dispatcher
  path on macOS AE 26.5.3.
- On the Windows isolated backend `manifest.json` records
  `destinationProof: "unproven"` and `ownershipProof: "unproven"`; the backend
  never reports them as proven.
- Non-interference with a working console user, and recovery from a crash or a
  hung dialog, were not measured on Windows.
- `ae-a8n setup` is not implemented in this version; it refuses and changes
  nothing.
- The native-channel mutation path (`prepareNativeChannel`,
  `publishNativeRequest`, consent grants, `reconcileItemComment`) is
  `fake/mock only`: verified against the ae-devtools fake C++ intake and
  shared wire-case fixtures, never against real After Effects. Real-host
  verification is tracked in ae-devtools #223. Authorization grants are
  an ae-a8n policy layer — they decide what this client will sign, not
  what a same-OS-user process could forge; see ADR-0004.

## Install

```bash
npm install @ido-bata/ae-a8n
```

Requirements on the machine that runs After Effects:

- After Effects installed in the default location (`/Applications/Adobe After Effects <version>/` on macOS), or pass `installDir`.
- **Settings → Scripting & Expressions → Allow Scripts to Write Files and Access Network** enabled. Without it the host can open a result file but never write it; `doctor` reports it as `A8N-PERM-003`, and `launch` refuses up front when the preference is provably off.
- On **After Effects 2026 (26.5)** the host also needs AE's approval to run scripts from the driver's folder: AE refuses the first `DoScriptFile` with `-1708` and shows a modal that points at its Scripting & Expressions panel. Approve the session's `staging/` folder there (the folder holds the entry script and the staged host script). The approval's granularity — per folder, per script, or coarser — is still unmeasured; a read-only probe and protocol for measuring it on a real Mac are in [docs/script-trust-measurement.md](docs/script-trust-measurement.md).

The full first-run sequence — install, `doctor`, the human permission
approvals, first launch, version check, close, and reconnect after a restart —
is in [docs/quickstart.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/quickstart.md).

## Doctor

`ae-a8n doctor` is the read-only entry point. A bare `doctor` probes the
**local** script-invocation path — the session you are running it in — so a
running After Effects is reported as info (`A8N-AE-009`), not refused, and
the console-session separation checks do not apply. `doctor --user` /
`--host` / `--target` probe the isolated-session path instead. It reports
every fact it could not read as `unproven` (a warning or info check), never
as a pass, and every blocker with a human-readable remedy. It does not
start After Effects, open a session, change TCC or SIP, read a credential,
or send an Apple Event.

```bash
npx @ido-bata/ae-a8n doctor
npx @ido-bata/ae-a8n doctor --json
npx @ido-bata/ae-a8n doctor --user ae-test
npx @ido-bata/ae-a8n doctor --host WIN-AE-01
```

Exit `0` means no blocker was found; exit `3` means at least one was. `--json`
prints exactly one document on stdout, with `schemaVersion`, `checks[]` and
`nextActions[]`; a warning does not by itself fail the command. A host target
selects the Windows adapter even when you invoke the CLI on another platform.
If the Windows probe commands cannot run there, the facts that depend on the
host are reported as unreadable and the command exits blocked.

## Test

`ae-a8n test -- <command>` runs the command inside the target session, once,
and keeps what it saw under `~/.ae-a8n/runs/<runId>/`: `manifest.json`,
`report.json`, `trace.jsonl` and `artifacts/`. It refuses before it opens
anything when `doctor` would report a blocker, when another run holds the
target's lock, or when a prior run left a quarantine record.

```bash
npx @ido-bata/ae-a8n test -- ./node_modules/.bin/vitest run
npx @ido-bata/ae-a8n test --json --timeout 600000 -- ./run-e2e.sh
```

Exit `0` pass, `5` test failed, `4` refused for safety, `3` environment
blocked, `6` unknown and quarantined. A timeout is `unknown`, never a failed
test, and a run that timed out is never re-sent automatically. With `--json`
stdout is exactly one document and the human summary goes to stderr.

## Recover

When a run times out, `test` quarantines the target and refuses to run again
until the state is looked at. `ae-a8n recover` shows what the run left behind
and releases only what cannot be wrong:

```bash
npx @ido-bata/ae-a8n recover                 # inspect; changes nothing it must not
npx @ido-bata/ae-a8n recover --dry-run       # say what it would do
npx @ido-bata/ae-a8n recover --force         # also clear the quarantine record
```

A lock whose recorded process is gone is released. A quarantine record is
only reported: it exists because nobody could prove the run had ended, so
clearing it takes an explicit `--force` from someone who checked. `recover`
never quits After Effects, never re-sends a command and never deletes a run
directory.

## Report

`ae-a8n report` reads a stored run and prints or re-renders its report. It
never starts After Effects and never changes the run.

```bash
npx @ido-bata/ae-a8n report                     # the most recent run
npx @ido-bata/ae-a8n report --run <id> --format json
npx @ido-bata/ae-a8n report --format junit      # for CI
```

`--format json` prints the stored `report.json` byte for byte; `--format junit`
maps each verdict to a testcase, and a `blocked` or `unknown` verdict becomes an
`<error>`, never a pass. A run that never wrote a report exits 1 and names
`recover`: `report` never returns an empty success.

## Supervision

`ae-a8n supervise status --session-root <dir>` reads the durable
supervision report a session publishes (`supervision.json`) — the same
document `ae.supervisionState()` returns — and is strictly read-only: it
never starts a monitor, presses a control or mutates the session.
`ae-a8n supervise watch --session-root <dir>` polls and prints each
phase/health transition until interrupted. Missing, corrupt or stale
state is reported as `unavailable`/`monitor-lost`, never as healthy.

`setup` is not implemented yet in this increment: it parses its contract flags
and then fails closed with a notice. It does not report success for work it did
not do.

## What it does to your After Effects

This is a tool that operates someone's desktop application. The rules it
follows ([docs/sessions.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/sessions.md)):

- **Ownership.** `ae.ownership()` is `owned` only if this session started After
  Effects and it is still that process; `attached` if AE was already running;
  `unknown` if neither can be established (for example when the Windows process list cannot be read). `close()`
  quits AE **only when owned**, and otherwise returns `{ quit: false, reason }`.
- **Unsaved changes are never discarded by default.** `close()` and
  `openProject()` reject with `UnsavedChangesError` instead. Pass
  `{ unsavedChanges: "discard" }` when the changes are your own.
- **Timeouts end the wait, not the work.** ExtendScript cannot be interrupted;
  a timed-out call's script keeps running and the next call waits for it.
  Nothing is retried automatically.
- **It never kills After Effects.**

Open a copy of a project, not the original: nothing here saves, but an
unsaved edit in someone's open project is still their work.

## API

| | |
| --- | --- |
| `AfterEffects.launch(options?)` | `{ sessionRoot?, installDir?, timeoutMs?, readinessTimeoutMs?, transport?, hostEnvironment? }`; `hostEnvironment` is set inside an owned AE process (`$.setenv`) for native plugins; `timeoutMs` is the per-call default, which `openProject`, `project` and `renderFrame` can override for one call; `readinessTimeoutMs` extends the readiness-probe budget (default 180 s) for slow cold starts; waits for a readiness probe |
| `AfterEffects.attach(options?)` | same options plus `target?: { pid? }`; connects to an already-running AE **only** — the attach-only transport has no path to process creation. No candidate / several candidates / another session's AE / unreadable process list / an unanswered probe all reject with `AttachTargetError` (`reason`: `not-found`, `ambiguous`, `wrong-session`, `unknown-target`, `unresponsive`, `unsupported`); nothing is resent or retried. On Windows the script lane cannot attach (every delivery is an `AfterFX.exe -r` spawn) — use `transport: "in-ae-dispatcher"` or a supplied transport |
| `ae.info()`, `ae.version()` | version from the probe / live |
| `ae.ownership()` | `{ kind: "owned" \| "attached" \| "unknown", evidence }` |
| `ae.openProject(path, { unsavedChanges?, timeoutMs? })` | → `Project`; `path` must be absolute (`/…`, `C:\…`, `\\server\…`), otherwise `TypeError` before anything is sent |
| `ae.project({ timeoutMs? })` | → `Project` for the project open now, without opening anything (e.g. after `openProject` timed out) |
| `ae.comps()`, `project.comps()`, `project.info()` | listings |
| `project.comp(name)` → `Comp` | `comp.info()`, `comp.layers()`, `comp.layer(name)` |
| `comp.renderFrame(frame, { subdirectory?, prefix?, timeoutMs? })` | one PNG under `ae.artifactsDir`; size read from the file |
| `layer.effects.all()`, `.apply(id)`, `.get(id)` | `id` is a match name (stable) or display name (localised) |
| `effect.parameters()`, `effect.parameter(id).get()` / `.set(v)` / `.info()` | every property is listed with a `kind` (`value`, `no-value`, `custom-value`, `group`) and its `valueType`; it has a `value` only when `kind` is `"value"`: a number (`OneD`, `LAYER_INDEX`, `MASK_INDEX`), `[x, y]` (`TwoD*`), `[x, y, z]` (`ThreeD*`) or `[r, g, b, a]` (`COLOR`). `set` takes the same shapes |
| `ae.menuCommand(nameOrId)` → `MenuCommand` | by menu text (localised for AE's own commands; a plugin's name for its own) or id; `EntityNotFoundError` (`kind: "menu-command"`) when AE has no such item |
| `command.execute({ timeoutMs? })`, `ae.undo()`, `ae.redo()` | → `{ id, before, after, added, removed, durationMs }`: the active comp's layers around the command, compared by id; also traced as `menu.execute.scene`. **Owned sessions only** (`HostNotOwnedError`) |
| `project.createComp({ name, width, height, duration, frameRate })` → `Comp` | refuses a name an item already has |
| `comp.addTextLayer({ text, font?, fontSize?, fillColor?, position? })` | → `{ layer, info }`; `info.font` is what AE applied |
| `comp.openInViewer()`, `comp.selectLayers(names)` | make the comp active; select exactly these layers |
| `comp.time()` | → `{ comp, time, frame }`: the current-time indicator (`CompItem.time`), read-only |
| `project.state()` | → `{ itemCount, dirty, activeItem }`: the project facts the DOM exposes, read-only |
| `layer.setEnabled(on)`, `layer.transform()`, `layer.shapePaths()` | video switch; transform values; a shape layer's paths in layer space |
| `layer.property(path)` | one property by name/match-name path (e.g. `["ADBE Transform Group", "ADBE Position"]`); the `PropertyInfo` also carries `selected`, `isTimeVarying` and `keyframes` (`{ index, time, value }`) where the host exposes them — read-only |
| `ae.close({ unsavedChanges? })` | → `{ quit, ownership, reason? }` |
| `ae.supervisionState()` | → `SupervisionReport`: the durable GUI-supervision document (`ae-a8n.supervision/v1`) — phase, observation health, blocking evidence, pending requests. Absent/corrupt/stale state reports `unavailable`/`monitor-lost`, never a fabricated healthy state |
| `AfterEffects.rebuild(options)` | verified relaunch after proven owned process loss; refuses attached/unknown ownership, PID reuse, residual instances and live monitor leases; reconciles pending requests without resending |
| `startDetachedSupervisor(options)` | spawns an observation-only supervisor process that keeps the monitor lease/heartbeat after the caller exits; no GUI mutation authority |
| `ae.diagnostics()` | → `SessionDiagnostics`: host crash reports, host logs and the trace collected into `ae.artifactsDir/diagnostics/`; `notes` says what could not be collected |
| `ae.tracePath`, `ae.traceEvents`, `ae.artifactsDir` | evidence |

Errors: `EntityNotFoundError` (with `kind`), `UnsavedChangesError`,
`PropertyHasNoValueError` (a `get`/`set` on a property without a value; nothing
is written), `ParameterValueError` (a `set` whose shape does not fit the
property's `valueType`; nothing is written),
`AfterEffectsError` (AE's own message; `cause` holds the protocol-level
error), `AfterEffectsNotInstalledError`. Lower-level pieces (`AeDriver`,
`ScriptInvocationTransport`, `resolveInstall`) are exported for tooling.

Not in this release: saving, layers other than text, keyframe writes (keyframe
*readback* is available via `layer.property`/`effect.parameter().info()`),
expressions, render-queue output modules.

### Driving a plugin's menu command

```ts
import { AfterEffects } from "@ido-bata/ae-a8n";

// The plugin reads PLUGIN_OUT with getenv; AE started by LaunchServices
// would not inherit it from this process.
const ae = await AfterEffects.launch({ hostEnvironment: { PLUGIN_OUT: "/tmp/plugin-out" } });
const comp = await (await ae.project()).createComp({ name: "E2E", width: 400, height: 300, duration: 1, frameRate: 30 });
const { info } = await comp.addTextLayer({ text: "H", font: "ArialMT", fontSize: 200 });
await comp.openInViewer();
await comp.selectLayers([info.name]);
const run = await (await ae.menuCommand("My Plugin: Run")).execute();
console.log(run.added); // the layers the plugin created
await ae.undo();
await ae.close({ unsavedChanges: "discard" });
```

A command that opens a modal dialog blocks After Effects until a person
dismisses it, and the call times out; a plugin driven this way needs a mode
that reports instead of alerting.

On macOS, do **not** recover by moving the physical user's cursor or clicking
through the user's desktop. A recovery may only act inside the session the
After Effects instance lives in, and it must never press a sign-in or licence
button. The [macOS isolation notes](https://github.com/ido-bata/ae-a8n/blob/main/docs/offstage-macos.md)
describe the separate-user session this needs (`offstage`'s session lane, or an
equivalent native runner), its safety gates, and what is still unverified. It
is **opt-in** and not verified against real AE yet (see
[#49](https://github.com/ido-bata/ae-a8n/issues/49)).

### `@ido-bata/ae-a8n/testing`

An in-process fake After Effects (`FakeAfterEffectsTransport`) that runs the
real host script against a modelled object model, for testing code built on
this package without After Effects. **Unstable:** its shape follows what real
After Effects turned out to do and changes with it.

## Examples and the agent skill

- [`examples/inspect.ts`](examples/inspect.ts) — install, ownership, listing; changes nothing.
- [`examples/smoke.ts`](examples/smoke.ts) — the minimal real-host smoke: launch → version → handshake → project → close; read-only, skips cleanly without After Effects.
- [`examples/render-compare.ts`](examples/render-compare.ts) — apply, set, render before/after, count changed pixels.
- [`examples/extension-consumer.ts`](examples/extension-consumer.ts) — a consumer-side static extension: `ae-a8n extension build` a host script, launch with it, call the method through `ae.call`; skips cleanly without After Effects.
- [`skills/after-effects-automation/SKILL.md`](skills/after-effects-automation/SKILL.md) — instructions for AI coding agents: how to use this package against a real After Effects without damaging anyone's work, and how to investigate failures. Both directories ship in the package; installing the package does not register the skill with any agent — copy it where your agent loads skills from.

## Development

Contributors and coding agents: bootstrap, daily commands, worktree lifecycle, and verification levels are in [docs/development.md](docs/development.md). Agent-facing operating rules are in [AGENTS.md](AGENTS.md). Consumer acceptance (clean install → real-host smoke, and what ae-test / Aulymo need) is in [docs/consumer-acceptance.md](docs/consumer-acceptance.md).

## Known risks

- A long-running script lets other installed CEP extensions run inside it. One
  such extension raised a modal alert once, which blocks After Effects until a
  person dismisses it.
- One repeat run stalled at quit (cause not established; not seen again in 20
  runs). One cold launch took 171 s of the 180 s readiness budget.

## License

MIT
