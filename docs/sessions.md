# Sessions: who owns After Effects, and what a timeout means

## Ownership

A session either started the After Effects process it talks to, or found one
already running. `AfterEffects.ownership()` reports which:

| Kind | Meaning | `close()` |
| --- | --- | --- |
| `owned` | This session launched AE, and it is still that process | quits AE |
| `attached` | AE was already running when the session launched | leaves AE running |
| `unknown` | Neither could be established | leaves AE running |

How it is decided on macOS: just before launching, the transport lists the
processes of this install's executable (pid and start time). If any exist,
the session is `attached`. If none existed and, once the readiness probe has
answered, exactly one is running and it started after the launch began, the
session owns that process. At `close()` the check is repeated: the same pid
with the same start time must still be the only instance — a restarted AE, a
reused pid, or a second instance all make it `unknown`.

Windows has no process check yet, so a Windows session is `unknown` and
`close()` does not quit AE there. That is deliberate: no evidence, no quit.

## Unsaved changes

Nothing discards unsaved changes without being told to.

- `close()` on an owned host whose project has unsaved changes rejects with
  `UnsavedChangesError`. The session stays open; repeat with
  `close({ unsavedChanges: "discard" })` to quit anyway.
- `openProject(path)` over unsaved changes rejects the same way, and accepts
  the same option.
- On an attached or unknown host, `close()` never touches the project at all,
  whatever the option says.

A session that edits a project it opened (applying effects, setting
parameters, rendering — `saveFrameToPng` changes the viewer resolution and
restores it, which AE counts as an edit) must pass `"discard"` to close: the
edits are its own, and saying so is the point.

## Timeouts

`DoScriptFile` (macOS) runs the script to completion before it returns, and
an ExtendScript cannot be interrupted from outside. So a timeout ends the
*wait*, not the work:

- **The call** rejects with `TimeoutError` at its deadline; the trace records
  `timeout`.
- **The script keeps running** inside AE and publishes its result late. The
  driver never reads it. Its effects on the project happen anyway.
- **The next call** waits for that script to finish before sending its own,
  within the next call's deadline. If it is still running at that deadline,
  the next call times out too, without having been sent.
- **Retrying** is not done for you, and is not safe in general: a retry of a
  timed-out `applyEffect` runs after the first one has finished, and the
  layer ends up with the effect twice. Retry only operations that are safe to
  repeat, or read the state back first.
- **`close()`** sends `app.quit` the same way: it waits for a script still
  running, within the quit's 10 s budget. If that runs out, `close()` rejects
  with `TimeoutError`, AE is left running, and the quit was never sent.

The transport never kills `osascript` on a deadline. Doing so (tried, on AE
26.5x89) left AE refusing every later script and refusing to quit until it
was force-killed.
