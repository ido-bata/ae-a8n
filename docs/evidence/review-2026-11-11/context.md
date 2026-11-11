# Release candidate: `@ido-bata/ae-a8n@0.1.0-alpha.2`

This diff is `main...release-0-1-0`: the entire release candidate for a
prerelease of a Node/TypeScript package that automates Adobe After Effects.
Review it as a release gate, not as a feature branch.

## What the software does

`ae-a8n` launches After Effects, runs ExtendScript inside it over a bridge, and
reports results. It has two isolation backends:

- **macOS**: a per-user login session driven through `launchctl`/`asuser`, with
  a GUI-recovery fallback that presses only OK/Cancel/Close/Dismiss.
- **Windows**: a dedicated host with a resident agent in the interactive
  session. The controller publishes HMAC-SHA256-signed jobs to a shared
  directory (SMB or local), the agent claims, executes and publishes signed
  results. Unknown outcomes are quarantined and never re-sent.

## Deliberate design decisions (do not report these as defects)

- **Fail closed.** Every ambiguous state refuses rather than proceeds: an ACL
  it cannot parse, a marker it cannot verify, a job it cannot attribute, a
  result that arrives after the deadline. Refusals are the safe direction;
  turning one into an acceptance is a real defect.
- **A late result is evidence, not success.** A result first seen after the
  deadline is recorded as `lateResult`, the run stays `unknown` and is
  quarantined, and the job is not re-sent.
- **Ownership.** The tool never quits an After Effects it did not start. The
  session marker is the claim of ownership.
- **No credential handling.** Adobe credentials are never collected, stored or
  submitted; login and licence dialogs are never auto-approved.
- **`destinationProof`/`ownershipProof` may be `"unproven"`.** That is the
  honest value when the instance cannot be proven; it must never say `proven`
  without proof. Known gap: T090/#72.
- **Tests live in `test/`** and are excluded from this review by the tool's
  defaults. The fake AE host is `test/fixtures/fake-ae-host.mjs`; the real host
  script is ES3 in `host/`.
- **Docs are Markdown** and excluded by the tool; they are not code.

## Where a defect would hurt most

1. **Windows job protocol**: signature coverage, replay, claim ordering,
   deadline handling, identity binding, path handling on shares.
2. **Process ownership and quitting**: anything that could quit or signal an
   After Effects this run did not start.
3. **Timeouts and unknowns**: paths that turn an unknown into a pass, or
   re-send a job that may already have run.
4. **Release tooling**: `scripts/check-release.js`, `publish-gate.js`,
   `stage-publish.js`, workflows — a mistake here publishes or tags wrongly.
5. **Cross-platform path/ACL handling**: Windows paths, `icacls`, POSIX modes.
6. **ExtendScript host code**: it is ES3, shipped verbatim, and runs inside
   After Effects; a syntax/expression problem there breaks every request.
