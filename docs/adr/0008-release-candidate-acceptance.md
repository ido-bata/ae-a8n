# ADR 0008 — Release-candidate acceptance: fixed candidate, public path, all-attempts ledger

- Status: proposed
- Date: 2026-11-28
- Issue: [#431](https://github.com/ido-bata/ae-a8n/issues/431) (parent program [#337](https://github.com/ido-bata/ae-a8n/issues/337)), spec [`specs/release-acceptance/spec.md`](../../specs/release-acceptance/spec.md)
- Relates to: [ADR-0005](0005-session-supervision.md), [ADR-0006](0006-standard-path-anomaly-recovery.md), [ADR-0007](0007-recording-authorization.md), [`docs/releasing.md`](../releasing.md), [`scripts/evidence-gate.js`](../../scripts/evidence-gate.js), [`docs/consumer-acceptance.md`](../consumer-acceptance.md) §4

## Context

Release PR #347 was sent back because its approval conflated two different claims: "the ticket issues are closed" and "the release candidate is proven". Ticket-level verification answers the first; nothing answered the second in a written, repeatable form. Each prior RC (`docs/evidence/release-0-2-0-rc/`, the `platforms/*.json` records behind #75) improvised its own evidence shape, and gaps accumulated: PoC-script evidence counted alongside public-path evidence, failed or blocked attempts went unrecorded, performance was measured but never budgeted, teardown residue had no verdict, and there was no machine-readable statement of what each capability actually guarantees on which platform.

## Decision

RC acceptance is a **separate contract** from ticket verification, fixed in `specs/release-acceptance/spec.md`. Its load-bearing choices:

1. **Fixed candidate identity.** A candidate is one commit SHA plus one `npm pack` tarball sha256, evaluated per platform lane and AE build. Every evidence artifact binds to that identity; mixed-candidate evidence is invalid by definition. This extends — does not replace — the `platforms/*.json` records `evidence-gate.js` consumes: the gate keeps enforcing "record exists, is current, says pass"; this contract defines what the run behind the record must contain.
2. **Public execution path only.** Acceptance evidence comes from `AfterEffects.launch/attach/resume` → `ae.*` → CLI → named consumers on the packed tarball. Fake hosts, injected transports, `scripts/poc-*`, and driver internals are never acceptance evidence. A scenario inexpressible on the public path is a capability gap to file, not a reason to reach inside.
3. **All-attempts append-only ledger.** Every attempt — pass, fail, `indeterminate`, `blocked`, `environment` — is a first-class record with per-step timing, expected-vs-actual, and anomaly/recovery/cleanup references. Failed attempts are evidence; re-running around them is candidate brute-force and invalidates the run set.
4. **Pre-declared budgets.** Readiness (split into named phases), representative-op p50/p95, recovery wait, supervision detection latency, recording overhead (gui-evidence §11), and a codified 10-consecutive-success rule are fixed before the run. Post-hoc relaxation is a contract change.
5. **Fail-closed everywhere.** `blocked`/`skipped`/`environment`/`indeterminate` never count as pass; `not-applicable` requires a recorded reason; the guarantee-boundary matrix (§9 of the spec) must agree with each spec's verification-level table or the run is invalid.
6. **Teardown verdict per attempt.** Process quit/leave-running, input/IME/clipboard restoration, lease release, supervision-document residue, and artifact residue are recorded as `clean`/`residue`/`unverifiable`; safety-relevant residue is an automatic fail.
7. **Evidence schema versioning.** Ledger, matrix, and verdict schemas carry `schemaVersion`; evolution is additive-only, breaking changes bump the version and stale records are denied rather than reinterpreted — the same posture `evidence-gate.js` already takes toward `platforms/*.json`.

## Why these choices

- **Separation from ticket verification** preserves the existing taxonomy (`implemented` → `verified on real host`) without inflating it: a ticket can be `verified on real host` for its narrow claim while the RC as a whole remains unproven. Conversely, an RC cannot be declared from ticket checkmarks — #347 is the precedent.
- **Public-path-only** is what makes the result mean "the product works for consumers" rather than "the internals work when prodded". It also keeps PoC value (contract inputs, vehicle measurements) while denying it verdict value.
- **All-attempts ledger** is the only honest denominator for the consecutive-success rule and for budget percentiles; a ledger that records only runs-that-work cannot compute p95 or detect flakiness.
- **Machine-readable guarantee boundary** forces the "Verification levels reached" tables to be checkable against reality per op/platform, so `verified on real host` claims cannot silently exceed evidence.

## Consequences

- New follow-up tickets are implied (not created here): attempt-ledger implementation, guarantee-boundary matrix generation, teardown-verdict collection, RC harness, and the first RC run under this contract.
- `docs/consumer-acceptance.md` §4 remains the per-run record template; the ledger is the run-set-level superset and §4 records slot into it as evidence references.
- `platforms/*.json` schemaVersion stays 1; any field this contract adds to the record's *requirements* (e.g. mandatory ledger pointer in `evidence`) lands as an additive change or a schema bump in a separate ticket.
- Until the first RC run completes, every scenario in the spec's matrix is `unverified`; this ADR records a decision, not a result.
