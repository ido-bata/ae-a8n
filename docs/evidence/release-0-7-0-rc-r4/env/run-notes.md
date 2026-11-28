# Run-4 environment notes (attempt-4, candidate fc6f6e3)

## Pre-run environment repairs (before first attempt)

1. **`Pref_SCRIPTING_FILE_NETWORK_SECURITY` restored to `"1"`** in
   `~/Library/Preferences/Adobe/After Effects/27.0/Adobe After Effects 27.0 環境設定.txt`.
   Found `= "0"` at 23:2x JST (backup at /tmp/rc436r4/環境設定.txt.bak, not committed —
   contains unrelated user prefs). With "0" the bridge cannot stage script files and
   `session.launch` fails fast with a named reason (first smoke attempt r4-s1-00-smoke
   recorded this honestly as `fail` before the repair). AE 2026's pref file has "1";
   runs 1-3 all ran with scripting access enabled, so "0" was a post-run-3 env drift,
   not the candidate's doing. No AE 2027 process was running at edit time.

## BirthPrefs modal recurrence (run-4)

- r4-s1-00-smoke (pid 8007): launch+handshake+project+renderFrame all succeeded
  (~6 min total); `session.close` hit a quit-blocking window set
  ("名称未設定プロジェクト", "警告") → HostQuitTimeoutError → teardown `residue`
  (honest). Supervision detected `blocked` (1 blocking window). Recovered via
  public `AfterEffects.terminate` (permit terminate-owned-host, force) — ledgered
  as RC-S17 pass. **This forced terminate is the suspected re-arm event.**
- r3-s1-01 (pid 55498) and r4-s1-02 (pid 82201): BirthPrefs modal recurrence —
  `sample` stacks identical to run-3 (`CEggApp::BirthPrefs → UI_MessageBox::RunModal`
  with nested `U.dylib Up_ReportErrorDialog` crash-report dialog). Readiness
  timeout at extendscript-response phase; terminated via public path; each
  recovery ledgered RC-S17 pass. Samples: `../sessions`-adjacent
  `/tmp/rc436r4-sessions/recover-samples/pid-*.txt` (copied into evidence at archive time).
- Pattern matches run-3: modal is armed by unclean/crashed shutdown and cleared
  only by a clean quit or human dismiss. Whether the streak can produce
  consecutive clean launch+close cycles is the open question of this run.

## Second environment repair (mid-run, ~23:50 JST)

3. **`Show Welcome Screen` set `01 → 00`** in the same 環境設定.txt
   (`[General Section]`). `CEggApp::BirthPrefs` is the birth/welcome-prefs
   path; the welcome screen is the only user-visible "birth" surface in the
   prefs file and is the leading hypothesis for the recurring modal
   (run-3 proved CrashOccurred/ForceQuitOccured and Skip Crash Recovery
   Prompt are NOT the trigger). Backup: /tmp/rc436r4/環境設定.txt.bak2.
   Reversible; documented here and in the manifest environmentNotes.
   Effect observed (or not) is reported per-attempt in the ledger —
   this is environment preparation, not scenario evidence.
