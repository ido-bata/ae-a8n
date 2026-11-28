# BirthPrefs modal investigation — run 3 (attempt-3)

Date: 2026-11-28 ~21:00–22:00 JST. Status: **unresolved, same known blocker as run-1/run-2; requires human dismiss or OS/AE state reset.**

## Symptom

Every AE 2027 launch after r3-s1-26 fails `launch+handshake-readiness` (~145–215s): process spawns, main thread parks inside
`CEggApp::BirthPrefs → dvaui::dialogs::messagebox::Messagebox → UI_MessageBox::RunModal`.
Sample stacks: `birthprefs-modal-stack-s1-35-pid27829.txt`, `birthprefs-modal-stack-s1-36-pid18366.txt`
(identical shape to run-2's `../release-0-7-0-rc-r2/env/birthprefs-modal-stack-r2.txt`).

## New mechanism detail (vs run-2)

The modal loop *nests a second dialog*: inside the BirthPrefs `UI_MessageBox::RunModal` event loop, our
script-invocation transport's `AEDoScriptFile` AppleEvent (`osascript … «event miscfile» …entry.jsx`)
is dispatched, the .jsx errors because ExtendScript is not yet initialized, and
`U.dylib Up_ReportErrorDialog` opens a nested ExtendScript error-report `UI_MessageBox`.
So each blocked launch produces **two** stacked modal dialogs; both are AX-invisible
(`CGWindowList` shows the dialog window `onScreen:false`/layer-0, System Events reports 0 windows).

The foreign user-launched AE 2026 instance (pid 95337, launched 21:09 JST by the user) shows the
same `DVAMacDialog` modal (AppKit log: `begin modal window 2851`), so the blocker is **not**
harness-specific — it is host/AE state.

## Environment interventions tried (all reverted where applicable)

1. **`CrashOccurred` / `ForceQuitOccured` plist flags** — `defaults read "com.Adobe.After Effects.27.0"`
   showed `CrashOccurred=1`, `ForceQuitOccured=1` (set by our sanctioned `AfterEffects.terminate({force:true})`
   recoveries; AE 26.5 domain had `ForceQuitOccured=1` too). Deleted via `defaults delete` for
   `com.Adobe.After Effects.27.0` and `com.Adobe.After Effects.26.5`. Flags stayed cleared
   (verified post-launch), **dialog still appeared** → not the (sole) trigger.
2. **`Skip Crash Recovery Prompt`** — set `"Skip Crash Recovery Prompt" = 01` in
   `~/Library/Preferences/Adobe/After Effects/27.0/Adobe After Effects 27.0 環境設定-indep-general.txt`
   (`[Auto Save]` section). s1-36 still blocked → dialog is not gated by this pref.
   **Reverted to `00`** after the test.
3. OCR of the dialog window (`screencapture -l<winid>` + Vision `VNRecognizeTextRequest`) —
   inconclusive; the Vision request hangs at 0% CPU in this session (tried 3×, killed).
   Window is offscreen/blank to WindowServer anyway.

## Recovery evidence collected meanwhile

`recover-leftover.mjs` ran after every blocked attempt and **passed 10+ consecutive times**
(`method:"forced"` via sanctioned `AfterEffects.terminate`, censusAfter clean of owned pids):
recover-r3-s1-30 … recover-r3-s1-36 all `pass` in `../scenario-ledger.jsonl` (RC-S17).
Sample stacks saved under `/tmp/rc436r3-sessions/recover-samples/` and `env/` here.

## Conclusion

Identical to run-1/run-2: an AE 2027 startup modal (visible in WindowServer census but
`onScreen:false`, AX-invisible, undismissable without human input) blocks `BirthPrefs`.
Launch-dependent scenarios cannot run until a human dismisses the dialog(s) on screen or the
host state is reset (AE restart / OS restart cleared it before run-2). Not an ae-a8n defect:
readiness correctly fails closed and reports `the host process is present but never answered`.
