# Pre-release review of `release-0-1-0` — 2026-11-11

The release candidate was reviewed as a gate, not as a feature branch. This
directory records what the review was given, what it found, and what this
branch does about each finding.

## How it ran

| | |
| --- | --- |
| Tool | [open-code-review](https://github.com/alibaba/open-code-review) v1.13.6 (891df1b6) |
| Command | `ocr review --from main --to release-0-1-0 --effort high --audience agent --format json` |
| Range | `c0a9e1924a4f` (`main`) .. `4746ff3d4a3d` (`release-0-1-0`) |
| Files reviewed | 81 (`test/**` and Markdown excluded by the tool's defaults) |
| Provider / model | `opencode-go` / `mimo-v2.6-flash` |
| Cost / time | 15,792,846 tokens; 3h39m, resumed once after per-request timeouts |
| Result | 170 findings — 7 high, 65 medium, 98 low |

The context the reviewer was given is in [`context.md`](context.md); the full
text of every finding is in [`FINDINGS.md`](FINDINGS.md), verbatim, numbered
1–170 (1–7 high, 8–72 medium, 73–170 low). Line numbers in `FINDINGS.md` refer
to `4746ff3`.

## High findings

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | `setup --channel --dry-run` set the channel to `--dry-run` and left the dry run off | **fixed** — a value that starts with `--` is a usage error; inline `--flag=value` stays explicit. Test: `cli.test.ts` "refuses a flag as another flag's value" |
| 2 | A quarantined recovery was rethrown as a plain `TimeoutError` | **fixed** — `HostQuarantinedError` carries `A8N-SEC-001` through `contextualise` to the caller. Test: `recovery.test.ts` "reports a quarantined state instead of a timeout" |
| 3 | The key-file ACL accepted `CONTOSO\alice` for the local `alice` | **fixed** — the owner's qualifier must be the machine's or domain's own name. Tests: `windows-acl.test.ts` (three new cases) |
| 4 | `channelAclVerdict` refuses only a hard-coded shared list, so `CONTOSO\Domain Users` with write access passes | **tracked as T105** (#93) — needs a trusted-account set and a real-host `icacls` reading |
| 5 | The session marker is unsigned; its secret is never checked | **tracked as T098** (#93); the module header and `verifySessionMarker` now say so instead of claiming it "cannot be predicted or replayed" |
| 6 | `recover()` ran the local probe for a `--host` target | **fixed** — remote targets read the host's state through the channel, or refuse with `A8N-JOB-007`. Tests: `windows-runner.test.ts`, `windows-remote-comms.test.ts` |
| 7 | The quarantine was read before the target lock was taken | **fixed** — the lock is taken first and the quarantine is read under it (`test-run.ts`) |

## Medium findings fixed on this branch

| # | Fix |
| --- | --- |
| 8 | `windows` is now a required check in `REQUIRED_CHECKS`, as the job comment and `docs/github-settings.md` already claimed |
| 9, 10, 11 | The Windows steps in `ci.yml` and `publish.yml` use `shell: bash`, so a failing first `node --check` no longer passes behind a green second one |
| 15 | `check-packed-package.js` accepts a CRLF shebang line, so a Windows build does not fail the release gate on the line ending |
| 43 | `ScriptNotSentError` is classified and exported: a call that never reached AE is reported as not sent, not as a generic failure |
| 46 | A single installed AE whose version cannot be read is reported as that, not as "more than one version is installed" |
| 53 | An executor that throws publishes `unknown` (the target is quarantined), not `failed` (which invites a retry) |
| 56 | `resolveComms` refuses `--key-file` without `--channel` even when the hosts file could supply one; the guard was unreachable |
| 60 | A key-load refusal reports its own code (`A8N-PERM-005` for an ACL failure) instead of always `A8N-JOB-003` |
| 62 | A `readFile` failure after the path checks is a structured refusal, not a raw exception |
| 70 | `recover` validates the run id from a quarantine record before joining it into a path |
| 71 | A quarantine record that cannot be written no longer aborts the run report; the notice says the next run is not guarded |
| 22 | `--substrate` is validated against `terminal`/`offstage`/`native`; a typo refuses instead of falling through to offstage (the nested ternary is now an if/else-if chain) |
| 12, 14 | `npm run lint` covers every top-level script (`scripts`, not only `scripts/isolated-session/`), and the config's hand-listed Node globals include `AbortController`, so `scripts/windows-agent.mjs` lints clean |
| 13 | `ui.alert` puts the `ae-a8n:` marker on every dialog it raises, whether or not the caller passed it, so the GUI fallback can always recognise and press the dialog this method exists to have closed. Test: `api.test.ts` "always carries the marker the fallback's one known class requires" |
| 16 | `dispatch.mjs` refuses a result whose `id` is not the job's (a hardlinked stale result passes owner and mode checks), and deletes the collected result so stale material does not accumulate |
| 17 | `dispatch.mjs` identifies a refusal by the missing `exitCode` alone; a failing command is reported with its own exit code and its stdout/stderr are echoed |
| 18 | `focus-watch.swift` sleeps by running the run loop (`RunLoop.current.run(mode:before:)`), so the key tap is serviced instead of reporting `keys=watched` with a permanent zero |
| 19, 20, 21 | The session facts (`consoleUid`, `consoleAsid`, `readGuiSession`, `readOffstageStatus`, `ensureSharedDir`) live once, in `session-rules.mjs`; the terminal substrate uses the shared EPERM-tolerant directory helper, and the native substrate resolves the session from offstage's status instead of `launchctl`, which is EPERM from the console |
| 23 | The agent's poll loop survives a result that cannot be published: it logs, remembers the id so the job is not run twice, and keeps polling |
| 24 | The controller's deadline travels in the job payload; the agent gives the child `timeout`/`killSignal` and escalates to SIGKILL after a grace period, publishing a distinct `timedOut` result with exit 124 |
| 25 | A log append that fails is reported to stderr and does not become an unhandled rejection that ends the agent |
| 26 | `sessionFromOffstageStatus` reports `asid: null` at the source, so offstage's own session number can never be read as a launchd asid by any caller |
| 27 | `parseTerminalResult` counts `onconsole` among the fields `complete` requires: silence about the console is no longer read as "off the console" |
| 28 | A session that cannot be read carries launchctl's own text in the refusal whenever there is one, so "not permitted" is never reported as "not logged in" |
| 29 | `session.recover` refuses a transport that is not the script transport (the fallback would silently not exist) and refuses a transport whose session is not the one asked for (the pid and the automated session must not diverge) |
| 30 | `showModalDialog` validates `message` with `requireString` like every other public method; the `ae-a8n:` marker is added by the host (finding 13) |
| 31 | `--log` without `--hidden` is a usage error, and the process mode is decided from flags in flag positions — a token in a value position (`--key-file --hidden`) cannot flip it |
| 32 | A test pins `NODE_FLOOR_MAJOR` to `package.json`'s `engines.node` floor, so a bump cannot silently leave `doctor` enforcing the old one |
| 33 | The Node-version parser lives once, in `doctor`, and the macOS adapter imports it instead of carrying a second copy |
| 34 | `A8N-ENV-002` names the machine it measured: for a `--host` target the check is about the controller, and the remedy says so |
| 35 | Host staging copies only the host script plus the shipped codec — a stale consumer `a8n-json.js` can no longer win, unrelated consumer files are not put where AE is pointed, and an unreadable entry refuses with context |
| 36 | `recoveryGraceMs` is a `LaunchOptions` field (validated, default 60 s) and is documented as time *in addition to* `timeoutMs`: the first wait ends, the fallback runs, then the grace starts |
| 38 | `a8nClean` is applied to the window and button labels as well as the static texts, so a line break or `|` in a title cannot split the record and make a real dialog read as non-blocking. Test: `macos-session.test.ts` "cleans every label that goes into a listing line" |
| 39 | The press re-checks the dialog's `ae-a8n:` static text **inside the target session**, the only identity an empty-title window has, so a sheet raised during the screenshot cannot receive the press. Test: "re-checks the dialog's text…" |
| 41 | One `pressButtonIn` path for listed and unlisted buttons: a listed `OK` whose AX press fails now gets the coordinate fallback instead of the loop moving on and the refusal claiming no button was available |
| 42 | The in-flight serialization is a `while` loop, so any number of waiters resume one at a time and `#inFlight` never points at a script that is no longer the last one sent |
| 44 | `capabilityChecks` is documented, in the module header and the function, as reporting rather than enforcement; the refusal is `assertProvenIdentity` on the identity measured for the target actually in use |
| 45 | `setup`'s session readiness requires an Aqua session **with a readable asid**, and names the unreadable-asid and non-Aqua cases separately, as `probeDarwin` does — so `setup` and `doctor` cannot disagree about the same machine |
| 47 | A local Windows target records this machine's own hostname and account as the job writer (run-lock owner and manifest included); `""` is kept only for a remote target, whose host configuration repairs it. Test: `doctor.test.ts` "records this machine's own host and account as a local job's writer" |
| 48 | `hasWrite` is a read-only allow list: `AD`, `GW`, word-form and `(special access:)` rights are no longer read as "no write", so an unrecognised spelling fails closed. Tests: `windows-acl.test.ts` "refuses a write spelled as a right the module does not know" |
| 49 | `agent --hidden` answers 0 only after the OS reports the child spawned, so an asynchronous spawn failure is a failed start (exit 1, nothing started) instead of a success line for a process that never ran. Tests: `agent-detach.test.ts` (two new cases) |
| 50 | The agent checks the stop signal between jobs, so Ctrl+C/SIGTERM is no longer held behind the whole queue; the previous job's result is already published. Test: `windows-agent-main.test.ts` "stops between jobs, not after the whole queue" |
| 51 | The poll loop's result read is guarded: one unreadable job directory is logged and skipped instead of rejecting `main` and taking the resident agent (and its heartbeat) down. Test: "keeps polling when one job's result path cannot be read" |
| 52 | A claim left by an agent that died is named, not silent: the agent logs the claimant and the claim file once per job, and the controller's `A8N-AE-004` message names the trusted claim and what a human must remove. Tests: `windows-agent-main.test.ts` "names a trusted claim that strands a job, once"; `windows-result-visibility.test.ts` (both directions) |
| 54 | A channel read is bounded while it reads: the file is opened, its size checked, and then read through the handle in 64 KiB chunks that stop at `maxReadBytes + 1`, so a writer that grows the file after the size check is refused at the cap instead of being buffered whole. Tests: `windows-channel.test.ts` (the limit is exact at the cap, one byte over is refused, a far-over file is refused before it is read) |
| 55 | A refused rename is retried before the destination is deleted, so a transient sharing violation no longer leaves the path absent between two calls (a heartbeat reader can see that); the delete is the last resort and, when it runs, a failed publication no longer leaves its temporary file behind. Tests: `windows-channel.test.ts` "retries a transient sharing violation…", "deletes the destination only after the retries are used up…" |
| 59 | A timeout no longer claims a kill nobody observed: `taskkill`'s own refusal is reported, a kill that throws is a failed kill, and a pid whose identity changed says so. The message names the pid and the creation time that was read, so a child nobody could kill is findable. Tests: `windows-executor.test.ts` "does not claim a kill the OS refused", "treats a kill that throws as a failed kill…", "the pid now names a different process" |
| 63 | `releaseRunLock` re-reads the lock immediately before unlinking and removes it only when the bytes are still the ones it validated, so a lock taken by another controller while this one waited is not deleted. The window is narrowed, not closed: the channel has no compare-and-delete. Tests: `windows-lock.test.ts` "leaves a lock that changed after it was validated", "leaves nothing to remove when the lock vanished…" |
| 61 | A key file's bytes are bound to the file that was checked: after the read the path is re-`lstat`ed and a refusal is returned when the inode, size or modification time changed, or the path is now a link or not a regular file. The race is narrowed, not eliminated (the read is not `O_NOFOLLOW` on a held handle). Test: `windows-auth.test.ts` "binds the bytes to the file that was checked" |
| 68 | Recovery no longer overwrites a report: `report.json` is created exclusively, so a report that appears between the check and the write is kept and reported; a run whose own lock is still alive is "in progress", not incomplete, and nothing is recorded for it. Tests: `runner-recover.test.ts` "does not record over a run whose lock's owner is still alive", "keeps a report path that appears between the check and the write" |
| 69 | A lock record that parses but names no usable pid is refused as undecidable (status `unknown`, record kept), like an unreadable one; it is no longer deleted as stale, which could free a lock that still protects a run. Test: "refuses a lock record that names no owner instead of calling it stale" |

## Low findings fixed on this branch

| # | Fix |
| --- | --- |
| 88 | `--timeout` in both helpers refuses a non-numeric or non-positive value instead of turning the poll deadline into `NaN`, which waits forever |

## Medium findings deferred

The reviewer marked these real; they are recorded, not fixed on this branch.
Each is a candidate for its own ticket (one per number-only branch).

| # | Where | Why deferred |
| --- | --- | --- |
| 37, 40 | — | **by design** (unreadable result is not an answer; recovery is synchronous) |
| 57, 58 | POSIX channel ACL, unsigned probe artifacts | design + schema |
| 64, 65, 66, 72 | unsigned manifest, runner lock leaks, session never closed | each is a lock/state change that needs its own tests |
| 67 | session marker signing | **tracked as T098** (#93) |

## Low findings

The 98 low findings are recorded verbatim in [`FINDINGS.md`](FINDINGS.md) and
were not dispositioned individually on this branch. None is a release blocker
by the reviewer's own severity; they are follow-up material. The deferred
mediums, grouped as tickets, are tracked in #94; the per-finding code check
behind each verdict is in [`TRIAGE.md`](TRIAGE.md).

## What this does not prove

- Every fix here is `implemented` + `automated test` unless stated otherwise.
  Nothing in this review was verified on a real After Effects host; the Windows
  basic acceptance of 2026-11-11 (`windows-2026-11-10/`) ran on an earlier
  build (`4bf9ea0`), not on this branch's head.
- The rename retry (finding 55) uses 3 attempts 50 ms apart. That a real SMB
  share clears a sharing violation within that budget was not measured; the
  behaviour under a destination held open by a reader lacking delete-sharing
  is `automated test` only.
- The timeout kill (finding 59) is tested with an injected kill; `taskkill.exe`
  itself was not run — the Windows `windows` job exercises the process paths,
  but not a refused kill.
- T095, T097, T098, T099 and T105 change, or will change, the job/marker
  schema; they need a fresh T092 run before the version carrying them may be
  called `verified on real host`.
