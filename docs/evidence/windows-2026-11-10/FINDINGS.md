# Windows host, 2026-11-10: why the first acceptance stopped, and what ran after

This directory holds two results, and they are not the same run:

- **Result A — the first attempt, which failed.** The job channel worked end
  to end on the first real attempt: a signed job was delivered, the agent
  claimed it, ran it, and the result came back. What came back was an error,
  and chasing it found a real defect in the shipped host script. Sections
  "The symptom", "The measurements" and "What the failed attempt meant" below
  are that result.
- **Result B — two runs after the fix, both clean.** `## Result B` at the end
  records them: AE 26.5x89, `0 → 1 → 0` processes, comp/layer/DOM/PNG/quit,
  twice. The fix is PR #91 (#61).

The first attempt proved nothing about After Effects operations; Result B
does, for the basic path only. Reads of this file should keep the two apart.

## The symptom

The acceptance script (`accept-ae.mjs`) asked for `app.info` as its readiness
probe. After Effects 26.5 launched (`AfterFX.exe` 0 before, 1 after) and
answered, in 10 ms:

```json
{"v":1,"id":"d7054f0f-…","ok":false,"durationMs":10,
 "error":{"name":"Error","message":"unknown method: app.info","line":976}}
```

Line 976 of the staged host script is the `throw` in `dispatch`. The file on
disk registers `methods["app.info"]` at line 376, was byte-identical to the
installed copy (`d819706f…`, 37,350 bytes, 1,085 lines), and `has()` is
`Object.prototype.hasOwnProperty.call`.

## The measurements

Four read-only scripts, each run through the same job channel as the
acceptance — every one of them started After Effects once and quit it normally
(`0 → 1 → 0` `AfterFX.exe`, nothing killed, no project opened):

| probe | finding |
| --- | --- |
| `diag-dispatch.jsx` (dispatch instrumented) | `request.method = [app.info]`, `own = true`, `count = 26`, `app.info` first in the list — and still `unknown method` |
| `diag-obj.jsx` | `o["a.b"]` reads back, dotted function values are callable, no path resolution |
| `diag-lookup.jsx` | the codec's `request.method` is a primitive `"app.info"`; `table[request.method]` reaches the function |
| `diag-ternary.jsx` | the nested conditional evaluates to `undefined`; grouped and statement forms do not |

The last one is the cause. Given `a ? x : b ? y : undefined`, AE 26.5x89
(ExtendScript 4.5.6) lets the *second* test decide the whole expression, so a
name that `methods` owns evaluates to `extensions[name]` — undefined. Every
request fails, not just the probe.

The expression came in with the extension-method dispatch (`143db87`, #61).
The release before it used a single-level conditional, which this engine
evaluates correctly.

## What the failed attempt meant

The first attempt did not reach any After Effects operation: it stopped at the
readiness probe. Nothing about project, comp, layer, render, ownership or quit
had been exercised on this host at that point, and none of it was claimed.

That is the state Result A was in. What it needed next was the fixed build
installed on the host (PR #91) and the acceptance run twice; Result B below is
that, and it is a separate result rather than a correction to this one.

## Reaching the host

Scripts delivered with `AfterFX.exe -r` from an SSH session do not execute:
the process prints its startup warnings and leaves no script output and no
process behind. Delivered from the job channel — the interactive session the
agent runs in — they execute. Every diagnostic here went through the job
channel for that reason; `diag-ae.mjs` is the wrapper that starts After
Effects, waits for the script's own completion marker, then quits it.

## Result B: the acceptance, after the fix

Build under test: `integration/win-cli` at `d5dea95` plus `c857a4c` (#61), merged
locally as `4bf9ea0` — no branch was merged or published. The tarball
(`ido-bata-ae-a8n-0.1.0-alpha.1.tgz`, sha256
`1729e255463b0aa8ed8a730b701de8bfc2d49133b51895adb163a2aafe8b7563`) was installed
into `C:\Users\rebui\AppData\Local\ae-a8n\agent-app`; the installed host script
is `b1d87e19a809046ec3571231a728659b0f2f79dc46622aaf7797097c750fe8b2` and carries
the statement form of the lookup.

Two runs, one after the other, each started from zero `AfterFX.exe`:

| | run 1 | run 2 |
| --- | --- | --- |
| run id | `20261110T155448Z-9190f1a0` | `20261110T155806Z-3f927bed` |
| summary | `acceptance/run-1-20261110T155706.json` | `acceptance/run-2-20261110T155904.json` |
| status | `ok`, no problems | `ok`, no problems |
| duration | 19.2 s | 18.7 s |
| `AfterFX.exe` before / during / after | 0 / 1 / 0 | 0 / 1 / 0 |
| version | 26.5x89 | 26.5x89 |
| ownership | `owned` (pid 43272, only instance) | `owned` (pid 35096, only instance) |
| comp | `A8N-ACCEPT` 320x240, 1 text layer `A8N` ArialMT 96 | same |
| frame 0 | 320x240 PNG, `acceptance/run-1-frame0.png` | identical bytes, `run-2-frame0.png` |
| quit | `quit: true`, ownership still `owned` at the moment of quitting | same |

The two rendered frames are byte-identical (sha256 `576576b6…`).

**What this proves:** on a real Windows 11 host with a real After Effects
26.5x89, the package launched AE, proved the instance was the one it started,
created a comp and a text layer, read them back through the DOM, rendered frame
0 to a PNG, proved ownership again and quit normally with no process left —
twice.

**What it does not prove:** non-interference (no run was made while the
console user worked normally), recovery after an abnormal termination (no
crash, kill or hung dialog was induced), extension calls through the agent
(the table was in the build; no `ae.call` was made), account separation, the
rest of the API (effects, parameters, menu commands, `openProject`/`save`,
viewer, shapes), the agent's long-running behaviour beyond one job,
installation paths outside this one, and macOS. The run path is `ae-a8n test`
on the dedicated-host backend only.
