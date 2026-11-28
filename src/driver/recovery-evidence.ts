/**
 * Recovery evidence manifest (#342, parent program #337 US-A1).
 *
 * When the standard path runs a recovery attempt — measured-class press,
 * expected-modal resolution, quarantine, or an honest refusal — the
 * outcome's facts are bound into one JSON document inside the session's
 * artifact directory, next to the screenshots the attempt already wrote.
 * The manifest is the index a consumer (ae-test, ae-devtools, a human
 * reading a failed run) uses to find every piece of evidence without
 * knowing the internal layout:
 *
 *   - the operation and recovery results (this file plus the `session.recover`
 *     trace row it is written beside),
 *   - the before/after screen images, or the recorded reason none exists,
 *   - pointers to the session trace and to `ae.diagnostics()` for the
 *     host-side logs and crash reports.
 *
 * Honesty rules, same as the diagnostics collector:
 *
 *   - A capture that did not happen is recorded (`uncapturable`), never
 *     omitted — an absent field must never read as "nothing to see".
 *   - The CEP/CSXS log gap is named, not papered over: those sources are
 *     #336's scope, and the manifest says so instead of implying coverage.
 *   - Writing the manifest never breaks the recovery: a failure is noted
 *     on the trace row the caller already writes, not thrown.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RecoveryOutcome } from "./recovery.js";

/** The manifest schema id; bump on breaking shape changes. */
export const RECOVERY_EVIDENCE_KIND = "ae-a8n.recovery-evidence/v1";

export type RecoveryEvidenceRecord = {
  readonly kind: typeof RECOVERY_EVIDENCE_KIND;
  /** The operation whose wait triggered the recovery. */
  readonly requestId: string;
  readonly method: string;
  readonly timeoutMs: number;
  readonly recovered: boolean;
  readonly outcome: RecoveryOutcome["outcome"] | null;
  readonly code: RecoveryOutcome["code"] | null;
  /** The blocking window's one-line description, when one was seen. */
  readonly window: string | null;
  /** The registered expectation that classified the window, when one did. */
  readonly expectedModal: string | null;
  /** What the recovery saw and did — the same text the trace row carries. */
  readonly evidence: string;
  /** Screen images: paths when captured, recorded reasons when not. */
  readonly screenshot: {
    readonly before: string | null;
    readonly after: string | null;
    readonly note: string | null;
  };
  /** What could not be captured, and why. Empty means everything applied. */
  readonly uncapturable: readonly string[];
  /**
   * Per-window captures of census windows AX cannot account for (#451):
   * the AX-invisible-modal evidence. `path` is the image when one was
   * written; `note` records why none exists. Empty when the attempt saw
   * no such windows.
   */
  readonly censusCaptures: readonly {
    readonly window: string;
    readonly windowNumber: number | null;
    readonly path: string | null;
    readonly note: string | null;
  }[];
  /**
   * Host-side logs and crash reports are collected on demand by
   * `ae.diagnostics()` into the same artifact directory — the manifest
   * points there rather than duplicating the collector. `cepCsxs` names
   * the known coverage gap (#336) so a reader does not assume it.
   */
  readonly hostLogs: {
    readonly collector: string;
    readonly cepCsxs: string;
  };
  /** The supervision summary the attempt ran under, when a monitor exists. */
  readonly supervision: string | null;
  readonly capturedAt: string;
};

/**
 * Builds the uncapturable list from the outcome. A blocking window was
 * seen whenever `window` is set; then a missing image is a gap to record,
 * with the recovery's own note when it gave one.
 */
export function uncapturableEvidence(outcome: RecoveryOutcome): string[] {
  const gaps: string[] = [];
  if (outcome.window !== undefined) {
    if (outcome.screenshotPath === undefined) {
      gaps.push(
        outcome.screenshotNote === undefined
          ? "screen-image:before"
          : `screen-image:before (${outcome.screenshotNote})`,
      );
    }
    if (
      outcome.screenshotAfterPath === undefined &&
      outcome.screenshotPath !== undefined
    ) {
      // A press ran (before image exists) but no after image: the press
      // either was refused before mutating or the post-capture failed.
      // Only a mutation-uncertain or dismissed outcome makes the after
      // image owed; refused outcomes legitimately have none.
      if (outcome.outcome === "dismissed" || outcome.code === "A8N-SEC-001") {
        gaps.push(
          outcome.screenshotNote === undefined
            ? "screen-image:after"
            : `screen-image:after (${outcome.screenshotNote})`,
        );
      }
    }
  }
  // Census-window captures (#451): a window AX cannot see still owes its
  // image or its recorded reason — the `kind:"none"` path has no
  // `window` field, so this is the only place the gap is named.
  for (const capture of outcome.censusCaptures ?? []) {
    if (capture.path === undefined) {
      gaps.push(
        `window-capture:${capture.windowNumber ?? "unaddressed"}` +
          (capture.note === undefined ? "" : ` (${capture.note})`),
      );
    }
  }
  return gaps;
}

export function recoveryEvidenceRecord(input: {
  readonly requestId: string;
  readonly method: string;
  readonly timeoutMs: number;
  readonly outcome: RecoveryOutcome;
  readonly supervision: string | null;
  readonly capturedAt?: string;
}): RecoveryEvidenceRecord {
  const { outcome } = input;
  return {
    kind: RECOVERY_EVIDENCE_KIND,
    requestId: input.requestId,
    method: input.method,
    timeoutMs: input.timeoutMs,
    recovered: outcome.recovered,
    outcome: outcome.outcome ?? null,
    code: outcome.code ?? null,
    window: outcome.window ?? null,
    expectedModal: outcome.expectedModal ?? null,
    evidence: outcome.evidence,
    screenshot: {
      before: outcome.screenshotPath ?? null,
      after: outcome.screenshotAfterPath ?? null,
      note: outcome.screenshotNote ?? null,
    },
    uncapturable: uncapturableEvidence(outcome),
    censusCaptures: (outcome.censusCaptures ?? []).map((capture) => ({
      window: capture.window,
      windowNumber: capture.windowNumber,
      path: capture.path ?? null,
      note: capture.note ?? null,
    })),
    hostLogs: {
      collector: "ae.diagnostics()",
      cepCsxs: "not collected: CEPHtmlEngine/CSXS sources are #336's scope",
    },
    supervision: input.supervision,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

/**
 * Writes the manifest as `recovery-<requestId>.evidence.json` inside the
 * artifacts directory, atomically (temp file + rename). Returns the path
 * written, or `null` with the reason when the write failed — the caller
 * traces the failure; it never propagates.
 */
export function writeRecoveryEvidence(
  artifactsDir: string,
  record: RecoveryEvidenceRecord,
): { readonly path: string | null; readonly error?: string } {
  const path = join(artifactsDir, `recovery-${record.requestId}.evidence.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    renameSync(tmp, path);
    return { path };
  } catch (error) {
    return { path: null, error: error instanceof Error ? error.message : String(error) };
  }
}
