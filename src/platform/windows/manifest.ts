/**
 * The run manifest: the one document that says what ran where, against which
 * identities and versions, and which job/result bytes it is bound to.
 *
 * `aeVersion` is null when the probe could not prove one version. It is never
 * guessed from a directory name.
 */

import type { FileChannel } from "./channel.js";
import { isRunId } from "./lock.js";
import type { DecodeOutcome } from "./job.js";

export const RUN_MANIFEST_SCHEMA_VERSION = "1.0";

export type RunOutcome = "ok" | "failed" | "refused" | "unknown";

export type RunManifest = {
  readonly schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  readonly runId: string;
  readonly host: string;
  readonly user: string;
  readonly sessionId: number;
  readonly agentId: string;
  readonly agentVersion: string;
  /** The one version the probe proved, or null when it could not. */
  readonly aeVersion: string | null;
  readonly jobId: string;
  readonly payloadSha256: string;
  readonly resultSha256: string;
  readonly outcome: RunOutcome;
  readonly startedAt: string;
  readonly finishedAt: string;
};

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OUTCOMES: readonly string[] = ["ok", "failed", "refused", "unknown"];

export function runManifestPath(runId: string): string {
  if (!isRunId(runId)) {
    throw new Error(`run id "${runId}" cannot be used as a path component`);
  }
  return `runs/${runId}/manifest.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function validDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** Validate every field before a manifest is trusted. */
export function decodeRunManifest(bytes: Uint8Array): DecodeOutcome<RunManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return { ok: false, detail: "manifest.json is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, detail: "manifest.json is not an object" };
  }
  if (parsed["schemaVersion"] !== RUN_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      detail: `unsupported manifest schema ${String(parsed["schemaVersion"])}`,
    };
  }
  const runId = stringField(parsed, "runId");
  const host = stringField(parsed, "host");
  const user = stringField(parsed, "user");
  const agentId = stringField(parsed, "agentId");
  const agentVersion = stringField(parsed, "agentVersion");
  const jobId = stringField(parsed, "jobId");
  const payloadSha256 = stringField(parsed, "payloadSha256");
  const resultSha256 = stringField(parsed, "resultSha256");
  const startedAt = stringField(parsed, "startedAt");
  const finishedAt = stringField(parsed, "finishedAt");
  if (
    runId === null ||
    host === null ||
    user === null ||
    agentId === null ||
    agentVersion === null ||
    jobId === null ||
    payloadSha256 === null ||
    resultSha256 === null ||
    startedAt === null ||
    finishedAt === null
  ) {
    return { ok: false, detail: "manifest.json is missing a required field" };
  }
  if (!isRunId(runId)) {
    return { ok: false, detail: `runId "${runId}" is not in the expected form` };
  }
  const sessionId = parsed["sessionId"];
  if (typeof sessionId !== "number" || !Number.isInteger(sessionId) || sessionId < 0) {
    return { ok: false, detail: "sessionId must be a non-negative integer" };
  }
  const aeVersion = parsed["aeVersion"];
  if (aeVersion !== null && (typeof aeVersion !== "string" || aeVersion === "")) {
    return { ok: false, detail: "aeVersion must be a non-empty string or null" };
  }
  const outcome = parsed["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
    return { ok: false, detail: `unknown outcome ${String(outcome)}` };
  }
  if (!HASH_PATTERN.test(payloadSha256) || !HASH_PATTERN.test(resultSha256)) {
    return { ok: false, detail: "payloadSha256 and resultSha256 must be SHA-256 hex digests" };
  }
  if (!validDate(startedAt) || !validDate(finishedAt)) {
    return { ok: false, detail: "startedAt and finishedAt must be ISO-8601 timestamps" };
  }
  return {
    ok: true,
    value: {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      runId,
      host,
      user,
      sessionId,
      agentId,
      agentVersion,
      aeVersion: typeof aeVersion === "string" ? aeVersion : null,
      jobId,
      payloadSha256,
      resultSha256,
      outcome: outcome as RunOutcome,
      startedAt,
      finishedAt,
    },
  };
}

export function encodeRunManifest(manifest: RunManifest): Uint8Array {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/** Write `runs/<runId>/manifest.json`. A manifest may only name its own run. */
export async function writeRunManifest(
  channel: FileChannel,
  runId: string,
  manifest: RunManifest,
): Promise<void> {
  if (manifest.runId !== runId) {
    throw new Error(
      `manifest.runId "${manifest.runId}" does not match the run directory "${runId}"`,
    );
  }
  await channel.writeAtomic(runManifestPath(runId), encodeRunManifest(manifest));
}

/** Read a manifest; a missing file is reported as such, never as a blank one. */
export async function readRunManifest(
  channel: FileChannel,
  runId: string,
): Promise<DecodeOutcome<RunManifest>> {
  const bytes = await channel.read(runManifestPath(runId));
  if (bytes === null) {
    return { ok: false, detail: "manifest.json is missing" };
  }
  const decoded = decodeRunManifest(bytes);
  if (decoded.ok && decoded.value.runId !== runId) {
    return {
      ok: false,
      detail: `manifest says run "${decoded.value.runId}" but it is in "${runId}"`,
    };
  }
  return decoded;
}
