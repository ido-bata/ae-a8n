/**
 * Reading a run's stored report for `ae-a8n report`
 * (`specs/isolated-ae/contracts/cli.md` §10).
 *
 * The contract's rule is blunt: a missing or malformed file is an error, never
 * an empty success. So every field this module returns is validated first, a
 * file that is not a v1.0 report is refused rather than half-read, and a report
 * stored under another run's id is refused too.
 *
 * Nothing here writes, spawns, or touches After Effects. `report` is a reader:
 * it must be safe to run on a machine where a test is in progress.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

import {
  RUN_REPORT_SCHEMA,
  type RunReport,
  type RunVerdict,
  type RunVerdictVerdict,
} from "./artifacts.js";
import { RUN_ID_PATTERN } from "./run-id.js";
import { stateLayout, type StateLayout } from "./state.js";

/** The manifest fields `report` prints. Anything else is not needed here. */
export type RunManifestView = {
  readonly command: readonly string[] | null;
  readonly adapter: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Path relative to the run directory, as the manifest recorded it. */
  readonly stdout: string | null;
  readonly stderr: string | null;
};

export type RunReportRead =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly directory: string;
      readonly report: RunReport;
      /** The file's bytes, so `--format json` prints it unchanged. */
      readonly text: string;
      readonly manifest: RunManifestView | null;
    }
  | {
      readonly ok: false;
      /** Null when no run could be chosen at all. */
      readonly runId: string | null;
      readonly directory: string | null;
      /** One sentence a human can act on. Never empty. */
      readonly reason: string;
    };

const VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "blocked", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is RunVerdictVerdict {
  return typeof value === "string" && VERDICTS.has(value);
}

/**
 * A report is accepted only when every field the summary prints is present and
 * of the right type; otherwise the caller gets a refusal, not a partial read.
 */
function parseReport(value: unknown): RunReport | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value["schemaVersion"] !== RUN_REPORT_SCHEMA) {
    return null;
  }
  const runId = value["runId"];
  const status = value["status"];
  const startedAt = value["startedAt"];
  const finishedAt = value["finishedAt"];
  if (typeof runId !== "string" || typeof status !== "string") {
    return null;
  }
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") {
    return null;
  }
  const rawVerdicts = value["verdicts"];
  if (!Array.isArray(rawVerdicts)) {
    return null;
  }
  const verdicts: RunVerdict[] = [];
  for (const item of rawVerdicts) {
    if (!isRecord(item)) {
      return null;
    }
    const id = item["id"];
    const verdict = item["verdict"];
    const message = item["message"];
    if (typeof id !== "string" || !isVerdict(verdict) || typeof message !== "string") {
      return null;
    }
    verdicts.push({ id, verdict, message });
  }
  const notice = value["notice"];
  if (notice !== undefined && typeof notice !== "string") {
    return null;
  }
  return {
    schemaVersion: RUN_REPORT_SCHEMA,
    runId,
    status,
    verdicts,
    startedAt,
    finishedAt,
    ...(notice === undefined ? {} : { notice }),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function capturedPath(value: unknown): string | null {
  return isRecord(value) ? stringOrNull(value["path"]) : null;
}

/**
 * The manifest is supplementary: it explains the run, but the report is the
 * source of truth. An unreadable manifest narrows what the summary prints; it
 * does not fail the command.
 */
function readManifestView(path: string): RunManifestView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const rawCommand: unknown = parsed["command"];
  const command =
    Array.isArray(rawCommand) && rawCommand.every((item) => typeof item === "string")
      ? rawCommand
      : null;
  return {
    command,
    adapter: stringOrNull(parsed["adapter"]),
    exitCode: numberOrNull(parsed["exitCode"]),
    timedOut: booleanOrNull(parsed["timedOut"]),
    startedAt: stringOrNull(parsed["startedAt"]),
    finishedAt: stringOrNull(parsed["finishedAt"]),
    stdout: capturedPath(parsed["stdout"]),
    stderr: capturedPath(parsed["stderr"]),
  };
}

/** Run ids sort lexicographically, so the last one is the most recent. */
export function listRunIds(layout: StateLayout): readonly string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(layout.runs, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export type ReadRunReportInput = {
  readonly stateRoot: string;
  /** Null means "the most recent run". */
  readonly runId: string | null;
};

export function readRunReport(input: ReadRunReportInput): RunReportRead {
  const layout = stateLayout(input.stateRoot);
  let runId = input.runId;
  if (runId === null) {
    const ids = listRunIds(layout);
    const newest = ids[ids.length - 1];
    if (newest === undefined) {
      return {
        ok: false,
        runId: null,
        directory: null,
        reason: `there is no run under ${layout.runs}; run "ae-a8n test" first`,
      };
    }
    runId = newest;
  }

  const directory = join(layout.runs, runId);
  const reportPath = join(directory, "report.json");
  let text: string;
  try {
    text = readFileSync(reportPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        runId,
        directory,
        reason: `the report cannot be read: ${reportPath}`,
      };
    }
    return existsSync(directory)
      ? {
          ok: false,
          runId,
          directory,
          reason:
            `run ${runId} has no report at ${reportPath}; the run did not finish. ` +
            `"ae-a8n recover" records it as unknown — it is never read as a pass`,
        }
      : {
          ok: false,
          runId,
          directory,
          reason: `there is no run ${runId} under ${layout.runs}`,
        };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, runId, directory, reason: `${reportPath} is not valid JSON` };
  }
  const report = parseReport(parsed);
  if (report === null) {
    return {
      ok: false,
      runId,
      directory,
      reason: `${reportPath} is not a v${RUN_REPORT_SCHEMA} run report`,
    };
  }
  if (report.runId !== runId) {
    return {
      ok: false,
      runId,
      directory,
      reason: `${reportPath} names run ${report.runId}, not ${runId}`,
    };
  }

  return {
    ok: true,
    runId,
    directory,
    report,
    text,
    manifest: readManifestView(join(directory, "manifest.json")),
  };
}
