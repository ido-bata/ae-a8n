# ADR-0006 — Anomaly response, bounded fallback and evidence on the standard lifecycle

- Status: **Proposed**
- Issue: [#342](https://github.com/ido-bata/ae-a8n/issues/342) (parent program [#337](https://github.com/ido-bata/ae-a8n/issues/337) A-RUNTIME, user stories US-A1/A2/A4)
- Spec: [`specs/gui-supervision/spec.md`](../../specs/gui-supervision/spec.md), [ADR-0005](0005-session-supervision.md)
- Builds on: #278/#284/#285/#287/#295 (supervision, taxonomy, recovery), #330/#332 (census attribution), #336 (session diagnostics), #339 (boot supervision), #340 (terminate/rebuild separation), #341 (machine-readable `nextActions`)

## Problem

The standard lifecycle — `launch`, every `call`, `close` — already contained the pieces for anomaly response, but they were **not connected**: a caller had to know to ask for them, and several contract points had no seam at all. Enumerating the unconnected points (task T001 of #342) against the pre-#342 tree:

1. **Recovery was opt-in, not standard.** `openAfterEffects` wired `HostRecovery` only when `session.recover === true`, and only for `ScriptInvocationTransport`. A default session timed out with no GUI fallback even though the machinery existed.
2. **No expected-modal seam.** A test that deliberately raises a dialog (unsaved-changes prompt, script-error sheet) had no way to declare it: the window was classified `unpressable`/`quarantine` and the run stopped for a modal the caller itself created.
3. **No anomaly vocabulary on the operation record.** A timeout carried `hostCondition` (`gone`/`unresponsive`/`modal`/`unknown`) but nothing named *which* anomaly the recovery saw — expected vs human-required vs unknown modal vs host-level failure — so consumers could not branch on it.
4. **No operation retry classification.** Nothing recorded whether an operation was read-only, verified-retryable, or of unknown side effect, so the "never resend in-flight" rule had no per-operation contract attached to it.
5. **Recovery evidence was unbound.** Screenshots were written ad hoc (`recovery-<id>.png`), the `session.recover` trace row carried prose, and nothing tied operation + outcome + before/after images + trace + diagnostics pointers into one artifact a consumer could find. Capture failures were silent.
6. **Platform asymmetry was implicit.** Windows had a `WindowsHostRecovery` with zero auto-safe classes and no screenshot vehicle; expected-modal support was undefined there rather than decided.

## Decision

### 1. Recovery is part of the standard path, opt-out not opt-in

For the built-in script transport, `HostRecovery` is wired by default on every session. `session.recover: false` opts out; `session.recover: true` keeps the strict contract — a session that cannot be wired (non-script transport, unnameable target session) refuses to launch rather than silently dropping a requested safety behaviour. A default-on session that cannot be wired launches without recovery and records `session.recovery` (status `error`, `RecoveryUnavailable`) on the trace — the caller never asked for it, so it is a recorded degradation, not a refusal.

This does not change *when* recovery runs: still only after a timeout (or a supervision-proven blocking phase), still bounded by `recoveryGraceMs`, still never resending the in-flight request.

### 2. Expected modals are a per-session registration contract

`LaunchOptions.expectedModals` seeds a session registry; `ae.expectModal(spec)` registers one while the session runs and returns its unregister function. A spec is `{ name, matches(window), resolve? }` where `window` is a deliberately small shape (title, role, subrole, static texts, button titles) and `resolve` returns `{ kind: "press", button }` or `{ kind: "wait" }` (the default).

Contract rules:

- Registration re-classifies a window the taxonomy would refuse or quarantine. It is consulted only for `unpressable` and `quarantine` choices — a measured `auto-safe` window is still handled by the taxonomy, and a `human-only` window (sign-in/licence) is decided **before** the registry is read: no expectation can make an account decision pressable.
- `press` goes through the identical audited path as a measured class — GUI lease, audit record, pid/start-identity re-proof, in-lease census re-attribution. The evidence names the expectation (`expected modal "<name>"`) so a registered press is never mistaken for a measured one.
- `wait` presses nothing: the modal is recorded as expected evidence and left for its owner while the original request keeps its bounded wait.
- A matcher or resolver that throws, or a `press` without a string button, degrades to `wait` — never to a press.
- `expectModal` throws `HostNotOwnedError` when no GUI recovery path is wired (non-script transport, `recover: false`), rather than registering into a void.

**Platform boundary:** the registry is consulted by `MacHostRecovery` only. On Windows, `WindowsHostRecovery` has no authorized press path for unmeasured classes, so launch-time `expectedModals` specs are recorded as `session.expected-modals` (status `error`, `ExpectedModalsUnavailable`) and `ae.expectModal` refuses. An unregistered window keeps its honest classification either way.

### 3. Anomaly classification is recorded, not guessed

`classifyAnomaly` (`src/driver/anomaly.ts`) maps already-collected facts to one `AnomalyKind`: `known-safe-modal`, `expected-modal`, `human-required-modal`, `unpressable-dialog`, `unknown-modal`, `process-gone`, `host-unresponsive`, `comms-lost`, `host-busy`, `cep-anomaly`, `unknown`. Precedence: explicit `reported` (evidence-driven, e.g. a future CEP detector) → registered expectation → window tier → host condition. It is pure — it never inspects windows, processes or pixels.

The unresolved-timeout path carries the kind into the operation's trace `result.anomaly` alongside `hostCondition`, and `classifyOperationRetry(method)` records `result.retryClass` (`read-only` / `verified-retry` / `unknown-side-effect`) on every failed operation row. `verified-retry` is reserved: membership requires recorded idempotency evidence, same rule as dialog tiers; no built-in method holds it today. These fields are the contract downstream consumers (ae-test, ae-devtools) branch on for resend decisions — the driver still never resends.

### 4. One evidence manifest per recovery attempt

Every `HostRecovery.attempt` — press, expected-modal resolution, quarantine, honest refusal — produces `artifacts/recovery-<requestId>.evidence.json` (`ae-a8n.recovery-evidence/v1`): operation identity, outcome/code, the blocking window's description, the expectation name when one classified it, before/after screenshot paths (or `null`), an `uncapturable` list naming every capture that did not happen and why, pointers to `ae.diagnostics()` for host logs/crash reports, the supervision summary the attempt ran under, and a `cepCsxs` note naming the known coverage gap (#336 owns those sources). The `session.recover` trace row carries the same fields plus the manifest path.

Honesty rules, same as the diagnostics collector: a capture that did not happen is recorded, never omitted; the manifest write itself is atomic (temp + rename) and a write failure is traced as `session.recover-evidence` — it never breaks the recovery it describes.

### 5. B boundary (shared foundation, not duplicated)

Large-scale screen recording and a viewer are program B's scope (#337 B-*). This ticket's contribution to that boundary is exactly the manifest: a stable, schema-versioned index (`kind`, paths, `uncapturable`, `capturedAt`) that B's recorder can append to or supersede without re-deriving what a recovery saw. No recording, no viewer, no OCR is added here — consistent with ADR-0005 §2.

## Contract diff summary (what changed for callers)

| Before #342 | After #342 |
| --- | --- |
| Recovery only with `session.recover: true` | Wired by default on the script transport; `false` opts out; `true` still refuses when unwirable |
| No way to declare an expected modal | `expectedModals` launch option + `ae.expectModal(spec)` (macOS); refused elsewhere |
| Timeout carried `hostCondition` only | Trace `result` also carries `anomaly` and `retryClass` |
| Screenshots + prose trace row | `artifacts/recovery-<id>.evidence.json` manifest per attempt, with `uncapturable` gaps |
| Windows recovery existed but expectations undefined | Explicit: expectations unsupported on Windows, recorded on trace |

Unchanged invariants: in-flight requests are never resent; `human-only` windows are never pressed through any path including registration; every press keeps the GUI lease + audit + census re-attribution; quarantine stays `A8N-SEC-001`; a timeout inside the existing budget never triggers an unnecessary restart.

## Consequences

- `Session.modalExpectations` and `AfterEffects.expectModal` are new public surface; `LaunchOptions.session.recover` semantics changed from opt-in to opt-out (documented in `src/api/types.ts`).
- The trace `result` object on failed operations now always carries `retryClass`; consumers parsing trace rows see a new field (additive).
- `MacHostRecovery` gained a `gui` test seam (`GuiRecoverySurface`) and before/after capture; `GuiRecoverySurface` is structural so tests fake it without Accessibility.
- Verification level: **fake/mock only** for the new seams (stub transport, stub GUI surface). The measured-class press path itself is unchanged code already covered by prior real-host evidence; expected-modal `press` reuses it but has not run against a real After Effects — that remains a real-host acceptance item.
