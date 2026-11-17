/**
 * The run manifest: the one document that says what ran where, against which
 * identities and versions, and which job/result bytes it is bound to.
 *
 * `aeVersion` is null when the probe could not prove one version. It is never
 * guessed from a directory name.
 */

import type { FileChannel } from "./channel.js";
import { isRunId } from "./lock.js";
import { decodeAuthField, type DecodeOutcome } from "./job.js";
import {
  signRunManifest,
  verifyRunManifestAuth,
  type JobAuth,
  type JobKey,
} from "./auth.js";

export const RUN_MANIFEST_SCHEMA_VERSION = "1.1";

export type RunOutcome = "ok" | "failed" | "refused" | "unknown";

/**
 * What the manifest can say about the run's session marker and about the AE
 * process. 1.1 added both: a manifest that cannot name its proof says
 * "unproven" rather than leaving the reader to assume one.
 */
export type DestinationProof = "marker" | "pid-and-start-time" | "unproven";
export type OwnershipProof = "pid-and-start-time" | "unproven";
/** Whether the result's artifact digests were checked against the bytes read. */
export type ArtifactProof = "verified" | "unproven";

const ARTIFACT_PROOFS: readonly string[] = ["verified", "unproven"];

const DESTINATION_PROOFS: readonly string[] = ["marker", "pid-and-start-time", "unproven"];
const OWNERSHIP_PROOFS: readonly string[] = ["pid-and-start-time", "unproven"];

export type RunManifest = {
  readonly schemaVersion: typeof RUN_MANIFEST_SCHEMA_VERSION;
  readonly runId: string;
  readonly host: string;
  readonly user: string;
  /** Null when the probe could not read it; 0 would claim session 0. */
  readonly sessionId: number | null;
  readonly agentId: string;
  readonly agentVersion: string;
  /** True only when the agent identity came from a verified signed result. */
  readonly agentVerified: boolean;
  /** The one version the probe proved, or null when it could not. */
  readonly aeVersion: string | null;
  readonly jobId: string;
  readonly payloadSha256: string;
  /** Null when no result was published (a timeout); never a hash of nothing. */
  readonly resultSha256: string | null;
  readonly outcome: RunOutcome;
  /** How the run's destination was proven; `unproven` when it was not. */
  readonly destinationProof: DestinationProof;
  /** How the AE process was proven to be this run's; `unproven` here. */
  readonly ownershipProof: OwnershipProof;
  readonly startedAt: string;
  readonly finishedAt: string;
  /**
   * Whether the artifacts the run reported were verified against the digests
   * its signed result carried. Absent — a manifest written before the field
   * existed — reads as unproven.
   */
  readonly artifactProof?: ArtifactProof;
  /**
   * The controller's HMAC over every field above, keyed by the channel key.
   * The manifest makes trust claims (`outcome`, `destinationProof`,
   * `agentVerified`), so it answers to the same secret every sibling
   * document does: a channel writer without the key can rewrite the file
   * but not re-sign it. Absent — a manifest written before signing — the
   * claims are unproven.
   */
  readonly auth?: JobAuth;
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
  const rawResultSha256 = parsed["resultSha256"];
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
    startedAt === null ||
    finishedAt === null
  ) {
    return { ok: false, detail: "manifest.json is missing a required field" };
  }
  if (!isRunId(runId)) {
    return { ok: false, detail: `runId "${runId}" is not in the expected form` };
  }
  const sessionId = parsed["sessionId"];
  if (
    sessionId !== null &&
    (typeof sessionId !== "number" || !Number.isInteger(sessionId) || sessionId < 0)
  ) {
    return { ok: false, detail: "sessionId must be a non-negative integer or null" };
  }
  const resultSha256 = rawResultSha256;
  if (
    resultSha256 !== null &&
    (typeof resultSha256 !== "string" || !HASH_PATTERN.test(resultSha256))
  ) {
    return { ok: false, detail: "resultSha256 must be a SHA-256 hex digest or null" };
  }
  const aeVersion = parsed["aeVersion"];
  if (aeVersion !== null && (typeof aeVersion !== "string" || aeVersion === "")) {
    return { ok: false, detail: "aeVersion must be a non-empty string or null" };
  }
  // Absent (a manifest written before the field existed) means unverified;
  // it never defaults to true.
  const rawAgentVerified = parsed["agentVerified"];
  if (rawAgentVerified !== undefined && typeof rawAgentVerified !== "boolean") {
    return { ok: false, detail: "agentVerified must be a boolean" };
  }
  const agentVerified = rawAgentVerified === true;
  const outcome = parsed["outcome"];
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
    return { ok: false, detail: `unknown outcome ${String(outcome)}` };
  }
  const destinationProof = parsed["destinationProof"];
  if (typeof destinationProof !== "string" || !DESTINATION_PROOFS.includes(destinationProof)) {
    return { ok: false, detail: `unknown destinationProof ${String(destinationProof)}` };
  }
  const ownershipProof = parsed["ownershipProof"];
  if (typeof ownershipProof !== "string" || !OWNERSHIP_PROOFS.includes(ownershipProof)) {
    return { ok: false, detail: `unknown ownershipProof ${String(ownershipProof)}` };
  }
  // Absent (a manifest written before the field existed) means unproven;
  // it never defaults to verified.
  const artifactProof = parsed["artifactProof"];
  if (artifactProof !== undefined && (typeof artifactProof !== "string" || !ARTIFACT_PROOFS.includes(artifactProof))) {
    return { ok: false, detail: `unknown artifactProof ${String(artifactProof)}` };
  }
  // Absent means unsigned: the claims are unproven, never assumed authentic.
  const auth = parsed["auth"];
  let decodedAuth: JobAuth | undefined;
  if (auth !== undefined) {
    const decoded = decodeAuthField({ auth });
    if (!decoded.ok) {
      return { ok: false, detail: `manifest auth is invalid: ${decoded.detail}` };
    }
    decodedAuth = decoded.value;
  }
  if (!HASH_PATTERN.test(payloadSha256)) {
    return { ok: false, detail: "payloadSha256 must be a SHA-256 hex digest" };
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
      sessionId: typeof sessionId === "number" ? sessionId : null,
      agentId,
      agentVersion,
      agentVerified,
      aeVersion: typeof aeVersion === "string" ? aeVersion : null,
      jobId,
      payloadSha256,
      resultSha256,
      outcome: outcome as RunOutcome,
      destinationProof: destinationProof as DestinationProof,
      ownershipProof: ownershipProof as OwnershipProof,
      startedAt,
      finishedAt,
      ...(artifactProof === undefined
        ? {}
        : { artifactProof: artifactProof as ArtifactProof }),
      ...(decodedAuth === undefined ? {} : { auth: decodedAuth }),
    },
  };
}

/** A manifest before its signature is attached. */
export type UnsignedRunManifest = Omit<RunManifest, "auth">;

export function encodeRunManifest(manifest: RunManifest): Uint8Array {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/**
 * Write `runs/<runId>/manifest.json`, signed with the channel key. A manifest
 * may only name its own run, and every manifest this module writes answers
 * to the same secret as the job, result, claim and heartbeat beside it: the
 * trust claims it carries (`outcome`, `destinationProof`, `agentVerified`)
 * are only evidence when the signature verifies.
 */
export async function writeRunManifest(
  channel: FileChannel,
  runId: string,
  manifest: UnsignedRunManifest,
  key: JobKey,
): Promise<void> {
  if (manifest.runId !== runId) {
    throw new Error(
      `manifest.runId "${manifest.runId}" does not match the run directory "${runId}"`,
    );
  }
  await channel.writeAtomic(
    runManifestPath(runId),
    encodeRunManifest(signRunManifest(manifest, key)),
  );
}

/**
 * Read a manifest; a missing file is reported as such, never as a blank one.
 *
 * `keys` is the channel keyring. A caller that passes it gets a verified
 * manifest or a refusal: an unsigned manifest, or one whose signature does
 * not verify, is reported as unreadable rather than returned with its claims
 * intact. Without `keys` the decode is shape-only and `manifest.auth` is
 * absent or unverified — the claims are unproven.
 */
export async function readRunManifest(
  channel: FileChannel,
  runId: string,
  keys?: readonly JobKey[],
): Promise<DecodeOutcome<RunManifest>> {
  const bytes = await channel.read(runManifestPath(runId));
  if (bytes === null) {
    return { ok: false, detail: "manifest.json is missing" };
  }
  const decoded = decodeRunManifest(bytes);
  if (!decoded.ok) {
    return decoded;
  }
  if (decoded.value.runId !== runId) {
    return {
      ok: false,
      detail: `manifest says run "${decoded.value.runId}" but it is in "${runId}"`,
    };
  }
  if (keys !== undefined) {
    if (decoded.value.auth === undefined) {
      return {
        ok: false,
        detail: "manifest.json carries no signature; its claims are unproven",
      };
    }
    const verified = verifyRunManifestAuth(decoded.value, keys);
    if (!verified.ok) {
      return { ok: false, detail: `manifest.json is not authentic: ${verified.detail}` };
    }
  }
  return decoded;
}
