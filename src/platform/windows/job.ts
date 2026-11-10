/**
 * The job/result files exchanged between the controller and the Windows
 * in-session agent.
 *
 * The channel is a directory both sides can see. Everything security-relevant
 * is data here: the payload hash, the job id, the writer, the age. The agent
 * refuses a job it cannot verify, and a refusal is a normal result — the
 * controller learns why instead of waiting.
 *
 * See `specs/isolated-ae/tasks.md` T087 and `specs/isolated-ae/plan.md` §3.
 */

import { createHash } from "node:crypto";

export const JOB_SCHEMA_VERSION = "1.0";
/** A job older than this is not executed: it may have been replayed. */
export const JOB_MAX_AGE_MS = 10 * 60 * 1000;
/** Tolerance for a controller clock that is slightly ahead of the agent's. */
export const JOB_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const JOB_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type JobWriter = {
  readonly host: string;
  readonly user: string;
};

export type Job = {
  readonly schemaVersion: typeof JOB_SCHEMA_VERSION;
  readonly jobId: string;
  /** ISO-8601. */
  readonly createdAt: string;
  readonly payloadSha256: string;
  /** A bare file name inside the job directory; never a path. */
  readonly payloadFile: string;
  readonly writer: JobWriter;
};

export type AgentIdentity = {
  readonly id: string;
  readonly host: string;
  readonly user: string;
  readonly sessionId: number;
  readonly version: string;
};

/** `unknown` is a real outcome: the agent could not tell what happened. */
export type JobStatus = "ok" | "failed" | "refused" | "unknown";

export type JobResult = {
  readonly schemaVersion: typeof JOB_SCHEMA_VERSION;
  readonly jobId: string;
  readonly status: JobStatus;
  /** `A8N-*` code when the run was refused or indoubt; null otherwise. */
  readonly code: string | null;
  readonly message: string;
  readonly payloadSha256: string | null;
  readonly agent: AgentIdentity;
  readonly startedAt: string;
  readonly finishedAt: string;
};

export type DecodeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

/**
 * What the executor is allowed to run. `argv` is never joined into a command
 * line; the first entry is an absolute program and each following entry is one
 * argument.
 */
export type JobPayload = {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
};

export type JobPayloadRules = {
  readonly isAbsolutePath: (value: string) => boolean;
  readonly hasControlCharacter: (value: string) => boolean;
};

const PAYLOAD_KEYS = new Set(["argv", "env", "cwd"]);

export function decodePayload(
  bytes: Uint8Array,
  rules: JobPayloadRules,
): DecodeOutcome<JobPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return { ok: false, detail: "the payload is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, detail: "the payload is not an object" };
  }
  for (const key of Object.keys(parsed)) {
    if (!PAYLOAD_KEYS.has(key)) {
      return { ok: false, detail: `unknown payload field "${key}"` };
    }
  }

  const argv = parsed["argv"];
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, detail: "argv must be a non-empty array" };
  }
  const args: string[] = [];
  for (const [index, value] of argv.entries()) {
    if (typeof value !== "string") {
      return { ok: false, detail: `argv[${index}] is not a string` };
    }
    if (rules.hasControlCharacter(value)) {
      return { ok: false, detail: `argv[${index}] contains a control character` };
    }
    args.push(value);
  }
  const program = args[0];
  if (program === undefined || !rules.isAbsolutePath(program)) {
    return { ok: false, detail: "argv[0] must be an absolute path" };
  }

  let env: Record<string, string> | undefined;
  const rawEnv = parsed["env"];
  if (rawEnv !== undefined) {
    if (!isRecord(rawEnv)) {
      return { ok: false, detail: "env must be an object" };
    }
    env = {};
    for (const [key, value] of Object.entries(rawEnv)) {
      if (key === "" || rules.hasControlCharacter(key)) {
        return { ok: false, detail: "env has an empty or invalid name" };
      }
      if (typeof value !== "string") {
        return { ok: false, detail: `env["${key}"] is not a string` };
      }
      env[key] = value;
    }
  }

  let cwd: string | undefined;
  const rawCwd = parsed["cwd"];
  if (rawCwd !== undefined) {
    if (typeof rawCwd !== "string" || !rules.isAbsolutePath(rawCwd)) {
      return { ok: false, detail: "cwd must be an absolute path" };
    }
    if (rules.hasControlCharacter(rawCwd)) {
      return { ok: false, detail: "cwd contains a control character" };
    }
    cwd = rawCwd;
  }

  return {
    ok: true,
    value: {
      argv: args,
      ...(env === undefined ? {} : { env }),
      ...(cwd === undefined ? {} : { cwd }),
    },
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `<UTC timestamp>-<random>`; sortable and unique enough for one controller. */
export function newJobId(now: Date, random: Uint8Array): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = Buffer.from(random).toString("hex").slice(0, 8);
  return `${stamp}-${suffix}`;
}

export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

/** The layout both sides share; every path is relative to the channel root. */
export function jobPaths(jobId: string): {
  readonly directory: string;
  readonly manifest: string;
  readonly claim: string;
  readonly resultDirectory: string;
  readonly result: string;
  payload: (fileName: string) => string;
} {
  return {
    directory: `jobs/${jobId}`,
    manifest: `jobs/${jobId}/job.json`,
    claim: `claims/${jobId}.json`,
    resultDirectory: `results/${jobId}`,
    result: `results/${jobId}/result.json`,
    payload: (fileName: string) => `jobs/${jobId}/${fileName}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function decodeJob(bytes: Uint8Array): DecodeOutcome<Job> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return { ok: false, detail: "job.json is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, detail: "job.json is not an object" };
  }
  if (parsed["schemaVersion"] !== JOB_SCHEMA_VERSION) {
    return { ok: false, detail: `unsupported job schema ${String(parsed["schemaVersion"])}` };
  }
  const jobId = stringField(parsed, "jobId");
  const createdAt = stringField(parsed, "createdAt");
  const payloadSha256 = stringField(parsed, "payloadSha256");
  const payloadFile = stringField(parsed, "payloadFile");
  const writer = parsed["writer"];
  if (jobId === null || createdAt === null || payloadSha256 === null || payloadFile === null) {
    return { ok: false, detail: "job.json is missing a required field" };
  }
  if (!isJobId(jobId)) {
    return { ok: false, detail: `jobId "${jobId}" is not in the expected form` };
  }
  if (!HASH_PATTERN.test(payloadSha256)) {
    return { ok: false, detail: "payloadSha256 is not a SHA-256 hex digest" };
  }
  if (payloadFile.includes("/") || payloadFile.includes("\\") || payloadFile === "..") {
    return { ok: false, detail: `payloadFile "${payloadFile}" is a path, not a file name` };
  }
  if (!isRecord(writer)) {
    return { ok: false, detail: "writer is missing" };
  }
  const host = stringField(writer, "host");
  const user = stringField(writer, "user");
  if (host === null || user === null) {
    return { ok: false, detail: "writer.host and writer.user are required" };
  }
  return {
    ok: true,
    value: { schemaVersion: JOB_SCHEMA_VERSION, jobId, createdAt, payloadSha256, payloadFile, writer: { host, user } },
  };
}

export function encodeJob(job: Job): Uint8Array {
  return Buffer.from(`${JSON.stringify(job, null, 2)}\n`, "utf-8");
}

export type JobCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "A8N-JOB-001"; readonly detail: string };

export type ValidateInput = {
  /** The directory the job was found in; a job in someone else's id is rejected. */
  readonly directoryJobId: string;
  readonly job: Job;
  readonly payload: Uint8Array;
  readonly now: Date;
  readonly maxAgeMs?: number;
  readonly futureToleranceMs?: number;
};

/** Every reason the agent must not execute a job. */
export function validateJob(input: ValidateInput): JobCheck {
  const { job } = input;
  if (job.jobId !== input.directoryJobId) {
    return {
      ok: false,
      code: "A8N-JOB-001",
      detail: `job.json says "${job.jobId}" but it is in "${input.directoryJobId}"`,
    };
  }
  const actual = sha256Hex(input.payload);
  if (actual !== job.payloadSha256) {
    return {
      ok: false,
      code: "A8N-JOB-001",
      detail: `payload hash ${actual} does not match the declared ${job.payloadSha256}`,
    };
  }
  const created = Date.parse(job.createdAt);
  if (Number.isNaN(created)) {
    return { ok: false, code: "A8N-JOB-001", detail: `createdAt "${job.createdAt}" is not a date` };
  }
  const age = input.now.getTime() - created;
  const tolerance = input.futureToleranceMs ?? JOB_FUTURE_TOLERANCE_MS;
  if (age < -tolerance) {
    return {
      ok: false,
      code: "A8N-JOB-001",
      detail: `createdAt is ${Math.round(-age / 1000)}s in the future; clocks disagree`,
    };
  }
  const maxAge = input.maxAgeMs ?? JOB_MAX_AGE_MS;
  if (age > maxAge) {
    return {
      ok: false,
      code: "A8N-JOB-001",
      detail: `job is ${Math.round(age / 1000)}s old, beyond the ${Math.round(maxAge / 1000)}s limit; it may be a replay`,
    };
  }
  return { ok: true };
}

export function encodeResult(result: JobResult): Uint8Array {
  return Buffer.from(`${JSON.stringify(result, null, 2)}\n`, "utf-8");
}

export function decodeResult(bytes: Uint8Array): DecodeOutcome<JobResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return { ok: false, detail: "result.json is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, detail: "result.json is not an object" };
  }
  if (parsed["schemaVersion"] !== JOB_SCHEMA_VERSION) {
    return { ok: false, detail: `unsupported result schema ${String(parsed["schemaVersion"])}` };
  }
  const jobId = stringField(parsed, "jobId");
  const message = stringField(parsed, "message");
  const startedAt = stringField(parsed, "startedAt");
  const finishedAt = stringField(parsed, "finishedAt");
  if (jobId === null || message === null || startedAt === null || finishedAt === null) {
    return { ok: false, detail: "result.json is missing a required field" };
  }
  const statusValue = parsed["status"];
  if (
    statusValue !== "ok" &&
    statusValue !== "failed" &&
    statusValue !== "refused" &&
    statusValue !== "unknown"
  ) {
    return { ok: false, detail: `unknown result status ${String(statusValue)}` };
  }
  const rawCode = parsed["code"];
  if (rawCode !== null && rawCode !== undefined && typeof rawCode !== "string") {
    return { ok: false, detail: "code must be a string or null" };
  }
  const rawHash = parsed["payloadSha256"];
  if (rawHash !== null && rawHash !== undefined && (typeof rawHash !== "string" || !HASH_PATTERN.test(rawHash))) {
    return { ok: false, detail: "payloadSha256 must be a SHA-256 hex digest or null" };
  }
  const agent = parsed["agent"];
  if (!isRecord(agent)) {
    return { ok: false, detail: "agent is missing" };
  }
  const id = stringField(agent, "id");
  const host = stringField(agent, "host");
  const user = stringField(agent, "user");
  const version = stringField(agent, "version");
  const sessionId = agent["sessionId"];
  if (id === null || host === null || user === null || version === null) {
    return { ok: false, detail: "agent identity is incomplete" };
  }
  if (typeof sessionId !== "number" || !Number.isInteger(sessionId)) {
    return { ok: false, detail: "agent.sessionId must be an integer" };
  }
  return {
    ok: true,
    value: {
      schemaVersion: JOB_SCHEMA_VERSION,
      jobId,
      status: statusValue,
      code: typeof rawCode === "string" ? rawCode : null,
      message,
      payloadSha256: typeof rawHash === "string" ? rawHash : null,
      agent: { id, host, user, sessionId, version },
      startedAt,
      finishedAt,
    },
  };
}
