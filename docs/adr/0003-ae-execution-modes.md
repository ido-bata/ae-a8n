# ADR-0003 — Separate AE execution from desktop isolation

- Status: **Proposed; proof required before changing the default**
- Decision issue: [#97](https://github.com/ido-bata/ae-a8n/issues/97)
- Proof: [#98](https://github.com/ido-bata/ae-a8n/issues/98)
- Delivery: [#99](https://github.com/ido-bata/ae-a8n/issues/99)
- Supersedes the *assumption that cross-user GUI entry is the default execution strategy* in [isolated AE plan](../../specs/isolated-ae/plan.md). Does not supersede its non-interference or safety requirements.

## Problem

ae-a8n's public TypeScript API and its versioned ES3 host dispatcher work on macOS and Windows. The macOS isolated-test path instead requires entering another GUI user's session for each job and sending Apple Events from an external process. Aulymo's real helper-host runs showed TCC responsibility assigned to Ghostty even after UID changes, permission error `-1743`, and AE instances left after failed readiness probes ([Aulymo #332](https://github.com/rebuildup/Aulymo_v04/issues/332), [ae-a8n #95](https://github.com/ido-bata/ae-a8n/issues/95)). Fixing that failure improves recovery but does not make cross-user entry a maintainable default.

The product requirement is **repeatable AE automation**, with **non-interference for isolated testing**. Those are separate capabilities; a transport must not claim the latter merely because the former works.

## Decision

Preserve `@ido-bata/ae-a8n`'s library API, static named extension contract, ES3 host operations and report/trace schemas. Introduce an explicit execution target beneath them:

| Mode | Meaning | UX / safety contract |
| --- | --- | --- |
| `local` | AE in the current interactive OS user's session | Easy explicit connection; **no non-interference promise**. Attaching to an existing AE requires explicit intent. Do not quit anything not proven owned. |
| `remote` | Dedicated AE host/VM, logged in under its own user | **Default for unattended isolated tests**. Controller only sends authenticated, bounded jobs. Host controls its own AE; no controller-side cross-user UI automation. |
| `isolated-user` | Another GUI user on the same machine | Experimental until measured on clean machines. No mandatory sudo/launchctl/Ghostty path for basic product use. Never silently fall back to the console. |

Separate **bootstrap** (user installs/activates a host component and grants necessary OS/Adobe permission once) from **per-operation dispatch**. The latter must not need `sudo`, cross-user `launchctl`, `osascript` permission prompts, physical keyboard input or foreground switching. Bootstrap can still require the human to open or authorize AE. No software can promise that all AE operations themselves are non-disruptive or that the host will never display UI.

### Candidate execution transport

The first hypothesis is an **AE-internal dispatcher**. An explicitly activated ES3 script runs inside AE, checks a private local request channel via `app.scheduleTask`, and returns an envelope. The Node controller does not send a per-command Apple Event. [#98](https://github.com/ido-bata/ae-a8n/issues/98) proves this with a strictly read-only `app.version` operation, not arbitrary JSX or a rewritten AE DOM. If proven, reuse the existing static `host/a8n-host.js` dispatcher/envelopes as the next step rather than implementing parallel API semantics.

The proof's manual File → Scripts activation is **not** the production onboarding design. Startup script or plugin installation, coexistence with other scripts, polling cost, signed/ACL-bound channels, crash recovery, user consent, and macOS/Windows compatibility are independent gates for production. An unproven proof must never be included in `@next` as ready-to-use.

The existing macOS Apple Event and Windows `AfterFX.exe -r` transports remain **compatibility fallbacks**, clearly identified by capability. A dedicated-host broker is a separate layer from AE dispatch: it may deliver commands from a remote controller, but it runs beside AE **as that host user**, and authenticates jobs/agent/host using the remaining security contracts in [#93](https://github.com/ido-bata/ae-a8n/issues/93) and [#94](https://github.com/ido-bata/ae-a8n/issues/94).

### Public API / CLI direction (not yet shipped)

- Preserve `AfterEffects.launch()` compatibility. Propose an **explicit** `connect({ target, mode })` or equivalent before exposing a new default. Do not silently reinterpret `launch()` as permission to manipulate another user's AE.
- `doctor` reports the available transport and what it can prove; missing AE/bridge is BLOCKED, not a passing test. `setup` must be genuinely guided, not a disguised platform-specific manual checklist.
- Isolated `test` requires a positively proven separate host or separately validated session. Local ordinary automation can work without isolation but must not claim it.
- Timeouts never retry unknown host actions; session identity, request id, result authenticity, owner, AE version, process identity where known, and exact binaries are recorded. Ownership provenance alone never permits quitting a process.

## Independent review refinements (2026-11-11)

### Why in-AE execution is preferable

The observed `-1743` was attributed by `tccd` to the **responsible application, Ghostty**, not simply to the effective UID or to the Apple Event destination. A controller that runs `osascript` from a different session/UID can still inherit an unexpected TCC responsible process. The major benefit of an in-AE dispatcher is **removing per-operation TCC/Apple-Event sender identity from the trust chain**, not merely eliminating one API call. This does not remove AE scripting-file permissions or one-time human consent from bootstrap.

### Trust boundary of the file channel

A user-private directory (`0700`/files `0600` on POSIX; verified user-only ACLs on Windows) protects primarily against **other OS users**, not malicious code running under the **same OS user**. A channel token readable by that user is **not** same-user authentication. Do not call this a secure transport, locally authenticated agent, or remotely safe endpoint on the basis of a token and file mode alone. Define distinct threats for (a) local accidental clients, (b) same-user adversarial clients, (c) other users, and (d) network/remote controller; prove a boundary before advertising it. Keep the read-only proof restricted to `app.version`.

### AE scheduling and deadlines

`app.scheduleTask()` executes in AE's scripting/GUI process: modal dialogs, blocking host activity and long-running renders can delay or suppress polling. Distinguish **AE busy**, **bridge not activated**, and **lost permission** only where actual evidence supports the distinction; otherwise report `UNKNOWN` and do not retry. Expired unclaimed jobs may be refused, but once claimed a long AE operation remains serialized. This architecture **does not remove AE main-thread contention or guarantee cancellation**, and does not eliminate unknown outcomes. It only decouples Node's per-request control from OS-delivered Apple Events and permits observable queue/deadline handling. Measure idle and render-time CPU/latency and focus behaviour separately.

### Bootstrap is the first production gate

Prove whether an ordinary, non-admin user can install an **AE-specific per-user `Scripts/Startup`** entry and have it activate consistently after restart on macOS and Windows **before** full bridge/API integration. Adobe documentation confirms user-scoped Scripts support; the exact per-user Startup lookup and execution behaviour in supported AE 2026/2027 builds still needs real-host verification. Document user controls for disable/uninstall, version upgrades, script-file/network permission prompts and corporate policy denial. Never silently change global AE scripting permissions. Initial manual `File → Scripts → Run Script File` is only a reversible proof step.

Do not couple product readiness to a specific terminal application or local username. If startup loading is denied by policy, explicitly evaluate a signed CEP/UXP host or dedicated-host approach rather than resurrecting cross-user per-call Apple Events as the default.

References: [Adobe per-user Scripts support](https://blog.adobe.com/en/publish/2013/09/08/after-effects-cc-12-1-whats-new-and-changed), [Adobe Scripts guide](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html), [After Effects startup script model](https://ae-scripting.docsforadobe.dev/introduction/overview/).

## Alternatives

- **Root → launchctl → helper → Apple Events every run:** rejected as product default. Real runs show TCC attribution depends on the responsible app (Ghostty) and partial launches can leave AE behind. Retain only as experimental opt-in.
- **GUI-session agent in a helper `.app` bundle:** plausible alternative; not selected without real evidence that TCC attribution, permissions and clean first-run onboarding are stable. Could be useful for remote host bootstrap.
- **CEP panel:** supports `evalScript` in current AE but depends on a legacy platform and panel lifecycle. Can be an alternative execution host if the in-AE script probe fails, not a mandatory dependency.
- **UXP:** Adobe announced AE public beta in November 2026, with broad production availability expected later. Evaluate it when the relevant AE host APIs, plugin loading and remote IPC work in a released build; do not require a beta for a generic stable package.
- **AE render-only subprocess (`aerender`):** useful for rendering but does not replace interactive composition/layer/property automation.

## Evidence and exit rules

[#98](https://github.com/ido-bata/ae-a8n/issues/98) is a reversible, read-only proof with a user-started AE and no project mutations. It must measure macOS and Windows separately; the absence of Apple Event **calls** is checkable in code, but the absence of TCC prompts, focus changes and GUI interference requires real-host observation. Validate that scheduled polling runs under host load without freezing AE, and that stale/duplicate requests are not replayed.

[#99](https://github.com/ido-bata/ae-a8n/issues/99) owns user-facing usability, an npm clean install, genuine AE operations, reconnect/recovery, dedicated-host isolation and ae-test/Aulymo acceptance. A green fake host is never a real-host PASS.

Do not merge a speculative new transport into a published entry path or remove existing working transports before evidence, review and migration coverage.

## External grounds

- [Adobe After Effects scripts](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html)
- [After Effects scripting: scheduleTask](https://ae-scripting.docsforadobe.dev/general/application/)
- [After Effects scripting: Startup/Shutdown](https://ae-scripting.docsforadobe.dev/introduction/overview/)
- [Adobe UXP transition announcement, 2026-09-24](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications)
- [AE UXP developer forum update, 2026-11-06](https://forums.creativeclouddeveloper.com/t/after-effects-is-adding-uxp-plugin-support-private-beta-now-open/12273)
