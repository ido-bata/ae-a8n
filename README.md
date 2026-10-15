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

> **Alpha.** `0.1.0-alpha.0` is published under the `next` dist-tag. The API
> may change before 0.1.0.

## Status

| | |
| --- | --- |
| macOS | Verified against After Effects 2026 (26.5x89, Japanese UI) on macOS 27, arm64: launch, project/comp/layer lookup, effects by match name, parameter write/read, one-frame PNG render, typed failures, timeouts, session ownership; 20 consecutive fresh-session runs |
| Windows | **Not run. No behaviour is claimed.** The launcher path exists (`AfterFX.exe -r`) but has never executed. A Windows session never quits After Effects for you |
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
  `unknown` if neither can be established (always, on Windows). `close()`
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
| `AfterEffects.launch(options?)` | `{ sessionRoot?, installDir?, timeoutMs?, transport? }`; waits for a readiness probe (180 s budget) |
| `ae.info()`, `ae.version()` | version from the probe / live |
| `ae.ownership()` | `{ kind: "owned" \| "attached" \| "unknown", evidence }` |
| `ae.openProject(path, { unsavedChanges? })` | → `Project` |
| `ae.comps()`, `project.comps()`, `project.info()` | listings |
| `project.comp(name)` → `Comp` | `comp.info()`, `comp.layers()`, `comp.layer(name)` |
| `comp.renderFrame(frame, { subdirectory?, prefix? })` | one PNG under `ae.artifactsDir`; size read from the file |
| `layer.effects.all()`, `.apply(id)`, `.get(id)` | `id` is a match name (stable) or display name (localised) |
| `effect.parameters()`, `effect.parameter(id).get()` / `.set(n)` / `.info()` | numeric parameters |
| `ae.close({ unsavedChanges? })` | → `{ quit, ownership, reason? }` |
| `ae.tracePath`, `ae.traceEvents`, `ae.artifactsDir` | evidence |

Errors: `EntityNotFoundError` (with `kind`), `UnsavedChangesError`,
`AfterEffectsError` (AE's own message; `cause` holds the protocol-level
error), `AfterEffectsNotInstalledError`. Lower-level pieces (`AeDriver`,
`ScriptInvocationTransport`, `resolveInstall`) are exported for tooling.

Not in this release: saving, creating comps/layers, keyframes, expressions,
render-queue output modules.

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
