# Triage of the medium findings (8–72)

Produced on 2026-11-11 by a read-only triage pass over the findings in
[`FINDINGS.md`](FINDINGS.md), checking each against the code at `4746ff3` (plus
the fixes on this branch). `REAL` means the code confirms the finding;
`BY-DESIGN` means the code documents the behaviour as intended; `TRACKED`
means the item is already a task in #93.

| # | Where | Verdict | Evidence |
| --- | --- | --- | --- |
| 8 | `.github/workflows/ci.yml:118` | REAL | `scripts/github-rulesets.js:40` omitted the job |
| 9 | `.github/workflows/ci.yml:145` | REAL | pwsh masks the first `node --check` |
| 10 | `.github/workflows/publish.yml:167` | REAL | same, release gate |
| 11 | `.github/workflows/publish.yml:172` | REAL | same, packed-package check |
| 12 | `eslint.config.js:32` | REAL | `AbortController` absent from globals |
| 13 | `host/a8n-host.js:422` | REAL | fallback message lacks the `ae-a8n:` marker |
| 14 | `package.json:50` | REAL | lint scope omits top-level scripts |
| 15 | `scripts/check-packed-package.js:148` | REAL | exact shebang match fails on CRLF |
| 16 | `scripts/isolated-session/dispatch.mjs:314` | REAL | result id never checked against the job |
| 17 | `scripts/isolated-session/dispatch.mjs:331` | REAL | every non-zero exit labelled refused |
| 18 | `scripts/isolated-session/focus-watch.swift:158` | REAL | run-loop source never serviced |
| 19 | `scripts/isolated-session/run-in-isolated-session.mjs:145` | REAL | duplicated `consoleAsid` without the integer guard |
| 20 | `scripts/isolated-session/run-in-isolated-session.mjs:304` | REAL | unconditional `chmod 1777` |
| 21 | `scripts/isolated-session/run-in-isolated-session.mjs:458` | REAL | native path forces `offstageStatus` null |
| 22 | `scripts/isolated-session/run-in-isolated-session.mjs:473` | REAL | `Number()` without validation |
| 23 | `scripts/isolated-session/session-agent.mjs:199` | REAL | result write unguarded on error paths |
| 24 | `scripts/isolated-session/session-agent.mjs:288` | REAL | `execFile` without a timeout |
| 25 | `scripts/isolated-session/session-agent.mjs:297` | REAL | log-append failures discarded |
| 26 | `scripts/isolated-session/session-rules.mjs:204` | REAL | raw offstage status, unvalidated asid |
| 27 | `scripts/isolated-session/session-rules.mjs:325` | REAL | `complete` ignores `onconsole` |
| 28 | `src/api/index.ts:137` | REAL | launchctl failure reason discarded |
| 29 | `src/api/index.ts:279` | REAL | `recover` dropped for custom transports |
| 30 | `src/api/index.ts:394` | REAL | raw message forwarded; marker absent |
| 31 | `src/cli/agent.ts:93` | REAL | `--log` alone starts detached mode |
| 32 | `src/doctor/index.ts:18` | REAL | Node floor mirrored without an assertion |
| 33 | `src/doctor/index.ts:29` | REAL | `nodeMajor` duplicated |
| 34 | `src/doctor/index.ts:45` | REAL | remote target's Node check measures the controller |
| 35 | `src/driver/bootstrap.ts:159` | REAL | stale codec can win |
| 36 | `src/driver/driver.ts:432` | REAL | recovery grace unbounded and not exposed |
| 37 | `src/driver/driver.ts:444` | BY-DESIGN | an unreadable result is not an answer |
| 38 | `src/driver/gui-recovery.ts:203` | REAL | labels emitted raw |
| 39 | `src/driver/gui-recovery.ts:281` | REAL | empty-title known class skips the guard |
| 40 | `src/driver/recovery.ts:249` | BY-DESIGN | recovery is documented as synchronous |
| 41 | `src/driver/recovery.ts:331` | REAL | AX press only; coordinate fallback unused |
| 42 | `src/driver/script-invocation.ts:872` | REAL | `#inFlight` not rechecked after await |
| 43 | `src/driver/transport.ts:19` | REAL | `ScriptNotSentError` unclassified |
| 44 | `src/platform/contract.ts:152` | REAL | `capabilityChecks` only called by tests |
| 45 | `src/platform/darwin/adapter.ts:851` | REAL | setup readiness omits asid |
| 46 | `src/platform/darwin/adapter.ts:896` | REAL | unreadable single install reported as several |
| 47 | `src/platform/select.ts:61` | REAL | local target defaults an empty user |
| 48 | `src/platform/windows/acl.ts:129` | REAL | `hasWrite` ignores AD/GW/special |
| 49 | `src/platform/windows/agent-detach.ts:204` | REAL | spawn failure logged after exit 0 |
| 50 | `src/platform/windows/agent-main.ts:265` | REAL | signal checked only after draining |
| 51 | `src/platform/windows/agent-main.ts:273` | REAL | unreadable read rejects the agent |
| 52 | `src/platform/windows/agent.ts:194` | REAL | stale claim strands a job silently |
| 53 | `src/platform/windows/agent.ts:350` | REAL | throw published as failed |
| 54 | `src/platform/windows/channel.ts:103` | REAL | cap enforced after `readFile` |
| 55 | `src/platform/windows/channel.ts:124` | REAL | unlink-then-rename lock gap |
| 56 | `src/platform/windows/comms.ts:222` | REAL | guard unreachable; key alone borrows the channel |
| 57 | `src/platform/windows/comms.ts:364` | REAL | channel ACL check only on win32 |
| 58 | `src/platform/windows/comms.ts:546` | REAL | probe artifacts unsigned |
| 59 | `src/platform/windows/executor.ts:343` | REAL | kill errors swallowed |
| 60 | `src/platform/windows/key-store.ts:66` | REAL | structured code unused |
| 61 | `src/platform/windows/key-store.ts:125` | REAL | lstat/ACL then separate read |
| 62 | `src/platform/windows/key-store.ts:125` | REAL | `readFile` rejection escapes raw |
| 63 | `src/platform/windows/lock.ts:167` | REAL | read-validate-remove not atomic |
| 64 | `src/platform/windows/manifest.ts:214` | REAL | trust fields unsigned |
| 65 | `src/platform/windows/runner.ts:761` | REAL | channel swapped after the lock was written |
| 66 | `src/platform/windows/runner.ts:976` | REAL | post-lock exception leaks the lock |
| 67 | `src/platform/windows/session-marker.ts:254` | TRACKED | T098 (#93) |
| 68 | `src/runner/recover-run.ts:156` | REAL | truncating write can overwrite a finished run |
| 69 | `src/runner/recover-run.ts:234` | REAL | pid-less lock treated as stale |
| 70 | `src/runner/recover-run.ts:271` | REAL | quarantine run id not validated as a path |
| 71 | `src/runner/test-run.ts:228` | REAL | `writeQuarantine` unguarded |
| 72 | `src/runner/test-run.ts:390` | REAL | opened session never closed |
