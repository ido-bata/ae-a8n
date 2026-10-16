# Windows: what has been verified, and how to repeat it

Evidence levels are those of [verification.md](verification.md). Nothing here is
a claim that Windows "works": the table says which gate was reached.

## Environment

| | |
| --- | --- |
| OS | Windows 11 Home Insider Preview 10.0.29683, 13th Gen Intel Core i7-13700H |
| Node / npm | 26.12.0 / 11.20.0 (native Windows processes only; no WSL) |
| After Effects | 26.5x89 (`app.version`), English UI, installed outside `C:\Program Files\Adobe` |
| Scripting | "Allow Scripts to Write Files and Access Network" on (`Pref_SCRIPTING_FILE_NETWORK_SECURITY = 1`) |
| CEP extensions present | several third-party panels (including Ty Plus and a Discord presence panel) |
| npm package | `@ido-bata/ae-a8n@0.1.0-alpha.0` installs |
| Code | `ido-bata/ae-a8n` `main@caabf04`; fixes in PR #17: `963b674`, `a668f86` |
| Date | 2026-10-16 |

## Gates

| Gate | Result | Level | Notes |
| --- | --- | --- | --- |
| P0 environment, safe dedicated session | **pass** | real host | No AE process before the run, no unsaved user project; AE started by the supervisor for the run. |
| P1 independent JSX | **pass for space-free paths; `-r` fails for paths with whitespace** | real host | See "P1". |
| P2 launch, readiness, `app.info`, result file | **pass, including a cold start through ae-a8n** (after a fix) | real host | Attach: probe 0.9 s. **Cold:** no AE running, then `AfterEffects.launch()`, ready in 7.4-8.8 s, then `version()`, `openProject`, `project.info`, `comp`, `comp.info`, `layers`, `close()`; 8/8 sequences, no modal. Before the fix the cold start failed 2/2 (below). `close()` leaves AE running: ownership is `unknown`. |
| P3 real `.aep`, comp/layer, write and read back | **pass on a clean AE** (blocked earlier, cause found: see "The modal") | real host | open → info → comps → comp → layers → layer → effect apply → parameter set/get, every call ~0.3-0.7 s, no modal. The earlier block was a global AE object left by *another* script, not ae-a8n. |
| P4 effect + PNG, pixels changed | **pass** | real host | Two 1920x1080 PNGs; Gaussian Blur 0 → 100 changed 453,574 pixels, identical in every run. |
| P5 ae-test real-host | **partial: the runner works; ae-test refuses the Windows session by design** | real host + fake | See "P5". Unmodified ae-test cannot run against a real AE here because ownership is `unknown`. With a verification-only ownership shim outside both packages: a real blur spec passed, the snapshot compared equal on a second cold start, a typed-error spec passed, a deliberately false assertion failed as intended, and teardown quit AE every time. |
| P6 fresh-session repeats, exceptions, cleanup | **repeats pass (10/10 attach, 8/8 cold); overlap understood; one modal unexplained** | real host | See "P6". |

Gate durations (wall clock): AE cold start to a usable GUI ~75 s (two
splash-like dialogs for ~60 s, then the main window); `-r` against a running AE
~0.4-1.1 s from launcher start to the JSX's file appearing.

## P1: what is established

Success is always "the file the JSX wrote has the expected content", never the
launcher's exit code (it is 0 whether or not the script ran).

| Delivery | Path | Result |
| --- | --- | --- |
| `File > Scripts > Run Script File` (menu item posted to the main window, path typed into the file dialog) | ASCII | ran |
| same | Japanese + space | ran; the JSX read back its own path and wrote `日本語` as UTF-8 |
| `AfterFX.exe -r <path>` to a running AE | ASCII | ran (~0.4 s) |
| same | Japanese, no space | ran |
| same | contains a space | **did not run, no error, no dialog; launcher exits 0** |
| same | contains a space, 8.3 short name of its directory | ran |
| same | contains a space, forward slashes | did not run |
| same | any path wrapped in `"..."` (also what Node adds for a space) | did not run |
| `AfterFX.exe -r` on a cold start | not run as its own case | - |

So the script engine and the path are fine (the GUI runs everything); the
command-line delivery of `-r` drops a path with whitespace, silently. The
original P1 failure was this (a Japanese path *with a space*) plus, in the
following attempts, an Adobe survey dialog; **that the survey dialog by itself
blocks scripts was not established**. What was established is a different
modal doing so: an error dialog ("Can't import file "After"", caused by a
malformed command line in a test) made every later `-r` fail until it was
closed. Scripts sent while a modal is open are dropped, silently.

Handled in #17: with whitespace in the entry path the transport hands `-r` the
8.3 short name of the directory (decoded as UTF-8; PowerShell otherwise answers
in CP932 and a kana short name was garbled), or refuses before launching with
`UnsupportedScriptPathError` naming `sessionRoot`. 8.3 names can be disabled on
a volume; that case is the refusal, **not verified on such a volume**.

## Found only on the real host, fixed in #17

- Discovery stopped at the newest `Adobe After Effects <year>` directory; on
  this machine `C:\Program Files\Adobe\Adobe After Effects 2026` is a 17-file
  leftover with no `AfterFX.exe`, so `new ScriptInvocationTransport()` threw.
  Real run: old code throws; new code returns the 26.5 install via the
  Uninstall registry (`InstallLocation`), no path hard-coded.
- That registry location also holds a stray `Support Files\AfterFX.exe`
  (25.6.4) next to the real install. The first version of the fallback picked
  it. Versioned installs under a location now win.
- `AfterFX.exe -r` with whitespace in the path (above).

## The modal: "Unable to execute script at line 0. Object is invalid"

**Cause (reproduced without ae-a8n): a script left a global variable holding an
After Effects object, and a later script switched projects with `app.open`.**
`AfterFX.exe -r` runs every script in one persistent engine (`$.engineName` is
`main`), so a top-level `var comp = app.project.items.addComp(...)` outlives the
script. When the project that `comp` belongs to is replaced, AE shows the modal
as the switching script ends, and the dialog regenerates after every OK.

Controls, each from a fresh AE process, plain JSX, ae-a8n not involved. Steps:
1. build and save a project (`newProject`, `addComp`, `addSolid`, `save`);
2. `app.open` a different `.aep`; 3. run a script that only writes a file.

| Condition | Result |
| --- | --- |
| A: all AE references inside an IIFE | pass, 2/2 |
| B: top-level `var comp = ...` (an AE `CompItem`) | **modal after step 2, 2/2** |
| C: top-level `var`s holding only `File` objects, the comp inside a function | pass |
| D: as B, but `comp = null` before the script ends | pass |
| E: as B, no `app.open` | pass (the stale reference alone is harmless) |
| F: as B, `app.open` run from `#targetengine "a8n_probe"` | **modal** |

F matters for the fix: a separate target engine does **not** avoid it, because
the stale object lives in `main`. `#targetengine` isolation was therefore not
implemented. ae-a8n itself leaves only `__a8n` (a plain object of path strings)
and wraps the host in an IIFE, so it holds no AE object across calls.

What this means for ae-a8n: it cannot prevent another script's globals from
breaking a project switch, and it cannot clear them. What it can do is name the
condition. A call that times out while an AE dialog is open looks like any other
timeout; "a modal dialog may be open in After Effects" in that message is a
candidate follow-up. **Not done**: that is a diagnostic change, not a fix.

The first occurrence (before this was understood) followed `mkfixture.jsx` and
`savefixture.jsx`, both of which had top-level `var comp`.

### Overlapping `-r`: "Attempt was made to run a second script while another script was already running"

Full text, read from the dialog: *"After Effects warning: Attempt was made to run
a second script while another script was already running. Second script was not
run. Try launching AE with the -ro or -so flag to override this behavior."*

- **Mechanism, reproduced without ae-a8n:** `-r long.jsx` (a 6 s `$.sleep`), then
  `-r quick.jsx` 1.5 s later. The dialog appears while the first runs; when the
  first ends the dialog is gone and `quick.jsx` *did* run, despite the text. The
  same happened with `-ro` for the second. So in that case an overlap is a
  transient dialog, not a lost script.
- ae-a8n alone does not overlap in practice: after a call times out, the next
  `-r` is spawned more than 0.3 s later, by which time a 0.4-0.6 s script (open,
  render) has finished (3 tries, no dialog). A longer abandoned script (a long
  render) would overlap; that was **not** tested with ae-a8n.
- **Not explained:** twice (once after two refused `openProject` calls, once at
  the first call after a cold start through the ae-test shim) the dialog
  appeared and *stayed* for minutes, with the call and `app.quit` timing out
  behind it. Whatever script AE believed was running never ended. Startup
  scripts and third-party ScriptUI panels exist on this machine; **no cause was
  found, and extensions were not disabled**. Two occurrences in about 35
  sessions; not reproduced on purpose. Evidence: `evidence-rep3`, `evidence-c1`
  (kept in the verification scratch directory).
- Decision: no serialisation was added. Overlap is not shown to cause the
  persistent case, and the transient case needs no fix. A sleep or a retry would
  hide the persistent one.

### A cold start that never answers (found and fixed, #17)

Before the fix `launch()` on a cold start failed 2/2: AE was up, healthy and idle
a minute later, but the one probe `-r` sent at launch had been dropped, and the
probe waited out its 180 s. Re-sending the probe every 5 s (tried, reverted) was
worse: a `-r` sent while AE was starting produced *"Unable to execute script. The
Scripting plugin is not installed."*, which blocked the start, and a second
`AfterFX.exe` instance was left running. The fix sends no script until AE's main
window is visible (`AE_CApplication*` plus `IsWindowVisible`; AE creates it
hidden and shows it after the plug-ins load; the class name does not depend on
the UI language). A probe sent the moment the window became visible worked every
time (10/10). The gate is `HostTransport.awaitScriptable`; if no window appears
within the readiness budget the error says no script was sent and why (a crash
recovery dialog, for instance). Unit tests: `test/windows-host.test.ts`.

### A relative `sessionRoot` (found and fixed, #17)

`AfterEffects.launch({ sessionRoot: "rel/dir" })` made `-r` receive a relative
entry path. AE resolves it against its own working directory, ignores it
silently, and `launch` waited out its timeout (180 s) with no error. The root is
now resolved to an absolute path in `launch`. A relative *project* path is
rejected with a `TypeError` by main's `isAbsoluteProjectPath` contract (#34);
this branch does not resolve it. Tests: `test/api.test.ts` (the root) and main's
`test/project-path.test.ts` (drive, UNC, Japanese, space, relative forms).

## P5: ae-test

`@ido-bata/ae-test@0.1.0-alpha.0` installed from npm into an empty directory,
with its README's blur spec. Four things are separate:

| Question | Result |
| --- | --- |
| Does ae-test itself run on native Windows? | **Yes**, with `--fake-host`: spec load, fixtures, assertions, snapshot record and compare, `report.json`, exit codes. Fake level only; the fake host has `ADBE Fake Gaussian Blur`, not the real effect. |
| Does it accept a real Windows AE? | **No.** Unmodified ae-test with the local ae-a8n: AE cold-started and answered in 8.8 s, then `HostNotOwnedError: ... unknown ownership (no process ownership check on win32)`. The AE it started was **left running** (`close()` correctly does not quit an unowned host); it was closed by hand. |
| Do ae-a8n's Windows driver and ae-test's assertions, renders, snapshots and artifacts work on the real AE? | **Yes**, through a verification-only shim (`owned-run.mjs`, in neither package) that reports ownership by the macOS rule: no AfterFX.exe before launch, exactly one after; pid and process start time kept. Three specs, a cold start each: the blur snapshot was recorded and then matched on a second run (same SHA-256 on a fresh AE), a typed `EntityNotFoundError` was asserted, and a deliberately false `toBe` failed with the right message. Traces and PNGs were collected. |
| Teardown and recovery | With the shim, `close()` sent `app.quit` and the process was gone after every test. Without it, ae-test leaves AE running. See the ownership issue. |

One earlier run of the shim hit the persistent "second script" dialog at its
first `project.open`; the test timed out, teardown's `app.quit` also timed out,
and the test AE was force-killed by PID after the evidence was saved. A rerun
passed.

## P6: repeats and recovery

- 10 sequential sessions against one running AE: 10/10, no modal (see P3/P4).
- 8 cold starts through ae-a8n, each followed by open / info / comp / layers and
  a normal UI quit between: 8/8.
- A new `launch` against the same AE (session recreation): covered by the 10.
- Timeout continuation: an `openProject` or `renderFrame` abandoned after 20-30
  ms still finished in AE, and the next call answered, no modal.
- Recovery: a forced kill (by PID) was needed only for blocked test AEs, never
  for a passing run. An unclean AE exit makes the next start show Crash Repair
  Options; the gate waits for it (and fails with a clear message after the
  budget) rather than sending a script into it.

## Test infrastructure: do not leave AE objects in globals

Every `-r` script shares one engine (`$.engineName` is `main`). A fixture-building
JSX with a top-level `var comp = ...`, followed by anything that switches
projects, makes AE show "Object is invalid" and keep showing it (see above).
Wrap fixture scripts in an IIFE, or set the variable to `null` before the
script ends. `#targetengine` does not help (condition F).

## Not verified

- Process ownership: not implemented; `close()` never quits AE on Windows.
- A long abandoned script followed by another call through ae-a8n.
- The persistent "second script" dialog: cause unknown; behaviour with the CEP
  and ScriptUI panels off, and in Safe Mode.
- `windowsHide` removal: no observable difference was recorded.
- Whether a project built *by ae-a8n itself* (not the AE-generated fixture)
  works; the fixture here was created by AE through plain JSX.
- macOS: the shared files were touched (`driver.ts`, `transport.ts`,
  `script-invocation.ts`, `api/index.ts`); the macOS tests pass on Windows
  against fakes, and the macOS real-host path was not re-run.

## Unit tests

`npm run check` on native Windows, on the branch merged with main (`e8ade6f`):
`tsc` and `eslint` clean, `vitest` 22 files, 379 passed, 1 skipped, 0 failed.
The Windows launcher, discovery, readiness gate and relative `sessionRoot` are
covered by `test/windows-host.test.ts`, `test/api.test.ts` and
`test/entry-script.test.ts`. The failures that #16 tracked are fixed on main.
The merge also needed one test fix: `operation-timeouts.test.ts` split an entry
path on `/`, which never matched on Windows, so its delays never applied.

## Repeating this

1. No AE running; no unsaved work. Start AE normally and wait for the main
   window; close any survey or error dialog by hand.
2. `node dist/...` discovery without `installDir`: expect your install, not a
   leftover.
3. Send a JSX that writes a file next to itself, with `AfterFX.exe -r <path>`
   (path as an argument array, not quoted by hand); judge by the file.
4. Do the same through `File > Scripts > Run Script File` to separate the
   engine from the delivery.
5. `AfterEffects.launch()` against it; read `info()`; `close()` must leave AE
   running.

Quit AE from its own UI. A forced kill (by PID, never by image name) is only a
recovery for a test AE blocked by a modal or a hang, after the evidence has been
saved; it is not a pass. After one, AE shows Crash Repair Options on the next
start: choose **Continue**, never Reset Preferences.

## macOS regression risk

The shared edits are `HostTransport.awaitScriptable` (optional; only the
script-invocation transport implements it, and it returns at once off Windows),
the driver's use of it, the removal of a Windows-only branch from `#run`, and
new constructor options. `macos-host.test.ts` passes unmodified on Windows (it
runs against fakes). The macOS real-host path was not re-run.

## Process ownership (#39)

`ownership()` on Windows is `owned` only on proof, by the macOS rule made stricter
(`windowsProcesses()` lists every `AfterFX.exe` with PID, creation time and image
path through CIM; no path filter, because any instance might receive a `-r`):

- nothing was running before `launch()`; otherwise `attached`, never quit;
- exactly one `AfterFX.exe` after the probe, created after launch began, whose
  image is this install's (case and slash insensitive; an unreadable path is not
  accepted), and whose PID is the one this transport spawned;
- re-checked in `ownership()` (so at `close()`): same PID **and** creation time
  (PID reuse), still the only instance; a list that cannot be read is `unknown`.

`close()` quits only an `owned` host, through `app.quit` (which refuses while the
project has unsaved changes unless `unsavedChanges: "discard"`), then waits for
that process to exit. Nothing in the library signals or terminates a process.

Real host (Windows 11, AE 26.5x89), by `own.mjs` against the dist build:

| Case | Result |
| --- | --- |
| no AE, cold launch | `owned` (pid shown in the evidence) |
| owned, unsaved edit, `close()` | refused (`UnsavedChangesError`), AE still running |
| owned, `close({unsavedChanges:"discard"})` | `quit: true`, 0 AE processes |
| AE already running, `launch()` | `attached` |
| attached, `close()` | `quit: false`, AE still running (same pid) |
| owned AE ended from outside mid-session | `unknown` ("pid ... is gone"), `close()` does not throw and quits nothing |

Fake process lists (`test/windows-ownership.test.ts`): two AEs at start, the only
AE not the one spawned, started before launch, other path, unreadable path, died
before the check, unreadable list, PID reuse (same pid, other start time), a
second instance appearing later, and a close that waits for exit or reports that
it did not. PID reuse and "two AEs at start" were not produced on the real host.

### P5 again, without the shim (on this branch)

Unmodified `@ido-bata/ae-test@0.1.0-alpha.0` from npm, with `@ido-bata/ae-a8n`
pointing at this branch's build (a directory junction in a temporary project; no
change to ae-test or its lockfile, no ownership override anywhere):

| Check | Result |
| --- | --- |
| ae-test starts a new Windows AE, ownership `owned` | yes (otherwise `HostNotOwnedError`) |
| apply `ADBE Gaussian Blur 2`, set `Blur` 0 → 100, render two PNGs | yes |
| snapshot compare | matched a baseline recorded in an earlier, separate AE session |
| a passing assertion and a typed `EntityNotFoundError` assertion | pass |
| a deliberately false `toBe` | fails with `expected 999, received 3`, as intended |
| AE processes after the run | 0, both runs (2 runs, 3 specs each, 3 cold starts each) |
| teardown after the failing test | `app.quit` quit AE; the next test started its own |

Not exercised: a launch that fails before a session exists (the readiness gate
timing out) under ae-test. The "persistent dialog" is #41.

### Hardening after review (still #40)

- **No pid, no ownership.** If the launcher reports no pid, a single `AfterFX.exe`
  is not tied to this session: `unknown`.
- **Fail-closed process list.** PowerShell returns one JSON document; Node
  validates every entry. A failed command, output that is not that document, a
  bad or repeated pid, a missing or invalid creation time or path field all
  throw, so nothing is claimed from the readable part. An empty list is a real
  answer ("none running"); an unreadable list is not (`parseWindowsProcessList`,
  tested case by case, plus a test against this machine's real PowerShell).
- **Exact creation times.** `Win32_Process.CreationDate` is a 100 ns kernel value;
  five reads of one process gave one value, so the old 1 s tolerance (needed for
  macOS `ps`, whole seconds) is 0 on Windows. A pid with a start time 500 ms off
  is `unknown`. (`Get-Process.StartTime` differs from CIM in the last digit; only
  CIM is used.)
- Regression tests that fail on the previous commit: no-pid and near-time pid
  reuse. The parser tests have no old counterpart: the old reader skipped lines it
  could not parse.
- Destination of `AfterFX.exe -r` vs ownership: measured and written up in #43
  (a `-r` launcher shows as a second `AfterFX.exe` for 0.3-0.7 s; a `-r` during
  startup starts a second full instance). Re-checking narrows the window, it does
  not guarantee the destination.

Re-verified on the real host with the hardened build: cold launch `owned`, unsaved
edit refused, `close(discard)` quits (0 AE); existing AE `attached` and the same
pid still alive after `close()`; owned AE ended from outside `unknown` with
`close()` quitting nothing. ae-test (unmodified npm package, **this branch's local
build**, not a published ae-a8n): 3 runs x 3 specs clean (snapshot recorded then
compared, typed error, deliberate failure, AE 0 after each run). Two other runs on
this build hit the persistent "second script" dialog at the first `project.open`
(#41); each was force-killed by PID after evidence was saved and is not counted
as a pass.
