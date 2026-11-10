# Windows dedicated host / VM requirements (Milestone 2)

This page states what a dedicated Windows host (physical or VM) must provide
before the isolated backend can be run against a real After Effects, and what
has actually been measured. The only evidence level above "documented
requirement, unverified" on this page is `verified on real host`, and it is used
only for facts observed read-only through `herdr` (machine `Windows`, pane
`w8:p1`)
on 2026-11-10. Nothing was launched, configured or changed on that host, and the
developer's own After Effects session was not touched.

The observed machine is **not** a dedicated host: it is a Windows 11 Home
Insider Preview desktop with the developer's own `AfterFX.exe` running in the
console session. No isolated-AE acceptance can pass there.

## What was observed

| Fact | Value | Level |
| --- | --- | --- |
| OS | `Microsoft Windows 11 Home Insider Preview`, version `10.0.29704`, build `29704`, EditionID `Core` | verified on real host |
| Hardware | Thirdwave `XL7C-R45`, 13th Gen Intel Core i7-13700H | verified on real host |
| GPU | Intel Iris Xe Graphics, driver `31.0.101.5186` | verified on real host |
| Hypervisor | `HypervisorPresent=True`, `VirtualizationFirmwareEnabled=False`, `VMMonitorModeExtensions=False`, `SecondLevelAddressTranslationExtensions=False` | verified on real host |
| Session | PowerShell in session `1`; console user `UUU\basic` | verified on real host |
| After Effects | `AfterFX.exe` pid `8028`, session `1`, `Responding=True` | verified on real host |
| Agent autostart | Startup folder empty; no scheduled task matching `*a8n*` | verified on real host |
| Remote access | `sshd` service `Stopped`; SMB shares `ADMIN$, C$, D$, IPC$, Users` | verified on real host |

Observed facts say what the host is. They do not say that any of the
requirements below are satisfied.

## 1. Virtualization support

- A VM host needs hardware virtualization exposed to the guest host: VT-x/AMD-V
  plus SLAT for a 64-bit Windows guest. **documented requirement, unverified**
- On the observed machine the firmware reports virtualization as disabled and
  no monitor-mode extensions or SLAT are exposed (`VMMonitorModeExtensions=False`,
  `SecondLevelAddressTranslationExtensions=False`). **verified on real host**
- Whether a usable VM can be created there, and whether nested virtualization
  would be required, was not tested. **documented requirement, unverified**

Consequence: do not assume the reachable Windows machine can host the dedicated
VM. Either enable virtualization in firmware and confirm it inside Windows, or
provide a separate physical host.

## 2. Windows edition and licence for a VM

- The isolated backend needs one interactive desktop session owned by a
  dedicated account, and a controller that can reach the channel (a share or
  SSH/SFTP). **documented requirement, unverified**
- Remote Desktop host, Hyper-V and domain join are edition features; a Home
  edition image is not suitable for a VM host that expects them.
  **documented requirement, unverified**
- The observed host is Windows 11 Home (`EditionID=Core`).
  **verified on real host**
- Licensing the guest Windows and keeping it activated is an owner decision and
  is not automated here. **documented requirement, unverified**

## 3. Adobe licence and per-user sign-in

- After Effects must be installed and licensed for the dedicated Windows user,
  and that user must be signed in to Adobe once in the desktop session.
  **documented requirement, unverified**
- Sign-in is never automated: the agent has no code that fills a credential
  field, and setup only reports `windows.signin` as `needs-human`.
  **documented requirement, unverified**
- After Effects 26.5x89 is installed on the observed host and its own session
  currently has `AfterFX.exe` running. That is the developer's session, not a
  dedicated-user licence. **verified on real host** (that this AE runs there)
- Whether the Adobe account may be used on a second machine, or how concurrent
  activations are counted, is a licensing question for the owner and was not
  measured. **documented requirement, unverified**

## 4. GPU requirements

- After Effects needs a supported GPU and current driver for GPU-accelerated
  effects and rendering; the exact requirement depends on the effect set.
  **documented requirement, unverified**
- The observed host uses integrated Intel Iris Xe Graphics with driver
  `31.0.101.5186`. **verified on real host**
- Whether that GPU is sufficient for the intended render workload, and what a
  VM would expose (GPU passthrough, software fallback), was not measured.
  **documented requirement, unverified**

## 5. Interactive GUI session

- The agent refuses to start in session 0 (`assertInteractiveIdentity`); it
  must run in the dedicated user's signed-in desktop session. This is covered
  by automated tests. **implemented / automated test**
- The observed PowerShell and `AfterFX.exe` are both in session `1`.
  **verified on real host**
- A session must remain signed in and unlocked for GUI After Effects work. What
  happens when the session locks or a screen saver starts was not tested.
  **documented requirement, unverified**

## 6. Agent starts at logon

- The agent must be running before a controller submits a job, in the dedicated
  user's interactive session. Setup checks for a configured logon entry
  (`windows.agent-autostart`) and otherwise asks a human to register one; it
  never registers it and never stores a password. **implemented / automated test**
- On the observed host the Startup folder is empty and no `*a8n*` scheduled task
  exists, so no agent would start at logon there today.
  **verified on real host**
- Registering the entry (Startup-folder shortcut or a logon task) and observing
  the agent actually start after a logon were not performed.
  **documented requirement, unverified**
- The agent is a resident background process, so the entry must use
  `ae-a8n agent --hidden …`. A plain `node.exe` started from a shortcut or a
  logon task creates a console window at process creation, and no option of
  the agent's own can remove it afterwards; `--hidden` starts a detached copy
  with `windowsHide` (CREATE_NO_WINDOW) and sends its stdout, stderr and exit
  state to one append-only log (`%LOCALAPPDATA%\ae-a8n\logs\agent.log` unless
  `--log` says otherwise). **implemented / automated test**
- The console window a plain start leaves on a real desktop, and the absence of
  one under `--hidden`, are **unverified on real host** (the agent's own start
  was not run on the Windows host in this increment).

## 7. How the controller reaches the channel

Two designs share one `FileChannel` interface:

- **Mounted share.** The controller mounts an SMB share and uses
  `DirectoryChannel`; the agent uses the same directory locally.
  **documented requirement, unverified**
- **SSH/SFTP.** The controller writes and reads the same paths over SFTP. No
  SFTP implementation of `FileChannel` exists in the repository yet; the
  interface is the whole contract. **documented requirement, unverified**
- Both sides need read/write access to the same root (`windows.channel`,
  `windows.channel-permissions`). A single account's write probe cannot prove
  the other account's access, so setup reports that step as `needs-human`.
  **implemented / automated test**
- The observed host exposes the default SMB shares and has `sshd` stopped.
  Reachability from a controller, firewall rules and share-level permissions
  were not tested. **documented requirement, unverified**

## 8. Recovery when the session disconnects

- T089 reports observable blocking states from `tasklist /V` and never presses,
  sends a key or kills a process. An unreadable state, `Not Responding` or an
  unknown window state is quarantined with `A8N-SEC-001` and a remedy.
  **implemented / automated test**
- There is no GUI automation on Windows, so a licence, sign-in or crash-repair
  dialog is a human's job. **implemented / automated test**
- If the session disconnects or the desktop locks, the agent loop may stop or
  the GUI may be unavailable. Recovering the session (re-login, restart the
  agent, re-run) was not exercised. **documented requirement, unverified**
- A timed-out job is never re-sent and is reported as unknown; its destination
  marker is unproven unless the agent wrote one. **implemented / automated test**

## What remains unverified on this page

- creating a Windows VM with virtualization enabled;
- licensing and activating a guest Windows and After Effects for a dedicated
  user;
- a dedicated user's Adobe sign-in in an interactive session;
- whether the observed GPU is adequate for the target effect/render workload;
- a locked/unlocked long-running desktop session;
- the agent starting at logon after registration;
- the controller reaching the channel over a mounted share or SFTP;
- recovery after a session disconnect;
- the whole isolated path against a real After Effects.

The end-to-end path is currently exercised only against the in-repo fake host
(`test/windows-e2e.test.ts`), which is `automated test` + `fake/mock only`.

## 9. What each isolation mode has to prove (audit, 2026-11-10)

`A8N-SESSION-003` ("target session is the console session") was written for
`isolation: "session"`: two accounts on **one** PC, where the test account
must not be the person at the console, because the whole claim is that a test
AE does not disturb the person using the machine.

`isolation: "remote-host"` makes a different claim — the test runs on a
**different computer** — and that claim is not proven by the same fact. The
audit question was whether the console-session check should still apply. It
should not, and it does not (`probe.ts` gates it on
`isolation === "session"`). But the check was also the *only* isolation gate,
so a `remote-host` target previously passed on the strength of a flag: on
2026-11-10 `doctor --host ...` was asked for `isolation: "remote-host"`, where
`A8N-SESSION-003` does not fire, on a host that was the developer's own
desktop.

The condition that replaces it for `remote-host` is three facts, each of which
the software now measures instead of assuming:

| Fact | How it is proven | Code |
| --- | --- | --- |
| **Host identity** | The agent's signed heartbeat names its host, user, session and version; the controller compares all four with the target. | `A8N-JOB-006` |
| **The host is not the controller** | The same host name as this controller means the test would run on the machine the person is using; "by construction" would be false. | `A8N-SESSION-006` |
| **Exclusive/dedicated use, as far as it can be measured** | The agent is alive in an interactive session (`sessionId > 0`), its heartbeat is fresh, and the channel is readable and writable from the controller. A stale heartbeat or session 0 is refused. | `A8N-JOB-005`, `A8N-JOB-007` |
| **Execution target and permissions** | Every job is signed with the shared channel key and carries a run id; the destination is proven by the agent's per-run marker before any close path may quit. The key's ACL on the host is not measurable from the controller and stays a human step. | `A8N-JOB-003`, `A8N-AE-002` |

What this does **not** prove, and must not be reported as proven:

- that no other person is logged into that host's session at the same time
  (a fresh signed heartbeat says the agent is in an interactive session, not
  that nobody else shares it);
- that the host is dedicated to testing rather than the owner's daily machine
  opened remotely — the host name differs from the controller's, which is all
  this check can see;
- the key file's ACL on the host, which remains `windows.channel-permissions`
  (`needs-human`).

`A8N-SESSION-003` is therefore **kept unchanged** for `session`, and
`remote-host` is refused on the four measured facts above rather than on the
console-session comparison. All of it is `automated test` against the in-repo
fake host (`test/windows-remote-comms.test.ts`); none of it is
`verified on real host` yet.
