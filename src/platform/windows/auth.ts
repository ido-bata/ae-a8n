/**
 * Authenticity of the job and result documents.
 *
 * The channel is a directory any local process may be able to write. A hash
 * only shows that a payload matches the manifest next to it; it does not show
 * who wrote either. Every job and every result therefore carries an
 * HMAC-SHA256 over its own fields, keyed by a secret provisioned to the two
 * trusted endpoints out of band. A writer without the secret can still write a
 * file, but not one either side will act on.
 *
 * The secret's confidentiality is the trust anchor. It must not live inside
 * the channel: a writer who can read it can forge anything. Setup provisions it
 * on each side in a location only that side's account can read; whether the
 * host's ACLs actually deliver that is a real-host question (T092), so this
 * module only implements and verifies the cryptography.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  AgentIdentity,
  Claim,
  DecodeOutcome,
  Job,
  JobResult,
  JobWriter,
} from "./job.js";

export const JOB_AUTH_ALG = "hmac-sha256";
export const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
/** 256 bits. A shorter shared secret is not worth the ceremony around it. */
export const MIN_SECRET_BYTES = 32;
export const MAX_KEY_FILE_BYTES = 4096;

export type JobKey = {
  readonly keyId: string;
  readonly secret: Uint8Array;
};

export type JobAuth = {
  readonly alg: typeof JOB_AUTH_ALG;
  readonly keyId: string;
  readonly signature: string;
};

export type UnsignedJob = Omit<Job, "auth">;
export type UnsignedJobResult = Omit<JobResult, "auth">;
export type UnsignedClaim = Omit<Claim, "auth">;

export type AuthCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

const JOB_DOMAIN = "ae-a8n job v1";
const RESULT_DOMAIN = "ae-a8n result v1";
const CLAIM_DOMAIN = "ae-a8n claim v1";

/** The signed subset, in a fixed order; `auth` itself is never signed. */
export function jobSigningBytes(job: UnsignedJob | Job): Uint8Array {
  return Buffer.from(
    JSON.stringify([
      JOB_DOMAIN,
      job.schemaVersion,
      job.jobId,
      job.createdAt,
      job.payloadSha256,
      job.payloadFile,
      job.writer.host,
      job.writer.user,
    ]),
    "utf-8",
  );
}

/** The signed subset, in a fixed order; `auth` itself is never signed. */
export function resultSigningBytes(result: UnsignedJobResult | JobResult): Uint8Array {
  const agent: AgentIdentity = result.agent;
  return Buffer.from(
    JSON.stringify([
      RESULT_DOMAIN,
      result.schemaVersion,
      result.jobId,
      result.status,
      result.code,
      result.message,
      result.exitCode,
      result.payloadSha256,
      agent.id,
      agent.host,
      agent.user,
      agent.sessionId,
      agent.version,
      result.startedAt,
      result.finishedAt,
    ]),
    "utf-8",
  );
}

/** The signed subset, in a fixed order; `auth` itself is never signed. */
export function claimSigningBytes(claim: UnsignedClaim | Claim): Uint8Array {
  const agent: AgentIdentity = claim.agent;
  return Buffer.from(
    JSON.stringify([
      CLAIM_DOMAIN,
      claim.schemaVersion,
      claim.jobId,
      claim.claimedAt,
      agent.id,
      agent.host,
      agent.user,
      agent.sessionId,
      agent.version,
    ]),
    "utf-8",
  );
}

function signatureOf(bytes: Uint8Array, key: JobKey): string {
  return createHmac("sha256", key.secret).update(bytes).digest("hex");
}

export function isValidKey(key: JobKey): boolean {
  return KEY_ID_PATTERN.test(key.keyId) && key.secret.length >= MIN_SECRET_BYTES;
}

export function signJob(job: UnsignedJob, key: JobKey): Job {
  return {
    ...job,
    auth: {
      alg: JOB_AUTH_ALG,
      keyId: key.keyId,
      signature: signatureOf(jobSigningBytes(job), key),
    },
  };
}

export function signResult(result: UnsignedJobResult, key: JobKey): JobResult {
  return {
    ...result,
    auth: {
      alg: JOB_AUTH_ALG,
      keyId: key.keyId,
      signature: signatureOf(resultSigningBytes(result), key),
    },
  };
}

export function signClaim(claim: UnsignedClaim, key: JobKey): Claim {
  return {
    ...claim,
    auth: {
      alg: JOB_AUTH_ALG,
      keyId: key.keyId,
      signature: signatureOf(claimSigningBytes(claim), key),
    },
  };
}

function checkAuth(
  auth: JobAuth,
  bytes: Uint8Array,
  keys: readonly JobKey[],
): AuthCheck {
  if (auth.alg !== JOB_AUTH_ALG) {
    return { ok: false, detail: `unsupported signature algorithm "${String(auth.alg)}"` };
  }
  const key = keys.find((candidate) => candidate.keyId === auth.keyId);
  if (key === undefined) {
    return {
      ok: false,
      detail: `the document is signed with key "${auth.keyId}", which this side does not have`,
    };
  }
  if (!SIGNATURE_PATTERN.test(auth.signature)) {
    return { ok: false, detail: "the signature is not a SHA-256 hex digest" };
  }
  const expected = signatureOf(bytes, key);
  const given = Buffer.from(auth.signature, "hex");
  const wanted = Buffer.from(expected, "hex");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, detail: "the signature does not match the document" };
  }
  return { ok: true };
}

export function verifyJobAuth(job: Job, keys: readonly JobKey[]): AuthCheck {
  return checkAuth(job.auth, jobSigningBytes(job), keys);
}

export function verifyResultAuth(result: JobResult, keys: readonly JobKey[]): AuthCheck {
  return checkAuth(result.auth, resultSigningBytes(result), keys);
}

export function verifyClaimAuth(claim: Claim, keys: readonly JobKey[]): AuthCheck {
  return checkAuth(claim.auth, claimSigningBytes(claim), keys);
}

/** The JSON shape of a provisioned key file. */
export type KeyFile = {
  readonly schemaVersion: "1.0";
  readonly keyId: string;
  /** Base64 of the raw secret bytes. */
  readonly secret: string;
};

export function encodeKeyFile(key: JobKey): Uint8Array {
  const file: KeyFile = {
    schemaVersion: "1.0",
    keyId: key.keyId,
    secret: Buffer.from(key.secret).toString("base64"),
  };
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KEY_FILE_KEYS = new Set(["schemaVersion", "keyId", "secret"]);

/**
 * Parse a key file. Unknown fields are refused rather than ignored: a file
 * that carries an extra "role" or "expires" field is not one this version
 * understands, and pretending otherwise is how a downgrade gets accepted.
 */
export function decodeKeyFile(bytes: Uint8Array): DecodeOutcome<JobKey> {
  if (bytes.length > MAX_KEY_FILE_BYTES) {
    return { ok: false, detail: `the key file is larger than ${MAX_KEY_FILE_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return { ok: false, detail: "the key file is not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, detail: "the key file is not an object" };
  }
  for (const key of Object.keys(parsed)) {
    if (!KEY_FILE_KEYS.has(key)) {
      return { ok: false, detail: `unknown key-file field "${key}"` };
    }
  }
  if (parsed["schemaVersion"] !== "1.0") {
    return { ok: false, detail: `unsupported key-file schema ${String(parsed["schemaVersion"])}` };
  }
  const keyId = parsed["keyId"];
  const secret = parsed["secret"];
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
    return { ok: false, detail: "keyId is not in the expected form" };
  }
  if (typeof secret !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(secret)) {
    return { ok: false, detail: "secret is not base64" };
  }
  const raw = Buffer.from(secret, "base64");
  // Node silently ignores invalid trailing bytes; require a lossless round trip.
  if (raw.toString("base64") !== secret) {
    return { ok: false, detail: "secret is not canonical base64" };
  }
  if (raw.length < MIN_SECRET_BYTES) {
    return { ok: false, detail: `the secret is shorter than ${MIN_SECRET_BYTES} bytes` };
  }
  return { ok: true, value: { keyId, secret: new Uint8Array(raw) } };
}

/** A job's writer, reconstructed from a verified document; for diagnostics. */
export function writerOf(job: Job): JobWriter {
  return job.writer;
}
