/**
 * `ae-a8n recover` — what a prior run left behind, and the little that may be
 * cleaned without guessing (`specs/isolated-ae/contracts/cli.md` §9).
 *
 * The rule that shapes this module: an unknown outcome is cleared only when a
 * human says so. A lock whose owner is gone is safe to release because
 * nothing can be writing under it; a quarantine record is *not* cleared,
 * because it exists precisely because nobody could prove the run had ended.
 *
 * It never quits After Effects, never re-sends a command, and never deletes a
 * run directory or a file it did not write.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DiagnosticCode } from "../doctor/diagnostics.js";
import type { PlatformAdapter, RecoveryFinding, TargetSpec } from "../platform/contract.js";
import type { RunReport } from "./artifacts.js";
import { readQuarantine, stateLayout, targetKey, type StateLayout } from "./state.js";

export type RecoveryAction = "reported" | "cleared" | "refused" | "recorded";

/** One `findings[]` entry. `remedy` is the exact next human action, if any. */
export type Finding = {
  readonly code: DiagnosticCode;
  readonly action: RecoveryAction;
  readonly detail: string;
  readonly remedy?: string;
};

export type RecoverStatus = "ok" | "unknown";

export type RecoverInput = {
  /** Null when no backend could be selected; the state is still inspected. */
  readonly adapter: PlatformAdapter | null;
  readonly target: TargetSpec;
  /** The run to inspect; null means "the quarantined run, if any". */
  readonly runId: string | null;
  readonly dryRun: boolean;
  /** Permits clearing a quarantine record. Nothing implies it. */
  readonly force: boolean;
  readonly stateRoot: string;
  readonly now?: () => Date;
  /** Test seam; defaults to `process.kill(pid, 0)`. */
  readonly isProcessAlive?: (pid: number) => boolean;
};

export type RecoverResult = {
  readonly runId: string | null;
  readonly findings: readonly Finding[];
  readonly cleared: boolean;
  readonly status: RecoverStatus;
  readonly notice?: string;
};

type LockRecord = {
  readonly schemaVersion?: unknown;
  readonly runId?: unknown;
  readonly pid?: unknown;
  readonly startedAt?: unknown;
};

type LockRead =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly path: string; readonly detail: string }
  | {
      readonly state: "held";
      readonly path: string;
      readonly record: LockRecord;
      readonly detail: string;
    };

function lockPathFor(layout: StateLayout, targetName: string): string {
  return join(layout.locks, `${targetKey(targetName)}.lock`);
}

function readLock(path: string): LockRead {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent" };
    }
    return { state: "unreadable", path, detail: `the lock file cannot be read: ${path}` };
  }
  if (text.trim().length === 0) {
    return { state: "unreadable", path, detail: `the lock file is empty: ${path}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "unreadable", path, detail: `the lock file is not valid JSON: ${path}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { state: "unreadable", path, detail: `the lock file is not a record: ${path}` };
  }
  const record = parsed as LockRecord;
  const runId = typeof record.runId === "string" ? record.runId : "unknown";
  const pid = typeof record.pid === "number" ? String(record.pid) : "unknown";
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : "unknown";
  return {
    state: "held",
    path,
    record,
    detail: `the lock names run ${runId} (pid ${pid}, started ${startedAt})`,
  };
}

/** `kill(pid, 0)`: ESRCH means the process is gone; anything else is alive. */
function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeFile(path: string): string | null {
  try {
    rmSync(path);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Marks a run directory that never finished as an unknown run. */
function recordUnknown(
  runDirectory: string,
  runId: string,
  now: () => Date,
): string | null {
  const reportPath = join(runDirectory, "report.json");
  const report: RunReport = {
    schemaVersion: "1.0",
    runId,
    status: "unknown",
    verdicts: [
      {
        id: "recovery",
        verdict: "unknown",
        message: "the run did not write a report; recovery recorded it as unknown",
      },
    ],
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    notice: "recovered: the run was incomplete and is recorded as unknown, not as a pass",
  };
  try {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function recoverRun(input: RecoverInput): Promise<RecoverResult> {
  const now = input.now ?? (() => new Date());
  const isAlive = input.isProcessAlive ?? defaultIsProcessAlive;
  const layout = stateLayout(input.stateRoot);
  const findings: Finding[] = [];
  let cleared = false;
  let cannotDecide = false;

  const quarantine = readQuarantine(layout, input.target.name);
  const lock = readLock(lockPathFor(layout, input.target.name));
  const runId =
    input.runId ??
    (quarantine.quarantined && quarantine.record !== null ? quarantine.record.runId : null);

  // 1. The quarantine record. It is reported, and only an explicit --force
  //    clears it: it exists because the outcome could not be proven.
  if (quarantine.quarantined) {
    const clearable = quarantine.record !== null;
    if (input.force && clearable) {
      if (input.dryRun) {
        findings.push({
          code: "A8N-JOB-002",
          action: "reported",
          detail: `would clear the quarantine record at ${quarantine.path} (dry run)`,
        });
      } else {
        const failure = removeFile(quarantine.path);
        if (failure === null) {
          cleared = true;
          findings.push({
            code: "A8N-JOB-002",
            action: "cleared",
            detail: `cleared the quarantine record at ${quarantine.path}`,
          });
        } else {
          findings.push({
            code: "A8N-JOB-002",
            action: "refused",
            detail: `the quarantine record could not be cleared: ${failure}`,
            remedy: `Inspect ${quarantine.path} and remove it yourself.`,
          });
        }
      }
    } else {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: quarantine.detail,
        remedy: clearable
          ? "Confirm that no After Effects from that run is still working, then run " +
            "`ae-a8n recover --force` to clear the quarantine."
          : `Inspect ${quarantine.path} and remove it yourself; it cannot be read.`,
      });
      if (!clearable) {
        cannotDecide = true;
      }
    }
  }

  // 2. The lock. A live owner is never overridden; a dead owner's lock is not
  //    protecting anything, so it is released.
  if (lock.state === "unreadable") {
    cannotDecide = true;
    findings.push({
      code: "A8N-JOB-002",
      action: "refused",
      detail: lock.detail,
      remedy: `Inspect ${lock.path} and remove it yourself; recovery will not guess.`,
    });
  } else if (lock.state === "held") {
    const pid = lock.record.pid;
    const alive = typeof pid === "number" && isAlive(pid);
    if (alive) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `${lock.detail}; that process is still running`,
        remedy: "Wait for it to finish, or stop it yourself; recovery never takes over a live lock.",
      });
    } else if (input.dryRun) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `${lock.detail}; that process is gone, so the lock is stale (dry run)`,
      });
    } else {
      const failure = removeFile(lock.path);
      if (failure === null) {
        cleared = true;
        findings.push({
          code: "A8N-JOB-002",
          action: "cleared",
          detail: `${lock.detail}; that process is gone, so the stale lock was released`,
        });
      } else {
        findings.push({
          code: "A8N-JOB-002",
          action: "refused",
          detail: `the stale lock could not be released: ${failure}`,
          remedy: `Remove ${lock.path} yourself after confirming no run is using it.`,
        });
      }
    }
  }

  // 3. The run directory itself: an incomplete run is recorded as unknown, not
  //    as a pass, and an existing report is never overwritten.
  let runDirectory: string | null = null;
  if (runId !== null) {
    runDirectory = join(layout.runs, runId);
    if (!existsSync(runDirectory)) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `there is no run directory for ${runId} at ${runDirectory}`,
      });
      runDirectory = null;
    } else if (existsSync(join(runDirectory, "report.json"))) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `run ${runId} already has a report at ${join(runDirectory, "report.json")}`,
      });
    } else if (input.dryRun) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `run ${runId} has no report; it would be recorded as unknown (dry run)`,
      });
    } else {
      const failure = recordUnknown(runDirectory, runId, now);
      findings.push(
        failure === null
          ? {
              code: "A8N-JOB-002",
              action: "recorded",
              detail: `run ${runId} had no report; it is now recorded as unknown, not as a pass`,
            }
          : {
              code: "A8N-JOB-002",
              action: "refused",
              detail: `the incomplete run could not be recorded: ${failure}`,
              remedy: `Inspect ${runDirectory} yourself; it was left unchanged.`,
            },
      );
    }
  }

  // 4. What the platform can see. The adapter reports; it never acts here.
  if (runDirectory !== null && input.adapter !== null) {
    try {
      const platform: readonly RecoveryFinding[] = await input.adapter.recover(runDirectory);
      findings.push(...platform);
    } catch (error) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `the platform could not inspect ${runDirectory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      cannotDecide = true;
    }
  }

  if (findings.length === 0) {
    findings.push({
      code: "A8N-JOB-002",
      action: "reported",
      detail: `nothing to recover for target ${input.target.name}: no lock, quarantine or run state`,
    });
  }

  const notice = input.dryRun ? "dry run: nothing was changed" : undefined;

  return {
    runId,
    findings,
    cleared,
    status: cannotDecide ? "unknown" : "ok",
    ...(notice === undefined ? {} : { notice }),
  };
}
