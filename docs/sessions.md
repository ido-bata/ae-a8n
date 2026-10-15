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
- **Retrying** is not done for you. A retry runs after the timed-out
  script has finished, so it sees that script's effects. The host's own
  operations are written to be repeatable: `layer.applyEffect` returns an
  effect with that identifier if the layer already has one (on AE 26.5x89, a
  retry after a timed-out apply left exactly one effect and reported
  `created: false`), `effect.setParameter` writes an absolute value, and
  `comp.renderFrame` overwrites its file. Anything a caller builds on top
  that is not repeatable has to read the state back before retrying.
- **A per-call budget.** `openProject`, `renderFrame` and `project` take
  `{ timeoutMs }`, which replaces the session's budget for that call only.
  It changes how long the caller waits, nothing else: a script that is past
  its deadline still runs to completion, and the next call still waits for
  it.
- **After a timed-out `openProject`**, AE usually finishes the open, but the
  caller has no `Project`. `ae.project()` returns one for whatever project
  is open now: it asks the host (`project.info`), so it waits for the open
  script first, and it opens, closes and edits nothing. On AE 26.5x89 with
  a 400 ms session budget: an open given 100 ms timed out, the host took
  494 ms to finish it, `ae.project()` answered after it with the opened
  file, and exactly one `project.open` request had been sent.
- **`close()`** sends `app.quit` the same way: it waits for a script still
  running, within the quit's 10 s budget. If that runs out, `close()` rejects
  with `TimeoutError`, AE is left running, and the quit was never sent.

The transport never kills `osascript` on a deadline. Doing so (tried, on AE
26.5x89) left AE refusing every later script and refusing to quit until it
was force-killed.
