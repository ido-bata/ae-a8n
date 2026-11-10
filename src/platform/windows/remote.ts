/**
 * The controller side: publish one job and wait for exactly one result.
 *
 * A timeout is not a failure and not a success. The job is left where it is,
 * reported as unknown, and never re-sent — re-sending is how a run that may
 * still be executing turns into two runs.
 */

import { randomBytes } from "node:crypto";

import type { FileChannel } from "./channel.js";
import {
  JOB_SCHEMA_VERSION,
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
  readonly timeoutMs: number;
  readonly writer: JobWriter;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
  /** Injected so a test does not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type SubmitResult =
  | { readonly status: "ok" | "failed"; readonly jobId: string; readonly result: JobResult }
  | { readonly status: "refused"; readonly jobId: string; readonly code: string; readonly message: string }
  | {
      readonly status: "unknown";
      readonly jobId: string;
      readonly code: "A8N-AE-004";
      readonly message: string;
    };

const DEFAULT_POLL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function submitJob(channel: FileChannel, options: SubmitOptions): Promise<SubmitResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  const now = options.now ?? (() => new Date());
  const random = options.random ?? randomBytes;
  const sleep = options.sleep ?? defaultSleep;
  const createdAt = now();
  const jobId = newJobId(createdAt, random(4));
  const paths = jobPaths(jobId);
  const job: Job = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    createdAt: createdAt.toISOString(),
    payloadSha256: sha256Hex(options.payload),
    payloadFile: "payload.json",
    writer: options.writer,
  };

  // Payload first, manifest last: a manifest never refers to a payload that
  // is not there yet.
  await channel.writeAtomic(paths.payload(job.payloadFile), options.payload);
  await channel.writeAtomic(paths.manifest, encodeJob(job));

  const deadline = createdAt.getTime() + options.timeoutMs;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    const bytes = await channel.read(paths.result);
    if (bytes !== null) {
      const decoded = decodeResult(bytes);
      if (!decoded.ok) {
        return {
          status: "refused",
          jobId,
          code: "A8N-JOB-001",
          message: `result.json is unreadable: ${decoded.detail}`,
        };
      }
      const result = decoded.value;
      if (result.jobId !== jobId) {
        return {
          status: "refused",
          jobId,
          code: "A8N-JOB-001",
          message: `result.json says job "${result.jobId}" but it is in "${jobId}"`,
        };
      }
      if (result.status === "refused") {
        return {
          status: "refused",
          jobId,
          code: result.code ?? "A8N-JOB-001",
          message: result.message,
        };
      }
      if (result.status === "unknown") {
        return {
          status: "unknown",
          jobId,
          code: "A8N-AE-004",
          message: result.message,
        };
      }
      return { status: result.status, jobId, result };
    }
    if (now().getTime() >= deadline) {
      return {
        status: "unknown",
        jobId,
        code: "A8N-AE-004",
        message:
          `no result after ${options.timeoutMs}ms; the job was left in place and will not be re-sent ` +
          "(it may still be running)",
      };
    }
    await sleep(pollMs);
  }
}
