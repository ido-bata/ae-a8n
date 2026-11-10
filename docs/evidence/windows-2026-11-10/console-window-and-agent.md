# Console windows and the hidden agent — 2026-11-10 (T088 evidence)

Every row below was measured on the real host described in
[`README.md`](./README.md), through `herdr` over the network. Nothing here
used After Effects: no AE process was started, no account was created, no
job was registered and no key file was made permanent beyond the two
throwaway directories named in §3.

**Source:** `integration/win-cli @ e446aec`
(`fix(cli): stop reading the agent's values as options`).
**Tarball:** `ido-bata-ae-a8n-0.1.0-alpha.1.tgz`,
sha256 `6922e5dac525b11e0a414c13479bd6ce89fae79abfe68d0fbfe7279a9de09a4a`,
packed from that commit and installed into an empty `%TEMP%` project with
`npm install <tarball>`.

## 1. The agent starts without a console window (`verified on real host`)

The question was not whether `windowsHide` is set in the source (`automated
test`, `test/agent-detach.test.ts`) but whether a real Windows creates a
console — measured by the child processes a console allocation leaves behind
(`conhost.exe` under the started process).

| # | Start | Command | Result |
| --- | --- | --- | --- |
| 1 | Plain, the way a logon task runs it | `Start-Process node cli.js agent --channel … --key-file … --host UUU --user basic --session-id 1` | process alive, **1 `conhost.exe` child** — a console was created |
| 2 | Hidden | `node cli.js agent --hidden --channel … --key-file … --host UUU --user basic --session-id 1` | `started in the background (pid 44552)`, process alive, **0 `conhost.exe` children** |

Row 1 is the control: it proves the measurement can see a console when one
exists, so row 2's zero is an absence and not a blind spot.

The agent's own failure still reaches a person (`verified on real host`):

| # | Step | Result |
| --- | --- | --- |
| 3 | `node cli.js agent --hidden … --key-file <missing>` | launcher exit 0, `started in the background (pid 46348); output: C:\Users\rebui\AppData\Local\ae-a8n\logs\agent.log` |
| 4 | the log 3 s later | 144 bytes: `windows-agent: the key file …\missing.key could not be read (ENOENT); nothing was polled` |
| 5 | the child | exited before the 3 s check — the failure was not swallowed and the launcher did not claim the agent was healthy |

What this does **not** say: that a person saw no window. The absence of a
console process is the mechanism by which no window can exist; the desktop
itself was not observed.

## 2. Why the windows appeared at all (`verified on real host`)

`HKCU\Console\%%Startup` decides which program renders every console a
process creates. On this host both values were the system default
(`{00000000-…}`), which delegates to **Windows Terminal**. A console created
with a hidden show flag is handed to `OpenConsole.exe -Embedding`, and the
Windows Terminal window it draws is visible — that is the window that
appeared and disappeared with each remote command.

Controlled A/B, same command both times
(`Start-Process node -e setTimeout(…,6000) -WindowStyle Hidden`):

| Delegation | `conhost.exe` child | terminal handoff |
| --- | --- | --- |
| `{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}` (Console Host) | 1 | **0** |
| `{00000000-0000-0000-0000-000000000000}` (system default → Windows Terminal) | 1 | **1** (`OpenConsole.exe`, pid 23292) |

The value is now Console Host on this host and the A/B ended with it
restored. **This is a change to the account's default terminal application,
not to this repository**, and it is wider than ae-a8n: every console app in
this profile now renders through Console Host. Reverting is one command:

```
Set-ItemProperty 'HKCU:\Console\%%Startup' -Name DelegationConsole  -Value '{00000000-0000-0000-0000-000000000000}'
Set-ItemProperty 'HKCU:\Console\%%Startup' -Name DelegationTerminal -Value '{00000000-0000-0000-0000-000000000000}'
```

## 3. Scheduled tasks (`verified on real host`)

| Task | Action before | Last result before | Action now | Result |
| --- | --- | --- | --- | --- |
| `HerdrServer` (logon, every 5 min) | `cmd.exe /c …\herdr-server-task.cmd` | 0 | `wscript.exe //B //Nologo …\herdr-server-task-hidden.vbs` | 0; log `…\.herdr\runtime\herdr-server-task.log` records `error: herdr server is already running` and the socket path; 5 `herdr` processes still running |
| `pc-setup-converge` (logon, hourly) | `powershell.exe -WindowStyle Hidden -File C:\Users\rebui\src\pc-setup-163\platforms\windows-11\converge.ps1` | `0xFFFD0000` | unchanged | **broken**: the script does not exist |
| `SecurityPathGuard-Every5Min` (every 5 min) | `wscript.exe //B //Nologo C:\Users\rebui\Security\start_watchdog.vbs` | 1 | unchanged | **broken**: the script does not exist |

`HerdrServer` was the only task here that worked and still made a window:
Task Scheduler gives a console program a visible console. The new action is
still `cmd.exe /c` for the task's own script, but it is started by
`WScript.Shell.Run(…, 0, True)` from a GUI-subsystem host, so no console is
created at all; the exit code is returned with `WScript.Quit` and the output
is appended to the log, so the change records failures instead of hiding
them.

The original task XML is at
`%TEMP%\a8n-task-backup\HerdrServer-20261110210822.xml`.

`pc-setup-converge` and `SecurityPathGuard-Every5Min` were **not** changed:
both point at scripts that no longer exist, and wrapping a broken task in a
hidden launcher would only hide the breakage. They are reported here for
their owner to fix or delete.

## 4. What produced console processes at all

A one-minute sample on the host before §2 was applied counted 64 `cmd.exe`,
64 `powershell.exe` and 79 `conhost.exe` starts in six minutes, dominated by
this session's own `herdr pane read` polling. Each `herdr` call over SSH
starts `cmd.exe /c powershell.exe -EncodedCommand … herdr remote-client-bridge`.
That launch path belongs to `herdr`, not to ae-a8n, and is not changed here;
§2 is what stops it from drawing a window on this host.

Nothing in the ae-a8n package requires `herdr`: the agent is `ae-a8n agent`,
and `docs/windows-host.md` §6 tells a host owner to register it with
`--hidden`.

## 5. The gate on both hosts, at `e446aec`

| Host | Command | Result |
| --- | --- | --- |
| macOS (this machine) | `npm run check` | exit 0; **56 files, 885 passed, 5 skipped (890)** |
| Windows 11 `UUU` | `git archive` of `e446aec` → `npm ci` → `npm run check` | exit 0; **56 files, 884 passed, 6 skipped (890)** |

The Windows run also printed the POSIX skip reason
(`isolated-session checks: skipped on Windows — they need a POSIX shell and
POSIX mode bits`), and ran the Windows-only counterparts: the key-file ACL
refusal in `windows-agent-main.test.ts` and the ACL module in
`windows-acl.test.ts`.

## 6. Levels reached

| Claim | Level |
| --- | --- |
| `--hidden` creates no console (0 `conhost.exe` children vs 1 for the plain form) | verified on real host |
| The agent's failure reaches the log and the process exits | verified on real host |
| The CLI accepts the documented agent command | verified on real host (it was refused here before `e446aec`) |
| `agent --hidden` is covered by unit tests | automated test (`test/agent-detach.test.ts`, `test/agent-command.test.ts`) |
| Windows Terminal delegation is what made the windows visible | verified on real host (controlled A/B, §2) |
| `HerdrServer` no longer creates a console | verified on real host for the run and its log; the absence of a window follows from `wscript.exe` being a GUI-subsystem process, not from watching the desktop |
| An After Effects job runs end to end over the remote channel | **not reached** — no AE was started |
