/**
 * Supervision checks for `doctor --session-root` (#287,
 * specs/gui-supervision/spec.md §API / CLI surface).
 *
 * `doctor` reads the same durable `supervision.json` every other consumer
 * reads — never a second copy of the state. The checks exist so a degraded
 * or lost monitor is reported as what it is: an observation problem, not
 * a clean bill, and a `needs-human`/`quarantined` phase is a blocker
 * because automation is stopped until a human acts.
 *
 * Read-only: `supervisionReport` validates and re-evaluates the document
 * against the heartbeat clock; nothing here writes.
 */

import { supervisionReport } from "../supervision/index.js";
import { diagnostic, type DiagnosticCheck, type DiagnosticEvidence } from "./diagnostics.js";

function evidence(sessionRoot: string, extra: DiagnosticEvidence = {}): DiagnosticEvidence {
  return { sessionRoot, ...extra };
}

/**
 * The supervision checks for one session directory: zero or one check,
 * because the report is a single honest answer — healthy, degraded, or
 * absent. An `unavailable` report is a warning, not silence: the operator
 * asked about this session root, so "nothing trustworthy exists" is the
 * finding.
 */
export function supervisionChecks(sessionRoot: string, now?: Date): readonly DiagnosticCheck[] {
  const report = supervisionReport(sessionRoot, now === undefined ? {} : { now });

  if (report.status === "unavailable") {
    return [
      diagnostic("A8N-SUP-003", {
        detail:
          `no trustworthy supervision state for ${sessionRoot} ` +
          `(${report.source}): ${report.reason}`,
        remedy:
          "Confirm the directory is the session's own sessionRoot. If a session " +
          "is live, its monitor may not have started — restart the session or " +
          "inspect `ae-a8n supervise status`.",
        remedyKind: "human",
        evidence: evidence(sessionRoot, { source: report.source }),
      }),
    ];
  }

  const doc = report.doc;
  const base = evidence(sessionRoot, {
    phase: doc.phase,
    health: report.health,
    enteredAt: doc.enteredAt,
  });

  if (doc.phase === "needs-human" || doc.phase === "quarantined") {
    const detail =
      doc.blocking?.detail ??
      doc.blocking?.windows.map((w) => w.title || w.dialogClass || w.role).join(", ") ??
      doc.phase;
    return [
      diagnostic("A8N-SUP-001", {
        detail:
          `supervision reports ${doc.phase}: ${detail}. ` +
          "Automation is stopped until a human resolves it; the phase deadline bounds the wait.",
        remedy:
          "Resolve the dialog or state in the After Effects window, then re-run " +
          "`ae-a8n supervise status`. Automation never presses unmeasured dialogs.",
        remedyKind: "human",
        evidence: base,
      }),
    ];
  }

  if (doc.phase === "blocked" || doc.phase === "recovering") {
    return [
      diagnostic("A8N-SUP-002", {
        detail:
          `supervision reports ${doc.phase}: ${doc.blocking?.detail ?? "blocking state observed"}. ` +
          "Requests against this session may stall until recovery completes or escalates.",
        remedy:
          "Watch `ae-a8n supervise watch --session-root <dir>` for the transition, or inspect " +
          "`ae-a8n supervise status`. If it persists past the phase deadline, treat it as needs-human.",
        remedyKind: "human",
        evidence: base,
      }),
    ];
  }

  if (report.health !== "ok") {
    return [
      diagnostic("A8N-SUP-003", {
        detail:
          `supervision phase is ${doc.phase} but observation health is ${report.health}` +
          `${report.healthDetail === null ? "" : `: ${report.healthDetail}`}. ` +
          "The target's current GUI state cannot be fully trusted — degraded or " +
          "unavailable observation is never reported as healthy.",
        remedy:
          "Restart the session's monitor (or the session itself). Until observation is " +
          "healthy again, treat the GUI state as unknown rather than clean.",
        remedyKind: "human",
        evidence: {
          ...base,
          healthDetail: report.healthDetail,
          monitor: doc.monitor === null ? null : doc.monitor.ownerId,
          heartbeatAt: doc.monitor?.heartbeatAt ?? null,
        },
      }),
    ];
  }

  return [
    diagnostic("A8N-SUP-004", {
      detail:
        `supervision is ${doc.phase} with healthy observation` +
        `${doc.monitor === null ? "" : ` (monitor ${doc.monitor.ownerId})`}.`,
      remedy: "",
      remedyKind: "none",
      evidence: base,
    }),
  ];
}
