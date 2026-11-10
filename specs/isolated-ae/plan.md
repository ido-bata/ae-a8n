# Implementation plan

- T005 (Issue #54)
- Spec: [spec.md](spec.md). Research: [research.md](research.md).
- Revision: 2026-11-10.

## 1. Target architecture

```text
bin/ae-a8n ──► src/cli/main.ts
                    │
      ┌─────────────┼───────────────────────────┐
      ▼             ▼                           ▼
  src/doctor    src/setup                   src/runner
      │             │                           │
      └──────┬──────┴───────────┬───────────────┘
             ▼                  ▼
    src/platform/contract.ts   src/reporter
             │
   ┌─────────┴──────────┐
   ▼                    ▼
macOS adapter      Windows adapter
(offstage/session   (remote host +
 agent, local)      in-session agent)
             │
             ▼
      src/api (unchanged public API)
             │
      src/driver (unchanged transport)
             │
      host/a8n-host.js (ES3, verbatim)
```

Rules:

- `src/cli`, `src/doctor`, `src/setup`, `src/runner`, `src/reporter` contain no
  `process.platform` branch. They ask the adapter.
- `src/api` does not import from `src/platform`. A caller using only the
  library never loads session/CLI code.
- The host script is still shipped verbatim and still runs against the fake.

## 2. File structure

### New

| Path | Responsibility |
| --- | --- |
| `src/cli/main.ts` | bin entry; argv → command; one JSON document on stdout |
| `src/cli/args.ts` | flag parsing and validation (no dependencies) |
| `src/cli/exit-code.ts` | the code table from `contracts/cli.md` §2 |
| `src/cli/render.ts` | human rendering of the common envelope |
| `src/doctor/index.ts` | run checks, aggregate status |
| `src/doctor/diagnostics.ts` | `DiagnosticCheck` type + code registry |
| `src/doctor/checks/*.ts` | one check per concern, platform probes via adapter |
| `src/setup/index.ts` | plan → apply loop, resume |
| `src/setup/state.ts` | idempotent, credential-free state file |
| `src/setup/steps.ts` | platform-neutral step definitions |
| `src/runner/index.ts` | lock → open session → run → collect → report |
| `src/runner/lock.ts` | exclusive per-target lock, stale-owner detection |
| `src/runner/quarantine.ts` | unknown-outcome state and recovery |
| `src/runner/outcome.ts` | classify not-sent / timeout / host-error / refusal |
| `src/reporter/manifest.ts` | `manifest.json` writer, hashes, identities |
| `src/reporter/report.ts` | `report.json` writer and reader |
| `src/platform/contract.ts` | `PlatformAdapter`, capabilities, data types |
| `src/platform/index.ts` | adapter selection from config/target |
| `src/platform/macos/index.ts` | macOS adapter |
| `src/platform/macos/session.ts` | session discovery/agent (from PR #50) |
| `src/platform/macos/gui-recovery.ts` | AX policy (promoted from `src/driver/gui-recovery.ts`) |
| `src/platform/macos/helpers/*.swift` | shipped, compiled at use |
| `src/platform/windows/index.ts` | Windows adapter (remote host backend) |
| `src/platform/windows/remote.ts` | controller side: file channel, host identity |
| `src/platform/windows/agent.ts` | in-session agent: job loop, launch, results |
| `src/extensions/registry.ts` | validation and method table |
| `src/extensions/build.ts` | ES3 concatenation, `acorn` validation, sha256 |
| `bin/ae-a8n` | `#!/usr/bin/env node` → `dist/cli/main.js` |

### Modified

| Path | Change |
| --- | --- |
| `package.json` | add `"bin"`, add `src/cli` to the build, ship `src/platform/macos/helpers`, bump to a new prerelease only at release time |
| `tsconfig.build.json` | include the new directories |
| `eslint.config.js` | allow the Swift helpers to be non-linted |
| `README.md` | document the five commands and link `quickstart.md` |
| `docs/verification.md` | cross-platform evidence matrix |
| `docs/windows-verification.md` | Windows backend gate |
| `CHANGELOG.md` | new surface |

### Removed or moved from PR #50

`scripts/isolated-session/*.mjs` becomes `src/platform/macos/*.ts`. The
behaviour is preserved; only the packaging changes. The Swift helpers move to
`src/platform/macos/helpers/` and are listed in `files`. Nothing from PR #50 is
dropped silently: each file either moves or is deleted with a note in the PR.

## 3. Platform adapter contract (locked)

```ts
export type PlatformId = "darwin" | "win32";

export type Capabilities = {
  /** "proven": measured on a real host; "by-construction": different machine. */
  readonly nonInterference: "proven" | "by-construction" | "unproven";
  readonly provesOwnership: boolean;
  readonly provesDestination: boolean;
  readonly guiRecovery: boolean;
  readonly sessionIdentity: "uid-asid" | "host-and-user" | "none";
};

export type TargetSpec = {
  readonly name: string;
  readonly isolation: "session" | "remote-host";
  readonly user?: string;
  readonly host?: string;
};

export type SessionIdentity = {
  readonly kind: "uid-asid" | "host-and-user";
  readonly user: string;
  readonly detail: Record<string, string | number | null>;
  /** False if any identity fact could not be read. */
  readonly proven: boolean;
};

export interface IsolatedSession {
  readonly identity: SessionIdentity;
  /** Idempotent; a session already open is reused only after re-probing. */
  open(): Promise<void>;
  /** Runs argv in the target session. Never retried. */
  run(argv: readonly string[], options: { timeoutMs: number; env: Record<string, string> }):
    Promise<{ exitCode: number; stdoutPath: string; stderrPath: string }>;
  close(): Promise<{ closed: boolean; reason?: string }>;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly id: string;
  capabilities(): Promise<Capabilities>;
  probe(target: TargetSpec): Promise<{ checks: DiagnosticCheck[]; capabilities: Capabilities }>;
  plan(target: TargetSpec): Promise<SetupStep[]>;
  apply(steps: readonly SetupStep[], options: { yes: boolean; dryRun: boolean }):
    Promise<{ stateFile: string; outcomes: StepOutcome[] }>;
  open(target: TargetSpec): Promise<IsolatedSession>;
  recover(runDir: string): Promise<RecoveryFinding[]>;
}
```

An adapter that cannot prove a capability says `false`/`"unproven"`. The runner
turns that into a refusal, not a warning.

## 4. Migration of PR #50

Do not rebase the branch blindly. The PR is a Draft with 40 files; moving it
into `src/platform/macos` changes its shape. Sequence:

1. Land PR #50's safety fixes on its branch with an independent review, or
   cherry-pick the reviewed commits into the new branch if #50 is closed.
2. Move the `.mjs` runner into `src/platform/macos` with tests that run against
   the same fixtures (`test/isolated-session.check.mjs`).
3. Keep `src/driver/mac-session.ts`, `gui-recovery.ts`, `recovery.ts` where they
   are until the adapter wraps them; do not duplicate logic.
4. Delete `scripts/isolated-session` only when the new path has equal tests.

If PR #50 cannot be merged in the release window, the macOS adapter is built
from the same reviewed commits; the PR is then closed with a link, not left
ambiguous.

## 5. Implementation order

| Phase | Deliverable | Depends on | Real host needed |
| --- | --- | --- | --- |
| 1 | `contracts/`, this plan, `tasks.md` | — | no |
| 2 | `src/cli` skeleton, exit codes, `doctor` on business logic with fake probes | 1 | no |
| 3 | macOS adapter wrapping PR #50; `doctor` real probes | 2 | read-only |
| 4 | `setup` for macOS (idempotent, resumable) | 3 | yes (human actions) |
| 5 | `runner` + `reporter`; `test` on macOS | 3 | yes |
| 6 | extensions build + `ae.call` | 2 | no (fake) |
| 7 | Windows adapter, remote controller + agent | 2 | **yes, Windows** |
| 8 | Windows setup/doctor/test/recover | 7 | **yes, Windows** |
| 9 | ae-test pass-through | 5, 6 | no |
| 10 | Aulymo E2E on both platforms | 5, 9 | yes, both |
| 11 | clean-machine install, tarball, prerelease, latest | 10 | yes, both |

Phase 7 can start before phase 5 finishes only for the controller and the
protocol; anything using AE is serialized per host.

## 6. Non-negotiable checks in code review

- No `process.platform` in the neutral layers (a grep test enforces it).
- No new `eval`/`new Function` in `src/` (a lint rule).
- The host script stays ES3 (existing test `test/host-script.test.ts`).
- Every refusal path has a unit test that asserts no side effect.
- Every diagnostic code in `contracts/cli.md` exists in `diagnostics.ts` and
  vice versa (a table test).
