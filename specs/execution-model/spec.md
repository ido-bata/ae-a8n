# Execution-mode product contract

- Decision: [ADR-0003](../../docs/adr/0003-ae-execution-modes.md)
- Tracking: [#97](https://github.com/ido-bata/ae-a8n/issues/97), [#98](https://github.com/ido-bata/ae-a8n/issues/98), [#99](https://github.com/ido-bata/ae-a8n/issues/99)
- Status: **proposed**. None of the target-mode commands below is implied to exist in alpha.2.

## User-facing outcomes

**US1 — Quick local automation.** After normal installation, a developer can explicitly connect to AE running in their interactive user session, read its version and execute named supported operations. The connection reports whether it owns or attaches to the AE instance. It never quits an attached instance. It makes **no non-interference guarantee**.

**US2 — Unattended isolated testing.** A test runs against AE on a dedicated separate host/VM, not the console desktop. After documented one-time host setup, invoking a test from a clean npm consumer requires no sudo, login switching or TCC approval on each run. The controller receives report, trace, artifacts and a reliable cleanup verdict. Lack of host proof causes refusal.

**US3 — Safety and recovery.** Refuse an unproven target; no automatic consent dialogs; no cross-user fallback; no duplicate dispatch after an uncertain timeout; no silent process abandonment or unsafe quit. Operator can inspect/recover a quarantined run with a named target identity. Existing [#95](https://github.com/ido-bata/ae-a8n/issues/95) remains a prerequisite for partial-launch safety.

**US4 — Generic consumers.** ae-test and Aulymo use published immutable package bytes, same named extension API and trace/report schema. Aulymo-specific adapters remain downstream; no project-specific names in ae-a8n.

## Capability contract

Each transport reports, rather than infers: execution mode, host OS/user/session, target AE identity, ownership evidence, whether calls require GUI delivery, whether console non-interference is proven, and which host operations/extensions are implemented. `unproven` never means `proven`.

A local AE in-process proof does not establish a remote broker, desktop isolation, robust startup or recovery. A separated host by construction does not alone prove which instance of AE receives a command.

## Acceptance / verification

1. **Proof #98**: Read-only `app.version` twice against one running AE, no per-call Apple Event; timeout/duplicate/unknown method never triggers execution. Fake/Node tests and separate macOS/Windows real-host evidence.
2. **Library #99**: Normal-user install/reconnect succeeds twice on macOS and Windows. Session ownership, wrong-target refusal, intentional error, trace, frame output and exit cleanup are verified. No fixed UID, local checkout or terminal brand.
3. **Remote #99**: Dedicated-host unattended command succeeds from a different controller; host refuses wrong signed agent/job; no console disturbance, duplicated execution or unauthorized writes; disconnect/quarantine measured.
4. **Consumer #99**: ae-test #19 and Aulymo #332/#333 use the same published bytes and exercise an actual static extension operation; both success and failure are observed.
5. **Release gate**: No `latest` promotion without exact build/host evidence and #63/#75 gates. Unsupported or experimental paths remain documented and disabled by default.

Existing [isolated AE spec](../isolated-ae/spec.md) remains the record of the original same-machine test-user requirement. ADR-0003 supersedes its *default execution assumption*, **not** the requirement for proven non-interference or the need to investigate optional same-machine isolation.
