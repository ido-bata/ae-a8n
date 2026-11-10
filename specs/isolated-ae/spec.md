# Isolated AE testing — product specification

- Parent epic: ido-bata/ae-a8n#53
- This document: T001 (Issue #54)
- Revision: 2026-11-10 — cross-platform (macOS + Windows)
- Status: **draft for independent review**. Nothing in this document is
  evidence that a feature exists.

## 1. Problem

`@ido-bata/ae-a8n` can drive a real After Effects from Node and is verified on
macOS and Windows for the *attached/owned* case (one AE, one user, one desktop).
It cannot yet be handed to a general user as a testing tool, because:

1. There is no packaged entry point. The package has no `bin`; the isolated
   runner that exists lives in `scripts/isolated-session/` on the unmerged
   Draft PR #50.
2. Isolation exists on macOS only, and only as scripts, not as a supported,
   diagnosed, installable flow.
3. On Windows there is no isolation design at all. The public API works on a
   real Windows host, but it operates the console user's own AE.
4. Setup, diagnosis, recovery and reporting are manual and undocumented as a
   single flow.
5. There is no extension contract for a consumer (Aulymo, ae-test) to register
   its own host methods.

A testing tool that takes over the developer's screen is not usable. A tool
that cannot prove which After Effects process received a script is not safe.
Both are product requirements here, not implementation details.

## 2. Goals

- One guided setup per machine, then one repeatable command to run a real-host
  AE test without disturbing the user at the keyboard.
- The same CLI shape and the same report format on macOS and Windows.
- Fail closed whenever the target session, the target AE process, or the
  integrity of a job/result file cannot be proven.
- A stable, static extension contract so external projects keep their own
  code and the package stays generic.
- A reproducible npm release whose tarball is the thing that was verified.

## 3. Non-goals

- Interactive authoring, a GUI, or a replacement for the After Effects UI.
- A general remote job queue, multi-machine scheduling, or GitHub integration
  (`ae-farm`).
- A test DSL, assertions or snapshots (`ae-test`).
- Running two Adobe users' After Effects at the same time on one licence seat.
- Bypassing SIP, TCC, UAC, licensing or consent, or capturing credentials.
- Arbitrary `eval` of caller-supplied script text. Static, named host methods
  only.

## 4. Users and stories

Each story has a scenario that can pass or fail without reading the source.

### US1 — First-time onboarding (P1)

A developer on a supported machine runs `npx @ido-bata/ae-a8n doctor`, follows
the remedies, runs `npx @ido-bata/ae-a8n setup`, performs only the actions the
OS or Adobe requires a human to perform, and reaches a state where `doctor`
exits 0.

Pass: on a clean machine, `doctor` → `setup` → `doctor` reaches exit 0 with no
hand-edited file, no manually copied Node binary, and no path, UID or username
hard-coded for that machine. Every human action is listed with its reason and
is repeatable.

Fail: success depends on a maintainer's local file, a fixed UID, or an
undocumented manual step.

### US2 — Repeatable isolated run (P1)

From a normal terminal, `npx @ido-bata/ae-a8n test ./tests/example.ts` runs the
test in a session the user is not using, writes `manifest.json`,
`report.json` and `trace.jsonl`, and exits with a documented code.

Pass: two consecutive runs and a run from a new terminal both succeed; the
artifacts identify OS, AE version, package version, source commit, session
identity, and every check's verdict.

Fail: a second run fails because of state left by the first, or artifacts
cannot be tied to the run.

### US3 — Safety and fail-closed (P1)

Ambiguity never becomes action:

- target session unknown → nothing is sent;
- another AE is running anywhere → refuse to start a test AE;
- the AE is not owned by this run → do not quit it;
- a job/result file is not provably ours → do not execute or accept it;
- a timed-out script is not re-sent;
- a licensing/sign-in/permission dialog is never dismissed automatically;
- a session that cannot be proven safe is quarantined, not reused.

Pass: each refusal is reproduced and reported with a distinct diagnostic code;
no user project is modified or saved.

### US4 — Generic consumer (P1)

An external project (Aulymo via `ae-test`) registers its own static named host
methods and runs its existing assertions against an isolated real AE.

Pass: the consumer's code lives entirely in the consumer; `ae-a8n` contains no
project-specific branch; the consumer's existing lock/quarantine/evidence rules
still hold.

### US5 — Release (P1)

A prerelease is installed from the registry into a clean consumer and passes
the documented smoke flow; `latest` is promoted only after every real-host gate
for both platforms passes.

Pass: `npm install` from the registry (not a source checkout) runs the same
flow that was verified.

## 5. Supported platforms and evidence

| Platform | Public API | Isolated backend | Evidence today |
| --- | --- | --- | --- |
| macOS 27 arm64, AE 2026 26.5x89 | verified on real host | exists only on Draft PR #50 | `verified on real host` for PR #50's scripts at the commits named there; **not merged** |
| Windows 11 x64, AE 2026 26.5x89 | verified on real host | **does not exist** | `verified on real host` for the public API (docs/windows-verification.md) |
| Linux | unsupported | none | — |

Every later claim in an issue or PR must name one of: `implemented`,
`automated test`, `fake/mock only`, `verified on real host`. A cross-platform
release requires the last one on both supported platforms.

## 6. Functional requirements

### FR-01 — Same shape on both platforms

Five commands exist on both supported platforms: `doctor`, `setup`, `test`,
`recover`, `report`. Flags, exit codes and JSON shapes are identical; only the
diagnostic codes and the human steps differ. Platform differences are surfaced
as data, never as a different command name.

### FR-02 — Non-interference

- The session that runs AE must be a session the user at the console is not
  using.
- No synthetic keyboard or mouse input is delivered to the console session.
- No Apple Event, UI Automation call, or script is aimed at an unproven target.
- If the platform cannot provide a provably separate session, the backend is a
  dedicated host/VM and the two machines are documented as such.
- Measurement is part of acceptance: a run is instrumented for focus changes
  and synthetic input on the console session, and the instrument's blind spots
  are written down.

### FR-03 — Guided, idempotent setup

- Detect dependencies first; automate what can be automated.
- Ask a human only for OS/Adobe consent, and state why.
- Never collect or store Adobe credentials.
- Resumable after interruption; re-running a completed step is a no-op.
- Errors name the cause and a concrete fix.
- No UID, username, home directory or Node absolute path is hard-coded.
- No SIP disablement, no direct TCC database writes, no silent UAC elevation.

### FR-04 — Generic architecture

Dependency direction is one-way:

```text
cli / runner / reporter
        │
        ├── platform adapter contract
        │        ├── macOS adapter
        │        └── Windows adapter
        │
        ├── doctor / setup (platform-agnostic orchestration)
        └── public API (src/api) ── driver ── host/a8n-host.js
```

Rules:

- Platform-specific launch, session, GUI and ownership code lives behind the
  adapter contract. Common orchestration is not duplicated per OS.
- The adapter contract does not pretend that unequal safety constraints are
  equal; capabilities are explicit (`canProveDestination`,
  `canProveOwnership`, `supportsNonInterference`).
- `src/api` and `host/a8n-host.js` stay free of consumer-specific names.
- The host script remains ES3, shipped verbatim, and runs unmodified against
  the in-repo fake host.

### FR-05 — Safety invariants (all platforms)

1. If the target cannot be identified, send nothing.
2. Quit only an AE this run started and can still prove it started.
3. Never modify or save a project the run did not open; copy fixtures.
4. Never re-send a timed-out ExtendScript operation.
5. Treat an unknown outcome as quarantine; do not guess.
6. Never approve a permission, licence or sign-in dialog.
7. Distinguish: not sent / timed out / failed in AE / environment blocked /
   permission denied / refused for safety.
8. Adobe's licensing rules and concurrent-use limits are recorded, not assumed.

## 7. Product surface

See [contracts/cli.md](contracts/cli.md) and
[contracts/extensions.md](contracts/extensions.md).

Package:

- bin: `ae-a8n`
- library: existing public API, unchanged
- subpath `@ido-bata/ae-a8n/testing`, unchanged in intent
- no consumer-specific module, fixture or name

## 8. Artifacts

A run directory contains:

| File | Meaning |
| --- | --- |
| `manifest.json` | what was asked to run: inputs, fixture hashes, versions, identities |
| `report.json` | verdict per check: `pass` / `fail` / `blocked` / `unknown` |
| `trace.jsonl` | ordered events, including refusals and sent/not-sent decisions |
| `artifacts/` | PNGs and other outputs, addressed from `report.json` |

Every file carries a schema version. A reader rejects an unknown major version
and an incomplete file rather than interpreting it.

## 9. Acceptance criteria

The product is not complete until all of these are true, each with evidence:

- [ ] `doctor` exits 0 on a clean supported macOS and on a clean supported
      Windows environment, and refuses (nonzero, with a code) on unsupported.
- [ ] `setup` reaches a working state from clean, twice in a row, after a
      reboot, and from a new terminal; interruption and resume work.
- [ ] `test` runs a real AE in a non-console session on both platforms and the
      console user can type continuously without focus or input loss.
- [ ] The refusal matrix in FR-05 is reproduced on real hosts.
- [ ] An external consumer runs through the packaged tarball with its own host
      methods and its own results.
- [ ] A clean consumer installs from the registry and runs the smoke flow.
- [ ] `latest` is promoted only after both platforms' real-host gates pass.

## 10. Decisions required from the owner

1. **Windows backend.** This spec selects a dedicated Windows host/VM with an
   in-session agent (see [research.md](research.md) §4). A same-machine
   second-session or hidden-desktop backend is not selected, because neither
   can currently be proven non-interfering. Owner confirmation is required
   before implementation reaches the release gate.
2. **Windows hardware.** Real-host verification of the Windows backend needs a
   reachable Windows 11 machine or VM. Until then, Windows work can reach
   `implemented` and `automated test`, never `verified on real host`.
3. **Adobe licensing.** The chosen backend runs AE under a dedicated OS account
   on a dedicated machine. Whether that is a separate "device" under the
   owner's Adobe terms must be confirmed by the owner, not assumed.

## 11. Out of scope

VM-strength isolation inside the *same* machine without a second OS, multiple
concurrent AE sessions, cloud scheduling, headless AE, and any change that
lowers an existing safety guarantee to make a test pass.
