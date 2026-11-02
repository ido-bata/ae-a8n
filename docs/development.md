# Development

## Bootstrap

```bash
mise install      # installs the pinned Node toolchain
npm ci            # installs the dependencies from package-lock.json
```

`mise` is the project-local toolchain frontend and the entry point for every command below. It
delegates to the npm scripts, so each command is defined exactly once, in `package.json`.

The lockfile is `package-lock.json` and the package manager is **npm**, not pnpm or Bun.

## Commands

| Task | Command |
| --- | --- |
| Quality gate (typecheck + lint + test) | `mise run check` |
| Typecheck only | `mise run typecheck` |
| Lint only | `mise run lint` |
| Unit tests | `mise run test` |
| One test file | `npx vitest run test/api.test.ts` |
| One test by name | `npx vitest run -t "renders a frame"` |
| Tests in watch mode | `mise run test.watch` |
| Build (`tsc` → `dist/`) | `mise run build` |
| Release gate | `mise run validate:release` |

`mise run validate:release` is the quality gate plus the build plus the shipping checks: the ES3
parse of the host scripts, the ES3 check of the documented JSX snippets, the packed-package check,
and the public-API check. It is the same set of checks the publish workflow runs.

## What the unit suite does and does not need

The unit suite never needs After Effects. It runs the **real** host script against the in-repo
fake host, so the bridge protocol is exercised end to end without a desktop application.

That makes every green suite a `fake/mock only` result. It is not evidence about a real After
Effects. Real-host evidence lives in `docs/verification.md`, and it is recorded property by
property.

## Integration against a real After Effects

Integration is opt-in and is skipped when no AE installation is discoverable. The procedure, the
environment, and the recorded results are in `docs/verification.md` (macOS) and
`docs/windows-verification.md` (Windows).

Before driving a real AE, read `skills/after-effects-automation/SKILL.md`. It covers how to run
against someone's open work without damaging it.

## Layout

- `src/api` — the public, typed API. `src/api/types.ts` is the public type surface.
- `src/driver` — request/response driving, timeouts, ownership, transport selection.
- `src/protocol` — the file-based bridge protocol and the session workspace.
- `src/testing` — the fake host and the `./testing` entry point.
- `src/trace` — the JSONL trace.
- `host/` — the ExtendScript host scripts, shipped verbatim, ES3.
- `test/` — the unit suite.
- `docs/` — vision, verification status, sessions, releasing, architecture.
- `quality/profile.json` — the machine-readable quality policy.
- `docs/github-settings.md` — the repository's GitHub settings and the rulesets script.

`docs/architecture.md` explains how these fit together.

## Releasing

`docs/releasing.md` has the whole procedure. Publishing and merging are separate acts: the
publish workflow stages a tarball through npm Trusted Publishing, and a maintainer approves it
with 2FA. Nothing in the repository publishes on its own.

## When something breaks

- A failure in the unit suite: `docs/troubleshooting.md`.
- A failure against a real After Effects: `docs/verification.md` and
  `skills/after-effects-automation/SKILL.md`.
- Ownership, unsaved changes, timeouts: `docs/sessions.md`.

## Picking work back up

GitHub is the state of record, not the conversation. `docs/recovery.md` has the procedure.
