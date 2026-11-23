/**
 * Dispatcher activation provenance (#294): the record an owned
 * `activateDispatcher()` delivery leaves in the channel so a *later*
 * session attaching through `DispatcherTransport` can attest which OS
 * process the dispatcher runs in.
 *
 * The in-AE dispatcher cannot name its own pid — ExtendScript has no API
 * for it — so the only honest pid evidence is what the delivering side
 * already proved: the session that owned the After Effects process
 * (`AfterFX.exe -r` delivery, issue #276) knows the pid, the process
 * start time / Windows creation identity, and the GUI session it was
 * verified to live in. This file persists exactly that, bound to the
 * heartbeat identity the nonce proof observed (`instance`,
 * `activatedAt`, `activationNonce`), so the record can never be read as
 * "some AE once activated here" — it names one activation of one
 * process.
 *
 * The record is evidence, not authority. A reader must re-prove the
 * process live (pid + start identity against the OS census) and the
 * heartbeat binding before trusting it; anything short of that is
 * "unattested", never a guess. It grants no ownership and no GUI
 * mutation rights — those stay with the script transport's own
 * attestation.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { errorMessage } from "../errors.js";
import { A8N_VERSION } from "../version.js";
import type { OwnedProcess } from "./transport.js";

export const DISPATCHER_PROVENANCE_SCHEMA = "a8n.dispatcher-provenance/v1";
export const DISPATCHER_PROVENANCE_FILE = "provenance.json";

/** The owned host process the activation was proven to run in. */
export type DispatcherHostProvenance = {
  readonly pid: number;
  /** Process start time, ms since the epoch (OS-reported precision). */
  readonly startedAt: number;
  /** Windows full creation time (100 ns), when the OS reported one. */
  readonly identity: string | null;
  /** The executable path the process list reported. */
  readonly executable: string;
  /** `process.platform` of the machine that recorded this. */
  readonly platform: string;
};

/** The GUI login session the host was verified to belong to, when known. */
export type DispatcherSessionProvenance = {
  readonly uid: number;
  readonly asid: number | null;
  readonly user: string | null;
};

export type DispatcherProvenance = {
  readonly schema: typeof DISPATCHER_PROVENANCE_SCHEMA;
  /** ISO timestamp of when the owning session recorded this. */
  readonly recordedAt: string;
  /** The ae-a8n version that wrote it. */
  readonly a8nVersion: string;
  readonly host: DispatcherHostProvenance;
  /**
   * The heartbeat identity the nonce proof observed at activation. The
   * record attests only while the answering dispatcher still reports
   * exactly these values — a re-activation (new instance, new
   * `activatedAt`, new nonce) invalidates it rather than being adopted.
   */
  readonly instance: string;
  readonly activatedAt: number;
  readonly activationNonce: string;
  /**
   * The session the delivering transport verified the host lives in
   * (macOS uid/asid). Null when the delivering side could not name one —
   * Windows activation records no login-session identity.
   */
  readonly session: DispatcherSessionProvenance | null;
};

export function dispatcherProvenancePath(channelDir: string): string {
  return join(channelDir, DISPATCHER_PROVENANCE_FILE);
}

/**
 * Records the proven activation. Written atomically (temp file + rename)
 * at mode 0600 — the channel directory's privacy checks already apply,
 * and the file must never be world-readable even though it carries no
 * secret (defence in depth: it names a process).
 */
export function recordDispatcherProvenance(
  channelDir: string,
  input: {
    readonly host: OwnedProcess;
    readonly instance: string;
    readonly activatedAt: number;
    readonly activationNonce: string;
    readonly session: DispatcherSessionProvenance | null;
  },
): void {
  if (input.instance === "" || !Number.isFinite(input.activatedAt)) {
    throw new Error("dispatcher provenance requires the heartbeat instance and activatedAt it is bound to");
  }
  const provenance: DispatcherProvenance = {
    schema: DISPATCHER_PROVENANCE_SCHEMA,
    recordedAt: new Date().toISOString(),
    a8nVersion: A8N_VERSION,
    host: {
      pid: input.host.pid,
      startedAt: input.host.startedAt,
      identity: input.host.identity ?? null,
      executable: input.host.executable,
      platform: process.platform,
    },
    instance: input.instance,
    activatedAt: input.activatedAt,
    activationNonce: input.activationNonce,
    session: input.session,
  };
  const path = dispatcherProvenancePath(channelDir);
  // The channel directory exists whenever a dispatcher was activated, but
  // the record must not depend on call order: create it like prepare() does.
  mkdirSync(channelDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(provenance, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

function isSession(value: unknown): value is DispatcherSessionProvenance {
  const s = value as Partial<DispatcherSessionProvenance> | null;
  return (
    s !== null &&
    typeof s === "object" &&
    typeof s.uid === "number" &&
    Number.isInteger(s.uid) &&
    s.uid > 0 &&
    (s.asid === null || (typeof s.asid === "number" && Number.isInteger(s.asid))) &&
    (s.user === null || typeof s.user === "string")
  );
}

/**
 * Reads recorded provenance. Returns null when the file does not exist —
 * "nothing was recorded" is the normal answer for a human-activated
 * dispatcher. A file that exists but does not parse as this schema
 * throws: half-written or foreign content must never be silently
 * treated as "no provenance", because the caller deciding whether a pid
 * may be attested needs to know the record is unusable, not absent.
 */
export function readDispatcherProvenance(channelDir: string): DispatcherProvenance | null {
  const path = dispatcherProvenancePath(channelDir);
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `dispatcher provenance at ${path} is not readable JSON: ${errorMessage(error)}`,
    );
  }
  const p = parsed as Partial<DispatcherProvenance> | null;
  const host = p?.host as Partial<DispatcherHostProvenance> | undefined;
  if (
    p === null ||
    typeof p !== "object" ||
    p.schema !== DISPATCHER_PROVENANCE_SCHEMA ||
    typeof p.instance !== "string" ||
    p.instance === "" ||
    typeof p.activatedAt !== "number" ||
    !Number.isFinite(p.activatedAt) ||
    typeof p.activationNonce !== "string" ||
    host === undefined ||
    typeof host !== "object" ||
    typeof host.pid !== "number" ||
    !Number.isInteger(host.pid) ||
    host.pid <= 0 ||
    typeof host.startedAt !== "number" ||
    !Number.isFinite(host.startedAt) ||
    (host.identity !== null && typeof host.identity !== "string") ||
    typeof host.executable !== "string" ||
    host.executable.length === 0 ||
    typeof host.platform !== "string" ||
    (p.session !== null && !isSession(p.session))
  ) {
    throw new Error(
      `dispatcher provenance at ${path} does not match ${DISPATCHER_PROVENANCE_SCHEMA}`,
    );
  }
  return p as DispatcherProvenance;
}
