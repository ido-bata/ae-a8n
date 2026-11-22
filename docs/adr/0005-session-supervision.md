# ADR-0005 — OS-native session supervision independent of the AE execution path

- Status: **Proposed**
- Epic: [#278](https://github.com/ido-bata/ae-a8n/issues/278)
- Spec: [`specs/gui-supervision/spec.md`](../../specs/gui-supervision/spec.md)
- Related: [ADR-0003](0003-ae-execution-modes.md) (execution modes / trust boundaries), [#41](https://github.com/ido-bata/ae-a8n/issues/41), [#107](https://github.com/ido-bata/ae-a8n/issues/107), [#109](https://github.com/ido-bata/ae-a8n/issues/109), [#111](https://github.com/ido-bata/ae-a8n/issues/111)

## Problem

Every AE execution transport (script-invocation, in-AE dispatcher, native-channel) can stop answering while After Effects itself is alive but blocked: a modal dialog, a crash-repair prompt, an unsaved-changes confirmation, a permission or sign-in window, a busy render, or a dead GUI session. Today the only signal is a call timing out, and recovery is a reactive, macOS-only, single-shot path with a one-class press allow list. There is no continuous observation, no shared state between the processes that use a session (CLI, MCP, editor), no Windows GUI observation at all, and no explicit lifecycle for "blocked → recovering → resumed / needs-human / quarantined". An agent that is not the process that timed out cannot see any of this.

## Decision

### 1. Supervision is a first-class ae-a8n capability, owned below the public API

GUI observation, blocking classification, safe recovery, and the supervision state machine live in ae-a8n. ae-devtools (and any other consumer) reads the published contract — a read-only supervision report plus the durable session state — and never reimplements GUI probing, dialog pressing, or recovery policy. This matches the existing boundary: callers never see bridge protocols, and OS-specific GUI mechanics stay inside the driver/platform layers.

### 2. Observation is OS-native and independent of AE's execution path

Probes use the operating system's own windowing and accessibility APIs — on macOS the Accessibility tree plus the WindowServer window census (existing `window-census.ts` / `gui-recovery.ts` machinery, extended to a probe role); on Windows Win32 window enumeration plus UI Automation where available. These sources keep working while ExtendScript, the dispatcher, and the native channel are all dead, which is exactly when supervision matters.

Screenshots, OCR, and image/AI interpretation are **not** detection or decision paths. A screenshot may be stored as evidence for a human; it never classifies a window and never justifies a press. Where the element APIs cannot see inside a window, the observation reports the window's existence, owner, and state and classifies its content as unknown — it does not guess.

### 3. One durable state, one writer, many readers

Supervision state is a schema-versioned document in the session directory, atomically published, and is the single source of truth for every client of that session. A cross-process **monitor lease** elects the single writer; readers never mutate. A stopped monitor is detected via its heartbeat and reported as `monitor-lost`; stale, corrupt, or future-version state is `unknown`, never healthy. This extends the ownership/provenance model (#105/#108) from "which process is AE" to "what is AE's GUI doing".

The monitor lease and the GUI mutation lease are separate authorities: the former serializes observation writes, the latter serializes screen mutations (press/click), exactly as the macOS GUI lease already does for mutations and is now required equivalently on Windows.

### 4. An explicit, bounded state machine

`running → blocked → recovering → resumed`, with `needs-human` and `quarantined` as structured terminal-for-now states. Every state carries entry time, deadline, evidence, and affected requests. "Blocked" is entered from observation, not only from timeouts, so detection can precede a request deadline. "Resumed" requires the blocking state to be cleared **and** the original request's outcome reconciled — a late result is authoritative, and an uncertain request is never resent (the UNKNOWN contract already established for dispatcher/native-channel transports is generalized to supervision).

Bounded waits are part of the contract: `needs-human`, `quarantined`, and `monitor-lost` all resolve to structured results within deadlines. No consumer waits forever on an unobservable AE.

### 5. Recovery is evidence-gated and ownership-aware

Only dialog classes measured on a real host as safe (`auto-safe`) may be pressed, and only through the GUI lease + audit path after re-verifying target identity and window shape. `human-required` classes (sign-in, licence, script permission, unsaved-changes decisions, crash-repair choices) and `unknown` windows are never pressed. Multi-script contention (#41) is fixed at the dispatch layer's serialization rules; the dialog is classified and reported, not merely dismissed.

Owned sessions may rebuild after proven process loss through the existing launch path with full re-proof (pid identity, single instance, readiness probe, provenance). Attached and unknown-ownership sessions are never killed, restarted, or mutated — they escalate. This preserves the ownership table in `docs/sessions.md` unchanged.

### 6. Honesty is a contract requirement

Every supervision claim carries a verification level. `fake/mock only` is never reported as working; unverified dialog classes are never marked auto-safe; degraded observation is never folded into "healthy". The real-host verification matrix (Windows 11 / macOS, AE 2026/2027, per dialog class) is an acceptance gate, not an afterthought.

## Alternatives considered

- **Extend the reactive timeout→recovery path only.** Rejected: it cannot detect blocking before a deadline, gives non-owner processes no visibility, and cannot express needs-human/quarantined lifecycle or monitor health.
- **A separate supervision daemon/process per session.** Rejected for now: it adds a lifecycle to secure and supervise, and the monitor lease + durable state already provide takeover semantics with the driver in-process. Revisit if real-host evidence shows in-process monitoring is insufficient (e.g. the supervising process itself is the thing that dies — monitor-lost covers detection, and a consumer can re-elect).
- **Screenshot/OCR-based dialog recognition.** Rejected as a primary path: non-deterministic, locale-fragile, and it cannot produce the structured evidence the press policy requires. Retained as human-facing evidence only.
- **Let ae-devtools own GUI probing for its own sessions.** Rejected: it would duplicate OS-specific mechanics per client, violate the repo boundary (ae-devtools consumes, ae-a8n owns runtime), and produce divergent safety policies across CLI/MCP/VS Code.

## Consequences

- New platform work: a Windows GUI probe (Win32 + UIA) and an equivalent mutation lease — the largest new surface.
- The measured dialog taxonomy grows only with recorded real-host evidence; until then most dialogs correctly land in human-required/unknown.
- Consumers gain a uniform state to render; ae-devtools work is contract consumption, not GUI mechanics.
- Supervision adds polling cost; it must be measurable and disable-able per session, and must never itself block the AE it observes.
