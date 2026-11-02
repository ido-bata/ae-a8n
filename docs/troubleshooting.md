# Troubleshooting

This page is a map, not a duplicate. The authoritative material lives elsewhere.

## The unit suite fails

1. Run the fast gate and read the first failure, not the last:
   `mise run typecheck`, then `mise run lint`, then `mise run test`.
2. If a test fails only in isolation, it is probably sharing mutable state. Every test creates
   its own session workspace with `mkdtempSync`; a new test must do the same rather than writing
   into a fixed path.
3. If the failure mentions the host script, read `host/a8n-host.js`. It is ES3 and runs verbatim;
   a modern syntax error surfaces there rather than as a bridge problem.

## A call against a real After Effects fails

Read `skills/after-effects-automation/SKILL.md` first — it describes how to investigate a real
host without disturbing someone's open work. Then:

- `docs/sessions.md` for ownership, unsaved changes, and what a timeout does to the running
  script.
- `docs/verification.md` for what has actually been observed, and for the exact probes used.
- The session workspace's `trace.jsonl` for the ordered record of what the bridge was asked to
  do.

A timeout ends the wait, not the work: ExtendScript cannot be interrupted, so the script keeps
running and the next call waits for it. Nothing is retried automatically.

## A published install does not work

- `node scripts/check-packed-package.js` packs the package, installs the tarball into a clean
  project, and resolves it the way a consumer does.
- `node scripts/check-public-api.js` imports the entry points from that installed package and
  drives a session.

These exist because this repository's own tests import through relative paths: a broken
`exports` map stays invisible to them while consumers get `ERR_MODULE_NOT_FOUND`.

## A publish was refused

`docs/releasing.md` has the gate's rules: what the version has to be, which commit it has to be
on, what the registry already has, and why the first version is published by hand.
