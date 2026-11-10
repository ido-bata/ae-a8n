# What the Windows host said on 2026-11-10, and why the acceptance stopped

The job channel worked end to end on the first real attempt: a signed job was
delivered, the agent claimed it, ran it, and the result came back. What came
back was an error, and chasing it found a real defect in the shipped host
script. This note is the measurement trail; the fix is PR #91 (#61).

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

## What this means for the acceptance

The acceptance did not reach any After Effects operation: it stopped at the
readiness probe. Nothing about project, comp, layer, render, ownership or
quit has been exercised on this host yet, and none of it is claimed.

The next attempt needs the fixed build installed on the host
(`PR #91`), and then the acceptance to pass twice.

## Reaching the host

Scripts delivered with `AfterFX.exe -r` from an SSH session do not execute:
the process prints its startup warnings and leaves no script output and no
process behind. Delivered from the job channel — the interactive session the
agent runs in — they execute. Every diagnostic here went through the job
channel for that reason; `diag-ae.mjs` is the wrapper that starts After
Effects, waits for the script's own completion marker, then quits it.
