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
the session is `attached`. If none existed, the transport asks LaunchServices
to start After Effects (`open` on the bundle — a directly spawned process is
invisible to LaunchServices for seconds, and the readiness probe's Apple
Event addressed by bundle path would make LaunchServices start a second
instance in that gap; observed on AE 27.0) and keeps the pid of the single
new process that appears. Once the readiness probe has answered, exactly one
instance must be running and its pid must be that recorded pid; otherwise the
session is `unknown`. At `close()` the check is
repeated: the same pid with the same start time must still be the only
instance — a restarted AE, a reused pid, or a second instance all make it
`unknown`. If the transport cannot record a pid, the session is `unknown` even
when a single instance appeared after the snapshot: that alone cannot tell the
run's After Effects from one the person started a moment later.

Windows has no process check yet, so a Windows session is `unknown` and
`close()` does not quit AE there. That is deliberate: no evidence, no quit.

## Attaching without ever launching (#269)

`AfterEffects.launch()` detects a running After Effects but falls back to
starting one when its probe cannot reach it — which is how a caller that
only wanted to connect could end up with a second AE process (#99). For
that case there is `AfterEffects.attach(options)`:

- The default script transport is built **attach-only**: its `launch()`
  selects a target from the process census and returns — the branches that
  would call `open` (macOS) or `AfterFX.exe` (Windows) are unreachable.
  On Windows the script lane refuses outright, because every script
  delivery there is itself an `AfterFX.exe -r` spawn; Windows attach uses
  `transport: "in-ae-dispatcher"` (a file channel that spawns nothing) or
  a caller-supplied transport.
- Selection is fail-closed. With no `target`, exactly one in-scope
  instance of the selected install must be running. `target.pid` pins one
  process. Refusals are `AttachTargetError` with `reason`:
  `not-found`, `ambiguous`, `wrong-session` (the AE belongs to another
  login session), `unknown-target` (the process list or identity could not
  be read), `unresponsive` (a target was selected but never answered the
  probe — busy or modal), `unsupported` (this transport cannot attach
  without creating a process). Nothing is resent or retried afterwards.
- Identity is re-proven at probe time: the selected pid and start time
  must still name the same process — and, unpinned, still the only
  in-scope instance — or ownership downgrades to `unknown`. Calls remain
  bound to the engine that answered the probe by the session marker.
- The session's ownership is `attached` (or `unknown`), so `close()`
  never quits the host, and `session.recover` is refused: the GUI
  fallback needs a process this session started.

## Resuming a session

`AfterEffects.launch()` writes `launch-provenance.json` into the session
directory once the readiness probe has proven ownership — the pid, the
process start time, the Windows creation identity when there is one, the
executable, the transport kind, and the ae-a8n version. It is evidence, not
authority: a file alone never makes a host ours.

`AfterEffects.resume({ sessionRoot })` rebinds to that host after the calling
process restarted. It re-checks everything live: the recorded pid must still
be the same process (pid *and* start time, plus the creation identity on
Windows), running the install's executable, and the only instance of that
install in scope — then the readiness probe must answer before ownership is
claimed, exactly as for a fresh launch. A clean `close()` removes the
record.

Resume refuses — starting nothing and touching nothing — when:

- the record is missing or does not parse as `a8n.launch-provenance/v1`;
- the recorded process is gone, or its pid was reused by a process with a
  different start time;
- another instance of the same install is running, so the recorded pid
  cannot be told apart from it;
- the record names a different executable than this install resolves to;
- the probe never answers (the host may be wedged; it is left running).

Ownership after a successful resume is `owned`, so owned-only operations —
`close()` quitting AE, `hostEnvironment` — work as they did in the original
session. A resume that cannot prove identity leaves the host `unknown` or
`attached`, and `close()` still refuses to quit it.

## Authorization is a separate grant (#145)

Three authorities stay separate: quitting the host is owned-only and is
enforced in the driver; the connected target is what the session bound at
launch (the dispatcher's `instance` for the in-AE transport); and each
privileged operation class — `extensionMethods` (`ae.call`),
`hostEnvironment`, `menuCommands` — needs either ownership or the matching
entry in `LaunchOptions.authorization`. A grant never promotes ownership,
never permits quitting, is snapshotted at launch, recorded in the trace and
`ae.capabilities().target.grantedOperations`, and ends with the session.
It is a caller-side consent gate — the AE host does not authenticate or
independently authorize it — and it applies only to `attached` sessions:
`unknown` ownership stays fully restricted until the session establishes a
proven target.

## A launch that fails after the process appeared

On macOS the transport starts After Effects itself, then the readiness probe
is sent as an Apple Event. That order has a state the ownership table does not
cover: the process exists, and the probe never answered — a denied Apple Event
(`-1743`), a host that is still starting, a modal dialog. The process is this
session's doing, but it is **not** proven to be this session's to quit, and
quitting on provenance alone would be exactly the guess the ownership rules
exist to prevent.

That failure is reported as `HostLeftRunningError` (`A8N-AE-005`), and it
carries the launch identity the transport kept: the pid it spawned, the
process start time `ps` first reported for it, the executable, whether the
pid was still that process at the last listing, and the uid/user/asid of the
session it was started into. Nothing is quit, killed or re-sent. If the
process list could not be read, the pid is still reported and the start time
is `null` — never guessed.

(`AfterEffects.launch()` throws this as an `AfterEffectsError` with
`code === "A8N-AE-005"` and the `HostLeftRunningError` as `cause`. The
isolated `test` runner reports it as `unknown`, records the identity in the
check's `evidence`, and quarantines the target so the next run does not treat
the leftover as a fresh, unoccupied After Effects.)

Recovery is a human's: find that pid in that session, quit After Effects, then
clear the quarantine (`ae-a8n recover`) before running again. Repeating the
probe from the same driver is refused — the same Apple Event that was denied
would just be denied again.

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
- **A timeout is classified, not just reported.** When a call times out the
  driver asks what the host looked like and the failure carries
  `hostCondition`: `"gone"` (the process is proven absent — a crash or a
  kill), `"unresponsive"` (the process is alive but did not answer),
  `"modal"` (the recovery observed a blocking window), or `"unknown"`
  (neither could be determined — never guessed). Through the public API it
  surfaces as `hostCondition` on the thrown `AfterEffectsError` (the
  `TimeoutError` stays the `cause`); the same classification is recorded
  in the trace.
- **`ae.diagnostics()`** collects host-side evidence into
  `<artifactsDir>/diagnostics/`: OS crash reports for the After Effects
  binaries modified during the session, After Effects host logs touched in
  the same window (other Adobe apps' logs are out of scope; tails only,
  size-capped, with per-file and total bundle budgets), and the session
  trace with its last events. Symbolic links are never followed or
  copied, hard-linked files are skipped, and a directory reached through a
  linked ancestor is named in `notes`. Every entry carries an
  `attribution`: `"session"` only when the file's own content names this
  session's host pid, `"app"` otherwise — an After Effects file in the
  window is not proof it belongs to *this* session's process, and an empty
  crash-report list is not evidence of a clean exit (a kill leaves none
  either). The bundle is **not sanitised** — logs can contain user names,
  paths, project names and serial numbers; it stays on this machine and
  should be reviewed before sharing. It returns the report — paths plus
  `notes` for whatever could not be collected — and never moves the user's
  files or sends anything anywhere. A `close()` that fails collects it
  automatically. `ae.diagnostics({ homeDir, sources, platform })` overrides
  where evidence is looked for, so tests and tooling never have to scan
  the real user directories.

The transport never kills `osascript` on a deadline. Doing so (tried, on AE
26.5x89) left AE refusing every later script and refusing to quit until it
was force-killed.
