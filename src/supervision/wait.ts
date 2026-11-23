/**
 * Bounded waits on supervision state (#280, spec §Supervision state
 * machine: "no state waits forever").
 *
 * A consumer that needs the session to reach a phase — or needs to know it
 * will NOT reach it in time — calls this instead of polling by hand. The
 * wait always ends: `reached`, `timeout`, or `unavailable`. The last report
 * read is returned in every outcome so the caller reports what it actually
 * saw, never a guess.
 */

import type { SupervisionPhase, SupervisionReport } from "./types.js";
import { supervisionReport } from "./state.js";

export type WaitOutcome =
  | {
      readonly status: "reached";
      readonly report: SupervisionReport;
      readonly waitedMs: number;
    }
  | {
      readonly status: "timeout";
      readonly report: SupervisionReport | null;
      readonly waitedMs: number;
    }
  | {
      readonly status: "unavailable";
      readonly report: SupervisionReport;
      readonly waitedMs: number;
    };

export type WaitForPhaseOptions = {
  readonly sessionDir: string;
  /** Phases that satisfy the wait. */
  readonly phases: readonly SupervisionPhase[];
  /** Hard bound; the wait never exceeds it. */
  readonly timeoutMs: number;
  readonly pollMs?: number;
  readonly monitorTtlMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the durable state until the phase is one of `phases`, the timeout
 * expires, or the state becomes unreadable.
 *
 * `unavailable` is returned immediately when the state cannot be read at
 * all — a missing/corrupt document is an answer, not something to wait on.
 * An `observed` report whose phase never matches ends in `timeout` with the
 * last report attached.
 */
export async function waitForSupervisionPhase(
  options: WaitForPhaseOptions,
): Promise<WaitOutcome> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = Math.max(1, options.pollMs ?? 250);
  const started = now().getTime();
  const deadline = started + options.timeoutMs;
  const wanted = new Set<string>(options.phases);

  for (;;) {
    const report = supervisionReport(options.sessionDir, {
      now: now(),
      ...(options.monitorTtlMs === undefined ? {} : { monitorTtlMs: options.monitorTtlMs }),
    });
    if (report.status === "unavailable") {
      return { status: "unavailable", report, waitedMs: now().getTime() - started };
    }
    if (wanted.has(report.doc.phase)) {
      return { status: "reached", report, waitedMs: now().getTime() - started };
    }
    const remaining = deadline - now().getTime();
    if (remaining <= 0) {
      return { status: "timeout", report, waitedMs: now().getTime() - started };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}
