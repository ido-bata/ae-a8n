# G0 startup-folder probe — macOS, 2026-11-16

Issue #99 gate G0: does After Effects run a per-user `Scripts/Startup`
entry without administrator privileges? Probe: `scripts/startup-probe.mjs`,
which installs one marker `.jsx` into the user Scripts/Startup folder for
the targeted AE version, launches AE through the public `AfterEffects`
API, waits for the marker, then removes the script and closes AE.

Verification level: **verified on real host** for the facts below; the
probe's own `startupExecuted` field stayed `null` because AE never reached
the readiness probe on either version — the evidence is the on-disk and
on-screen observation recorded here, not a green probe run.

## Machine

- macOS, user `rebuildup` (uid 501, console Aqua session)
- Adobe After Effects 2026 = 26.5.3, Adobe After Effects 2027 = 27.0.0,
  both under `/Applications`

## AE 2026 (26.5.3) — partial pass, permission gate found

- User Scripts/Startup path used:
  `~/Library/Preferences/Adobe/After Effects/26.5/Scripts/Startup`
  (no admin; the folder already exists, created by AE).
- The Startup script **ran**: `startup-marker.txt` was created in the
  work dir at launch time (15:09 JST). File contents stayed empty because
  `Pref_SCRIPTING_FILE_NETWORK_SECURITY = "0"` in
  `~/Library/Preferences/Adobe/After Effects/26.5/Adobe After Effects 26.5 環境設定.txt`
  — "Allow Scripts To Write Files And Access Network" is OFF, so the
  script's `File.write` produced nothing (the `open("w")` still created
  the file).
- Consequence: with scripting file/network access off, the whole
  file-envelope transport cannot answer `app.info`; the readiness probe
  timed out at ~180 s and the session correctly refused ownership
  (`unknown`) and left AE running.
- Quit path: `tell application … to quit` returned -128 (cancelled); the
  process did not exit on SIGTERM. It was terminated with SIGKILL after
  launch provenance confirmed this session started it (pid 82767). No
  project was open.

## AE 2027 (27.0.0) — blocked: scripting component absent

- User Scripts/Startup path used:
  `~/Library/Preferences/Adobe/After Effects/27.0/Scripts/Startup`.
- No marker file was created; `DoScript`, `DoScriptFile` (including an
  `alert()`-only script) produced no observable effect, and `app.info`
  timed out at ~180 s.
- WindowServer census showed two small AE-owned windows; the operator
  reported two dialogs: **crash-repair options** and
  **"スクリプトファイルは実行できません。スクリプト機能のプラグインは
  インストールされていません"** (script files cannot be executed — the
  scripting plug-in is not installed).
- Interpretation: AE 2027 on this machine lacks the ExtendScript
  component, so no script — Startup folder or otherwise — can run. This
  is a hard prerequisite failure, distinct from the file-permission gate
  on 26.5. The dialogs were dismissed by the operator; the probe-launched
  instance (pid 7356) was terminated.

## What G0 has established so far (macOS only)

1. Per-user `Scripts/Startup` under
   `~/Library/Preferences/Adobe/After Effects/<ver>/` is real, requires no
   admin, and AE executes entries from it — proven on 26.5 by the marker
   file creation.
2. Two independent human gates exist before an in-AE dispatcher can work:
   - the AE scripting component must be installed (missing entirely on
     this machine's 27.0 install);
   - "Allow Scripts To Write Files And Access Network" must be enabled
     per AE version (off on 26.5, on for 27.0's prefs but moot without
     the scripting component).
3. Both gates are per-AE-version preferences, not per-machine or per-user
   OS settings — install/uninstall/disable stories must cover them.

## Still open for G0

- Windows per-user `Scripts/Startup` equivalent
  (`%APPDATA%\Adobe\After Effects\<ver>\Scripts\Startup`) — untested.
- Clean restart behaviour, disable/uninstall path, enterprise-policy
  denial, and behaviour when the scripting component is absent — needs a
  deliberate run on a machine where it is installed.
- Whether enabling the file/network pref prompts the user once or is a
  silent checkbox — not yet observed (the pref was already off; flipping
  it is a human consent action and was not done by the agent).
