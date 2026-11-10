/**
 * The agent side: claim one job, verify it, run it, publish one result.
 *
 * The agent is the only process that starts After Effects, and it runs in the
 * dedicated user's interactive session. Everything it refuses to do leaves a
 * result file behind, so the controller learns the outcome instead of waiting
 * for a timeout.
 */

import { randomBytes } from "node:crypto";

import type { FileChannel } from "./channel.js";
import {
  JOB_SCHEMA_VERSION,
  decodeJob,
  decodeResult,
  encodeResult,
  jobPaths,
  sha256Hex,
  validateJob,
  type AgentIdentity,
  type Job,
  type JobResult,
} from "./job.js";
import { createSessionMarker, writeSessionMarker } from "./session-marker.js";

export type JobExecution = {
  /** `unknown` means the executor could not tell what happened; never retry it. */
  readonly status: "ok" | "failed" | "unknown";
  /** A diagnostic code, when the executor has one; published as `code` or null. */
  readonly code?: string;
  /** The process's exit code, or null/absent when it did not exit normally. */
  readonly exitCode?: number | null;
  readonly message: string;
  /** Relative paths under the result directory, written after the result. */
  readonly artifacts?: Readonly<Record<string, Uint8Array>>;
};

export interface JobExecutor {
  execute(input: { readonly job: Job; readonly payload: Uint8Array }): Promise<JobExecution>;
}

export type AgentRunOutcome =
  | { readonly state: "no-job" }
  | { readonly state: "claimed-by-other" }
  | { readonly state: "already-finished"; readonly result: JobResult | null }
  | { readonly state: "refused"; readonly result: JobResult }
  | { readonly state: "finished"; readonly result: JobResult };

export type AgentRunOptions = {
  readonly channel: FileChannel;
  readonly identity: AgentIdentity;
  readonly executor: JobExecutor;
  readonly jobId: string;
  readonly now?: () => Date;
  readonly maxAgeMs?: number;
  /** The marker secret; injected in tests, `randomBytes` otherwise. */
  readonly random?: (size: number) => Uint8Array;
};

/** An agent in session 0 has no desktop, so it cannot run a GUI AE. */
export class AgentNotInteractiveError extends Error {
  constructor(sessionId: number) {
    super(
      `the agent is in session ${sessionId}, which has no interactive desktop; ` +
        "start it in the dedicated user's signed-in session",
    );
    this.name = "AgentNotInteractiveError";
  }
}

export function assertInteractiveIdentity(identity: AgentIdentity): void {
  if (identity.sessionId <= 0) {
    throw new AgentNotInteractiveError(identity.sessionId);
  }
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

async function publishResult(
  channel: FileChannel,
  jobId: string,
  result: JobResult,
): Promise<void> {
  await channel.writeAtomic(jobPaths(jobId).result, encodeResult(result));
}

/** Runs at most one job. Never throws for a job it refuses; throws only if the channel fails. */
export async function runJob(options: AgentRunOptions): Promise<AgentRunOutcome> {
  const now = options.now ?? (() => new Date());
  const { channel, identity, jobId } = options;
  const paths = jobPaths(jobId);

  const claimed = await channel.createExclusive(
    paths.claim,
    new TextEncoder().encode(
      `${JSON.stringify({ jobId, claimedAt: timestamp(now), agent: identity }, null, 2)}\n`,
    ),
  );
  if (!claimed) {
    return { state: "claimed-by-other" };
  }

  // A result means some agent already ran this job. It is never re-sent,
  // even when the result cannot be read: that is an unknown outcome.
  const existing = await channel.read(paths.result);
  if (existing !== null) {
    const decoded = decodeResult(existing);
    return { state: "already-finished", result: decoded.ok ? decoded.value : null };
  }

  const startedAt = timestamp(now);
  const manifestBytes = await channel.read(paths.manifest);
  if (manifestBytes === null) {
    const result = await refuse(channel, identity, jobId, null, startedAt, now, "job.json is missing");
    return { state: "refused", result };
  }

  const decoded = decodeJob(manifestBytes);
  if (!decoded.ok) {
    const result = await refuse(channel, identity, jobId, null, startedAt, now, decoded.detail);
    return { state: "refused", result };
  }
  const job = decoded.value;
  const payload = await channel.read(paths.payload(job.payloadFile));
  if (payload === null) {
    const result = await refuse(
      channel,
      identity,
      jobId,
      null,
      startedAt,
      now,
      `payload "${job.payloadFile}" is missing`,
    );
    return { state: "refused", result };
  }

  const checked = validateJob({
    directoryJobId: jobId,
    job,
    payload,
    now: now(),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
  });
  if (!checked.ok) {
    const result = await refuse(channel, identity, jobId, sha256Hex(payload), startedAt, now, checked.detail);
    return { state: "refused", result };
  }

  // Verified, not yet executed: bind this run to the marker before anything
  // can act. A channel failure here aborts the job; the controller then has no
  // marker and must not treat the destination as proven.
  await writeSessionMarker(
    channel,
    createSessionMarker({
      runId: job.runId,
      jobId,
      agent: identity,
      now,
      random: options.random ?? randomBytes,
    }),
  );

  let execution: JobExecution;
  try {
    execution = await options.executor.execute({ job, payload });
  } catch (error) {
    execution = {
      status: "failed",
      message: `the executor threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const result: JobResult = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    status: execution.status,
    code: execution.code ?? null,
    message: execution.message,
    exitCode: execution.exitCode ?? null,
    payloadSha256: job.payloadSha256,
    agent: identity,
    startedAt,
    finishedAt: timestamp(now),
  };
  // Artifacts first: a result that names them never precedes them.
  for (const [relativePath, bytes] of Object.entries(execution.artifacts ?? {})) {
    await channel.writeAtomic(`${paths.resultDirectory}/${relativePath}`, bytes);
  }
  await publishResult(channel, jobId, result);
  return { state: "finished", result };
}

async function refuse(
  channel: FileChannel,
  identity: AgentIdentity,
  jobId: string,
  payloadSha256: string | null,
  startedAt: string,
  now: () => Date,
  detail: string,
): Promise<JobResult> {
  const result: JobResult = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    status: "refused",
    code: "A8N-JOB-001",
    message: detail,
    exitCode: null,
    payloadSha256,
    agent: identity,
    startedAt,
    finishedAt: timestamp(now),
  };
  await publishResult(channel, jobId, result);
  return result;
}
