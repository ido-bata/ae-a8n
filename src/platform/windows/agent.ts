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
  isResultArtifactPath,
  jobPaths,
  sha256Hex,
  validateJob,
  type AgentIdentity,
  type Job,
  type JobResult,
} from "./job.js";
import {
  createSessionMarker,
  signSessionMarker,
  writeSessionMarker,
} from "./session-marker.js";

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
  /**
   * The run directory exists but carries no `job.json` yet: the controller is
   * still publishing the submission. Nothing was claimed, run or refused.
   */
  | { readonly state: "not-ready" }
  /**
   * A trusted claim exists, so another agent took the job. The claimant and
   * when it claimed are carried so the caller can report a claim that never
   * produced a result: a stranded claim is only clearable by hand, and saying
   * nothing about it leaves a human with a job that silently never runs.
   */
  | {
      readonly state: "claimed-by-other";
      readonly claim: { readonly agent: string; readonly claimedAt: string };
    }
  /**
   * A claim exists that this agent cannot attribute to a trusted issuer. The
   * job's state is unknown, so it is quarantined: not run, not released, and
   * never treated as another agent working on it.
   */
  | { readonly state: "claim-unauthenticated"; readonly detail: string }
  /**
   * The signed job names a different agent as its target. Nothing was
   * claimed, run or refused: refusing here would publish a result the real
   * target then reads as "already finished", so a wrong agent must step
   * aside silently and let the addressed agent take the job.
   */
  | { readonly state: "not-for-us" }
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && Buffer.from(left).equals(Buffer.from(right));
}

/**
 * The target test for T095. The comparison is case-insensitive for the same
 * reason `sameName` is in session-marker.ts: Windows names are not case
 * sensitive. An absent `target` is the compatibility rule — this channel's
 * only agent runs it.
 */
function jobTargetsThisAgent(
  job: Job,
  identity: AgentIdentity,
): boolean {
  if (job.target === undefined) {
    return true;
  }
  return (
    sameText(job.target.id, identity.id) &&
    sameText(job.target.host, identity.host) &&
    sameText(job.target.user, identity.user)
  );
}

function sameText(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

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

  // The target check must happen before the claim: a non-target agent that
  // claimed the job and published a refusal would end the job for the agent
  // it was actually addressed to. The manifest is immutable once written, so
  // reading it here is the same document the post-claim path re-reads. Only
  // an authenticated target is honoured — an unsigned or malformed manifest
  // falls through to the claim path, which refuses it properly.
  const earlyManifest = await readCapped(channel, paths.manifest);
  if (earlyManifest.ok && earlyManifest.bytes !== null && earlyManifest.bytes.length <= MAX_JOB_BYTES) {
    const early = decodeJob(earlyManifest.bytes);
    if (early.ok && verifyJobAuth(early.value, [key]).ok && !jobTargetsThisAgent(early.value, identity)) {
      return { state: "not-for-us" };
    }
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
  const claimBytes = encodeClaim(claim);
  /**
   * An existing claim only blocks this job when it verifies as a signed claim
   * for this job (T103). Anything else — unsigned, forged, unreadable,
   * misplaced, or a claim `O_EXCL` never really excluded (T100) — is replaced
   * by this agent's signed claim, and the replacement is proven by reading
   * the path back: proceeding only when the bytes there are exactly ours.
   * A claim that still is not ours afterwards stays quarantined.
   */
  const retake = async (why: string): Promise<AgentRunOutcome | null> => {
    await channel.writeAtomic(paths.claim, claimBytes);
    const retaken = await readCapped(channel, paths.claim);
    if (retaken.ok && retaken.bytes !== null && bytesEqual(retaken.bytes, claimBytes)) {
      return null;
    }
    return {
      state: "claim-unauthenticated",
      detail: `the existing claim is not a trusted claim for this job and could not be replaced by a signed one: ${why}`,
    };
  };
  const adjudicate = async (heldByUs: boolean): Promise<AgentRunOutcome | null> => {
    if (heldByUs) {
      return null;
    }
    // Someone else got there first — or a claim this agent cannot attribute
    // occupies the path. Distinguish a real agent's claim from a file that
    // merely exists: only a signature shows that an agent holding the channel
    // secret took the job.
    const existingClaim = await readCapped(channel, paths.claim);
    if (!existingClaim.ok) {
      return retake(`the existing claim cannot be read: ${existingClaim.detail}`);
    }
    if (existingClaim.bytes === null) {
      return retake("the existing claim disappeared before it could be verified; the job's state is unknown");
    }
    const decodedClaim = decodeClaim(existingClaim.bytes);
    if (!decodedClaim.ok) {
      // Not a claim this version understands — unsigned, truncated or planted.
      return retake(decodedClaim.detail);
    }
    if (decodedClaim.value.jobId !== jobId) {
      // Authenticated content, wrong job: quarantine rather than overwrite,
      // because a key holder wrote it and the safe reading is corruption.
      return {
        state: "claim-unauthenticated",
        detail: `the existing claim names job "${decodedClaim.value.jobId}", not "${jobId}"`,
      };
    }
    const claimCheck = verifyClaimAuth(decodedClaim.value, [key]);
    if (!claimCheck.ok) {
      return retake(`the existing claim is not from a trusted issuer: ${claimCheck.detail}`);
    }
    return {
      state: "claimed-by-other",
      claim: { agent: decodedClaim.value.agent.id, claimedAt: decodedClaim.value.claimedAt },
    };
  };

  const claimed = await channel.createExclusive(paths.claim, claimBytes);
  if (claimed) {
    // `O_EXCL` is assumed, not proven, on every share (T100): a share that
    // does not honour exclusive create lets two agents both "win". Read the
    // claim back and require it to be exactly what this agent wrote before
    // acting on the win; anything else goes through the same adjudication as
    // a lost race.
    const held = await readCapped(channel, paths.claim);
    const ours =
      held.ok && held.bytes !== null && bytesEqual(held.bytes, claimBytes);
    const outcome = await adjudicate(ours);
    if (outcome !== null) {
      return outcome;
    }
  } else {
    const outcome = await adjudicate(false);
    if (outcome !== null) {
      return outcome;
    }
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

  // Signed is not the same as addressed to me. On a channel with more than
  // one agent every agent verifies every signature; only the target may run.
  if (!jobTargetsThisAgent(job, identity)) {
    const addressed = `${job.target?.id ?? "?"} on ${job.target?.host ?? "?"}\\${job.target?.user ?? "?"}`;
    const result = await refuse(
      channel,
      identity,
      jobId,
      null,
      startedAt,
      now,
      `the job is addressed to agent "${addressed}", not this agent "${identity.id}"; ` +
        "another agent on the channel owns it",
      key,
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
    signSessionMarker(
      createSessionMarker({
        runId: job.runId,
        jobId,
        agent: identity,
        now,
        random: options.random ?? randomBytes,
      }),
      key,
    ),
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
  // Artifacts first: a result that names them never precedes them. Each
  // digest is of the bytes just published, and the signature covers the map
  // — a channel writer without the key can replace a log but cannot make
  // the replacement match what the signed result claims.
  let artifactDigests: Record<string, string> | undefined;
  if (execution.artifacts !== undefined) {
    artifactDigests = {};
    for (const [relativePath, bytes] of Object.entries(execution.artifacts)) {
      // The digest map is signed and decoded with the same path rules, so a
      // name that is not inside the result directory is refused here rather
      // than published into a result nobody can read back.
      if (!isResultArtifactPath(relativePath)) {
        throw new Error(
          `the executor named an artifact "${relativePath}" outside the result directory`,
        );
      }
      await channel.writeAtomic(`${paths.resultDirectory}/${relativePath}`, bytes);
      artifactDigests[relativePath] = sha256Hex(bytes);
    }
  }
  const signed = await publishResult(
    channel,
    jobId,
    {
      ...result,
      ...(artifactDigests === undefined ? {} : { artifacts: artifactDigests }),
    },
    key,
  );
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
