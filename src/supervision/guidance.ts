/**
 * Derive the machine-readable next actions for a supervision report
 * (#341, parent program #337 US-A4).
 *
 * This is the single place supervision facts become guidance, so
 * `ae.supervisionState()`, `ae-a8n supervise`, the session trace and any
 * future consumer all hand out the same `nextActions[]`. The mapping is
 * deliberately conservative:
 *
 *   - `inspect` (read evidence) is always permitted — observation mutates
 *     nothing.
 *   - `wait` is permitted only while a bounded deadline exists; the
 *     action text names it so a consumer can bound its own wait.
 *   - Anything needing a human (`needs-human`, `quarantined`,
 *     `monitor-lost`, `unavailable`) is reported with `allowed: false`.
 *     Automation NEVER gets an allowed action that presses a dialog,
 *     grants a permission, runs a shell command, or interprets OCR text —
 *     those classes do not exist in this vocabulary.
 *   - Pending requests in `unknown`/`timed-out` never produce a retry:
 *     their outcome is unproven and resending is forbidden.
 */

import {
  humanAction,
  inspectAction,
  nextAction,
  waitAction,
  type NextAction,
} from "./next-actions.js";
import type { SupervisionReportFacts } from "./types.js";

const INSPECT_REPORT =
  "Read the supervision report (`ae.supervisionState()` or " +
  "`ae-a8n supervise status --session-root <dir>`) for the structured " +
  "blocking evidence before deciding anything else.";

function windowSummary(report: SupervisionReportFacts): string {
  if (report.status !== "observed" || report.doc.blocking === null) {
    return "";
  }
  const titles = report.doc.blocking.windows
    .map((w) => w.title || w.dialogClass || w.role)
    .filter((t) => t.length > 0);
  return titles.length === 0 ? "" : ` Blocking windows: ${titles.join(", ")}.`;
}

/**
 * The next actions a supervision report implies. Empty only for a healthy
 * `running`/`resumed` session with live observation — the one state where
 * nothing is owed.
 */
export function supervisionNextActions(
  report: SupervisionReportFacts,
): readonly NextAction[] {
  if (report.status === "unavailable") {
    const corrupt = report.source === "corrupt";
    return [
      inspectAction(
        "supervision.state",
        corrupt
          ? "Inspect the supervision state file named in `stateFile`; it failed schema validation."
          : "Confirm `--session-root` names the session's own directory; a live session's monitor may not have started.",
        "permitted",
        "the durable evidence is unavailable; reading it is still safe",
      ),
      humanAction(
        "supervision.unavailable",
        "evidence-unavailable",
        corrupt
          ? "The supervision state is corrupt or from a future schema: a human must decide whether to keep or remove it before automation can trust this session."
          : "No trustworthy supervision state exists for this session root; if a session should be supervised, start it through the normal launch path so a monitor is attached.",
      ),
    ];
  }

  const doc = report.doc;
  const actions: NextAction[] = [];

  // Observation health is orthogonal to the phase: a monitor-lost or
  // degraded pipeline means even a `running` phase is not proven.
  if (report.health === "monitor-lost") {
    actions.push(
      inspectAction(
        "supervision.health",
        "Read the durable supervision document and trace; the monitor's heartbeat is stale, so the target's current GUI state is unknown — not healthy.",
      ),
      humanAction(
        "supervision.monitor-lost",
        "monitor-lost",
        "Restart or re-attach the session's supervision (a new launch/attach starts a monitor); until then treat the host state as unknown.",
      ),
    );
  } else if (report.health === "degraded" || report.health === "unavailable") {
    actions.push(
      inspectAction(
        "supervision.health",
        `Observation is ${report.health}${report.healthDetail === null ? "" : `: ${report.healthDetail}`}. Read the evidence before relying on the phase.`,
      ),
    );
  }

  switch (doc.phase) {
    case "running":
    case "resumed":
      break;
    case "blocked":
    case "recovering": {
      const deadline =
        doc.deadline === null ? "the phase deadline" : `the phase deadline ${doc.deadline}`;
      actions.push(
        waitAction(
          "supervision.blocked",
          `After Effects is ${doc.phase}: ${doc.blocking?.detail ?? "a blocking state was observed"}.${windowSummary(report)} ` +
            `Wait within ${deadline}; automation is already recovering or the monitor will classify further.`,
        ),
        inspectAction("supervision.state", INSPECT_REPORT),
      );
      break;
    }
    case "needs-human": {
      const detail = doc.blocking?.detail ?? "a human decision is required";
      actions.push(
        humanAction(
          "supervision.needs-human",
          "requires-human",
          `After Effects needs a human: ${detail}.${windowSummary(report)} ` +
            "Resolve it in the After Effects window, then the monitor returns to `recovering`; automation never presses unmeasured dialogs.",
        ),
        inspectAction("supervision.state", INSPECT_REPORT),
      );
      break;
    }
    case "quarantined": {
      const detail = doc.blocking?.detail ?? "the blocking state could not be classified safely";
      actions.push(
        humanAction(
          "supervision.quarantined",
          "unsafe-to-automate",
          `Supervision is quarantined: ${detail}.${windowSummary(report)} ` +
            "Nothing was pressed and nothing may be pressed until a human resolves the state; inspect the evidence in `stateFile`.",
        ),
        inspectAction("supervision.state", INSPECT_REPORT),
      );
      break;
    }
  }

  // A recovered session whose original request stayed unresolved is NOT
  // a retry licence: `unknown`/`timed-out` outcomes are never resent.
  // Surface that fact as guidance so no consumer invents a resend.
  const unresolved = doc.pendingRequests.filter(
    (request) => request.state !== "in-flight",
  );
  if (unresolved.length > 0 && (doc.phase === "resumed" || doc.phase === "running")) {
    actions.push(
      nextAction({
        kind: "human",
        allowed: false,
        code: "supervision.pending-unknown",
        reason: { code: "unknown-outcome" },
        action:
          `${unresolved.length} request(s) from before the block have unproven outcomes ` +
          `(${unresolved.map((r) => `${r.method}:${r.state}`).join(", ")}). ` +
          "They are never resent automatically; reconcile them from evidence or re-issue deliberately.",
      }),
    );
  }

  return actions;
}
