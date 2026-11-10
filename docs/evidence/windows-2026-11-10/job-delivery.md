# A real job from the Mac to the Windows host — 2026-11-10 (T089 evidence)

This is the first time a job crossed the network from this Mac to the
Windows host `UUU` and a result came back, and the first set of refusals
measured on the real channel rather than in a test. Nothing here started
After Effects, opened a project, registered a task or changed a permission:
the job is `node.exe` printing two lines.

**Source:** `integration/win-cli` at the commits named in each section.
**Host:** `UUU`, Windows 11, account `basic`, session 1.
**Transport:** SMB share `\\100.118.123.62\Users` mounted on the Mac at
`/Volumes/Users`; the channel is the directory the agent polls,
`C:\Users\rebui\AppData\Local\ae-a8n\channel`.

## 1. What was provisioned (approved before it was created)

| What | Where | Who may read it | How to delete it |
| --- | --- | --- | --- |
| channel root | `C:\Users\rebui\AppData\Local\ae-a8n\channel` | `UUU\basic`, `SYSTEM`, `Administrators` (inheritance removed) | remove the directory |
| channel key | `…\ae-a8n\agent.key` (116 bytes) | the same three principals | remove the file |
| controller key | `~/.ae-a8n/agent.key` (0600) | this account | remove the file |
| controller host entry | `~/.ae-a8n/hosts.json` (0600) | this account | remove the file |

The key was generated on the Mac and copied once; it was never printed.
Its sha256 was compared on both sides (`b2110c29…97ef1`) and the staging copy
on the host was moved, not copied.

The agent runs from the packed tarball, not a clone:
`…\ae-a8n\agent-app` with `@ido-bata/ae-a8n 0.1.0-alpha.1`, sha256
`6922e5da…09a4a` — the same bytes the macOS gate was run against.

## 2. The five states, kept apart

The launcher's exit code is not any of them.

| State | How it was measured | Result |
| --- | --- | --- |
| started | `node cli.js agent --hidden …` then the process table | pid 9012, session 1, exit 0 from the launcher, **0** `conhost.exe` children |
| ready | the agent's own loop | presence file written within seconds |
| heartbeat | `agents/ae-a8n.json` re-read 12 s apart | mtime advanced (`21:33:52` → `21:34:05`), `heartbeatAt` advanced, `interactive: true` |
| job executable | `ae-a8n test --host UUU` | refused until the defects in §4 were fixed, then one job claimed and run |
| result received | the controller's run directory | exit 0, `artifacts/stdout.log`, `artifacts/stderr.log`, `report.json` |

## 3. The job and what came back

```
ae-a8n test --host UUU --timeout 90000 --keep -- \
  'C:\Program Files\nodejs\node.exe' -e "…console.log('hello-from-windows');
  console.error('stderr-line')"
```

| Item | Value |
| --- | --- |
| controller run | `20261110T130506Z-279da1ef`, `ok` (exit 0) |
| job | `20261110T130543Z-41ceef94` |
| stdout | `hello-from-windows` (19 bytes, sha256 `a946dc0e…f92f3`) |
| stderr | `stderr-line` (12 bytes, sha256 `5a88b247…f2cbf`) |
| exit code | 0 |
| artifacts | `result.json`, `session-marker.json`, `stdout.log`, `stderr.log` in `results/<job>/` |
| claims for the job | exactly 1 |
| result signature | `verifyResultAuth` → `{"ok":true}` with the channel key |
| result binding | `result.jobId` = the job's directory; `result.payloadSha256` = the job's payload hash |
| result agent | `ae-a8n` / `UUU` / `basic` / session 1 / `0.1.0-alpha.1` |
| double execution | the command appends one line per execution; one submission produced one line |

The probe commands take the same path: they are jobs too. A run takes
~40–50 s on this host, almost all of it the two probe passes.

## 4. Two defects the real host found (fixed, with tests)

Both were invisible to the unit tests because those inject a channel and a
key, which the CLI never has.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `test --host UUU` refused: "the Windows channel key is not configured" while the channel was reachable and the agent heartbeating | the adapter verified the key file through `openComms` and then signed the job with a key only an injected caller sets | the run signs with the key `openComms` verified, resolved before the run lock |
| the job was written but the agent refused it (`A8N-JOB-001: writer.host and writer.user are required`) and the controller reported a timeout | `--host` without `--user` produced an empty writer; the host entry's account was never applied | the host configuration's account is used when the caller names none |

Reproduced by `test/windows-remote-comms.test.ts` ("signs a run with the key
the host configuration names, with none injected"), which failed with exactly
the production error before the fix and passes after it.

## 5. Refusals measured on the real host (nothing sent)

`jobs/` was counted before and after each attempt.

| Case | Command | Outcome | Jobs written |
| --- | --- | --- | --- |
| agent not started (heartbeat 52 s old) | `test --host UUU` | blocked, exit 3, `A8N-JOB-005` | 106 → 106 |
| channel unreachable | `--channel /tmp/a8n-no-such-channel --key-file …` | blocked, exit 3, `A8N-JOB-007` | 106 → 106 |
| key mismatch | `--key-file` a key the agent does not hold | blocked, exit 3, `A8N-JOB-003` ("signed with key UUU-5872629d, which this side does not have") | 106 → 106 |
| duplicate submission | two identical runs at the same time | one ran (`ok`); the other refused, exit 4, run lock — **one execution** | two jobs, one execution |
| job timeout | a 40 s command with `--timeout 25000` | `unknown`, exit 6, `A8N-AE-004`, job left in place, target quarantined | 1 job, **1** claim, **1** execution |

The timeout row is the one that shows why a timed-out job is not re-sent: the
controller gave up at `13:19:24`, the agent finished at `13:19:39` with
`status: ok, exitCode: 0`, and the command's marker file holds exactly one
line. Re-sending would have run it twice. `ae-a8n recover --force` cleared
the quarantine; the earlier refusal case (a job the agent refused before
execution) was cleared the same way. `recover` cannot read the host's
After Effects state over the channel yet — it reports `tasklist exited 127`
and acts on nothing.

## 6. An agent started over ssh does not survive it

`node cli.js agent --hidden …` run through `ssh` returned exit 0, wrote a
signed heartbeat and served jobs for about half a minute, then disappeared
when the ssh session ended — no error, nothing in the agent log, presence
frozen at the last write. The same command started from the signed-in
desktop session (a pane in that session) ran for tens of minutes and is
still running. This is OpenSSH on Windows tearing down the process tree of
the session, not an ae-a8n failure, and it is exactly why a launcher's exit
code is not evidence that an agent is up: the agent must be started in the
interactive session (a logon entry or a shortcut), never over ssh for the
purpose of leaving it running.

The 60 s probe budget is also close to the mark on this host: a run costs
~40–50 s because the seven probe commands travel as jobs, twice per run,
and the agent claims one job at a time on a 1 s poll.

## 7. Not reached

- An After Effects job over this channel. §4 of the plan needs approval
  before AE is started at all.
- A result *tampered with in transit* (`A8N-JOB-003` on the result path) is
  covered by `submitJob`'s unit tests only; no real-host test forged one.
