/**
 * Durable supervision state (specs/gui-supervision/spec.md §Durable shared
 * state, #280).
 *
 * One schema-versioned JSON document per session directory is the single
 * source of truth every client reads. Writes are atomic (tmp + rename,
 * mode 0600). Reads are honest: absent, corrupt and future-version state
 * are distinguished, and a stale monitor heartbeat is re-evaluated at read
 * time — the stored `observationHealth` is never trusted over the clock.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
  ObservationHealth,
  SupervisionPhase,
  SupervisionReadSource,
  SupervisionReport,
  SupervisionReportFacts,
  SupervisionStateDoc,
} from "./types.js";
import { SUPERVISION_PHASES, SUPERVISION_SCHEMA_VERSION } from "./types.js";
import { supervisionNextActions } from "./guidance.js";

export const SUPERVISION_STATE_FILE = "supervision.json";

/** Default monitor heartbeat freshness window. */
export const DEFAULT_MONITOR_TTL_MS = 30 * 1000;

export function supervisionStatePath(sessionDir: string): string {
  return join(sessionDir, SUPERVISION_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PHASES = new Set<string>(SUPERVISION_PHASES);
const HEALTHS = new Set<string>(["ok", "degraded", "monitor-lost", "unavailable"]);
const HOST_STATES = new Set<string>([
  "none",
  "process-gone",
  "not-responding",
  "busy-suspected",
  "gui-session-lost",
  "unknown",
]);
const TIERS = new Set<string>(["auto-safe", "human-required", "report-only", "unknown"]);

function isSupervisionWindow(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["title"] === "string" &&
    typeof value["role"] === "string" &&
    typeof value["blocking"] === "boolean" &&
    typeof value["tier"] === "string" &&
    TIERS.has(value["tier"])
  );
}

function isPendingRequest(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["id"] === "string" &&
    typeof value["method"] === "string" &&
    typeof value["since"] === "string" &&
    typeof value["state"] === "string" &&
    ["in-flight", "timed-out", "unknown"].includes(value["state"])
  );
}

function isMonitorRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["ownerId"] === "string" &&
    typeof value["pid"] === "number" &&
    typeof value["acquiredAt"] === "string" &&
    typeof value["heartbeatAt"] === "string"
  );
}

function isBlockingInfo(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value["host"] !== "string" || !HOST_STATES.has(value["host"])) {
    return false;
  }
  if (typeof value["detail"] !== "string") {
    return false;
  }
  return (
    Array.isArray(value["windows"]) && value["windows"].every(isSupervisionWindow)
  );
}

/**
 * Validate a parsed document. Returns the doc or null — a document that
 * fails validation is corrupt, never partially trusted.
 */
export function decodeSupervisionDoc(value: unknown): SupervisionStateDoc | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value["schemaVersion"] !== SUPERVISION_SCHEMA_VERSION) {
    return null;
  }
  if (typeof value["phase"] !== "string" || !PHASES.has(value["phase"])) {
    return null;
  }
  if (typeof value["observationHealth"] !== "string" || !HEALTHS.has(value["observationHealth"])) {
    return null;
  }
  if (typeof value["enteredAt"] !== "string" || typeof value["updatedAt"] !== "string") {
    return null;
  }
  if (value["deadline"] !== null && typeof value["deadline"] !== "string") {
    return null;
  }
  if (value["sessionId"] !== null && typeof value["sessionId"] !== "string") {
    return null;
  }
  if (!isBlockingInfo(value["blocking"])) {
    return null;
  }
  if (!Array.isArray(value["pendingRequests"]) || !value["pendingRequests"].every(isPendingRequest)) {
    return null;
  }
  if (value["monitor"] !== null && !isMonitorRecord(value["monitor"])) {
    return null;
  }
  if (!Array.isArray(value["evidence"]) || !value["evidence"].every((e) => typeof e === "string")) {
    return null;
  }
  if (!Array.isArray(value["history"])) {
    return null;
  }
  const phase = value["phase"] as SupervisionPhase;
  // The bounded-wait invariant is re-checked on read: a hand-edited or
  // partially-written document that violates it is corrupt, not trusted.
  if (
    (phase === "blocked" || phase === "recovering" || phase === "needs-human" || phase === "quarantined") &&
    value["deadline"] === null
  ) {
    return null;
  }
  return value as unknown as SupervisionStateDoc;
}

export type ReadStateResult =
  | { readonly kind: "state"; readonly doc: SupervisionStateDoc }
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt"; readonly detail: string };

/** Read and validate the state document. Never throws for bad content. */
export function readSupervisionState(sessionDir: string): ReadStateResult {
  const path = supervisionStatePath(sessionDir);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "corrupt", detail: `state file exists but cannot be read: ${path}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "corrupt", detail: `state file is not valid JSON: ${path}` };
  }
  const doc = decodeSupervisionDoc(parsed);
  if (doc === null) {
    return { kind: "corrupt", detail: `state file failed schema validation: ${path}` };
  }
  return { kind: "state", doc };
}

/**
 * Atomically publish the state document. Throws on I/O failure — a state
 * that cannot be written must not be reported as written.
 */
export function writeSupervisionState(sessionDir: string, doc: SupervisionStateDoc): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const path = supervisionStatePath(sessionDir);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Remove the state document; used by session teardown. Idempotent. */
export function removeSupervisionState(sessionDir: string): void {
  try {
    rmSync(supervisionStatePath(sessionDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Re-evaluate observation health at read time. The stored value is the
 * monitor's last claim; the heartbeat clock is the truth. A heartbeat older
 * than `monitorTtlMs` means `monitor-lost` regardless of what the document
 * says — and `unavailable`/`degraded` stored values are preserved because
 * they describe probe failures a fresh heartbeat cannot disprove.
 */
export function evaluateObservationHealth(
  doc: SupervisionStateDoc,
  now: Date,
  monitorTtlMs: number = DEFAULT_MONITOR_TTL_MS,
): { readonly health: ObservationHealth; readonly detail: string | null } {
  if (doc.monitor === null) {
    return {
      health: doc.observationHealth === "ok" ? "unavailable" : doc.observationHealth,
      detail: doc.observationHealth === "ok" ? "no monitor is recorded" : null,
    };
  }
  const heartbeatAt = Date.parse(doc.monitor.heartbeatAt);
  if (Number.isNaN(heartbeatAt)) {
    return { health: "monitor-lost", detail: "the recorded monitor heartbeat is unreadable" };
  }
  if (now.getTime() - heartbeatAt > monitorTtlMs) {
    return {
      health: "monitor-lost",
      detail:
        `the monitor heartbeat is stale (last beat ${doc.monitor.heartbeatAt}, ` +
        `ttl ${monitorTtlMs}ms); the target's current GUI state is unknown`,
    };
  }
  return { health: doc.observationHealth, detail: null };
}

/** Attach the derived fields every report carries (#341). */
function withGuidance(
  facts: SupervisionReportFacts,
  stateFile: string,
): SupervisionReport {
  return {
    ...facts,
    stateFile,
    nextActions: supervisionNextActions(facts),
  };
}

/** Build the public report for a session directory. */
export function supervisionReport(
  sessionDir: string,
  options: { readonly now?: Date; readonly monitorTtlMs?: number } = {},
): SupervisionReport {
  const now = options.now ?? new Date();
  const readAt = now.toISOString();
  const stateFile = supervisionStatePath(sessionDir);
  const result = readSupervisionState(sessionDir);
  switch (result.kind) {
    case "absent":
      return withGuidance(
        {
          status: "unavailable",
          source: "absent",
          reason:
            "no supervision state exists for this session directory; " +
            "either supervision never ran or the session dir is wrong",
          readAt,
        },
        stateFile,
      );
    case "corrupt":
      return withGuidance(
        { status: "unavailable", source: "corrupt", reason: result.detail, readAt },
        stateFile,
      );
    case "state": {
      const evaluated = evaluateObservationHealth(result.doc, now, options.monitorTtlMs);
      return withGuidance(
        {
          status: "observed",
          source: "state",
          doc: result.doc,
          health: evaluated.health,
          healthDetail: evaluated.detail,
          readAt,
        },
        stateFile,
      );
    }
  }
}

export type { SupervisionReadSource };
