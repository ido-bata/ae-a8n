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
| 38, 39, 41 | `gui-recovery.ts` label cleaning and press fallback | needs a real macOS window to verify |
| 42 | `script-invocation` in-flight recheck | concurrency test |
| 44 | `capabilityChecks` only called by tests | contract-level decision |
| 45 | setup readiness omits asid | needs the macOS session facts |
| 47 | local Windows target defaults an empty user | select/adapter design |
| 48 | `hasWrite` ignores AD/GW/special rights | belongs with T105 |
| 49–52 | `agent-detach`, `agent-main`, `agent.ts` claim handling | Windows protocol tickets; each changes behaviour |
| 54, 55 | channel read cap and unlink-then-rename | needs an SMB measurement (T100) |
| 57, 58 | POSIX channel ACL, unsigned probe artifacts | design + schema |
| 59 | kill errors swallowed | executor ticket |
| 61, 63, 64, 65, 66, 69, 72 | key TOCTOU, lock races, unsigned manifest, runner lock leaks, recover lock handling, session never closed | each is a lock/state change that needs its own tests |
| 67 | session marker signing | **tracked as T098** (#93) |
| 68 | recovery overwrites a just-finished report | lock/report ordering |

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
- T095, T097, T098, T099 and T105 change, or will change, the job/marker
  schema; they need a fresh T092 run before the version carrying them may be
  called `verified on real host`.
