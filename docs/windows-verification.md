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
| P2 launch, readiness, `app.info`, result file | **pass, attached to a running AE only** | real host | `launch()` + probe 0.92 s; `info()` = `{version:"26.5x89", build:"89"}`; `close()` left AE running. **Cold start through ae-a8n not run.** Session roots with a space, with Japanese, and with both reached the probe in ~0.4-0.5 s after #17. |
| P3 real `.aep`, comp/layer, write and read back | **pass on a clean AE** (blocked earlier, cause found: see "The modal") | real host | open → info → comps → comp → layers → layer → effect apply → parameter set/get, every call ~0.3-0.7 s, no modal. The earlier block was a global AE object left by *another* script, not ae-a8n. |
| P4 effect + PNG, pixels changed | **pass** | real host | Two 1920x1080 PNGs; Gaussian Blur 0 → 100 changed 453,574 pixels, identical in every run. |
| P5 ae-test real-host | **not run** | - | ae-test is not in this environment. |
| P6 fresh-session repeats, exceptions, cleanup | **10/10 pass (attach mode)** | real host | Ten sequential `launch → … → close` sessions against one AE, no modal. One unexplained modal in an earlier run (below). Cold start through ae-a8n still not run; `close()` never quits AE here. |

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

### A second modal, not explained

Once, in the run that followed two refused `openProject` calls (the previous
session's unsaved changes), AE showed a different dialog: "After Effects
warning: Attempt was made to ... another script was already running ...
launching AE with the -ro or -so flag" (the dialog was partly off-screen; the
middle of the sentence was not readable). The request in `inbox/` was not
answered. It did **not** reproduce: the same sequence a second time, and ten
sequential sessions, produced no modal. Evidence: `evidence-rep3` (kept in the
session scratch directory). Whether two `-r` launches overlapping a still-running
script can produce it is a hypothesis, not a finding.

### A relative `sessionRoot` or project path (found and fixed, #17)

`AfterEffects.launch({ sessionRoot: "rel/dir" })` made `-r` receive a relative
entry path. AE resolves it against its own working directory, ignores it
silently, and `launch` waits out its timeout (180 s) with no error. A relative
project path made `openProject` fail with "project file not found". Both are now
resolved to absolute paths in the API; regression tests are in
`test/api.test.ts`.

## Not verified

- A cold start of AE by `AfterEffects.launch()` (this run attached to an AE the
  supervisor had started); whether `-r` sent while AE is still starting up is
  delivered.
- `windowsHide` removal: no observable difference was recorded.
- Timeout continuation and serialisation on Windows: `-r` returns immediately,
  so the macOS "next call waits for the in-flight script" does not exist here.
- Process ownership: not implemented; `close()` never quits AE on Windows.
- ae-test, snapshot, behaviour with the CEP panels off and in Safe Mode.
- Whether a project built *by ae-a8n itself* (not the AE-generated fixture)
  works; the fixture here was created by AE through plain JSX.

## Unit tests

`npm run check` on native Windows: `tsc` and `eslint` clean; `vitest` 9 failures
that are not about this work, all in `publish-gate` / `docs-api` (see #16; three
are the CRLF checkout, six are a harness that cannot run on Windows). The
Windows launcher and discovery are covered by `test/windows-host.test.ts`
against a fake launcher, plus one test that asks Windows for a real short name.

On Windows, clone with `core.autocrlf=false` (or add an `.gitattributes`) or
three unrelated tests fail on line endings.

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

`ScriptInvocationTransport` still takes the same `darwin` branches; the only
shared edits are the removal of a Windows-only branch from `#run` and a new
constructor option. `macos-host.test.ts` passes unmodified on Windows (it runs
against fakes). The macOS real-host path was not re-run.
