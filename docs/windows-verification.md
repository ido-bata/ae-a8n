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
| P3 real `.aep`, comp/layer, write and read back | **blocked** | - | `openProject` returned in 0.8 s; the next call never answered because AE raised repeated modal errors (below). |
| P4 effect + PNG, pixels changed | not run | - | Depends on P3. |
| P5 ae-test real-host | not run | - | Depends on P3/P4. |
| P6 fresh-session repeats, exceptions, cleanup | not run | - | |

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

## P3: blocked, cause not established

After `openProject(<disposable copy of the fixture>)` (which succeeded), the
next call (`project.info`) timed out at 120 s. AE showed two stacked modal
dialogs, "Unable to execute script at line 0. Object is invalid". Dismissing
one with its OK button, ten times in a row, made a new one appear each time
and never reached zero; with no clicking the set stays constant. Real-host
work was stopped there, as agreed, and the AE process was left for a person to
close.

What this does and does not show:

- The error is not raised by an ae-a8n script: the host script keeps no
  reference to `app.project`, schedules no task, and the entry script catches
  and reports every exception from the host as a result.
- It is consistent with a script that AE runs periodically from outside
  ae-a8n (a CEP panel polling `app.project` after the project object was
  replaced). **No extension was identified**; the Discord presence panel's
  host script wraps its reads in try/catch, so it is not an obvious source.
- It did not occur in P2 (no project opened) and was seen once, so it is not
  known to be reproducible. Whether it also happens with the third-party
  panels disabled is **untested**.
- The dialog regenerating after each OK means it cannot be recovered by
  automation; ae-a8n's only symptom is a plain timeout. A readiness/timeout
  message that mentions "a modal dialog may be open" is a candidate follow-up.

## Not verified

- A cold start of AE by `AfterEffects.launch()` (this run attached to an AE the
  supervisor had started); whether `-r` sent while AE is still starting up is
  delivered.
- `windowsHide` removal: no observable difference was recorded.
- Timeout continuation and serialisation on Windows: `-r` returns immediately,
  so the macOS "next call waits for the in-flight script" does not exist here.
- Process ownership: not implemented; `close()` never quits AE on Windows.
- P3-P6, ae-test, snapshot, repeat runs, behaviour with the CEP panels off.

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

Do not use `taskkill /F`; quit AE from its own UI.

## macOS regression risk

`ScriptInvocationTransport` still takes the same `darwin` branches; the only
shared edits are the removal of a Windows-only branch from `#run` and a new
constructor option. `macos-host.test.ts` passes unmodified on Windows (it runs
against fakes). The macOS real-host path was not re-run.
