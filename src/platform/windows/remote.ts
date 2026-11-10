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
  readonly timeoutMs: number;
  readonly writer: JobWriter;
  /**
   * The shared channel secret. Every job is signed with it and every result
   * is accepted only when it carries a valid signature from it.
   */
  readonly key: JobKey;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
  /** Injected so a test does not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
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
  const unsigned: UnsignedJob = {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    createdAt: createdAt.toISOString(),
    payloadSha256: sha256Hex(options.payload),
    payloadFile: "payload.json",
    writer: options.writer,
  };
  const job: Job = signJob(unsigned, options.key);

  // Payload first, manifest last: a manifest never refers to a payload that
  // is not there yet.
  await channel.writeAtomic(paths.payload(job.payloadFile), options.payload);
  await channel.writeAtomic(paths.manifest, encodeJob(job));

  const deadline = createdAt.getTime() + options.timeoutMs;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    let bytes: Uint8Array | null;
    try {
      bytes = await channel.read(paths.result);
    } catch (error) {
      if (error instanceof ChannelFileTooLargeError) {
        return {
          status: "refused",
          jobId,
          code: "A8N-JOB-004",
          message: error.message,
          resultSha256: null,
        };
      }
      throw error;
    }
    if (bytes !== null) {
      const resultSha256 = sha256Hex(bytes);
      const refused = (code: string, message: string): SubmitResult => ({
        status: "refused",
        jobId,
        code,
        message,
        resultSha256,
      });
      if (bytes.length > MAX_RESULT_BYTES) {
        return refused(
          "A8N-JOB-004",
          `result.json is ${bytes.length} bytes, beyond the ${MAX_RESULT_BYTES}-byte limit`,
        );
      }
      const decoded = decodeResult(bytes);
      if (!decoded.ok) {
        return refused("A8N-JOB-001", `result.json is unreadable: ${decoded.detail}`);
      }
      const result = decoded.value;
      if (result.jobId !== jobId) {
        return refused(
          "A8N-JOB-001",
          `result.json says job "${result.jobId}" but it is in "${jobId}"`,
        );
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
        return refused(result.code ?? "A8N-JOB-001", result.message);
      }
      if (result.status === "unknown") {
        return {
          status: "unknown",
          jobId,
          code: "A8N-AE-004",
          message: result.message,
          resultSha256,
        };
      }
      return { status: result.status, jobId, result, resultSha256 };
    }
    if (now().getTime() >= deadline) {
      return {
        status: "unknown",
        jobId,
        code: "A8N-AE-004",
        message:
          `no result after ${options.timeoutMs}ms; the job was left in place and will not be re-sent ` +
          "(it may still be running)",
        resultSha256: null,
      };
    }
    await sleep(pollMs);
  }
}
