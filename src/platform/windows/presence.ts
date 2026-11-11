/**
 * The agent's signed heartbeat.
 *
 * A job result proves what happened to one job. It says nothing about whether
 * an agent is alive *now*, in which session, at which version, or whether the
 * host the controller is talking to is the one it named. The heartbeat answers
 * exactly those questions, and it is signed with the same channel key as a
 * job: an unsigned heartbeat planted in the channel is refused, not reported
 * as a live agent.
 *
 * The heartbeat is the remote-host backend's evidence for three things the
 * console-session check cannot see from another machine:
 *
 *   - identity: this channel's agent runs on the named host, as the named user;
 *   - liveness: it was alive within `PRESENCE_MAX_AGE_MS`;
 *   - interactivity: its session id is a real interactive session, not session 0
 *     or an SSH-spawned non-interactive process.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { JobKey } from "./auth.js";
import { JOB_AUTH_ALG, SIGNATURE_PATTERN } from "./auth.js";
import type { DecodeOutcome, AgentIdentity } from "./job.js";

export const PRESENCE_SCHEMA_VERSION = "1.0";
export const PRESENCE_DOMAIN = "ae-a8n/presence/1";
/** Older than this and the agent is not considered alive. */
export const PRESENCE_MAX_AGE_MS = 30_000;
export const MAX_PRESENCE_BYTES = 16 * 1024;

export type PresenceAuth = {
  readonly alg: typeof JOB_AUTH_ALG;
  readonly keyId: string;
  readonly signature: string;
};

export type Presence = {
  readonly schemaVersion: typeof PRESENCE_SCHEMA_VERSION;
  readonly agent: AgentIdentity;
  /** ISO-8601; the agent's own clock. */
  readonly heartbeatAt: string;
  /** The agent measured a real interactive session for itself. */
  readonly interactive: boolean;
  readonly auth: PresenceAuth;
};

export type UnsignedPresence = Omit<Presence, "auth">;

export function presencePath(agentId: string): string {
  return `agents/${agentId}.json`;
}

export function presenceSigningBytes(presence: UnsignedPresence | Presence): Uint8Array {
  const { agent } = presence;
  return Buffer.from(
    JSON.stringify([
      PRESENCE_DOMAIN,
      presence.schemaVersion,
      agent.id,
      agent.host,
      agent.user,
      agent.sessionId,
      agent.version,
      presence.heartbeatAt,
      presence.interactive,
    ]),
    "utf-8",
  );
}

function signatureOf(bytes: Uint8Array, key: JobKey): string {
  return createHmac("sha256", key.secret).update(bytes).digest("hex");
}

export function signPresence(presence: UnsignedPresence, key: JobKey): Presence {
  return {
    ...presence,
    auth: {
      alg: JOB_AUTH_ALG,
      keyId: key.keyId,
      signature: signatureOf(presenceSigningBytes(presence), key),
    },
  };
}

export type PresenceAuthCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

export function verifyPresenceAuth(
  presence: Presence,
  keys: readonly JobKey[],
): PresenceAuthCheck {
  if (presence.auth.alg !== JOB_AUTH_ALG) {
    return { ok: false, detail: `unsupported signature algorithm "${String(presence.auth.alg)}"` };
  }
  const key = keys.find((candidate) => candidate.keyId === presence.auth.keyId);
  if (key === undefined) {
    return {
      ok: false,
      detail: `the heartbeat is signed with key "${presence.auth.keyId}", which this side does not have`,
    };
  }
  if (!SIGNATURE_PATTERN.test(presence.auth.signature)) {
    return { ok: false, detail: "the heartbeat signature is not a SHA-256 hex digest" };
  }
  const expected = signatureOf(presenceSigningBytes(presence), key);
  const given = Buffer.from(presence.auth.signature, "hex");
  const wanted = Buffer.from(expected, "hex");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { ok: false, detail: "the heartbeat signature does not match the document" };
  }
  return { ok: true };
}

export function encodePresence(presence: Presence): Uint8Array {
  return Buffer.from(`${JSON.stringify(presence, null, 2)}\n`, "utf-8");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FIELDS = new Set([
  "schemaVersion",
  "agent",
  "heartbeatAt",
  "interactive",
  "auth",
]);
const AGENT_FIELDS = new Set(["id", "host", "user", "sessionId", "version"]);
const AUTH_FIELDS = new Set(["alg", "keyId", "signature"]);

function refuse(detail: string): DecodeOutcome<Presence> {
  return { ok: false, detail };
}

/** Strict: an unknown field is refused, so nothing is silently ignored. */
export function decodePresence(bytes: Uint8Array): DecodeOutcome<Presence> {
  if (bytes.length > MAX_PRESENCE_BYTES) {
    return refuse(`the heartbeat is ${String(bytes.length)} bytes, over the limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return refuse("the heartbeat is not valid JSON");
  }
  if (!isObject(parsed)) {
    return refuse("the heartbeat is not an object");
  }
  for (const key of Object.keys(parsed)) {
    if (!FIELDS.has(key)) {
      return refuse(`unknown heartbeat field "${key}"`);
    }
  }
  if (parsed["schemaVersion"] !== PRESENCE_SCHEMA_VERSION) {
    return refuse(`unsupported heartbeat schema "${String(parsed["schemaVersion"])}"`);
  }
  if (typeof parsed["heartbeatAt"] !== "string") {
    return refuse("heartbeatAt is not a string");
  }
  if (typeof parsed["interactive"] !== "boolean") {
    return refuse("interactive is not a boolean");
  }
  const agent = parsed["agent"];
  if (!isObject(agent)) {
    return refuse("agent is not an object");
  }
  for (const key of Object.keys(agent)) {
    if (!AGENT_FIELDS.has(key)) {
      return refuse(`unknown agent field "${key}"`);
    }
  }
  const { id, host, user, sessionId, version } = agent;
  if (
    typeof id !== "string" ||
    typeof host !== "string" ||
    typeof user !== "string" ||
    typeof version !== "string" ||
    typeof sessionId !== "number" ||
    !Number.isInteger(sessionId) ||
    sessionId < 0
  ) {
    return refuse("the agent identity is not well formed");
  }
  const auth = parsed["auth"];
  if (!isObject(auth)) {
    return refuse("auth is not an object");
  }
  for (const key of Object.keys(auth)) {
    if (!AUTH_FIELDS.has(key)) {
      return refuse(`unknown auth field "${key}"`);
    }
  }
  const { alg, keyId, signature } = auth;
  if (typeof alg !== "string" || typeof keyId !== "string" || typeof signature !== "string") {
    return refuse("the auth block is not well formed");
  }
  return {
    ok: true,
    value: {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      agent: { id, host, user, sessionId, version },
      heartbeatAt: parsed["heartbeatAt"],
      interactive: parsed["interactive"],
      auth: { alg: JOB_AUTH_ALG, keyId, signature },
    },
  };
}

export type PresenceVerdict =
  | { readonly ok: true; readonly presence: Presence; readonly ageMs: number }
  | {
      readonly ok: false;
      readonly code: "A8N-JOB-001" | "A8N-JOB-003" | "A8N-JOB-005" | "A8N-JOB-006";
      readonly detail: string;
    };

export type PresenceExpectation = {
  readonly host: string;
  readonly user: string | null;
  /** Null accepts any version; a version is compared exactly. */
  readonly version: string | null;
};

/**
 * Verify a heartbeat against what the target claims to be. Every refusal names
 * which of the three it is: not from a trusted issuer, not alive, or not the
 * identity the target named.
 */
export function checkPresence(
  presence: Presence,
  keys: readonly JobKey[],
  expected: PresenceExpectation,
  now: Date,
): PresenceVerdict {
  const auth = verifyPresenceAuth(presence, keys);
  if (!auth.ok) {
    return { ok: false, code: "A8N-JOB-003", detail: auth.detail };
  }
  const heardAt = Date.parse(presence.heartbeatAt);
  if (!Number.isFinite(heardAt)) {
    return { ok: false, code: "A8N-JOB-001", detail: "the heartbeat time is not an ISO timestamp" };
  }
  const ageMs = now.getTime() - heardAt;
  if (ageMs > PRESENCE_MAX_AGE_MS) {
    return {
      ok: false,
      code: "A8N-JOB-005",
      detail:
        `the agent last checked in ${String(Math.round(ageMs / 1000))}s ago ` +
        `(limit ${String(PRESENCE_MAX_AGE_MS / 1000)}s); it is not running, or its clock is wrong`,
    };
  }
  if (ageMs < -PRESENCE_MAX_AGE_MS) {
    // A heartbeat dated in the future is not a fresh one. Saying "52s from
    // now" made a stopped agent read as an early one.
    return {
      ok: false,
      code: "A8N-JOB-005",
      detail:
        `the agent's heartbeat is dated ${String(Math.round(-ageMs / 1000))}s in the future ` +
        `(limit ${String(PRESENCE_MAX_AGE_MS / 1000)}s); the two clocks disagree, so liveness ` +
        "cannot be measured from here",
    };
  }
  if (!presence.interactive || presence.agent.sessionId <= 0) {
    return {
      ok: false,
      code: "A8N-JOB-005",
      detail:
        `the agent runs in session ${String(presence.agent.sessionId)}, which is not an interactive session; ` +
        "a process started from SSH or a service is not treated as GUI-capable",
    };
  }
  const hostMatches = presence.agent.host.toLowerCase() === expected.host.toLowerCase();
  const userMatches =
    expected.user === null ||
    presence.agent.user.toLowerCase() === expected.user.toLowerCase() ||
    presence.agent.user.toLowerCase().endsWith(`\\${expected.user.toLowerCase()}`);
  if (!hostMatches || !userMatches) {
    return {
      ok: false,
      code: "A8N-JOB-006",
      detail:
        `the agent reports host "${presence.agent.host}" as "${presence.agent.user}"; ` +
        `the target names host "${expected.host}"` +
        (expected.user === null ? "" : ` as "${expected.user}"`),
    };
  }
  if (expected.version !== null && presence.agent.version !== expected.version) {
    return {
      ok: false,
      code: "A8N-JOB-006",
      detail:
        `the agent runs version ${presence.agent.version}, but this controller is ` +
        `${expected.version}; upgrade the agent on the host or install the matching controller`,
    };
  }
  return { ok: true, presence, ageMs };
}

export type PresenceDecodeCheck =
  | { readonly ok: true; readonly presence: Presence }
  | { readonly ok: false; readonly detail: string };

/** Decode and authenticate in one step; the claim and presence share the key. */
export function readPresenceBytes(bytes: Uint8Array, keys: readonly JobKey[]): PresenceDecodeCheck {
  const decoded = decodePresence(bytes);
  if (!decoded.ok) {
    return { ok: false, detail: decoded.detail };
  }
  const auth = verifyPresenceAuth(decoded.value, keys);
  if (!auth.ok) {
    return { ok: false, detail: auth.detail };
  }
  return { ok: true, presence: decoded.value };
}
