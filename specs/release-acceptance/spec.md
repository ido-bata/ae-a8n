# Release-candidate acceptance contract

- Issue: [#431](https://github.com/ido-bata/ae-a8n/issues/431) (parent program [#337](https://github.com/ido-bata/ae-a8n/issues/337); acceptance criteria live in #337 US-A1..A5 / US-B1..B4)
- Decision: [ADR-0008](../../docs/adr/0008-release-candidate-acceptance.md)
- Status: **draft**. This document is contract text only. It specifies what a release-candidate (RC) acceptance run must do and what its evidence must contain; it implements nothing and claims no real-host result.
- Builds on: [gui-supervision spec](../gui-supervision/spec.md) (detection/recovery/state contract), [gui-evidence spec](../gui-evidence/spec.md) §11 (recording overhead budget), [execution-model spec](../execution-model/spec.md) (UNKNOWN non-resend), [`docs/consumer-acceptance.md`](../../docs/consumer-acceptance.md) §4 (per-run record template), [`docs/releasing.md`](../../docs/releasing.md) + [`scripts/evidence-gate.js`](../../scripts/evidence-gate.js) (`platforms/*.json` evidence contract), [`docs/gui-supervision-safety-gates.md`](../../docs/gui-supervision-safety-gates.md) (#338 safety-gate audit).

## 1. Problem

Release PR #347's approval conflated "implementation issues are closed" with "the release candidate is proven useful on a real host" and was sent back. Ticket-level verification answers "does this change do what its ticket says, at the level it claims"; it does not answer "does this fixed candidate, exercised only through the paths a consumer actually uses, survive the program's normal and abnormal scenarios within declared budgets, with every attempt on the record". Without a written contract, each RC re-derives its own bar — or skips it — and evidence cannot be compared across candidates.

This spec fixes that bar. It is the acceptance contract a candidate must satisfy before a human may treat it as release-ready; it does not replace the per-ticket verification taxonomy, the `platforms/*.json` evidence gate, or the publish mechanics in `docs/releasing.md`.

## 2. Scope boundary

**In scope (contract only):**

- What identifies an RC candidate and binds all acceptance evidence to it.
- Which execution paths may produce acceptance evidence.
- The attempt-ledger schema an RC run must produce (implementation is a separate ticket).
- The performance budgets an RC run is judged against, fixed before the run.
- Reproducibility conditions, the abnormal-scenario matrix, the guarantee-boundary matrix requirement, the teardown verdict, and honesty rules.

**Out of scope:**

- Implementing the ledger, the guarantee-boundary matrix generator, teardown verdict collection, or any harness. Those are follow-up tickets under #337.
- Running the acceptance itself. No scenario in §8 is claimed verified by this document.
- Changing publish/tag/dist-tag mechanics (`docs/releasing.md`), the `platforms/*.json` gate schema in `scripts/evidence-gate.js` (this spec *extends the contract the records must satisfy*; a schema change is a separate ticket), or per-ticket verification requirements.
- ae-farm worker/queue concerns and ae-devtools UX; consumers appear only as the surfaces an RC must exercise.

## 3. Candidate identity

An RC candidate is **one immutable thing**: a commit SHA plus the exact packed bytes consumers install. Every piece of acceptance evidence — every ledger entry, trace bundle, screenshot, platform record — must name the same identity:

| Field | Source |
| --- | --- |
| `commit` | full SHA of the candidate commit (`git rev-parse HEAD` at freeze) |
| `tarballSha256` | sha256 of the `npm pack` output for that commit (the same hash `evidence-gate.js` checks) |
| `platform` | lane: `macos` / `windows`, OS version, arch |
| `aeVersion` / `aeBuild` | After Effects version and build reported by the host (`app.version` / build number equivalent) |
| `consumer` | the public surface used: packaged CLI, library API, MCP, or named consumer (ae-test, ae-devtools, Aulymo) |
| `runId` / `schemaVersion` | run identifier and the ledger/evidence schema version (§5, §9) |

Rules:

- A run against a different commit, a repacked tarball with a different hash, a different AE build, or a different platform is a **different candidate evaluation**. Evidence never mixes candidates.
- The `platforms/<platform>.json` records consumed by `evidence-gate.js` are the per-platform summary of this identity; this spec adds the requirement that the record's `evidence` pointer resolve to a complete attempt ledger (§5), not to ad-hoc logs.
- Schema evolution is additive-only within a `schemaVersion`; a breaking change bumps the version and old records become stale rather than reinterpreted.

## 4. Public execution path only

Acceptance evidence counts only when produced through the surfaces a consumer can actually reach:

```
AfterEffects.launch / AfterEffects.attach / AfterEffects.resume
  → ae.* public API (incl. ae.supervisionState(), ae.expectModal(), ae.record.*, ae.call)
  → ae-a8n CLI (incl. `ae-a8n supervise`)
  → named consumers driving the packed tarball (ae-test, ae-devtools, Aulymo)
```

**Never acceptance evidence:**

- The fake host or any injected test transport — that is `fake/mock only` at best and is reported as such.
- PoC scripts under `scripts/poc-*` or any script that drives `host/` ExtendScript, driver internals, or OS APIs directly around the public API. PoC evidence may *inform* a contract change (as #357 did for #358) but cannot satisfy an RC scenario.
- Internal seams (`GuiRecoverySurface` test fakes, stub transports, unit-level fixtures).
- Hand-edited or hand-assembled evidence files; the ledger is produced by the run, not reconstructed after it.

The boundary is the package's public exports and CLI, exactly as `docs/consumer-acceptance.md` §1 defines for consumer smoke. A scenario that cannot be expressed on the public path is **out of scope for RC acceptance** — it is a capability gap to file, not a reason to reach inside.

## 5. Attempt ledger

Every RC run produces an **append-only attempt ledger** per platform lane. The ledger is the primary evidence artifact; trace bundles, screenshots, manifests and platform records are linked from it. (Schema implementation is a follow-up ticket; this section fixes the required shape.)

### 5.1 Ledger envelope

- One ledger per (candidate, platform, run set). Entries are never edited or deleted; corrections are new entries that reference the corrected attempt.
- Every entry echoes the full candidate identity (§3) so a ledger cannot be re-attributed to a different candidate.
- `schemaVersion` is recorded on the ledger; readers must reject unknown major versions rather than guess.

### 5.2 Attempt record

One record per attempt at a scenario (§8) or operation-battery step:

| Field | Requirement |
| --- | --- |
| `attemptId`, `scenarioId` | unique within the ledger; scenario id from §8 catalog |
| `startedAt` / `endedAt` | wall-clock, monotonic duration derived |
| `verdict` | `pass` / `fail` / `indeterminate` / `blocked` / `environment` — exactly one; definitions in §11 |
| `steps[]` | per-step `{ stepId, startedAt, durationMs, expected, actual, evidenceRefs[] }` — every step that ran, including steps inside a failed attempt |
| `anomaly` | classification when the supervision/recovery path engaged (`known-safe-modal`, `expected-modal`, `human-required-modal`, `unknown-modal`, `process-gone`, `host-unresponsive`, `comms-lost`, `host-busy`, `unknown`, … per ADR-0006) or `null` |
| `recovery` | recovery attempt references (recovery-evidence manifest ids per ADR-0006 §4) or `null` |
| `cleanup` | teardown verdict reference (§10) — required on every attempt that launched or attached a session |
| `evidenceRefs[]` | trace bundle paths, screenshot/recording artifact ids (gui-evidence index), diagnostics bundle, supervision `stateFile` snapshot |
| `notes` | free text; never substitutes for a structured field |

Rules:

- **All attempts are recorded.** Successes, failures, `indeterminate` (outcome unproven), `blocked` (a human/external precondition was missing), and `environment` (host/OS/AE fault outside the candidate's control) are first-class entries. A run that only logs passes is invalid evidence.
- **Per-step timing is mandatory** for every step, not only failing ones — the performance budgets (§6) are computed from these `durationMs` values. Steps that produced no timing (e.g. GUI mutation ops that today leave no `trace.jsonl` row) are a known gap this contract exposes; the ledger must still carry the step with `durationMs` measured by the harness, and the gap is reported, not hidden.
- `expected` vs `actual` are recorded per step in structured form (the assertion and the observed value), not as prose.
- A retry is a **new attempt** referencing the prior one; the prior attempt's verdict stands. Re-running until green without recording the failures is candidate brute-force and invalidates the run (§11).

## 6. Performance budgets

Budgets are **declared before the run** in the run manifest and are part of the candidate evaluation. Post-hoc relaxation is a contract change, not a run note. This spec fixes the *dimensions*; the concrete numbers are fixed per RC from the pre-RC baseline measurement and recorded in the manifest (no number invented here is self-authorizing).

| Budget | Definition | Anchor |
| --- | --- | --- |
| Readiness probe bound | `launch` → first scriptable response must complete within `readinessTimeoutMs` (default 180 000 ms, `src/api/types.ts`). The wait is split into named phases — process spawn, first OS-level observation (census/AX or Windows equivalent), first ExtendScript response, capability handshake — each with its own bound so a slow phase is identified, not averaged away. A breach is `fail`, not a longer wait. | `readinessTimeoutMs`; phases per supervision spec §"pre-response window" |
| Representative op duration | For the declared representative-op set (launch→handshake→project open→comp create→renderFrame→close, plus each in-candidate GUI capability's smoke op), record `durationMs` per attempt; judge p50 and p95 against the manifest budget. | `trace.jsonl` `durationMs`; ledger `steps[]` |
| Recovery wait bound | Time from blocking detection to `resumed`/`needs-human`/`quarantined` must stay within `recoveryGraceMs` plus the declared per-class bound; no state waits forever (supervision spec: every state carries a deadline). | `recoveryGraceMs`, supervision state `deadline` |
| Supervision detection latency | Time from the blocking condition arising to the durable supervision state reflecting it. Bound = monitor interval + observation latency + classification confirm bound (e.g. the 2-consecutive-observation rule for unaccounted windows, #321). | `DEFAULT_MONITOR_INTERVAL_MS` (2 s), `DEFAULT_MONITOR_TTL_MS`/lease TTL (30 s) |
| Recording overhead | When the recording capability is in the candidate: requested vs achieved fps, dropped frames, encode cost, and `measuredOverheadMs` on a concurrent mutate op vs the same op unrecorded. Budget per gui-evidence spec §11 proposal: <5% frame-drop at 30 fps target, no measurable op-latency regression beyond noise; breach → capability reports `degraded` with numbers. | gui-evidence §11 |
| Consecutive success | A scenario is accepted only after **10 consecutive `pass` attempts** (§7). This codifies the provisional "10 consecutive" bar used in earlier real-host runs. | this spec |

A budget breach on a scenario that otherwise behaved correctly is still a recorded `fail` (or `degraded` where the contract defines degraded as an honest verdict) — budgets are acceptance criteria, not diagnostics.

## 7. Reproducibility conditions

An RC run set is comparable and countable only when:

- **Same fixture set**: the run manifest names a fixture manifest (project files, comps, scripts, expected values) by content hash. Fixture drift = new run set.
- **Same AE build declaration**: `aeVersion` + `aeBuild` recorded per attempt; a mid-run-set AE update invalidates the set. Where the platform can prove install identity, it is recorded; where it cannot (heartbeat-reported version only, per `docs/consumer-acceptance.md` §1.4), the limitation is stated, not papered over.
- **N consecutive clean runs**: the consecutive-success rule (§6) applies per scenario per platform lane — 10 consecutive `pass` verdicts.
- **`blocked` / `environment` / `skipped` count as non-pass**: they neither satisfy nor are hidden inside a pass count. They break consecutiveness (the streak restarts after them) and are listed in the run summary with reasons. A lane that cannot run a scenario for environmental reasons reports `blocked`/`environment` — never `pass`, never silence.
- **Same candidate**: §3 identity identical across every attempt in the set.

## 8. Abnormal scenario matrix

Each row is a contract-level scenario (`RC-S*`). "Accept" means the scenario must run on the public path and produce a ledger verdict; "out-of-scope" requires a recorded reason and is never counted as pass. Platform applicability follows the guarantee-boundary matrix (§9): a capability absent on a platform makes its scenario `not-applicable` there — an honest matrix entry, not a skipped pass.

| ID | Scenario | Program US | Expected behavior under test | Verdict criterion | Scope |
| --- | --- | --- | --- | --- | --- |
| RC-S1 | Launch → handshake → read-only smoke → close | US-A4, baseline | Standard path works end-to-end on packed bytes; readiness phases within bounds | all steps pass; budgets met | accept (both platforms) |
| RC-S2 | Owned AE crash mid-session → `process-gone` → verified rebuild → `resumed` | US-A1, US-A2 | Detection without request timeout where polling allows; rebuild only after proven loss; transport re-stage honestly reported (`ready`/`degraded`/`unproven`); old UNKNOWN preserved | `resumed` with rebuild report; no kill-mixed rebuild; attached/unknown sessions escalate instead of restarting | accept (owned sessions; attached variant asserts refusal/escalation) |
| RC-S3 | Expected modal (registered via `ae.expectModal`) | US-A1 | Registered expectation resolves through the audited press path or bounded wait; evidence names the expectation | modal cleared within bound; audit + evidence manifest present | accept on macOS; **out-of-scope on Windows** — expectations unsupported there per ADR-0006 (recorded `not-applicable`, refuse path still verified) |
| RC-S4 | Human-required modal (sign-in/licence/unsaved-changes class) | US-A1 | `needs-human` with structured content and resume path; never pressed | state reaches `needs-human` bounded; zero presses on the window | accept |
| RC-S5 | Unknown/unmeasured modal | US-A1 | `quarantined`/`A8N-SEC-001`-class stop; no press; structured evidence | quarantine verdict; zero presses; evidence bundle complete | accept |
| RC-S6 | AX-invisible modal (census-visible, AX-unaccounted; #321 shape) | US-A1 | Detected via consecutive unaccounted-window observations, not AX alone | `blocked` entered within detection-latency budget; classified honestly | accept where census+AX observation exists; Windows variant per its probe contract |
| RC-S7 | Communication loss / request timeout → UNKNOWN | US-A2, US-A5 | No resend of in-flight/possibly-executed request; late result authoritative within grace; `retryClass` recorded | zero resends in ledger; outcome `unknown`/late-result reconciled; `not-sent` is the only retry-permitted reason | accept |
| RC-S8 | Wrong focus / foreign-app window present | US-A3, US-B3 | Census/AX attribution excludes non-owned windows; any mutation refuses `foreign`/`unmatched`/`unproven` | mutation attempts refuse; observation reports degraded honestly; zero foreign presses/clicks | accept |
| RC-S9 | Permission denial (TCC/OS consent absent or revoked) | US-A3 | Structured refusal; automation never approves OS/Adobe consent; no silent degradation to a weaker path | refuse verdict with named reason; no consent bypass attempted | accept |
| RC-S10 | Mid-operation abort (session close / process kill during an op) | US-A5 | Operation outcome recorded honestly (`indeterminate` where unproven); teardown verdict produced; no false pass/fail | ledger shows honest outcome + teardown verdict; circuit-breaker counters (consecutive failures / total recoveries / total time) honored where implemented | accept |
| RC-S11 | AX non-vend (AE not vending AXChildren/AXWindows; #406 shape) | US-A1, US-B3 | Observe-only path (`AXFocusedWindow` + census) works; mutation refuses rather than guessing | observe returns honest `axSuspect`/focused-only data; every mutation op refuses with named reason | accept (macOS; Windows per its own probe gaps) |
| RC-S12 | Monitor loss / stale supervision state | US-A1, US-A4 | Dead monitor reported `monitor-lost`; corrupt/future state reads `unknown`, never `running` | `monitor-lost`/`unknown` reported within TTL bound; readers never mutate | accept |
| RC-S13 | Representative op battery with budgets | all US (perf) | §6 durationMs p50/p95 within manifest budgets across the attempt set | budget table pass per op | accept |
| RC-S14 | Recording overhead measurement | US-B4 | §6 recording-overhead budget measured and recorded (`measuredOverheadMs`, fps/drop stats) | within gui-evidence §11 budget or capability reports `degraded` with numbers | accept **only when recording is in the candidate**; otherwise `not-applicable` with reason |
| RC-S15 | Multi-instance non-interference | US-A3 | Two supervised sessions (or AE instances) do not cross-attribute windows, leases, or state | zero cross-attributed actions; per-session state isolated | accept where multi-instance is supported; else `not-applicable` |
| RC-S16 | Packed-consumer path (ae-test / ae-devtools / named consumer) | US-A4, US-B1..B4 | Consumer drives the same tarball through its real entry point; consumer-visible results match ledger | consumer run recorded as attempts on the same candidate identity | accept per consumer availability; a consumer that cannot run reports `blocked`, not absent |

**Explicitly out of scope for RC acceptance** (from #337 non-goals and safety boundaries — recorded here so their absence is a decision, not an omission):

- Full side-effect restoration or mid-operation resume of arbitrary scripts (US-A2 non-goal).
- OCR/screenshot/AI-based GUI detection or decision paths (gui-supervision spec non-goal).
- Auto-approval of OS/Adobe consent, licence, or sign-in flows (US-A3).
- Remote-worker/queue behavior (ae-farm scope).
- Guaranteeing every possible dialog class is auto-safe; unknown ends in controlled stop (that *is* the requirement).

## 9. Guarantee-boundary matrix

Before an RC run, a **machine-readable guarantee-boundary matrix** must exist covering every public capability/operation, with per-row:

```json
{ "capability": "…", "op": "…", "platforms": ["macos", "windows"],
  "support": "supported | partial | unsupported",
  "verificationLevel": "implemented | automated test | fake/mock only | verified on real host",
  "gate": "panelMutationGate | recordingScopeAuthorizer | supervision attestation | … | none",
  "refuseConditions": ["foreign-attribution", "unknown-ownership", "…"],
  "evidenceRef": "spec/ADR/issue pointer" }
```

Requirements:

- The matrix must agree with each spec's "Verification levels reached" table; a disagreement is a spec bug to fix before the run, not a run finding.
- `verificationLevel` may not exceed what the linked evidence supports; `verified on real host` requires RC-run or prior real-host evidence bound to a named candidate.
- RC acceptance validates consistency fail-closed: a public op missing from the matrix, or a matrix row claiming support the run contradicts, invalidates the run.
- Generation/maintenance tooling is a follow-up ticket; until it exists, a hand-maintained matrix under `docs/evidence/` is acceptable if it carries `schemaVersion` and the same fields.

## 10. Teardown verdict

Every attempt that launched, attached to, or mutated a session ends with a structured **teardown verdict**, recorded in the ledger (`cleanup` field) and retained as evidence:

- Process state: owned sessions quit through the public close path; attached sessions provably left running (no quit); no third-party process touched.
- Input state restored: input source, clipboard, IME composition state returned to pre-run condition (per B-IME contract where input was used).
- Leases released: GUI lease and monitor lease free; no held lease blocks the next attempt.
- Supervision residue: durable supervision document removed or expired per its TTL; no `monitor-lost` residue mistaken for a live monitor.
- Artifact residue: channel dirs, staged host scripts, temp fixtures either cleaned or listed as retained-with-reason.

Verdict ∈ `clean` / `residue` (with itemized list) / `unverifiable` (could not determine — honest, never `clean` by default). Safety-relevant residue — a killed non-owned process, a press on a non-target window, a consent change — is an automatic scenario `fail` regardless of functional outcome.

## 11. Honesty rules

1. `blocked`, `skipped`, `environment`, and `indeterminate` **never count as pass** — in scenario verdicts, in the consecutive-success count, in platform records, and in any summary. This is the same fail-closed principle as `A8N_RESULT` (`real: "pass"` is the only pass; exit code proves nothing) and `evidence-gate.js` (missing/stale/failed records deny).
2. **Failed attempts are first-class evidence.** They stay in the ledger with full steps and refs. Deleting, overwriting, or re-running-around them is candidate brute-force and invalidates the entire run set.
3. **No verification-only ad-hoc recovery.** Recovery during an RC run goes through the public, audited paths under test. An operator manually dismissing a dialog "to keep the run going" converts the attempt to `environment`/`blocked` with the intervention recorded — the scenario does not get a pass for a state automation did not handle.
4. **No silent narrowing.** A scenario or US that cannot run is reported `blocked`/`not-applicable` with reason and tracking reference; it is not dropped from the matrix.
5. Every claim carries its verification level per `docs/consumer-acceptance.md` §4. `fake/mock only` is never reported as working; `verified on real host` requires a public-path run on the fixed candidate (§3, §4) — PoC scripts and fake lanes do not qualify.
6. The run manifest, budgets (§6), fixture manifest (§7), guarantee-boundary matrix (§9), and ledgers (§5) are published together under `docs/evidence/`; the `platforms/*.json` records point at them.

## 12. Acceptance / verification of an RC run

An RC acceptance run is judged as follows:

1. **Preconditions**: candidate frozen (§3); budgets declared (§6); fixture manifest fixed (§7); guarantee-boundary matrix published (§9); platform lanes named.
2. **Execution**: scenarios RC-S1..RC-S16 run on the public path (§4) per platform lane; every attempt lands in the ledger (§5); teardown verdicts recorded (§10).
3. **Per-scenario verdict**: `pass` requires the verdict criterion *and* the consecutive-success rule (§7) *and* all budgets met; otherwise `fail` / `indeterminate` / `blocked` / `environment` / `not-applicable` as defined.
4. **Per-US verdict**: a US is accepted only when every scenario mapped to it in §13 has a `pass` verdict on every required platform lane, or an explicit `not-applicable`/`out-of-scope` row with recorded reason. US verdicts roll up to the RC verdict: `pass` only if every in-scope US passes; any `fail` → `fail`; missing evidence → `blocked`. The RC verdict is an input to the human release decision in `docs/releasing.md`, not a publish authorization.
5. **Evidence packaging**: ledger + run manifest + budgets + fixture manifest + matrix + teardown verdicts + per-platform `platforms/*.json` records bound to the candidate identity, under `docs/evidence/`.

## 13. Traceability — program US to scenarios

Every #337 user story maps to at least one RC scenario or an explicit out-of-scope decision. Nothing is silently narrowed.

| US | Scenarios | Notes / out-of-scope |
| --- | --- | --- |
| US-A1 (detect/classify/respond to blocking states on the normal path) | RC-S1, RC-S2, RC-S3, RC-S4, RC-S5, RC-S6, RC-S12 | Unknown-class handling ends in controlled stop by design; "every dialog auto-safe" is a non-goal (§8) |
| US-A2 (UNKNOWN non-resend; proven-loss rebuild; new-generation continuation) | RC-S2, RC-S7 | Arbitrary-script side-effect restoration / mid-op resume: out-of-scope per #337 |
| US-A3 (execution-mode/ownership boundaries; non-interference; no consent auto-approval) | RC-S8, RC-S9, RC-S15 | Remote-worker supervision: ae-farm scope, out-of-scope |
| US-A4 (runtime facts, nextActions, evidence on every surface) | RC-S1, RC-S12, RC-S16 | Consumer-specific UX depth is downstream scope; ae-a8n must expose the facts |
| US-A5 (test outcome/recovery/retry separation; circuit breaker; no fake PASS/SKIP) | RC-S7, RC-S10 | — |
| US-B1 (panel identify → resize → capture → ae-test assertion, both OS) | RC-S16 (+ capability ops in §9 matrix) | Accept **when B-PANEL/B-TEST slices are in the candidate**; until then `not-applicable` with tracking (#343, ae-test#144) — never claimed |
| US-B2 (CEP composition vs OS IME E2E; input/convert/confirm/cancel) | RC-S16 (+ B-IME ops) | Accept when B-IME (#344) slice is in the candidate; ScriptUI/native/custom-draw surfaces per actual verification, internal composition observation not initially required (#337) |
| US-B3 (window/timeline/comp/layer/effect/RQ/workspace real-operation slices) | RC-S8, RC-S16 (+ per-slice ops) | GUI path only — scripting mutation never substitutes (workspace-editing spec §2); slices land per #345, each activates its scenario on merge |
| US-B4 (GUI stills/regions/panels/dialogs, original vs derived, operation recording vs AE render, trace/artifact correlation) | RC-S14, RC-S16 | Accept when B-EVIDENCE (#346) is in the candidate; renderer/viewer non-goals per gui-evidence spec |

## 14. Verification levels reached by this document

| Claim | Level |
| --- | --- |
| This acceptance contract exists as spec/ADR text | `implemented` (this document) |
| Anchors cited (`readinessTimeoutMs` 180 s default, monitor interval 2 s / TTL 30 s, `recoveryGraceMs`, UNKNOWN non-resend, `platforms/*.json` schema, gui-evidence §11 budget proposal, #406 AX non-vend behavior) | `implemented` — read from source/docs; the underlying behaviors carry their own levels per the safety-gates audit |
| Attempt ledger, guarantee-boundary matrix, teardown verdict, RC harness | not implemented — follow-up tickets; this spec fixes only the required shape |
| Any RC scenario outcome (RC-S1..RC-S16) | `unverified` — no RC run has executed under this contract |
| "10 consecutive" bar | codified here from the provisional convention used in earlier real-host runs; the number is a contract decision, not a measurement |
