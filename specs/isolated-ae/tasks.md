# Tasks

- T005 (Issue #54)
- Task IDs are global to this feature. Existing ranges T001–T084 are owned by
  Issues #54–#63 and are not renumbered. New work starts at **T085**.
- Each task ends with an independently testable deliverable and names the files
  it owns. A task is not complete on a fake-only green when its acceptance
  requires a real host; the evidence level is recorded.

## Existing allocation (unchanged)

| Range | Owner | Area |
| --- | --- | --- |
| T001–T005 | #54 | This specification set |
| T006–T011 | #55 | `doctor` |
| T012–T019 | #56 | Guided `setup` |
| T020–T026 | #57 | Permission/Adobe consent |
| T027–T033 | #58 | Isolated `test` runner |
| T034–T039 | #59 | Identity, job trust, recovery |
| T040–T046 | #60 | PR #50 acceptance, Windows/ae-test regression |
| T047–T053 | #61 | Extension API |
| T054–T059 | ae-test#19 | Fixture/session pass-through |
| T060–T065 | Aulymo#332 | Consumer adapter |
| T066–T071 | Aulymo#333 | Consumer acceptance |
| T072–T077 | #62 | Quickstart, troubleshooting |
| T078–T084 | #63 | Release |

## New tasks: cross-platform contract and Windows backend

### T085 — Platform adapter contract and fake adapter

**Files:** create `src/platform/contract.ts`, `src/platform/index.ts`,
`test/platform-contract.test.ts`, `test/platform-neutral.test.ts`.

**Deliverable:** the `PlatformAdapter` / `IsolatedSession` types from
`plan.md` §3, a `FakeAdapter` that records calls and can be told to refuse, and
a grep test asserting `src/cli`, `src/doctor`, `src/setup`, `src/runner`,
`src/reporter` contain no `process.platform`.

**Acceptance:** contract compiles; the fake adapter can drive `doctor` and
`runner` end to end without a real host; the neutrality test fails if a
`process.platform` branch is added to a neutral layer.

**Verification:** `automated test`.

**Depends on:** T005.

### T086 — Windows read-only environment probe

**Files:** create `src/platform/windows/probe.ts`,
`test/windows-probe.test.ts`; extend `src/doctor/checks/*` with the codes
`A8N-ENV-*`, `A8N-SESSION-*`, `A8N-PERM-*` for Windows.

**Deliverable:** probe reports: OS build, Node version, AE installation and
version, target user/host reachability, whether any AE is running on the
target, whether the agent is reachable, and Adobe sign-in state if it can be
read without touching it. Unknown is `warning`/`blocker`, never success.

**Acceptance:** every probe is read-only; a test asserts no write, spawn of AE,
or network mutation on the Windows fixture; each unknown maps to a code and a
remedy.

**Verification:** `automated test` + `fake/mock only` for the Windows fixture.
**Not** a Windows real-host result.

**Delivered 2026-11-10 (#67, PR #68):** OS caption/version, session id,
current and console user, After Effects uninstall entries (HKLM, WOW6432Node,
HKCU), running `AfterFX.exe` processes and target-account existence, all
read-only, with raw output kept as evidence. Deliberate boundaries: the Node
floor stays with `doctor` (T006) rather than being duplicated here; agent
reachability needs the agent, so it is T087's; Adobe sign-in cannot be read
without starting AE, so it belongs to T089. The real-host run is recorded in
`docs/windows-verification.md` ("Read-only host probe").

**Depends on:** T085.

### T087 — Windows remote-host setup and in-session agent

**Files:** create `src/platform/windows/remote.ts`,
`src/platform/windows/agent.ts`, `src/platform/windows/setup-steps.ts`,
`test/windows-remote.test.ts`, `test/windows-agent.test.ts`.

**Deliverable:** controller side (file channel over SSH/SFTP or a mounted
share) and the agent that runs in the dedicated user's interactive session.
Setup steps create/validate the agent, the shared job directory, the AE install
check and the sign-in reminder. Idempotent and resumable.

**Acceptance:** setup twice in a row is a no-op; interruption resumes; no
credential is written; the agent refuses to run a job from a file it cannot
prove it owns; an agent that is not in an interactive session refuses to start.

**Verification:** `automated test` against a fake host; real Windows pending.

**Delivered 2026-11-10 (#69, PR #76):** the job protocol (`job.ts`,
`channel.ts`, `agent.ts`, `remote.ts`) with exclusive claim, SHA-256 payload
binding, replay-age refusal, publish-by-rename, and `unknown` on timeout.
The setup steps, the agent entry point and the logon task moved to T088: they
cannot name a real agent command until the executor exists, and a stub would
not be completion.

**Depends on:** T086.

### T088 — Windows isolated runner

**Files:** create `src/platform/windows/runner.ts`,
`test/windows-runner.test.ts`; extend `src/runner/*`.

**Deliverable:** one `test` invocation opens the target session through the
agent, launches AE there, runs the command, collects results and artifacts, and
classifies outcomes as not-sent / timeout / host-error / refusal.

**Acceptance:** the lock is exclusive; a stale lock is detected and never
silently reused; a timed-out call is never retried; the manifest records the
host identity, AE version, agent version and job/result hashes.

**Verification:** `automated test`; real Windows pending.

**Delivered 2026-11-10 (#70, PR #77):** the run lock, the validated executor,
the run manifest, `WindowsAdapter`/`WindowsSession`, the idempotent setup
steps and the in-session agent entry (`agent-main.ts` +
`scripts/windows-agent.mjs`). Recorded 576 tests green. Deliberate boundaries:
`provesOwnership` and `provesDestination` stay `false` until T089/T090, and
`recover()` reports that GUI recovery is unimplemented rather than returning a
clean empty result. The controller submits the command; the agent runs it in
the dedicated session, so the controller never starts `AfterFX.exe` itself.
No row of T092 is satisfied.

**Depends on:** T085, T087.

### T089 — Windows recovery and consent policy

**Files:** create `src/platform/windows/recovery.ts`,
`test/windows-recovery.test.ts`; reuse `src/driver/recovery.ts` policy.

**Deliverable:** detect crash-repair, licence, sign-in and "another script"
dialogs; report them with codes; dismiss only `OK/Cancel/Close/Dismiss` and
never a licence/sign-in window; never re-send a script.

**Acceptance:** a table test over dialog classes asserts press/don't-press; the
licence/sign-in class always reports and never presses; an unknown dialog is
`A8N-SEC-001` and the run is quarantined.

**Verification:** `automated test` + `fake/mock only`; real Windows pending.

**Depends on:** T088.

### T090 — Windows destination proof

**Files:** extend `src/driver/script-invocation.ts`,
`test/windows-ownership.test.ts`, `test/session-marker.test.ts`.

**Deliverable:** the session marker (#43/#44) is exercised on the isolated
backend: the probe writes a per-run marker, and `app.quit` runs only where the
marker matches. Record the evidence in the manifest.

**Acceptance:** a mis-delivered quit does nothing; the manifest says whether
the destination was proven or only PID-proven.

**Verification:** `automated test` + `fake/mock only`; real Windows pending.

**Depends on:** T088.

### T091 — Windows extension compatibility

**Files:** extend `test/extensions.test.ts`,
`test/windows-extension.test.ts`.

**Deliverable:** the generated host script and `ae.call` work through the
Windows agent without changing the extension contract.

**Acceptance:** a static method runs in the Windows fake host; an unknown
method is refused before sending; the host script remains ES3.

**Verification:** `automated test`.

**Depends on:** T085, T087, T098.

### T092 — Windows real-host acceptance

**Files:** `docs/windows-verification.md`, `docs/verification.md`,
`docs/evidence/windows-<date>/README.md`.

**Deliverable:** the full matrix on a real Windows 11 + AE 2026 host: setup,
doctor, isolated session, non-interference measurement, test pass/fail/unknown,
recovery, ownership, destination proof, extension call.

**Acceptance:** every row is PASS/FAIL/UNVERIFIED with a source SHA, package
tarball hash, host identity, and artifacts. Any UNVERIFIED row blocks `latest`.

**Verification:** `verified on real host` only. A mock cannot satisfy this.

**Depends on:** T085–T091; Windows hardware.

### T093 — Cross-platform release gate

**Files:** `.github/workflows/*`, `scripts/check-release.js`,
`docs/releasing.md`, `test/release-gate.test.ts`.

**Deliverable:** the release gate requires both platforms' real-host evidence
files and refuses `latest` when either is missing or older than the candidate
commit. `next` prereleases may proceed with Windows marked UNVERIFIED only if
the package description and README say so.

**Acceptance:** a missing/stale evidence file fails the gate with a named
reason; the published tarball hash equals the verified one.

**Verification:** `automated test` for the gate logic; the real gate run is a
release action.

**Depends on:** T092, T084.

## Dependency notes

- T085 unblocks all Windows work and the neutral-layer extraction.
- T086–T089 are serialized on a real Windows host only for their real-host
  verification; their automated tests can proceed in parallel.
- T090 must not be started before T088's result-file integrity checks are in
  place.
- T092 is the only task that can turn any Windows claim into
  `verified on real host`. Until it runs, every Windows deliverable is
  `implemented` or `automated test`.

## ID allocation going forward

Append-only. The next free ID is **T094**. A task that changes an existing
task's acceptance is a new task, not an edit that hides the change.
