# Permission contract

- T020 (Issue #57)
- Scope: the macOS isolated-session setup path. Windows has no TCC
  equivalent; its permission surface is the interactive desktop session
  and is covered by `docs/windows-verification.md` instead. Command and
  diagnostic-code shape is shared — see `contracts/cli.md`.

This contract defines which permissions the isolated backend needs, who
grants them, how each is verified, and what a denial means. It is the
reference `doctor`, `setup`, `test` and `recover` diagnostics
(`A8N-PERM-*`, `A8N-SESSION-*`) are written against.

## 1. Permission matrix

| Permission | Granted by | Non-destructive probe | Denial signature | Diagnostic |
| --- | --- | --- | --- | --- |
| Screen Recording | target user, System Settings → Privacy & Security | window census / screenshot-capability probe in the target session | window titles and images unavailable | `A8N-PERM-001` |
| Accessibility | target user, System Settings → Privacy & Security | AX read of a known on-screen element in the target session | AX queries fail or return nothing | `A8N-PERM-002` |
| Automation → System Events | target user, per responsible process (see §2) | `osascript -e 'tell application "System Events" to count processes'` run as a child of the responsible process; a numeric answer is the pass | `-1743` with no prompt | permission check in the grant loop; see §4 |
| AE script access (script-folder trust) | target user, in After Effects → Settings → Scripting & Expressions | a `DoScriptFile` probe of a file inside the allowed folder | `-1708` plus an AE modal | `A8N-PERM-008` (unproven) / `A8N-PERM-003` (off) |
| AE file/network permission | target user, in After Effects preferences | the same script probe; file/network dialogs are never answered by the tool | AE modal or refused file access | `A8N-PERM-003` |
| Adobe sign-in | target user, in After Effects | AE reaches an interactive project state without a sign-in modal | sign-in / licence modal | `A8N-PERM-004` |

A probe that cannot run is `unknown`, never `PASS`. An API call succeeding
is not proof a permission was granted — only the probe for that permission,
run in the intended user and ASID, counts.

## 2. Responsible-process rule

macOS attributes TCC grants to the *responsible process* — the innermost
app bundle. `offstage-sessiond` is a bundle-less binary: Apple Events sent
from it are refused immediately with `-1743` and **no prompt is ever
shown**, so no human can grant it anything. The measured comparison is in
`docs/offstage-macos.md` §10.2–10.3.

Therefore the grant/request/check loop (T021) runs as a child of
**Terminal.app inside the target user's graphical session**: grants then
appear in System Settings, inherit to the test process, and prompts show
on a desktop a human can reach. Nothing in this contract assumes the
daemon itself receives TCC authorization.

## 3. Prompt routing

- Every OS or AE consent dialog appears on the **target user's GUI
  desktop**, not the controller's and not necessarily the current one.
- The operator switches users with macOS fast user switching — no logout —
  answers the dialog there, then returns to the normal terminal to
  resume or re-run the check.
- The tool prints which desktop/session a pending prompt is expected on
  before it waits (T022).
- The tool **never** presses a security, licence or sign-in dialog, never
  stores Adobe credentials, never resets arbitrary TCC grants, and never
  modifies SIP or `TCC.db` directly (T023). `tccutil reset` for a single
  named service and app is a documented manual step for the operator, not
  something the tool runs on its own.

## 4. Denial-mode map

Distinct observed failures map to distinct next actions; they must not
collapse into one "permission denied" (T024):

| Observation | Meaning | Next action |
| --- | --- | --- |
| `-1708` from `DoScriptFile` | AE script trust / script-folder approval pending; AE shows a modal | human approves the script folder in AE settings on the target desktop; re-run the probe |
| `-1743` Apple Event error | TCC/Automation consent missing, **or** the sender has no responsible-process bundle | verify the sender is a Terminal.app child in the target session; grant Automation on the target desktop; if it persists with no prompt, the earlier denial is remembered — reset that one service/app and re-prompt |
| `-1712` Apple Event timeout | the event reached AE but AE is not answering — a modal, welcome or sign-in screen is up | human dismisses the blocking dialog on the target desktop; the tool never answers it; re-probe |
| missing system permission | the matching `A8N-PERM-00x` probe failed in the target session | grant in System Settings on the target desktop; re-run doctor |
| pending AE script-folder approval | `-1708` with the approval UI not yet answered | same as `-1708` |
| target user not logged in | no GUI session for the target ASID | log the target user in (fast user switching is enough); `A8N-SESSION-002` |

`-1712` is deliberately *not* retried as a permission problem: it means
delivery worked and the host is blocked, which is a different remedy.

## 5. Verification rule

Every row of §1 is verified by its own probe in the intended user and
ASID before `setup`/`test` proceeds (T025). A check that cannot complete
reports `unknown` or `blocker` — never `PASS`. Real-host acceptance of
this loop (T026) is recorded separately from fake-host tests; fake
coverage of the denial/retry paths does not close the real-host gate.

Probe implementations today:

- packaged `doctor` local intent: `src/platform/darwin/tcc.ts` runs the
  Screen Recording / Accessibility preflight APIs for the caller's own
  responsible process; the isolated intent reports `unproven` until an
  in-session job exists.
- repo-level isolated runner: `scripts/isolated-session/permission-probe.mjs`
  runs the same preflight APIs plus the Automation and AE-preference
  probes inside the target session, reached through
  `run-in-isolated-session.mjs` (terminal/offstage/native substrates).
