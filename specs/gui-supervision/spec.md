# GUI supervision product contract

- Decision: [ADR-0005](../../docs/adr/0005-session-supervision.md)
- Epic: [#278](https://github.com/ido-bata/ae-a8n/issues/278)
- Status: **proposed**. No command or API named below is implied to exist yet.
- Builds on: [execution-model spec](../execution-model/spec.md) (US3 safety/recovery), [isolated-ae spec](../isolated-ae/spec.md), ADR-0003.

## Problem

After Effects stops answering for many reasons that are not request failures: modal dialogs (script errors, crash repair, unsaved-changes confirmations, permission and sign-in prompts), crashes, busy periods (startup, render, quit), and GUI session changes (lock, disconnect, console switch). Today ae-a8n learns about these only when a call times out, classifies them reactively on macOS only, presses only one measured dialog class, and has no shared, continuous record of what the target's GUI is doing. A consumer that is not the process that timed out — another CLI invocation, an MCP server, a VS Code extension — cannot see the blocked state at all. On Windows there is no GUI observation beyond `tasklist /V` "Not Responding".

The product requirement is: **an agent must never be silently stalled by an unobservable After Effects.** Blocking must be detected, classified, reported, recovered when safe, and escalated when not — as an explicit state, not as an unexplained timeout.

## User stories

**US1 — Continuous honest observation.** While a session exists, the target's GUI and process state are observed by OS-native means that do not depend on After Effects' own script execution path (ExtendScript, the in-AE dispatcher, or the native-channel plug-in). Observation works while AE is wedged, and observation failure is reported as degraded/unknown — never as "no windows" or "healthy".

**US2 — Explicit supervision state.** Every supervised session has a durable, schema-versioned supervision state that any consumer can read: `running`, `blocked`, `recovering`, `resumed`, `needs-human`, or `quarantined`. Each state carries when it was entered, its deadline, the evidence behind it, and the requests it affects. A monitor that stops writing is detected as `monitor-lost`; stale or corrupt state is `unknown`, never healthy.

**US3 — Safe automatic recovery.** When a blocking state is a dialog class the project has measured as safe, recovery dismisses it through the GUI lease and audit path, then reconciles the original request's outcome (a late result is authoritative; an unknown outcome is never resent). Unsent requests may proceed; possibly-executed requests are never duplicated.

**US4 — Structured human escalation.** When recovery requires a human — sign-in, licence, unsaved-changes decisions, script permissions, unknown dialogs — the session reports `needs-human` (or `quarantined` for unmeasured state) with the dialog's structured content, why automation stopped, the choices available, and how to resume. The wait is bounded: no consumer waits forever.

**US5 — Owned crash rebuild.** When an owned (disposable) AE process is proven gone, the session may relaunch and re-prove ownership through the existing launch path, then resume supervision. Attached and unknown-ownership sessions are never killed, restarted, or mutated; they escalate instead.

**US6 — Multi-client consistency.** CLI, MCP, and editor surfaces read the same durable supervision state for a session. Exactly one monitor writes it (monitor lease); readers never mutate. GUI mutations remain serialized by the existing GUI lease and audit.

## Capability contract

### Observation (GuiProbe)

Per-OS probes produce a structured observation, independent of the AE execution path:

- **Window census**: every top-level window belonging to the target pid — title, class/role, subrole, geometry, visibility, enabled state, owning process, OS session id.
- **Element tree**: buttons, static texts, and other actionable elements with machine-readable names/identifiers, to the extent the OS accessibility API provides. Windows where the element API yields nothing are still reported as existing windows — absence of detail is not absence of a window.
- **Process state**: pid + start-time/creation identity re-proof, liveness, and the OS "not responding" signal where available.
- **Session state**: GUI session identity, console/lock state where the OS exposes it.
- **Monitor heartbeat**: the observation loop's own liveness, so a dead monitor is distinguishable from a healthy target.

macOS sources: Accessibility API tree, `CGWindowListCopyWindowInfo` census, `lsappinfo`/process identity (existing `window-census.ts`, `gui-recovery.ts`, `mac-session.ts`). Windows sources: Win32 window enumeration plus UI Automation where available (implementation vehicle is a ticket-level decision; the contract is OS-native structured data, not pixels).

**Prohibited as primary detection**: screenshot interpretation, OCR, and image/AI-based judgment. Screenshots may be captured as evidence for humans; they are never the detection or decision path. Where the OS APIs cannot see inside a window, the contract reports what is known (window exists, owner, state) and classifies content as unknown — it does not guess.

### Blocking taxonomy

Two axes, reported separately:

1. **Host-level state** (not a dialog): `process-gone`, `not-responding`, `busy-suspected` (alive, no blocking window, not answering — e.g. render/startup/quit), `gui-session-lost`, `monitor-lost`, `unknown`.
2. **Window-level class** for each blocking window, with an evidence-backed tier:
   - `auto-safe` — a measured dialog class whose dismissal button was verified on a real host; the only tier automation may press.
   - `human-required` — measured classes that belong to a human decision (sign-in, licence, script permission, unsaved-changes save/discard, crash-repair choices).
   - `report-only` — measured states that are informational or whose safe action is not pressing (e.g. busy indicators surfaced as windows).
   - `unknown` — anything unmeasured. Always quarantine; never pressed.

Tier membership requires recorded real-host evidence (OS, AE version, dialog identity, observed structure, why the action is safe). A class is never added "to be helpful". Existing `MEASURED_DIALOG_CLASSES` / `UNPRESSABLE_DIALOG_CLASSES` / `isHumanOnlyWindow` in `src/platform/recovery-policy.ts` and `src/driver/recovery.ts` are the seed of this taxonomy and are extended, not replaced.

### Supervision state machine

```
running → blocked → recovering → resumed
                     │   └──────→ needs-human → (human acts) → recovering → resumed
                     └──────────→ quarantined
```

- `running`: no blocking state observed; requests flow normally.
- `blocked`: a blocking window or host-level state was observed. Carries the classification, evidence, and affected pending requests. Entered from observation, not only from timeouts — detection should precede the request deadline where polling allows.
- `recovering`: an automated recovery action is in progress (bounded).
- `resumed`: blocking cleared and the original request's outcome was reconciled (late result accepted, or the request provably never ran and a bounded retry policy applies). Never means "dialog closed" alone.
- `needs-human`: a structured human decision is required. Includes what to look at, the options, and the resume path.
- `quarantined`: state could not be classified safely. Nothing was pressed; the run reports `A8N-SEC-001`-class evidence and stops mutating until a human resolves it.

Every state records `enteredAt`, `deadline` (bounded — no state waits forever), transition reason, evidence references, and affected request ids. Observation health (`ok` / `degraded` / `monitor-lost` / `unavailable`) is reported alongside the state and is never folded into "healthy".

### Durable shared state and monitor lease

- Supervision state is persisted in the session directory as a schema-versioned document with atomic publish. It is the single source of truth all clients read.
- Exactly one monitor writes at a time, elected by a cross-process monitor lease (same pattern family as the GUI lease and Windows channel lock). A standby monitor may take over after lease expiry; a dead monitor's stale heartbeat is reported as `monitor-lost`, not as a healthy target.
- Corrupt, unreadable, or future-version state is `unknown`, never defaulted to `running`.
- GUI mutations (press/click/rebuild) go through the existing GUI lease + audit on macOS and the equivalent lease on Windows; the monitor lease governs observation writes, the GUI lease governs screen mutations. They are separate authorities.

### Recovery rules

- Only `auto-safe` classes may be pressed, only through the lease + audit path, only after re-verifying the target pid identity and the window's measured shape immediately before acting.
- `human-required` and `unknown` are never pressed. Unknown is quarantined with structured evidence.
- A timed-out or blocked request is **never resent** while its execution is uncertain (UNKNOWN semantics already established for dispatcher/native-channel transports apply to all transports). After recovery, the original request's late result is awaited within a bounded grace window and, if present, is authoritative.
- Owned sessions may rebuild after proven process loss via the existing launch path (re-prove pid identity, single instance, readiness probe, provenance). Attached/unknown sessions never restart or mutate the host.
- Recovery never touches windows not belonging to the target pid, never operates other applications, and never changes global OS/Adobe permission settings.
- Multi-script contention (#41) is handled at its root: the dispatch layer's serialization/in-flight rules are the fix; the dialog itself is classified and reported, not merely dismissed.

### API / CLI surface (direction, finalized per ticket)

- A read-only supervision report on the public API (working name `ae.supervision()`), returning the durable state plus observation health — `unavailable`/`degraded` are honest answers, not empty successes.
- `ae-a8n supervise` CLI for status/watch from any client, reading the same durable state.
- Trace and audit: supervision transitions, monitor heartbeats, and every GUI mutation are recorded in the session trace and GUI audit log.
- `ae.capabilities()` reports which supervision features the platform/transport supports and at what verification level.

## Acceptance / verification

1. **Contract tests (all platforms, fake host)**: state machine transitions, durable state corruption/staleness handling, lease exclusivity and takeover, bounded waits, UNKNOWN non-resend, attached-session no-mutation.
2. **macOS real host**: measured dialog classes observed and handled per tier; blocked detection before timeout where polling allows; owned crash → verified rebuild → resumed; session lock / process loss reported honestly.
3. **Windows real host**: window census + UIA (or documented fallback) observation; Not Responding / busy classification; measured-class press only where real-host evidence exists; no mutation of non-target windows.
4. **Consumer**: ae-devtools CLI/MCP/VS Code read the same supervision state and present needs-human/resume paths without reimplementing GUI logic.
5. Every claim carries its verification level. `fake/mock only` is never reported as working; unverified dialog classes are never marked auto-safe.

## Non-goals

- Guaranteeing every possible dialog can be auto-dismissed. Unknown blocking state ends in a controlled, structured stop — that is the requirement, not a failure of it.
- Screenshot/OCR/AI-based GUI understanding as a detection or decision path.
- Non-interference or isolation promises (ADR-0003 modes unchanged).
- ae-devtools owning any part of GUI observation or recovery.
- Replacing the dispatcher/native-channel transports; supervision observes and recovers around them.
