/**
 * Read-only inspection of the isolated-session shared root
 * (`join("/Users", "Shared", "ae-a8n")` by default).
 *
 * This is the packaged counterpart of the repository harness's
 * `status`/`prune` inspection (`scripts/isolated-session/session-rules.mjs`
 * + `run-in-isolated-session.mjs`): it classifies what a stale job, an
 * orphaned result or an interrupted publish left behind so `doctor` can
 * report it. It never deletes, never signals a process and never guesses
 * ownership — the same fail-closed rules as the harness:
 *
 *   - a job file is trusted only when it is a regular file (lstat, so a
 *     symlink is refused), owned by the account allowed to publish jobs,
 *     and not writable by group or others;
 *   - the account allowed to publish jobs is the agent banner's
 *     `trustedUid` when one was recorded, else the console owner — never
 *     the uid of whoever happens to run `doctor`;
 *   - `untrusted`, `malformed`, `stale`, `cancelled`, `finished` and
 *     `pending` are distinct states; `unknown` means the publishing
 *     account could not be determined at all;
 *   - stale/cancelled jobs can never run again; pending ones may still be
 *     picked up, so they are reported, never touched.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SharedJobState =
  | "unknown"
  | "untrusted"
  | "malformed"
  | "finished"
  | "cancelled"
  | "stale"
  | "pending";

export type SharedJobEntry = {
  readonly name: string;
  readonly state: SharedJobState;
  readonly reason: string;
};

export type SharedAgentBanner = {
  readonly startedAt: string | null;
  readonly sessionUid: number | null;
  readonly sessionKind: string | null;
  readonly consoleUid: number | null;
  readonly trustedUid: number | null;
  readonly isolated: boolean;
};

/** An artifact that is not a classifiable job or result (`.command`, `.done`, logs…). */
export type SharedOtherArtifact = {
  readonly dir: "jobs" | "results" | "logs";
  readonly name: string;
  readonly kind: string;
};

export type SharedRootReport = {
  /** False when the root does not exist — not an error, just nothing to see. */
  readonly present: boolean;
  readonly jobs: readonly SharedJobEntry[];
  /** Result files with no matching job file, or results still uncollected. */
  readonly orphanResults: readonly string[];
  /** Publish temporaries older than the publish window. */
  readonly staleTemporaries: readonly string[];
  /** The agent banner, when readable — proof it started, not that it lives. */
  readonly banner: SharedAgentBanner | null;
  /** Terminal-substrate and launcher leftovers, reported but never classified. */
  readonly otherArtifacts: readonly SharedOtherArtifact[];
  /** Log file names left in `logs/`. */
  readonly logs: readonly string[];
};

/** Same window the harness uses: tmp+rename finishes in milliseconds. */
export const SHARED_TMP_STALE_MS = 60_000;

const JOB_FILE = /^(.*)\.job\.json$/;
const JOB_TMP = /^(.*)\.job\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
const RESULT_FILE = /^(.*)\.result\.json$/;
const RESULT_TMP = /^(.*)\.result\.json\.\d+\.[0-9a-f]{8}\.tmp$/;
const CANCEL_TMP = /\.cancel\.\d+\.[0-9a-f]{8}\.tmp$/;

type JobKind = "job" | "job-tmp" | "cancel" | "cancel-tmp" | "command" | "cmd" | "other";
type ResultKind =
  | "result"
  | "result-tmp"
  | "done"
  | "stdout"
  | "stderr"
  | "other";

function jobKind(name: string): JobKind {
  if (JOB_FILE.test(name)) return "job";
  if (JOB_TMP.test(name)) return "job-tmp";
  if (name.endsWith(".cancel")) return "cancel";
  if (CANCEL_TMP.test(name)) return "cancel-tmp";
  if (name.endsWith(".command")) return "command";
  if (name.endsWith(".cmd")) return "cmd";
  return "other";
}

function resultKind(name: string): ResultKind {
  if (name === "agent.json") return "other"; // handled as the banner
  if (RESULT_FILE.test(name)) return "result";
  if (RESULT_TMP.test(name)) return "result-tmp";
  if (name.endsWith(".done")) return "done";
  if (name.endsWith(".out")) return "stdout";
  if (name.endsWith(".err")) return "stderr";
  return "other";
}

function artifactId(name: string): string | null {
  const job = JOB_FILE.exec(name);
  if (job !== null) return job[1] ?? null;
  const jobTmp = JOB_TMP.exec(name);
  if (jobTmp !== null) return jobTmp[1] ?? null;
  const result = RESULT_FILE.exec(name);
  if (result !== null) return result[1] ?? null;
  const resultTmp = RESULT_TMP.exec(name);
  if (resultTmp !== null) return resultTmp[1] ?? null;
  if (name.endsWith(".cancel")) return name.slice(0, -".cancel".length);
  return null;
}

/** The harness's trust rule, verbatim: regular file, owner, no group/other write. */
function fileIsTrusted(path: string, trustedUid: number | null): boolean | null {
  if (trustedUid === null) {
    return null;
  }
  try {
    const info = lstatSync(path);
    return info.isFile() && info.uid === trustedUid && (info.mode & 0o022) === 0;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Same shape the harness's `parseAgentBanner` returns, flattened for doctor. */
function parseBanner(text: string): SharedAgentBanner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const session =
    typeof record["session"] === "object" && record["session"] !== null
      ? (record["session"] as Record<string, unknown>)
      : null;
  const intOrNull = (value: unknown): number | null =>
    Number.isInteger(value) ? (value as number) : null;
  return {
    startedAt: typeof record["startedAt"] === "string" ? record["startedAt"] : null,
    sessionUid: session === null ? null : intOrNull(session["uid"]),
    sessionKind: session === null ? null : typeof session["kind"] === "string" ? session["kind"] : null,
    consoleUid: intOrNull(record["consoleUid"]),
    trustedUid: intOrNull(record["trustedUid"]),
    isolated: record["isolated"] === true,
  };
}

/**
 * The uid of the console owner, or null when it cannot be read. The same
 * fallback the harness uses for `trustedUid`: without a banner, jobs are
 * trusted only from the account on the console.
 */
function consoleUid(): number | null {
  try {
    const uid = lstatSync("/dev/console").uid;
    return Number.isInteger(uid) && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

function classifyJob(
  trusted: boolean | null,
  job: Record<string, unknown> | null,
  hasResult: boolean,
  hasCancel: boolean,
  now: number,
): { state: SharedJobState; reason: string } {
  if (trusted === null) {
    return { state: "unknown", reason: "the account allowed to publish jobs is not known" };
  }
  if (trusted !== true) {
    return { state: "untrusted", reason: "the file is not attributable to the controlling account" };
  }
  if (job === null) {
    return { state: "malformed", reason: "the job file is not a JSON object" };
  }
  if (hasResult) {
    return { state: "finished", reason: "a result exists and has not been collected" };
  }
  if (hasCancel) {
    return { state: "cancelled", reason: "the controller cancelled this job" };
  }
  const deadline = job["deadline"];
  if (!Number.isFinite(deadline)) {
    return { state: "stale", reason: "the job carries no usable deadline, so no agent may ever run it" };
  }
  if (!Number.isFinite(now) || now >= (deadline as number)) {
    return {
      state: "stale",
      reason: `the job's deadline (${String(deadline)}) has passed; it can never run`,
    };
  }
  return { state: "pending", reason: "waiting for the session agent" };
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function mtimeMs(path: string): number | null {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Inspect the shared root. `trustedUid` may be injected for tests; the
 * default resolution is the harness's: the agent banner's `trustedUid`
 * when an agent recorded one, else the console owner. When neither is
 * known every job reports `unknown` rather than a guessed verdict.
 */
export function inspectSharedRoot(
  root: string,
  options: { readonly trustedUid?: number | null; readonly now?: number } = {},
): SharedRootReport {
  const now = options.now ?? Date.now();

  let present = true;
  try {
    lstatSync(root);
  } catch {
    present = false;
  }
  if (!present) {
    return {
      present: false,
      jobs: [],
      orphanResults: [],
      staleTemporaries: [],
      banner: null,
      otherArtifacts: [],
      logs: [],
    };
  }

  const jobsDir = join(root, "jobs");
  const resultsDir = join(root, "results");
  const logsDir = join(root, "logs");
  const jobNames = listDir(jobsDir);
  const resultNames = listDir(resultsDir);
  const logNames = listDir(logsDir);

  // The banner is read before jobs are classified: it is the record of
  // which account the running (or last running) agent accepts jobs from.
  let banner: SharedAgentBanner | null = null;
  if (resultNames.includes("agent.json")) {
    try {
      banner = parseBanner(readFileSync(join(resultsDir, "agent.json"), "utf-8"));
    } catch {
      banner = null;
    }
  }

  const trustedUid =
    options.trustedUid !== undefined
      ? options.trustedUid
      : (banner?.trustedUid ?? consoleUid());

  // Only a real `.result.json` proves a job finished; a publish temporary
  // mid-rename does not. Same for jobs: an orphan check needs the real
  // `<id>.job.json`, not a leftover tmp.
  const realResultIds = new Set(
    resultNames
      .filter((name) => RESULT_FILE.test(name))
      .map((name) => artifactId(name))
      .filter((id): id is string => id !== null),
  );
  const realJobIds = new Set(
    jobNames
      .filter((name) => JOB_FILE.test(name))
      .map((name) => artifactId(name))
      .filter((id): id is string => id !== null),
  );
  const cancelIds = new Set(
    jobNames
      .filter((name) => name.endsWith(".cancel"))
      .map((name) => artifactId(name))
      .filter((id): id is string => id !== null),
  );

  const jobs: SharedJobEntry[] = [];
  const staleTemporaries: string[] = [];
  const otherArtifacts: SharedOtherArtifact[] = [];
  for (const name of jobNames) {
    const kind = jobKind(name);
    const path = join(jobsDir, name);
    if (kind === "job-tmp" || kind === "cancel-tmp") {
      const mtime = mtimeMs(path);
      if (mtime !== null && now - mtime > SHARED_TMP_STALE_MS) {
        staleTemporaries.push(`jobs/${name}`);
      }
      continue;
    }
    if (kind !== "job") {
      otherArtifacts.push({ dir: "jobs", name, kind });
      continue;
    }
    const id = artifactId(name);
    const trusted = fileIsTrusted(path, trustedUid);
    const job =
      trusted === true
        ? (() => {
            const parsed = readJson(path);
            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : null;
          })()
        : null;
    const verdict = classifyJob(
      trusted,
      job,
      id !== null && realResultIds.has(id),
      id !== null && cancelIds.has(id),
      now,
    );
    jobs.push({ name, state: verdict.state, reason: verdict.reason });
  }

  const orphanResults = resultNames.filter((name) => {
    if (!RESULT_FILE.test(name)) {
      return false;
    }
    const id = artifactId(name);
    return id === null || !realJobIds.has(id);
  });
  for (const name of resultNames) {
    const kind = resultKind(name);
    if (kind === "result-tmp") {
      const mtime = mtimeMs(join(resultsDir, name));
      if (mtime !== null && now - mtime > SHARED_TMP_STALE_MS) {
        staleTemporaries.push(`results/${name}`);
      }
      continue;
    }
    if (kind !== "other") {
      otherArtifacts.push({ dir: "results", name, kind });
    }
  }
  for (const name of logNames) {
    otherArtifacts.push({ dir: "logs", name, kind: name.endsWith(".log") ? "log" : "other" });
  }
  const logs = logNames.filter((name) => name.endsWith(".log"));

  return { present: true, jobs, orphanResults, staleTemporaries, banner, otherArtifacts, logs };
}
