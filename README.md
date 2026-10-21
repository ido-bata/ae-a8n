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

> **Alpha.** `0.1.0-alpha.1` is published under the `next` dist-tag. The API
> may change before 0.1.0.

## Status

| | |
| --- | --- |
| macOS | Verified against After Effects 2026 (26.5x89, Japanese UI) on macOS 27, arm64: launch, project/comp/layer lookup, effects by match name, parameter write/read, one-frame PNG render, typed failures, timeouts, session ownership; 20 consecutive fresh-session runs |
| Windows | Verified against After Effects 2026 (26.5x89, English UI) on Windows 11 x64: cold launch, install discovery, process ownership and quit-only-what-this-session-started, menu commands, `hostEnvironment`, scene building, Undo/Redo, and Ae_Restro's 33-check E2E through this API (3 runs). See [docs/windows-verification.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/windows-verification.md) and [docs/verification.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/verification.md). ARM64 and non-English UIs not run |
| Node | 22 or later (developed on 24) |

What has been checked, and how, is in [docs/verification.md](https://github.com/ido-bata/ae-a8n/blob/main/docs/verification.md).

## Install

```bash
npm install @ido-bata/ae-a8n@next
```

Requirements on the machine that runs After Effects:

- After Effects installed in the default location (`/Applications/Adobe After Effects <version>/` on macOS), or pass `installDir`.
- **Settings → Scripting & Expressions → Allow Scripts to Write Files and Access Network** enabled. Without it the first call times out instead of failing fast.

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
| `AfterEffects.launch(options?)` | `{ sessionRoot?, installDir?, timeoutMs?, transport?, hostEnvironment? }`; `hostEnvironment` is set inside an owned AE process (`$.setenv`) for native plugins; `timeoutMs` is the per-call default, which `openProject`, `project` and `renderFrame` can override for one call; waits for a readiness probe (180 s budget) |
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
| `layer.setEnabled(on)`, `layer.transform()`, `layer.shapePaths()` | video switch; transform values; a shape layer's paths in layer space |
| `ae.close({ unsavedChanges? })` | → `{ quit, ownership, reason? }` |
| `ae.tracePath`, `ae.traceEvents`, `ae.artifactsDir` | evidence |

Errors: `EntityNotFoundError` (with `kind`), `UnsavedChangesError`,
`PropertyHasNoValueError` (a `get`/`set` on a property without a value; nothing
is written), `ParameterValueError` (a `set` whose shape does not fit the
property's `valueType`; nothing is written),
`AfterEffectsError` (AE's own message; `cause` holds the protocol-level
error), `AfterEffectsNotInstalledError`. Lower-level pieces (`AeDriver`,
`ScriptInvocationTransport`, `resolveInstall`) are exported for tooling.

Not in this release: saving, layers other than text, keyframes, expressions,
render-queue output modules.

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

### `@ido-bata/ae-a8n/testing`

An in-process fake After Effects (`FakeAfterEffectsTransport`) that runs the
real host script against a modelled object model, for testing code built on
this package without After Effects. **Unstable:** its shape follows what real
After Effects turned out to do and changes with it.

## Examples and the agent skill

- [`examples/inspect.ts`](examples/inspect.ts) — install, ownership, listing; changes nothing.
- [`examples/render-compare.ts`](examples/render-compare.ts) — apply, set, render before/after, count changed pixels.
- [`skills/after-effects-automation/SKILL.md`](skills/after-effects-automation/SKILL.md) — instructions for AI coding agents: how to use this package against a real After Effects without damaging anyone's work, and how to investigate failures. Both directories ship in the package; installing the package does not register the skill with any agent — copy it where your agent loads skills from.

## Known risks

- A long-running script lets other installed CEP extensions run inside it. One
  such extension raised a modal alert once, which blocks After Effects until a
  person dismisses it.
- One repeat run stalled at quit (cause not established; not seen again in 20
  runs). One cold launch took 171 s of the 180 s readiness budget.

## License

MIT
