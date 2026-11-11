/**
 * The agent side: claim one job, verify it, run it, publish one result.
 *
 * The agent is the only process that starts After Effects, and it runs in the
 * dedicated user's interactive session. Everything it refuses to do leaves a
 * result file behind, so the controller learns the outcome instead of waiting
 * for a timeout.
 */

import { randomBytes } from "node:crypto";

import {
  signClaim,
  signResult,
  verifyClaimAuth,
  verifyJobAuth,
  type JobKey,
  type UnsignedClaim,
  type UnsignedJobResult,
} from "./auth.js";
import { ChannelFileTooLargeError, type FileChannel } from "./channel.js";
import {
  JOB_SCHEMA_VERSION,
  MAX_JOB_BYTES,
  MAX_PAYLOAD_BYTES,
  decodeClaim,
  decodeJob,
  decodeResult,
  encodeClaim,
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
  /**
   * The run directory exists but carries no `job.json` yet: the controller is
   * still publishing the submission. Nothing was claimed, run or refused.
   */
  | { readonly state: "not-ready" }
  | { readonly state: "claimed-by-other" }
  /**
   * A claim exists that this agent cannot attribute to a trusted issuer. The
   * job's state is unknown, so it is quarantined: not run, not released, and
   * never treated as another agent working on it.
   */
  | { readonly state: "claim-unauthenticated"; readonly detail: string }
  | { readonly state: "already-finished"; readonly result: JobResult | null }
  | { readonly state: "refused"; readonly result: JobResult }
  | { readonly state: "finished"; readonly result: JobResult };

export type AgentRunOptions = {
  readonly channel: FileChannel;
  readonly identity: AgentIdentity;
  readonly executor: JobExecutor;
  readonly jobId: string;
  /**
   * The shared channel secret. Jobs without a valid signature from this key
   * are refused before the executor sees them; every result is signed with it.
   */
  readonly key: JobKey;
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

type ChannelRead =
  | { readonly ok: true; readonly bytes: Uint8Array | null }
  | { readonly ok: false; readonly detail: string };

/** A read the channel refused for size is a refusal, not a crash. */
async function readCapped(channel: FileChannel, path: string): Promise<ChannelRead> {
  try {
    return { ok: true, bytes: await channel.read(path) };
  } catch (error) {
    if (error instanceof ChannelFileTooLargeError) {
      return { ok: false, detail: error.message };
    }
    throw error;
  }
}

async function publishResult(
  channel: FileChannel,
  jobId: string,
  result: UnsignedJobResult,
  key: JobKey,
): Promise<JobResult> {
  const signed = signResult(result, key);
  await channel.writeAtomic(jobPaths(jobId).result, encodeResult(signed));
  return signed;
}

/** Runs at most one job. Never throws for a job it refuses; throws only if the channel fails. */
export async function runJob(options: AgentRunOptions): Promise<AgentRunOutcome> {
  const now = options.now ?? (() => new Date());
  const { channel, identity, jobId, key } = options;
  const paths = jobPaths(jobId);

  // The controller creates the run directory before it publishes `job.json`, so
  // a job directory with no manifest is a submission in progress, not a job.
  // Claiming it here would deny the real submission to every agent and publish
  // a refusal for work that was never offered; leave it for a later poll. The
  // read after the claim stays authoritative, including its size refusal.
  const preflight = await readCapped(channel, paths.manifest);
  if (preflight.ok && preflight.bytes === null) {
    return { state: "not-ready" };
  }

  const claim = signClaim(
    {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId,
      claimedAt: timestamp(now),
      agent: identity,
    } satisfies UnsignedClaim,
    key,
  );
  const claimed = await channel.createExclusive(paths.claim, encodeClaim(claim));
  if (!claimed) {
    // Someone else got there first. Distinguish a real agent's claim from a
    // file that merely exists: only a signature shows that an agent holding
    // the channel secret took the job.
    const existingClaim = await readCapped(channel, paths.claim);
    if (!existingClaim.ok) {
      return {
        state: "claim-unauthenticated",
        detail: `the existing claim cannot be read: ${existingClaim.detail}`,
      };
    }
    if (existingClaim.bytes === null) {
      return {
        state: "claim-unauthenticated",
        detail: "the existing claim disappeared before it could be verified; the job's state is unknown",
      };
    }
    const decodedClaim = decodeClaim(existingClaim.bytes);
    if (!decodedClaim.ok) {
      return {
        state: "claim-unauthenticated",
        detail: `the existing claim is not valid: ${decodedClaim.detail}`,
      };
    }
    if (decodedClaim.value.jobId !== jobId) {
      return {
        state: "claim-unauthenticated",
        detail: `the existing claim names job "${decodedClaim.value.jobId}", not "${jobId}"`,
      };
    }
    const claimCheck = verifyClaimAuth(decodedClaim.value, [key]);
    if (!claimCheck.ok) {
      return {
        state: "claim-unauthenticated",
        detail: `the existing claim is not from a trusted issuer: ${claimCheck.detail}`,
      };
    }
    return { state: "claimed-by-other" };
  }

  // A result means some agent already ran this job. It is never re-sent,
  // even when the result cannot be read: that is an unknown outcome.
  const existing = await readCapped(channel, paths.result);
  if (!existing.ok) {
    return { state: "already-finished", result: null };
  }
  if (existing.bytes !== null) {
    const decoded = decodeResult(existing.bytes);
    return { state: "already-finished", result: decoded.ok ? decoded.value : null };
  }

  const startedAt = timestamp(now);
  const manifestRead = await readCapped(channel, paths.manifest);
  if (!manifestRead.ok) {
    const result = await refuse(
      channel,
      identity,
      jobId,
      null,
      startedAt,
      now,
      manifestRead.detail,
      key,
      "A8N-JOB-004",
    );
    return { state: "refused", result };
  }
  const manifestBytes = manifestRead.bytes;
  if (manifestBytes === null) {
    const result = await refuse(channel, identity, jobId, null, startedAt, now, "job.json is missing", key);
    return { state: "refused", result };
  }
  if (manifestBytes.length > MAX_JOB_BYTES) {
    const result = await refuse(
      channel,
      identity,
      jobId,
      null,
      startedAt,
      now,
      `job.json is ${manifestBytes.length} bytes, beyond the ${MAX_JOB_BYTES}-byte limit`,
      key,
      "A8N-JOB-004",
    );
    return { state: "refused", result };
  }

  const decoded = decodeJob(manifestBytes);
  if (!decoded.ok) {
    const result = await refuse(channel, identity, jobId, null, startedAt, now, decoded.detail, key);
    return { state: "refused", result };
  }
  const job = decoded.value;

  // A hash binds the payload to the manifest; the signature binds the
  // manifest to an issuer that knows the channel secret. Without it any local
  // writer could make the dedicated user execute arbitrary code.
  const authenticated = verifyJobAuth(job, [key]);
  if (!authenticated.ok) {
    const result = await refuse(
      channel,
      identity,
      jobId,
      null,
      startedAt,
      now,
      `the job is not from a trusted issuer: ${authenticated.detail}`,
      key,
      "A8N-JOB-003",
    );
    return { state: "refused", result };
  }

  const payloadRead = await readCapped(channel, paths.payload(job.payloadFile));
  if (!payloadRead.ok) {
    const result = await refuse(
      channel,
      identity,
      jobId,
      null,
      startedAt,
      now,
      payloadRead.detail,
      key,
      "A8N-JOB-004",
    );
    return { state: "refused", result };
  }
  const payload = payloadRead.bytes;
  if (payload === null) {
    const result = await refuse(
      channel,
      identity,
      jobId,
      null,
      startedAt,
      now,
      `payload "${job.payloadFile}" is missing`,
      key,
    );
    return { state: "refused", result };
  }
  if (payload.length > MAX_PAYLOAD_BYTES) {
    const result = await refuse(
      channel,
      identity,
      jobId,
      sha256Hex(payload),
      startedAt,
      now,
      `payload is ${payload.length} bytes, beyond the ${MAX_PAYLOAD_BYTES}-byte limit`,
      key,
      "A8N-JOB-004",
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
    const result = await refuse(channel, identity, jobId, sha256Hex(payload), startedAt, now, checked.detail, key);
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
    // A throw says the harness lost the outcome, not that the command failed:
    // it may have run, half-run or not started. Publishing "failed" would
    // invite a retry of something that may have happened; "unknown" makes the
    // controller quarantine the target, which is the contract's rule.
    execution = {
      status: "unknown",
      message: `the executor threw, so the outcome is unknown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const result: UnsignedJobResult = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    status: execution.status,
    code: execution.code ?? null,
    message: execution.message,
    // `ok` means the process exited 0; an executor that reports ok without an
    // exit code is recording the same fact, not a missing one.
    exitCode:
      execution.exitCode ?? (execution.status === "ok" ? 0 : null),
    payloadSha256: job.payloadSha256,
    agent: identity,
    startedAt,
    finishedAt: timestamp(now),
  };
  // Artifacts first: a result that names them never precedes them.
  for (const [relativePath, bytes] of Object.entries(execution.artifacts ?? {})) {
    await channel.writeAtomic(`${paths.resultDirectory}/${relativePath}`, bytes);
  }
  const signed = await publishResult(channel, jobId, result, key);
  return { state: "finished", result: signed };
}

async function refuse(
  channel: FileChannel,
  identity: AgentIdentity,
  jobId: string,
  payloadSha256: string | null,
  startedAt: string,
  now: () => Date,
  detail: string,
  key: JobKey,
  code = "A8N-JOB-001",
): Promise<JobResult> {
  const result: UnsignedJobResult = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    status: "refused",
    code,
    message: detail,
    exitCode: null,
    payloadSha256,
    agent: identity,
    startedAt,
    finishedAt: timestamp(now),
  };
  return publishResult(channel, jobId, result, key);
}
