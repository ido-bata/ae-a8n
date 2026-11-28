/**
 * Teardown verdict (#434, `specs/release-acceptance/spec.md` §10).
 *
 * When a session ends — `ae.close()` success or failure — this aggregates
 * the session's own evidence into one structured verdict written to
 * `<sessionRoot>/teardown-<sessionId>.json` (atomic tmp+rename):
 *
 *   - process: the `session.close` trace status and the `CloseResult`
 *     (owned hosts quit through the public path; attached/unknown hosts
 *     are left running — that is clean, not residue);
 *   - input: every `input.*` trace row's recorded `cleanupAllRestored`;
 *   - leases: `gui-audit.jsonl` acquire/release balance for the session's
 *     AE pid — an acquire with no release/reap is residue;
 *   - recorder: `recorderResidue` on every evidence-index segment;
 *   - supervision: the monitor lease must be released (`free`/`expired`)
 *     and the durable `supervision.json` is reported as retained state —
 *     it expires per its TTL by design and is required by resume/rebuild.
 *
 * Verdict ∈ `clean` / `residue` / `unverifiable`. `unverifiable` is the
 * honest answer whenever a source could not be read — never `clean` by
 * default (spec §10). Safety-relevant residue is flagged per item so the
 * ledger/scenario layer can fail the attempt regardless of function.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { evidenceIndexPath, parseGuiEvidenceIndexDocument } from "../evidence/index.js";
import {
  defaultGuiLeaseRoot,
  guiLeasePaths,
  type GuiAuditRecord,
} from "../platform/darwin/gui-lease.js";
import { inspectMonitorLease } from "../supervision/lease.js";
import { readSupervisionState } from "../supervision/state.js";
import type { Session } from "../api/session.js";
import type { CloseResult } from "../api/index.js";
import type { TraceEvent } from "../trace/trace.js";
import {
  readLaunchProvenance,
  type LaunchProvenance,
} from "../driver/launch-provenance.js";
import {
  psProcesses,
  sameProcess,
  windowsProcesses,
  type HostProcess,
} from "../driver/host-processes.js";

export const TEARDOWN_SCHEMA_VERSION = 1;
export const TEARDOWN_KIND = "ae-a8n.teardown/v1";

export type TeardownItemVerdict = "clean" | "residue" | "unverifiable";

export type TeardownItem = {
  readonly area:
    | "process"
    | "input"
    | "leases"
    | "recorder"
    | "supervision"
    | "artifacts";
  readonly verdict: TeardownItemVerdict;
  readonly detail: string;
  /** True when the residue is safety-relevant (spec §10 automatic fail). */
  readonly safetyRelevant?: boolean;
};

export type TeardownVerdict = "clean" | "residue" | "unverifiable";

export type TeardownReport = {
  readonly schemaVersion: typeof TEARDOWN_SCHEMA_VERSION;
  readonly kind: typeof TEARDOWN_KIND;
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly evaluatedAt: string;
  readonly verdict: TeardownVerdict;
  readonly items: readonly TeardownItem[];
  /** Path the report was written to, when the write succeeded. */
  readonly reportPath: string | null;
};

export type TeardownOptions = {
  readonly now?: () => Date;
  /** GUI lease/audit state root override (tests); production default ~/.ae-a8n. */
  readonly leaseStateRoot?: string;
  /** The AE pid captured before close, when still known. */
  readonly targetPid?: number | null;
  /**
   * Process census for the quit-timeout re-check (#443); production uses
   * the same listing the transport's ownership checks read. Injectable so
   * tests never scan the real process table.
   */
  readonly processCensus?: () => readonly HostProcess[];
};

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function lastTraceEvent(events: readonly TraceEvent[], op: string): TraceEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.op === op) {
      return event;
    }
  }
  return null;
}

function aggregate(
  items: readonly TeardownItem[],
): TeardownVerdict {
  if (items.some((item) => item.verdict === "unverifiable")) {
    return "unverifiable";
  }
  if (items.some((item) => item.verdict === "residue")) {
    return "residue";
  }
  return "clean";
}

/**
 * Process verdict for a close that failed because `app.quit` did not take
 * effect inside the exit budget (#443).
 *
 * "Unverifiable" is only honest when the host's fate cannot be re-proven.
 * The launch provenance written while the session owned the host carries
 * pid + start identity, so a live census can answer definitively:
 *
 * - the recorded process is still running → `residue`: an owned host was
 *   left running, which is exactly the state a later session must not
 *   trip over. Recovery is the ownership-proven path — `AfterEffects.
 *   attach` + `rebuild`, or `AfterEffects.terminate` under
 *   `permit: "terminate-owned-host"` — never a bare kill.
 * - the recorded process is gone → the quit landed after the budget; the
 *   process area is `clean` and the detail says the close outran its
 *   timeout, not that teardown was unobserved.
 * - provenance or census unreadable, or the pid is alive without a start
 *   time to tell it from a reuse → `unverifiable`, as before.
 */
function quitTimeoutProcessItem(
  sessionRoot: string,
  closeError: string,
  options: TeardownOptions,
): TeardownItem {
  const base = `session close failed: ${closeError}`;
  let provenance: LaunchProvenance | null;
  try {
    provenance = readLaunchProvenance(sessionRoot);
  } catch (error) {
    return {
      area: "process",
      verdict: "unverifiable",
      detail:
        `${base}; launch provenance could not be read ` +
        `(${error instanceof Error ? error.message : String(error)}), ` +
        "so the recorded host cannot be re-identified",
    };
  }
  if (provenance === null) {
    return {
      area: "process",
      verdict: "unverifiable",
      detail:
        `${base}; no launch provenance exists for this session root, ` +
        "so the host app.quit reached cannot be re-identified",
    };
  }
  const host = provenance.host;
  const census =
    options.processCensus ??
    (process.platform === "win32" ? windowsProcesses : psProcesses);
  let processes: readonly HostProcess[];
  try {
    processes = census();
  } catch (error) {
    return {
      area: "process",
      verdict: "unverifiable",
      detail:
        `${base}; the process census failed ` +
        `(${error instanceof Error ? error.message : String(error)}), ` +
        "so whether the host was left running is unproven",
    };
  }
  const pidAlive = processes.some((p) => p.pid === host.pid);
  if (host.startedAt === null) {
    // Without a start time a live pid cannot be told apart from the
    // recorded process or a reuse — the same ambiguity rebuild refuses on.
    return pidAlive
      ? {
          area: "process",
          verdict: "unverifiable",
          detail:
            `${base}; pid ${host.pid} is still running and the launch record ` +
            "has no start time, so the recorded After Effects cannot be " +
            "told apart from a reused pid",
        }
      : {
          area: "process",
          verdict: "clean",
          detail:
            `${base}; pid ${host.pid} is absent from the process list at ` +
            "teardown — the quit landed after its budget",
        };
  }
  const recorded: HostProcess = {
    pid: host.pid,
    startedAt: host.startedAt,
    executable: host.executable,
    ...(host.identity === null ? {} : { identity: host.identity }),
  };
  const same = processes.filter((p) =>
    sameProcess(process.platform, p, recorded),
  );
  if (same.length > 0) {
    return {
      area: "process",
      verdict: "residue",
      safetyRelevant: true,
      detail:
        `${base}; the recorded After Effects (pid ${host.pid}, started ` +
        `${new Date(host.startedAt).toISOString()}) is still running at ` +
        "teardown — an owned host was left running after app.quit. " +
        "Recover through the ownership-proven path: AfterEffects.attach " +
        "+ rebuild, or AfterEffects.terminate with " +
        'permit "terminate-owned-host"; never signal the pid directly.',
    };
  }
  return {
    area: "process",
    verdict: "clean",
    detail:
      `${base}; the recorded After Effects (pid ${host.pid}) is gone at ` +
      "teardown — the quit landed after its budget",
  };
}

/**
 * Evaluate and persist the teardown verdict for `session`. Called by
 * `AfterEffects.close()` on both the success and failure paths; also
 * exported for the RC harness, which may evaluate a session it did not
 * close through this API (e.g. after a crash) by passing the session's
 * recorded events.
 *
 * Never throws: every item degrades to `unverifiable` with the reason,
 * and a report-write failure leaves `reportPath: null` rather than
 * breaking session teardown.
 */
export function writeTeardownVerdict(
  session: Session,
  close:
    | CloseResult
    | { readonly error: string; readonly quitTimedOut?: boolean }
    | null,
  options: TeardownOptions = {},
): TeardownReport {
  const now = options.now ?? (() => new Date());
  const driver = session.driver;
  const sessionRoot = driver.sessionRoot;
  const sessionId = driver.sessionId;
  const events = session.events;
  const items: TeardownItem[] = [];

  // -- process ------------------------------------------------------------
  {
    const closeEvent = lastTraceEvent(events, "session.close");
    const closeFailed = close !== null && "error" in close;
    if (close === null) {
      items.push({
        area: "process",
        verdict: "unverifiable",
        detail: "no close result was supplied; session teardown was not observed",
      });
    } else if (closeFailed) {
      if (close.quitTimedOut === true) {
        // `app.quit` was delivered but the owned process did not exit in
        // budget (#443). The recorded launch identity lets the verdict
        // re-check live instead of reporting an unproven failure.
        items.push(quitTimeoutProcessItem(sessionRoot, close.error, options));
      } else {
        items.push({
          area: "process",
          verdict: "unverifiable",
          detail: `session close failed: ${close.error}; whether the host was left running is unproven`,
        });
      }
    } else {
      const quit = close.quit === true;
      const owned = close.ownership?.kind === "owned";
      // An owned host that was not quit is process residue (spec §10:
      // owned sessions quit through the public close path). "already
      // closed" is the idempotent second close() — not residue.
      const processResidue = owned && !quit && close.reason !== "already closed";
      items.push({
        area: "process",
        verdict:
          closeEvent !== null && closeEvent.status === "error"
            ? "unverifiable"
            : processResidue
              ? "residue"
              : "clean",
        detail:
          `close=${JSON.stringify(close)}; session.close trace ` +
          `${closeEvent === null ? "absent" : closeEvent.status}` +
          (close.reason !== undefined ? `; reason=${close.reason}` : "") +
          (owned && !quit
            ? "; owned host reported not quit — investigate before reuse"
            : ""),
      });
    }
  }

  // -- input ---------------------------------------------------------------
  {
    const inputRows = events.filter((event) => event.op.startsWith("input."));
    if (inputRows.length === 0) {
      items.push({
        area: "input",
        verdict: "clean",
        detail: "no input operations ran this session",
      });
    } else {
      const unrestored = inputRows.filter(
        (event) => event.result?.["cleanupAllRestored"] === false,
      );
      const unreported = inputRows.filter(
        (event) => event.result?.["cleanupAllRestored"] === undefined,
      );
      if (unrestored.length > 0) {
        items.push({
          area: "input",
          verdict: "residue",
          detail:
            `${unrestored.length} input op(s) reported cleanup not fully ` +
            `restored: ${unrestored.map((e) => e.op).join(", ")}`,
          safetyRelevant: true,
        });
      } else if (unreported.length === inputRows.length) {
        items.push({
          area: "input",
          verdict: "unverifiable",
          detail:
            `${inputRows.length} input op(s) ran but none recorded a ` +
            "cleanupAllRestored verdict; input state restoration is unproven",
        });
      } else {
        items.push({
          area: "input",
          verdict: "clean",
          detail: `${inputRows.length} input op(s); all reported cleanupAllRestored`,
        });
      }
    }
  }

  // -- leases ---------------------------------------------------------------
  {
    const stateRoot = options.leaseStateRoot ?? defaultGuiLeaseRoot();
    const auditLog = guiLeasePaths(stateRoot).auditLog;
    const guiOps = events.filter(
      (event) =>
        event.op.startsWith("panel.") ||
        event.op.startsWith("windowOps.") ||
        event.op.startsWith("dragDrop.") ||
        event.op.startsWith("contextMenu.") ||
        event.op.startsWith("fileDialog.") ||
        event.op.startsWith("projectDialog.") ||
        event.op.startsWith("workspace.") ||
        event.op.startsWith("timeline.") ||
        event.op.startsWith("compView.") ||
        event.op.startsWith("effectControls.") ||
        event.op.startsWith("menuBar.") ||
        event.op.startsWith("dockedPane.") ||
        event.op.startsWith("renderQueue."),
    );
    if (!existsSync(auditLog)) {
      items.push({
        area: "leases",
        verdict: guiOps.length === 0 ? "clean" : "unverifiable",
        detail:
          guiOps.length === 0
            ? "no GUI lease audit log exists and no GUI ops ran"
            : `${guiOps.length} GUI op(s) ran but the lease audit log ` +
              `${auditLog} does not exist; lease release is unproven`,
      });
    } else {
      let records: GuiAuditRecord[] = [];
      try {
        records = readFileSync(auditLog, "utf-8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as GuiAuditRecord);
      } catch (error) {
        items.push({
          area: "leases",
          verdict: "unverifiable",
          detail: `the GUI audit log could not be parsed: ${String(error)}`,
        });
        records = [];
      }
      if (records.length > 0) {
        const pid = options.targetPid ?? null;
        const scoped =
          pid === null ? records : records.filter((r) => r.pid === pid);
        const acquired = scoped.filter((r) => r.kind === "lease-acquire");
        const released = scoped.filter(
          (r) => r.kind === "lease-release" || r.kind === "lease-reap",
        );
        // An acquire is balanced by a release OR a reap of its owner; a
        // lease-refuse never held anything.
        const held = Math.max(0, acquired.length - released.length);
        items.push({
          area: "leases",
          verdict: held > 0 ? "residue" : "clean",
          detail:
            `${scoped.length} audit row(s)` +
            (pid === null ? " (unscoped: target pid unknown at teardown)" : ` for pid ${pid}`) +
            `: ${acquired.length} acquire, ${released.length} release/reap` +
            (held > 0 ? ` — ${held} lease(s) possibly still held` : ""),
        });
      } else {
        items.push({
          area: "leases",
          verdict: "clean",
          detail: "GUI audit log exists but holds no rows",
        });
      }
    }
  }

  // -- recorder ---------------------------------------------------------------
  {
    const recordOps = events.filter((event) => event.op.startsWith("record."));
    const indexPath = evidenceIndexPath(driver.artifactsDir);
    const index = existsSync(indexPath) ? readJsonFile(indexPath) : null;
    if (index === null) {
      items.push({
        area: "recorder",
        verdict: recordOps.length === 0 ? "clean" : "unverifiable",
        detail:
          recordOps.length === 0
            ? "no recording ops ran; no evidence index expected"
            : `${recordOps.length} record.* op(s) ran but no evidence index ` +
              "exists at " +
              indexPath,
      });
    } else {
      try {
        const doc = parseGuiEvidenceIndexDocument(index);
        const bad = doc.segments.filter(
          (segment) =>
            segment.recorderResidue === "terminated" ||
            segment.recorderResidue === "unknown",
        );
        items.push({
          area: "recorder",
          verdict: bad.length > 0 ? "residue" : "clean",
          detail:
            `${doc.segments.length} segment(s); ` +
            (bad.length === 0
              ? "no recorder residue reported"
              : `${bad.length} segment(s) report residue: ` +
                bad.map((s) => `${s.id}=${s.recorderResidue}`).join(", ")),
        });
      } catch (error) {
        items.push({
          area: "recorder",
          verdict: "unverifiable",
          detail: `the evidence index could not be parsed: ${String(error)}`,
        });
      }
    }
  }

  // -- supervision ---------------------------------------------------------------
  {
    const lease = inspectMonitorLease(sessionRoot);
    const state = readSupervisionState(sessionRoot);
    if (lease.state === "held") {
      items.push({
        area: "supervision",
        verdict: "residue",
        detail:
          `a monitor lease is still held (pid ${lease.record?.pid ?? "?"}, ` +
          `heartbeat ${lease.record?.heartbeatAt ?? "?"}) after session end`,
        safetyRelevant: false,
      });
    } else if (state.kind === "absent") {
      items.push({
        area: "supervision",
        verdict: "clean",
        detail: "no durable supervision document exists for this session",
      });
    } else if (state.kind === "corrupt") {
      items.push({
        area: "supervision",
        verdict: "unverifiable",
        detail: `supervision state is corrupt: ${state.detail}`,
      });
    } else {
      items.push({
        area: "supervision",
        verdict: "clean",
        detail:
          `monitor lease ${lease.state}; supervision.json retained as ` +
          `durable state (phase=${state.doc.phase}) — it expires per its ` +
          "TTL and is required by resume/rebuild, not session residue",
      });
    }
  }

  // -- artifacts -----------------------------------------------------------------
  {
    // Honest accounting only: the session artifact tree is retained by
    // design (it IS the evidence). Report what exists so a reviewer can
    // see residue was considered, not silently kept.
    const artifactsDir = driver.artifactsDir;
    items.push({
      area: "artifacts",
      verdict: existsSync(artifactsDir) ? "clean" : "unverifiable",
      detail: existsSync(artifactsDir)
        ? `artifacts retained at ${artifactsDir} (evidence, not residue)`
        : `artifacts dir ${artifactsDir} does not exist`,
    });
  }

  const verdict = aggregate(items);
  const report: TeardownReport = {
    schemaVersion: TEARDOWN_SCHEMA_VERSION,
    kind: TEARDOWN_KIND,
    sessionId,
    sessionRoot,
    evaluatedAt: now().toISOString(),
    verdict,
    items,
    reportPath: null,
  };

  const reportPath = join(sessionRoot, `teardown-${sessionId}.json`);
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    const tmp = `${reportPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, reportPath);
    return { ...report, reportPath };
  } catch {
    return report;
  }
}
