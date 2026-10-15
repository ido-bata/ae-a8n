---
name: after-effects-automation
description: Drive a real Adobe After Effects from Node with @ido-bata/ae-a8n — open a project, apply an effect by match name, set parameters, render a frame to PNG, and verify the pixels — without damaging anyone's open work. Use when a task needs After Effects itself to do something or to prove a plugin/effect behaves, not just to read or write .aep-adjacent files.
---

# Driving After Effects with ae-a8n

`@ido-bata/ae-a8n` runs ExtendScript inside a real After Effects and gives you
a typed API over it. Everything below matches the package's public types; if
a call you want is not listed here, check `dist/index.d.ts` rather than guess —
there is, for example, **no save, no layer creation, and no arbitrary-script
API**.

Verified on macOS (After Effects 2026 / 26.5, Japanese UI). **Windows has not
been run at all**; on Windows the package will not quit After Effects for you
(ownership is always `unknown` there).

## Rules that are not optional

1. **Never kill After Effects** (`kill`, `pkill`, Force Quit) unless the human
   said so for that process. A killed AE shows a crash-recovery dialog on the
   next launch that only a person can dismiss.
2. **Work on a copy** of any `.aep`. Never open a production project.
3. **If After Effects was already running, it is not yours.** `ownership()`
   tells you; do not open projects in an `attached` or `unknown` session.
   Report it and ask the human to quit AE instead.
4. **Discard only your own edits.** Pass `{ unsavedChanges: "discard" }` only
   to `close()` / `openProject()` of a session you own, about changes you made.
5. **One session at a time.** After Effects is single-instance; do not run two
   scripts that launch it concurrently.
6. **Do not leave long-running work inside AE.** A script that runs for
   seconds lets other installed extensions run inside it; one has been seen to
   raise a modal alert that blocks AE until a person clicks it.

## Before you start

```bash
pgrep -lx "After Effects"        # macOS: anything listed is someone's session
```

```ts
import { resolveInstall } from "@ido-bata/ae-a8n";
const install = resolveInstall(); // throws AfterEffectsNotInstalledError if none
```

After Effects must have **Settings → Scripting & Expressions → Allow Scripts
to Write Files and Access Network** enabled (General in older versions).
Without it the first call times out after the readiness budget instead of
failing fast.

## The session

```ts
import { AfterEffects } from "@ido-bata/ae-a8n";

const ae = await AfterEffects.launch({ timeoutMs: 120_000 }); // per-call budget; default 30 s
ae.info();       // { version: "26.5x89", build: "89" } from the readiness probe
ae.ownership();  // { kind: "owned" | "attached" | "unknown", evidence: string }
```

- A cold launch can take long; the readiness probe has its own 180 s budget.
  One cold launch has been observed at 171 s.
- `owned`: this session started AE and it is still that process. Only then
  does `close()` quit it.
- `attached`: AE was running before. `close()` leaves it alone.
- `unknown`: no evidence either way (every Windows session, or the process
  was replaced). Treated like `attached`.

## Doing the work

```ts
const project = await ae.openProject("/tmp/work/copy-of-fixture.aep");
const comp = await project.comp("Main");          // EntityNotFoundError if absent
const layer = await comp.layer("Solid 1");
const effect = await layer.effects.apply("ADBE Gaussian Blur 2");
const blur = effect.parameter("ADBE Gaussian Blur 2-0001");
await blur.set(60);       // returns the value AE now holds
await blur.get();         // read back; plugins may clamp
```

- **Use match names**, not display names. Display names are localised
  (Gaussian Blur's "Blurriness" is "ブラー" in a Japanese UI); match names are
  not. Find them from what AE reports:
  `await layer.effects.all()` → `{ name, matchName }[]`,
  `await effect.parameters()` → `{ name, matchName, value }[]`.
- `effects.apply(id)` returns the existing effect if the layer already has
  one with that name or match name; it does not add a second.
- Defaults are AE's, not zero: Gaussian Blur's Blurriness defaults to 25.
- Built-in effects can have options that confine a change. Gaussian Blur's
  "Repeat Edge Pixels" (`ADBE Gaussian Blur 2-0003`) defaults on and keeps
  the blur inside the layer's bounds: pixels outside the layer never change,
  and on a uniform solid only a thin band just inside its edges does
  (observed: 79,212 of 2,073,600 pixels between blur 0 and 100, alpha
  255 → 253 at the edge). Compare the whole image, not one sample point, or
  turn the option off (`0`) to let the blur spread past the layer.

## Rendering and checking pixels

```ts
const before = await comp.renderFrame(0, { subdirectory: "before" });
await blur.set(100);
const after = await comp.renderFrame(0, { subdirectory: "after" });
// { path, frame, width, height } — size read from the PNG that was written
```

- `frame` is a frame index (time = frame × frame duration).
- Files land in `ae.artifactsDir[/subdirectory]/<prefix or comp>.<00000>.png`.
- Output is 8-bit RGBA at full comp resolution; outside the layers alpha is 0.
- Compare files by hash *and* by pixels. `examples/png.ts` in this package
  has a dependency-free reader and `countChangedPixels`.
- Rendering marks the project as changed (the viewer resolution is forced to
  full and restored), so plan to close with `discard`.

## Closing

```ts
const result = await ae.close({ unsavedChanges: "discard" }); // only for your own edits
// { quit: boolean, ownership, reason? }
```

- With unsaved changes and no `discard`, `close()` throws
  `UnsavedChangesError` and the session stays open — decide, then retry.
- `quit: false` with a `reason` means AE was left running on purpose.
- Then check: `pgrep -lx "After Effects"` should print nothing if you owned
  it, and `pgrep -l osascript` should be empty.

## When something goes wrong

| Error | Meaning | Do |
| --- | --- | --- |
| `EntityNotFoundError` (`kind`) | comp/layer/effect name not in the project | list with `comps()`, `layers()`, `effects.all()` |
| `UnsavedChangesError` | would discard unsaved work | if it is yours, retry with `discard`; else stop |
| `AfterEffectsError` | AE reported a failure; message has AE's text | read `error.message` and `error.cause` |
| `TimeoutError` (as `cause`) | no answer within the budget | see below — the work may still be running |
| `AfterEffectsNotInstalledError` | no install found | pass `installDir` or stop |

Launcher messages carry osascript's own error code: `-1728` the application
path did not resolve, `-609` AE was quitting, `-1712` the AppleEvent itself
timed out (AE blocked, often by a dialog).

**Evidence.** `ae.tracePath` is a JSON-lines file: one record per operation
with `op`, `status` (`ok`/`error`/`timeout`), `durationMs`, `args`, `result`
or `error`. `ae.traceEvents` is the same in memory. The session directory
(`dirname(ae.tracePath)`) also holds every request and result envelope
(`inbox/`, `outbox/`) and renders (`artifacts/`). Read these before
re-running anything.

## After a timeout

An ExtendScript cannot be interrupted. A timeout ends *your wait*, not the
work:

- The script keeps running in AE and its effects land anyway.
- The next call waits for it (within its own budget) before sending.
- Nothing is retried for you. Before retrying, **read the state back**
  (`effects.all()`, `parameter.get()`); the operations above are written to
  be repeatable, but your own sequence may not be.
- If calls keep timing out, AE is probably blocked by a modal dialog. Scripts
  cannot dismiss it. Stop, tell the human what you saw (trace + the last
  error), and do not kill AE.

## Not covered

Saving projects, creating comps or layers, expressions, keyframes, render
queue output modules, audio, Windows behaviour. Do not improvise these
through other channels without the human's agreement.

## Worked examples

In the package (`node_modules/@ido-bata/ae-a8n/examples/`) and the repository:

- `examples/inspect.ts` — install, ownership, project listing; touches nothing.
- `examples/render-compare.ts` — apply, set, render before/after, count
  changed pixels, close.

Node will not run `.ts` files from inside `node_modules`; copy `examples/`
into your own directory first, then run them with a Node that executes
TypeScript directly (Node 24 does):

```bash
node examples/render-compare.ts copy.aep Main "Solid 1" \
  "ADBE Gaussian Blur 2" "ADBE Gaussian Blur 2-0001" 0 100 "ADBE Gaussian Blur 2-0003=0"
```
