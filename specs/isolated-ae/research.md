# Research: isolating After Effects from the user at the console

- T002 (Issue #54)
- Revision: 2026-11-10
- This document separates **measured on a real host**, **established OS
  behaviour**, and **to measure**. It deliberately does not present the third
  category as the first.

## 1. What has already been measured on macOS

Source: Draft PR #50 (`docs/offstage-macos.md`, §10.14–10.15), commits
`59ef4e2`, `a11b969`, `414460a`, re-measured once on `a11b969`.

| Claim | Level | Where |
| --- | --- | --- |
| A second OS user's Aqua session can be created and kept alive without the console user logging out | `verified on real host` | PR #50 |
| A script delivered with `osascript DoScriptFile` inside that session reaches that user's AE, not the console user's | `verified on real host` | PR #50 |
| The console owner stays uid 501 while the test session runs as uid 502 / asid 109086 | `verified on real host` | PR #50 |
| The frontmost application did not change during three measured runs; no programmatically posted key events were observed | `verified on real host` | PR #50 |
| Cursor position moved in 2 of 3 runs; attribution is not possible | `verified on real host` (limitation recorded) | PR #50 |
| A real AE modal can be dismissed with Accessibility inside the target session | `verified on real host` | PR #50 |
| The coordinate-click fallback was never used | `fake/mock only` | PR #50 |
| Windows regression and ae-test compatibility | **UNVERIFIED** | PR #50 |

The implementation depends on `offstage` (`@exla/offstage` 0.4.1 at the time of
the audit; the originally named `@viraatdas/offstage` was unpublished and is
404). The audit found no postinstall hooks, a session daemon bound per uid, and
`getpeereid` peer checks. `offstage session setup` writes TCC.db **only when
SIP filesystem protection is already off**; PR #50 does not depend on that path.
SIP must remain on. These are properties of a third-party tool, not of this
repository, and must be re-audited before a release pins a version.

## 2. macOS: why the design is a second user session

The console session's own AE cannot be used: it is the user's, and driving it
would both touch their work and put GUI automation in front of them. A second
GUI session for a dedicated user is the only same-machine arrangement observed
to keep the console user's screen and input untouched. The cost is manual
onboarding: an admin creates the account, a human logs it in once with fast
user switching, grants Screen Recording / Accessibility / Automation inside
that session, and signs AE in once. Those are consent operations and are not
automated by this project.

## 3. Windows: candidates

No Windows backend exists today. The public API is verified on a real Windows
host only in attached/owned mode (`docs/windows-verification.md`).

The requirement (FR-02) is: a person using the Windows PC continues working
while an isolated AE test runs, with no focus change and no synthetic input
reaching their desktop.

### A. Dedicated Windows host or VM with an in-session agent — **selected**

Shape:

```text
controller (any OS, Node)                    dedicated Windows 11 host / VM
  ├── job + fixtures ─── shared folder / SFTP ──►  session agent (logged-in user)
  └── result + artifacts ◄── shared folder ──────  AE launched in that session
```

The agent runs inside the dedicated user's interactive session (started at
logon), exactly as the macOS session agent does. The controller never sends GUI
input; it writes a job and reads results. Remote transport is only the file
channel (SSH/SFTP or a mounted share); it does not launch AE directly, because
a process started from the Windows SSH service runs in a non-interactive
session and cannot show a GUI.

Why selected:

- Non-interference is true by construction: the user is on a different machine
  (or a VM's host), so their session is untouched.
- It fits the exact architecture already proven on macOS: session agent, job
  and result files, ownership evidence, quarantine.
- The Windows host can be reset, snapshotted, and dedicated to a test Adobe
  account without touching the developer's daily machine.
- The spec explicitly permits this when in-machine non-interference cannot be
  proven (epic #53 / FR-02).

Costs and open points:

- A second Windows machine or VM is required, and Node must be installed there.
- Adobe licensing: a second device may consume a seat. **Owner decision.**
- The controller's transport (SSH vs. mounted share) is a deployment choice;
  the agent protocol is the same.

### B. A second interactive user session on the same Windows PC — **rejected**

On Windows client SKUs, the console session is the only interactive session.
Creating a second interactive session requires Remote Desktop, which takes the
console session away from the person at the keyboard; fast user switching hides
the console session behind the sign-in screen. Either way the user cannot keep
working, which is the requirement. `runas` / `CreateProcessWithLogonW` alone
does not create a separate interactive desktop: the new process inherits the
caller's window station and desktop.

Status: `established OS behaviour` for the mechanics; rejected on requirement
grounds, not on a failed experiment.

### C. A separate desktop or window station in the same session — **not selected**

`CreateDesktop` creates another desktop on the same window station. Windows on
that desktop have their own GUI namespace, but:

- input injection (`SendInput`) is routed to the **active** desktop, so either
  the automation switches desktops (taking the screen) or its injected input
  does not reach its target;
- direct window messages (`PostMessage`/`SendMessage`) can reach a window on a
  non-active desktop, but applications that validate foreground/input state,
  and some UIA providers, do not behave normally there;
- screen capture of a non-active desktop is not reliable under desktop
  composition;
- the clipboard is shared across desktops on the same window station.

For AE specifically, the script channel is file-based, so a hidden desktop
might carry the non-GUI part. The GUI part (modal recovery) is exactly the part
whose reliability is doubtful on a hidden desktop. This remains a research
candidate only if someone measures it on a real AE; it is **not** a supported
backend and must not be described as one.

Status of the mechanics: `established OS behaviour` (API-level); AE behaviour
on a hidden desktop: **not measured**.

### D. Session 0 / a service — **rejected**

Since Windows Vista, services run in session 0, which is non-interactive.
GUI windows created there are not visible, and a modal call can hang the
service. There is no supported path to drive an interactive GUI application
from a service without a user-session agent.

Status: `established OS behaviour`.

## 4. Decision

`specs/isolated-ae/plan.md` implements **A** as the Windows backend:
`RemoteWindowsAdapter` + the same session-agent protocol as macOS.

Explicitly not claimed:

- that a Windows test can run on the *same* PC as the developer without a VM;
- that hidden-desktop isolation works with AE;
- any Windows result as `verified on real host` until measured on Windows 11
  with AE 2026 and recorded in `docs/windows-verification.md`.

## 5. Windows-specific technical risks to settle by measurement

| Risk | Why it matters | How it is settled |
| --- | --- | --- |
| A process started over SSH/WinRM cannot show a GUI | The controller must not launch AE itself | Launch through the in-session agent; assert the AE window exists in that session |
| `AfterFX.exe -r` has no target pid | A script can reach the wrong instance | Session marker already implemented (`#43`, `#44`); repeat the proof on the isolated backend |
| "Second script" dialog can persist (#41) | Blocks calls; cause unknown | Capture evidence per #41, never auto-dismiss |
| Modal/consent dialogs (sign-in, licence, crash repair) | Must never be auto-approved | Recovery policy from `src/driver/recovery.ts` reused; report only |
| Windows quit semantics | `close()` must quit only the owned AE | Ownership by pid + 100 ns creation time (already on main, #39) |
| Path whitespace in `-r` | Silent non-delivery | 8.3 short name or explicit `UnsupportedScriptPathError` (#17) |
| Node on the Windows host | Setup must not hard-code a path | `doctor` reports it; `setup` proposes an install but never stores a machine-specific absolute path in the package |

## 6. Adobe licensing and consent boundary

- The run does not collect, transmit or store Adobe credentials.
- Sign-in and licence dialogs are human actions; the recovery policy reports
  them and refuses to press anything (`src/driver/recovery.ts`).
- Concurrent use: the runner refuses to start a test AE when any AE is already
  running on the target machine. On the dedicated-host backend this is the
  target host's AE processes, not the developer's.
- Whether a dedicated host consumes an additional device activation is an owner
  decision before release; it is recorded in the release gate, not guessed.

## 7. What this revision could not verify

- No live web documentation was reachable from the working environment in this
  revision (the search tool returned no results). The OS statements in §3 are
  therefore labelled `established OS behaviour` and are not cited to a URL.
  Before a release, each is re-checked against Microsoft documentation and the
  check is recorded with a date.
- No Windows hardware was reachable. Nothing in this document is a Windows
  real-host result.
