/**
 * The controller side: publish one job and wait for exactly one result.
 *
 * A timeout is not a failure and not a success. The job is left where it is,
 * reported as unknown, and never re-sent — re-sending is how a run that may
 * still be executing turns into two runs.
 */

import { randomBytes } from "node:crypto";

import { signJob, verifyResultAuth, type JobKey, type UnsignedJob } from "./auth.js";
import { ChannelFileTooLargeError, type FileChannel } from "./channel.js";
import { isRunId } from "./lock.js";
import {
  JOB_SCHEMA_VERSION,
  MAX_RESULT_BYTES,
  decodeResult,
  encodeJob,
  jobPaths,
  newJobId,
  sha256Hex,
  type Job,
  type JobResult,
  type JobWriter,
} from "./job.js";

export type SubmitOptions = {
  readonly payload: Uint8Array;
  /** The controller's run id; the job carries it so the agent can name it. */
  readonly runId: string;
  readonly timeoutMs: number;
  readonly writer: JobWriter;
  /**
   * The shared channel secret. Every job is signed with it and every result
   * is accepted only when it carries a valid signature from it.
   */
  readonly key: JobKey;
  readonly pollMs?: number;
  /**
   * How long one read of the result path may take before it counts as a
   * failure to answer rather than as an absent result. A share that dropped
   * mid-poll otherwise keeps the controller waiting past its own deadline.
   */
  readonly readTimeoutMs?: number;
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
  /** Injected so a test does not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
};

/** What the polling loop saw, kept so a second occurrence is diagnosable. */
export type PollEvidence = {
  readonly polls: number;
  readonly absent: number;
  readonly failed: number;
  readonly lastError: string | null;
  readonly slowestReadMs: number;
};

/** A signed result the controller saw only after its deadline had passed. */
export type LateResult = {
  readonly status: JobResult["status"];
  readonly exitCode: number | null;
  readonly resultSha256: string;
};

export type SubmitResult =
  | {
      readonly status: "ok" | "failed";
      readonly jobId: string;
      readonly result: JobResult;
      readonly resultSha256: string;
    }
  | {
      readonly status: "refused";
      readonly jobId: string;
      readonly code: string;
      readonly message: string;
      /** The bytes that were refused, when a result file was there to refuse. */
      readonly resultSha256: string | null;
    }
  | {
      readonly status: "unknown";
      readonly jobId: string;
      readonly code: "A8N-AE-004";
      readonly message: string;
      readonly resultSha256: string | null;
      readonly evidence: PollEvidence;
      /**
       * A result found after the deadline. Recorded, never promoted: the run
       * stays unknown and quarantined, and the job is never re-sent.
       */
      readonly lateResult: LateResult | null;
    };

const DEFAULT_POLL_MS = 250;
/** A read that has not answered in this long has failed to answer. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;
/** One last look at the result path after the deadline, before giving up. */
const LATE_RECHECK_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type ReadAttempt =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly ms: number }
  | { readonly kind: "absent"; readonly ms: number }
  | { readonly kind: "failed"; readonly detail: string; readonly ms: number }
  | { readonly kind: "too-large"; readonly error: ChannelFileTooLargeError; readonly ms: number };

/** A read that did not answer within its budget. */
class ChannelReadStalledError extends Error {
  constructor(ms: number) {
    super(`the channel did not answer within ${String(ms)}ms`);
    this.name = "ChannelReadStalledError";
  }
}

function describeReadError(error: unknown): string {
  if (error instanceof Error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
    return code === null ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

/**
 * One read, bounded in time.
 *
 * The deadline is a promise to the caller. A read that never returns must not
 * be able to keep the controller past it, and a read that throws is a failed
 * observation, not the end of the run: the job may already be executing, so
 * nothing here is followed by a re-send.
 */
async function readResult(
  channel: FileChannel,
  path: string,
  budgetMs: number,
): Promise<ReadAttempt> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bytes = await Promise.race([
      channel.read(path),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ChannelReadStalledError(budgetMs));
        }, budgetMs);
      }),
    ]);
    const ms = Date.now() - started;
    return bytes === null ? { kind: "absent", ms } : { kind: "bytes", bytes, ms };
  } catch (error) {
    const ms = Date.now() - started;
    if (error instanceof ChannelFileTooLargeError) {
      return { kind: "too-large", error, ms };
    }
    return { kind: "failed", detail: describeReadError(error), ms };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The result's own verdict, or the reason it cannot be read as one. */
type Judgement =
  | {
      readonly kind: "result";
      readonly status: "ok" | "failed" | "unknown";
      readonly result: JobResult;
      readonly sha: string;
    }
  | {
      readonly kind: "refused";
      readonly code: string;
      readonly message: string;
      readonly sha: string;
    };

export async function submitJob(channel: FileChannel, options: SubmitOptions): Promise<SubmitResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  if (!isRunId(options.runId)) {
    throw new Error(`run id "${options.runId}" cannot be used as a path component`);
  }
  const now = options.now ?? (() => new Date());
  const random = options.random ?? randomBytes;
  const sleep = options.sleep ?? defaultSleep;
  const createdAt = now();
  const jobId = newJobId(createdAt, random(4));
  const paths = jobPaths(jobId);
  const unsigned: UnsignedJob = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    runId: options.runId,
    createdAt: createdAt.toISOString(),
    payloadSha256: sha256Hex(options.payload),
    payloadFile: "payload.json",
    writer: options.writer,
  };
  const job: Job = signJob(unsigned, options.key);

  // The result directory exists before the first poll, not when the agent
  // gets to it. A macOS SMB client caches the answer "no such directory" and
  // keeps giving it for a minute after the directory appears, so a poll that
  // walks through a directory the agent has not created yet can be blind to a
  // result that is already there. Measured on the real host on 2026-11-10:
  // the controller timed out 57 s after the agent had published its refusal.
  await channel.ensureDirectory(paths.resultDirectory);

  // Payload first, manifest last: a manifest never refers to a payload that
  // is not there yet.
  await channel.writeAtomic(paths.payload(job.payloadFile), options.payload);
  await channel.writeAtomic(paths.manifest, encodeJob(job));

  const deadline = createdAt.getTime() + options.timeoutMs;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const evidence = {
    polls: 0,
    absent: 0,
    failed: 0,
    lastError: null as string | null,
    slowestReadMs: 0,
  };

  const judge = (bytes: Uint8Array): Judgement => {
    const sha = sha256Hex(bytes);
    const refused = (code: string, message: string): Judgement => ({
      kind: "refused",
      code,
      message,
      sha,
    });
    if (bytes.length > MAX_RESULT_BYTES) {
      return refused(
        "A8N-JOB-004",
        `result.json is ${String(bytes.length)} bytes, beyond the ${String(MAX_RESULT_BYTES)}-byte limit`,
      );
    }
    const decoded = decodeResult(bytes);
    if (!decoded.ok) {
      return refused("A8N-JOB-001", `result.json is unreadable: ${decoded.detail}`);
    }
    const result = decoded.value;
    if (result.jobId !== jobId) {
      return refused("A8N-JOB-001", `result.json says job "${result.jobId}" but it is in "${jobId}"`);
    }
    // A signature says an agent holding the channel secret produced these
    // bytes; the binding says they describe this payload. Neither implies
    // the other.
    const authenticated = verifyResultAuth(result, [options.key]);
    if (!authenticated.ok) {
      return refused("A8N-JOB-003", `the result is not from a trusted agent: ${authenticated.detail}`);
    }
    if (
      result.status === "refused"
        ? result.payloadSha256 !== null && result.payloadSha256 !== job.payloadSha256
        : result.payloadSha256 !== job.payloadSha256
    ) {
      return refused(
        "A8N-JOB-001",
        `result.json is bound to payload ${String(result.payloadSha256)}, not ${job.payloadSha256}`,
      );
    }
    if (result.status === "refused") {
      return { kind: "refused", code: result.code ?? "A8N-JOB-001", message: result.message, sha };
    }
    return { kind: "result", status: result.status, result, sha };
  };

  const asSubmitResult = (judged: Judgement): SubmitResult => {
    if (judged.kind === "refused") {
      return {
        status: "refused",
        jobId,
        code: judged.code,
        message: judged.message,
        resultSha256: judged.sha,
      };
    }
    if (judged.status === "unknown") {
      return {
        status: "unknown",
        jobId,
        code: "A8N-AE-004",
        message: judged.result.message,
        resultSha256: judged.sha,
        evidence,
        lateResult: null,
      };
    }
    return { status: judged.status, jobId, result: judged.result, resultSha256: judged.sha };
  };

  for (;;) {
    // The deadline is measured before the read, not after it: once it has
    // passed, a result is something that arrived late, and saying so is more
    // honest than calling the run whatever the file happens to claim. The
    // first read happens even then — publishing the job over a share can
    // cost more than a short timeout, and "never looked" is not a verdict.
    const remaining = deadline - now().getTime();
    if (remaining <= 0 && evidence.polls > 0) {
      break;
    }
    const attempt = await readResult(
      channel,
      paths.result,
      remaining > 0 ? Math.min(readTimeoutMs, remaining) : readTimeoutMs,
    );
    evidence.polls += 1;
    evidence.slowestReadMs = Math.max(evidence.slowestReadMs, attempt.ms);
    if (attempt.kind === "too-large") {
      return {
        status: "refused",
        jobId,
        code: "A8N-JOB-004",
        message: attempt.error.message,
        resultSha256: null,
      };
    }
    if (attempt.kind === "bytes") {
      return asSubmitResult(judge(attempt.bytes));
    }
    if (attempt.kind === "absent") {
      evidence.absent += 1;
    } else {
      evidence.failed += 1;
      evidence.lastError = attempt.detail;
    }
    await sleep(pollMs);
  }

  // One last look, without waiting and without sending anything. A result
  // found here is recorded as evidence, never promoted to the run's outcome:
  // the target stays quarantined and a person decides.
  const late = await readResult(channel, paths.result, Math.min(readTimeoutMs, LATE_RECHECK_MS));
  let lateResult: LateResult | null = null;
  if (late.kind === "bytes") {
    const judged = judge(late.bytes);
    lateResult =
      judged.kind === "result"
        ? { status: judged.status, exitCode: judged.result.exitCode, resultSha256: judged.sha }
        : { status: "refused", exitCode: null, resultSha256: judged.sha };
  }
  let message =
    `no result after ${String(options.timeoutMs)}ms ` +
    `(${String(evidence.polls)} read(s): ${String(evidence.absent)} absent, ` +
    `${String(evidence.failed)} failed` +
    (evidence.lastError === null ? "" : `, last error: ${evidence.lastError}`) +
    (evidence.slowestReadMs >= 1_000 ? `, slowest read ${String(evidence.slowestReadMs)}ms` : "") +
    ")" +
    "; the job was left in place and will not be re-sent (it may still be running)";
  if (lateResult !== null) {
    message +=
      `; a signed result for this job appeared after the deadline (status ${lateResult.status}, ` +
      `exit ${lateResult.exitCode === null ? "unknown" : String(lateResult.exitCode)})` +
      "; the run stays unknown and quarantined — review it with `ae-a8n recover`, and never re-send the job";
  }
  return {
    status: "unknown",
    jobId,
    code: "A8N-AE-004",
    message,
    resultSha256: null,
    evidence,
    lateResult,
  };
}
