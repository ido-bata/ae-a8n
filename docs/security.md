# Security

## What this package does on a user's machine

`@ido-bata/ae-a8n` drives After Effects. It is not a sandboxed library:

- it launches After Effects (or attaches to a running one),
- it writes ExtendScript into AE and executes it,
- it reads and writes files in a session workspace on disk,
- it spawns `osascript` on macOS and `AfterFX.exe -r` on Windows.

`docs/sessions.md` covers what it does with the user's open work: it never discards unsaved
changes by default, `close()` quits AE only when the session owns the process, and it never
kills AE.

The blast radius of a bug in the host script is therefore the user's desktop session, not just a
test fixture. The host script is ES3 and ships verbatim, which keeps it small enough to read.

## Dependencies

The published package has **no runtime dependencies**. Everything in `devDependencies` is a build
or test tool. `package-lock.json` is the inventory, and `npm ci` reproduces it exactly.

Dependency advisories are tracked with the `security-maintenance` skill; the inventory is the
lockfile, not a hand-written list.

## Secrets

The library reads no credentials and ships no secret handling. There is no `.env` in this
repository and no secret to configure.

Publishing uses npm Trusted Publishing (OIDC) from the publish workflow. There is no
`NPM_TOKEN` to leak, and the trusted publisher is stage-only: a plain `npm publish` from that
workflow is refused by the registry as well.

Secret values never belong in this repository, in a checkpoint, or in an agent result. If a
future change needs one, that change needs a repository-controlled schema and a scoped identity
first.

## Vendored Agent Skills

The Agent Skills under `.claude/skills/` are copies owned elsewhere, pinned by
`skills-lock.json` and checked by `test/vendored-skills.test.ts`. A copy that is edited in place,
or dropped from the repository, fails the test. Do not edit a vendored copy: fix it at the
source and re-vendor.

Attribution for the vendored skills is kept next to them (`LICENSE.upstream`, `UPSTREAM.md`).

## Reporting

Open a GitHub issue. Security-relevant reports are handled the same way until a private channel
is agreed.
