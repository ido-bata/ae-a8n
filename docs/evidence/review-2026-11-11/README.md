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
| 65 | A remote run's channel is settled once — by an injected channel, or by the first resolution that assigns one — and a later resolution may not replace it. Before, the send-time liveness check re-read the host configuration and could move the job, the manifest and the release to a new channel root while the run lock stayed in the old one, which nothing checks again. Test: `windows-remote-comms.test.ts` "keeps a run in the channel its configuration named when the file is rewritten" (fails without the guard) |
| 66 | Every throw after the run lock is taken releases it: the liveness check, the publish, the manifest and the local artifacts all sit inside one `try`, and the catch releases before rethrowing. The deliberate `unknown` outcome is the single exception — the job may still be executing, and `close()` releases that lock after the caller decides. A failed release never replaces the original error. Test: `windows-runner.test.ts` "releases the run's lock when the run throws before it has an outcome" |
| 72 | The runner closes the session it opened, in a `finally`, after the lock is released. The outcome is already decided at that point, so neither a refusing close (on Windows, a session marker that is not this run's) nor a throwing one changes it; the close and its reason are recorded as `session.closed` and appended to the run's trace when the directory was kept. Tests: `runner-test.test.ts` "closes the session after the command, and keeps the result in the trace", "keeps a refusing close out of the run's verdict", "does not let a close that throws change the run" |
| 57 (T106) | `openComms` no longer gates the channel check on the controller's `process.platform`: an injected ACL reader is called on every platform, Windows keeps its `icacls` verdict, and POSIX falls back to `stat` + the new `channelModeVerdict` (`channel-mode.ts`), which refuses a channel root writable by group or others — `1777` included, since anyone can still create entries in it — and refuses outright when mode or ownership cannot be read (`A8N-PERM-006`). No "probably fine" state. Tests: `windows-remote-comms.test.ts` |
| 58 (T107) | `JobResult` carries an `artifacts` map (relative path → SHA-256) that is inside the signed bytes, the agent publishes digests computed from the bytes it writes, and the reader verifies artifact bytes against the signed digests before decoding (`result-artifacts.ts`); a rewritten, undeclared or missing artifact is refused. A result that predates the field stays readable for one release and reports `unproven`, which the run manifest records as `artifactProof`. Tests: `windows-job.test.ts`, `windows-result-artifacts.test.ts`, `windows-agent.test.ts`, `windows-runner.test.ts` |
| 64 (T108) | The run manifest is signed with the channel key (`auth` field, same HMAC construction as the sibling documents) and `readRunManifest` takes a keyring: with one, an unsigned, wrongly signed or tampered manifest is refused; without one it decodes for shape only and stays unproven. `artifactProof` was added alongside so artifact verification state survives into the manifest. Tests: `windows-manifest.test.ts`, `windows-runner.test.ts` |

## Low findings fixed on this branch

| # | Fix |
| --- | --- |
| 88 | `--timeout` in both helpers refuses a non-numeric or non-positive value instead of turning the poll deadline into `NaN`, which waits forever |

## Medium findings deferred

The reviewer marked these real; they are recorded, not fixed on this branch.
Each is a task in `specs/isolated-ae/tasks.md`, and a number-only branch when
it is picked up.

| # | Where | Why deferred |
| --- | --- | --- |
| 37, 40 | — | **by design** (unreadable result is not an answer; recovery is synchronous) |
| 67 | session marker signing | **tracked as T098** (#93) |

## Low findings fixed on this branch

| # | Fix |
| --- | --- |
| 88 | `--timeout` in both helpers refuses a non-numeric or non-positive value instead of turning the poll deadline into `NaN`, which waits forever |
| 113 | `A8N-SESSION-005`/`006` are declared in the diagnostics registry in the contract's numeric order |
| 132 | The dry-run outcome map no longer carries a dead `state === "planned" ? "planned" : state` conditional |
| 135 | The misspelled `builtin\adminstrators` allowlist entry (which could never match `icacls` output) is removed |
| 140 | The never-produced `"no-job"` member is removed from `AgentRunOutcome` |
| 141 | Executor artifact names are refused unless `isResultArtifactPath` accepts them, so `../../claims/<id>.json` cannot escape the job's result directory (covered by the T107 artifact-path rules and `windows-job.test.ts`) |
| 143 | `ChannelCommandRunner` defaults its id entropy to `randomBytes` instead of four zero bytes, matching `submitJob` |
| 144 | `decodeUtf8`'s dead `exitCode === null ? "" : ""` branch is collapsed and the now-unused parameter dropped |
| 145 | The dead `describeChannel`/`sha256Hex` re-export surface is removed from `comms.ts` |
| 146 | The unreachable `code === undefined` arm in the executor's control-character scan is removed |
| 147 | Executor artifacts are returned even when the local `agent-runs` copy fails, so the channel result still carries stdout/stderr (the failure stays visible in `artifactNote`) |
| 150 | An explicit `owner: null` now reaches `keyFileAclVerdict` as "owner unknown" (the stricter refusal) instead of being swallowed by `??` into the current-user comparison |
| 151, 152 | `isRunId` drops guards the pattern already makes unreachable, and the `busy` state's comment no longer claims an unreadable timestamp is busy (it is `stale`) |
| 153 | `decodeRunManifest` refuses unknown fields instead of silently dropping them, matching every sibling decoder |
| 163 | `packageInfo()` falls back to `A8N_VERSION` (the release-checked constant `--version` prints) instead of a plausible-looking `"0.0.0"` |
| 168, 169 | The stale "(not implemented in this increment)" remedy text is gone; the quarantine remedy names `recover --force` and the lock remedy describes what `recover` actually does |

## Low findings deferred or dispositioned otherwise

All 98 lows are dispositioned. The 18 fixed above (88 was fixed earlier on the
review branch; 151/152 and 168/169 share rows) are listed in the table; the
remaining 80 are recorded here with a one-line reason each. None is a release blocker by the reviewer's own
severity; deferred items are follow-up material for later number-only branches.

| # | Disposition |
| --- | --- |
| 73 | deferred — CI hardening (`persist-credentials: false`); workflow-only change, no local test surface |
| 74 | deferred — pin `core.autocrlf` in the Windows CI job; workflow-only change |
| 75 | deferred — `setup-node` npm cache in CI jobs; workflow-only change |
| 76 | deferred — same `core.autocrlf` pin for the publish-gate Windows job |
| 77 | deferred — eslint `files` glob vs lint-scope mismatch; needs a decision on whether `scripts/*.js` joins the lint set |
| 78 | deferred — drop CJS-only globals from the `.mjs` eslint block; trivial but bundled with the 77 decision |
| 79 | deferred — `package-lock.json` version fields lag `package.json`; regenerate on the next dependency-touching change |
| 80 | deferred — document that git-URL installs ship without `dist/` (only `prepack` runs); docs decision |
| 81 | deferred — wrap the `--help` probe in `check-packed-package.js` through `fail()`; release-script polish |
| 82 | deferred — `ae-e2e.mjs` argv validation (missing values, unknown flags); dev-session tooling |
| 83 | deferred — `ae-e2e.mjs` unreadable-console fail-open; dev-session tooling, fail-closed fix needs a fixture |
| 84 | deferred — `ae-e2e.mjs` top-level setup outside `try` skips `finish()`; dev-session tooling |
| 85 | deferred — `ae-e2e.mjs` `"skipped"` close status always fails the report; dev-session tooling |
| 86 | deferred — `analyze-focus.mjs` `gapped(N)` contradicts the not-monitored line; witness tooling |
| 87 | deferred — `analyze-focus.mjs` key-total label overstates human attribution; witness tooling |
| 89 | deferred — `dispatch.mjs` should reuse `resultFileIsTrusted` instead of three inline copies of the trust rule |
| 90 | deferred — `dispatch.mjs` timeout leaves the job file for a slow agent to run; best-effort withdraw narrows but cannot close the race |
| 91 | deferred — replace `sleep 0.5` spawn polling with a timer promise in the session helpers |
| 92 | deferred — `run-in-isolated-session.mjs` JSON quoting is not sh quoting for `$`/backticks; use `shellQuote` |
| 93 | deferred — launcher output files can be group-writable under umask 002 and then fail the trust check; add `umask 022` |
| 94 | deferred — terminal launcher defaults `onconsole=0` when `/dev/console` is unreadable; fail-open self-report |
| 95 | deferred — `session open` spawn is unbounded by `--timeout`; pass a timeout through |
| 96 | deferred — dead `status === 69` branch in `run-in-isolated-session.mjs`; dispatch never exits 69 |
| 97 | deferred — nested ternary substrate dispatch; replace with a handler map that also refuses unknown substrates |
| 98 | deferred — nested ternary exit-code mapping in `session-agent.mjs`; extract `exitCodeOf` |
| 99 | deferred — `session-agent.mjs` top-level `await main()` lacks the refused-message wrapper its siblings have |
| 100 | deferred — orphaned JSDoc block in `session-rules.mjs`; documentation fix |
| 101 | deferred — `sharedDirIsUsableForOthers` mask accepts modes that cannot actually be used; tighten to `0o1703` |
| 102 | deferred — `probe-windows.mjs` has no structured error path outside the documented 0/3 contract |
| 103 | deferred — `HostNotOwnedError.declared` aliases the live extension-methods array; copy or freeze it |
| 104 | deferred — `session.recover` on non-macOS produces a misleading "no login session" message; refuse with a platform message |
| 105 | deferred — `LaunchOptions.session` has no runtime validation (`null` crashes, non-boolean `recover` silently disables the fallback) |
| 106 | deferred — `hostScript` read failures all report "not found"; include the underlying reason |
| 107 | deferred — `extension.call` `params` is forwarded unchecked; validate non-array object |
| 108 | deferred — `extensionMethods()` returns the live internal array; return a copy |
| 109 | deferred — `agent` flag parser misattributes a flag in value position; report `<flag> needs a value` |
| 110 | deferred — `--help`/`--version` compute but ignore `json`; honour the flag or drop the field |
| 111 | deferred — `extension` subcommand parser accepts unknown/duplicate flags; share the strict argv loop |
| 112 | deferred — `agent`/`extension` dispatch bypasses injected writers and casts `exitCode`; move `dependencies(input)` up |
| 114 | deferred — `nodeMajor` regex misses a bare major and is duplicated in the darwin adapter; export one shared helper |
| 115 | deferred — `session.recover` trace records hardcoded `0` ms durations; record real elapsed time |
| 116 | deferred — `|` in a window title can shift parsed fields in `gui-recovery.ts`; sanitise W/B fields like static texts |
| 117 | deferred — unguarded `buttons of w` enumeration can discard a whole window listing on error |
| 118 | deferred — dead `blockingWindows()` entry point; delete or route the recovery policy through it |
| 119 | deferred — dead `screenshotLooksReal` test seam; assert it in recovery tests or remove it |
| 120 | deferred — `execFileSync` calls in `mac-session.ts` have no timeout; bound them like `listAppInstances` |
| 121 | deferred — nested ternary stderr decoding in `mac-session.ts`; extract a helper |
| 122 | deferred — dead `listAppInstances()` wrapper; remove or wire the session binding it documents |
| 123 | deferred — `timeoutMs` option on the session spawn is never enforced; wire it or drop it |
| 124 | deferred — triplicated session-refusal message in `mac-session.ts`; extract a shared helper |
| 125 | deferred — a throw during the GUI-recovery press escapes `attempt()` instead of a `refused` outcome with evidence |
| 126 | deferred — dead `sessionId` field on `HostProcess`; remove or populate it from the session binding |
| 127 | deferred — `uid === undefined` reads as "this session's process" in the injected-process seam; tightening it breaks the seam's fixtures, so it needs a fixture-aware change, not a one-liner |
| 128 | deferred — the `automatable`/`--yes` consent gate is documented but not implemented; needs a design decision (check `yes` in `apply` or drop the promise) |
| 129 | deferred — `close()` has no production caller, so the designed Windows lock release never runs; wire it into `runTest` or move the release to the throw site |
| 130 | deferred — every darwin run leaves `ae-a8n-darwin-run-*` in tmpdir; reap it or write into the run directory |
| 131 | deferred — nested ternaries in `darwin/adapter.ts` plan reasons; extract named helpers |
| 133 | deferred — `chooseAction` labels non-pressable measured classes "belongs to a human"; give them their own wording |
| 134 | deferred — `DialogClass.button ?? "OK"` can turn a `presses: true` class with no button into an OK press; skip the window instead (needs a skip path) |
| 136 | tracked in #93 — `quoteForPowerShell`/`icaclsCommand` dead exports sit in `acl.ts`, which T101 reworks |
| 137 | deferred — agent flag contract duplicated between `agent-detach.ts` and `agent-main.ts`; export one shared set |
| 138 | deferred — `--log` swallows a missing/flag value in `agent-detach.ts`; report a usage error |
| 139 | deferred — `messageOf` duplicated four times across the windows modules; extract a shared helper |
| 142 | tracked in #93 — dead `writerOf` in `auth.ts`; the file is being reworked for T098 marker signing |
| 148 | tracked in #93 — env values skip the control-character screen argv/cwd get; job payload schema is T095 territory |
| 149 | tracked in #93 — `payloadFile` accepts `.`, device names and trailing dot/space; same T095 schema work |
| 154 | tracked in #93 — `presencePath` interpolates the agent id unvalidated; presence documents are T102 territory |
| 155 | tracked in #93 — `decodePresence` discards the received `alg` instead of refusing a mismatch; same T102 work |
| 156 | deferred — `tasklist`/`parseState` English literals are localised on non-English Windows; needs shape-based recognition like `parseIcacls` |
| 157 | deferred — nested ternary state-to-text in `recovery.ts`; lookup table |
| 158 | deferred — nested ternaries in `runner.ts` `plan()` reasons; style refactor |
| 159 | tracked in #93 — `sessionMarkerPath` call kept only for its throw; marker module is T098 territory |
| 160 | tracked in #93 — `decodeSessionMarker` accepts unknown fields; same T098/T102 decoder strictness work |
| 161 | deferred — `exitCodeOf` maps `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` to "could not start"; distinguish start failures from run failures |
| 162 | deferred — `RUN_TRACE_SCHEMA` has no reader; stamp it into `trace.jsonl` or drop the constant |
| 164 | deferred — plain `recover` never inspects the run a stale lock names; fall back to `lock.record.runId` for cleared stale locks only |
| 165 | deferred — refused `recover` findings still exit 0; fold them into `status: "unknown"` |
| 166 | deferred — a failed lock write leaves an empty lock that refuses every later run; remove it best-effort before rethrowing |
| 167 | deferred — passing runs write then delete the full artifact set; decide `keep` first (perf only) |
| 170 | deferred — `onAlert` hook in the fake host has no consumer; wire it through the fake transport or drop it |

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
  called `verified on real host`. T106–T108 (findings 57, 58, 64, fixed on the
  #94 branch) likewise change the channel check, the signed result schema and
  the manifest schema, so they carry the same requirement; T106's POSIX mode
  check has not been measured on the SMB mount the product uses.
