/**
 * Launch provenance: the minimal record a session leaves behind so a later
 * process can ask "is the After Effects I started still the same process?"
 *
 * The file is evidence, not authority. It names a pid, a start time, and an
 * executable; whether that process may be adopted is decided again, live, by
 * the transport and the readiness probe — never by this document alone.
 * Anything that cannot be proven stays `unknown`/`attached` and is left
 * running.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { A8N_VERSION } from "../version.js";
import { errorMessage } from "../errors.js";

export const LAUNCH_PROVENANCE_SCHEMA = "a8n.launch-provenance/v1";

/**
 * How far the recording session got with the host it names (#458):
 *
 * - `"spawned"`: the transport reported the process it started, but the
 *   readiness probe never answered — the host may be wedged, modal-blocked,
 *   or still starting. The record still names exactly which process this
 *   session spawned (pid + pinned start identity), which is what lets
 *   `terminate` prove "we spawned this exact pid" through the live census
 *   re-proof and end a host that will never answer a script.
 * - `"ready"`: the readiness probe answered and ownership was proven — the
 *   full record `resume`/`rebuild`/`terminate` have always relied on.
 *
 * Records written before `phase` existed carry no field; readers treat
 * them as `"ready"` because they could only be written after the probe.
 */
export const LAUNCH_PROVENANCE_PHASES = ["spawned", "ready"] as const;
export type LaunchProvenancePhase = (typeof LAUNCH_PROVENANCE_PHASES)[number];

export type LaunchProvenance = {
  readonly schema: typeof LAUNCH_PROVENANCE_SCHEMA;
  /** ISO timestamp of when the owning session recorded this. */
  readonly recordedAt: string;
  /** The ae-a8n version that wrote it. */
  readonly a8nVersion: string;
  /** The transport kind that owned the host. */
  readonly transport: string;
  /** How far the session got with the host; absent in pre-#458 records = "ready". */
  readonly phase: LaunchProvenancePhase;
  readonly host: {
    readonly pid: number;
    /** Process start time in ms; null when the platform cannot report one. */
    readonly startedAt: number | null;
    /** Windows full creation time (100 ns), when reported. */
    readonly identity: string | null;
    /** The executable path the process list reported. */
    readonly executable: string;
    readonly platform: string;
  };
};

/** What a transport reports as the process it owns; the rest is filled in here. */
export type OwnedProcess = {
  readonly pid: number;
  readonly startedAt: number;
  readonly identity?: string | undefined;
  readonly executable: string;
};

/**
 * The host identity a provenance record names. `startedAt` may be null: a
 * spawn-phase record is written from the transport's pending-launch report,
 * which keeps `null` rather than guessing a start time when the process
 * list could not be read. A null start time never authorizes a signal —
 * every consumer's live census re-proof treats it as ambiguous.
 */
export type ProvenanceHost = {
  readonly pid: number;
  readonly startedAt: number | null;
  readonly identity?: string | undefined;
  readonly executable: string;
};

export function launchProvenancePath(sessionRoot: string): string {
  return join(sessionRoot, "launch-provenance.json");
}

/**
 * Records the owned host of a session. Written atomically (temp file +
 * rename) so a crash mid-write cannot leave a half document that reads as
 * valid provenance.
 */
export function recordLaunchProvenance(
  sessionRoot: string,
  input: {
    readonly transport: string;
    readonly host: ProvenanceHost;
    /** Defaults to `"ready"` — the phase every pre-#458 caller meant. */
    readonly phase?: LaunchProvenancePhase;
  },
): void {
  const provenance: LaunchProvenance = {
    schema: LAUNCH_PROVENANCE_SCHEMA,
    recordedAt: new Date().toISOString(),
    a8nVersion: A8N_VERSION,
    transport: input.transport,
    phase: input.phase ?? "ready",
    host: {
      pid: input.host.pid,
      startedAt: input.host.startedAt,
      identity: input.host.identity ?? null,
      executable: input.host.executable,
      platform: process.platform,
    },
  };
  const path = launchProvenancePath(sessionRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(provenance, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

/**
 * Reads recorded provenance. Returns null when the file does not exist —
 * "nothing was recorded" is a normal answer. A file that exists but does not
 * parse as this schema throws: half-written or foreign content must never be
 * silently treated as "no provenance", because the caller deciding whether a
 * host may be adopted needs to know the record is unusable, not absent.
 */
export function readLaunchProvenance(sessionRoot: string): LaunchProvenance | null {
  const path = launchProvenancePath(sessionRoot);
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `launch provenance at ${path} is not readable JSON: ${errorMessage(error)}`,
    );
  }
  const p = parsed as Partial<LaunchProvenance> | null;
  const host = p?.host as Partial<LaunchProvenance["host"]> | undefined;
  if (
    p === null ||
    typeof p !== "object" ||
    p.schema !== LAUNCH_PROVENANCE_SCHEMA ||
    typeof p.transport !== "string" ||
    (p.phase !== undefined &&
      !(LAUNCH_PROVENANCE_PHASES as readonly unknown[]).includes(p.phase)) ||
    host === undefined ||
    typeof host !== "object" ||
    typeof host.pid !== "number" ||
    !Number.isInteger(host.pid) ||
    host.pid <= 0 ||
    (host.startedAt !== null && typeof host.startedAt !== "number") ||
    (host.identity !== null && typeof host.identity !== "string") ||
    typeof host.executable !== "string" ||
    host.executable.length === 0 ||
    typeof host.platform !== "string"
  ) {
    throw new Error(`launch provenance at ${path} does not match ${LAUNCH_PROVENANCE_SCHEMA}`);
  }
  // Records predating `phase` could only be written after the probe, so a
  // missing field reads as "ready" — never as the weaker "spawned".
  return { ...(p as LaunchProvenance), phase: p.phase ?? "ready" };
}

/** Removes the record, e.g. after the owned host was quit cleanly. */
export function clearLaunchProvenance(sessionRoot: string): void {
  rmSync(launchProvenancePath(sessionRoot), { force: true });
}
