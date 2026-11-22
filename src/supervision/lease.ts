/**
 * Monitor lease: exactly one supervision writer per session (#280,
 * spec §Durable shared state).
 *
 * The durable supervision document is shared by every client of a session;
 * only the lease holder may write it. The lease coordinates *cooperating*
 * ae-a8n processes — it cannot stop a non-cooperating writer, which is why
 * the state document is schema-validated on every read and why monitor
 * health is reported from the heartbeat, not assumed.
 *
 * Takeover is allowed — unlike the GUI mutation lease — when the recorded
 * owner is provably gone (dead pid, reused pid) or its heartbeat is older
 * than the lease TTL. A hung monitor must not block supervision forever;
 * the takeover is recorded so the audit trail shows the handoff. An
 * unreadable lease is `ambiguous` and refuses, matching the fail-closed
 * rule everywhere else.
 */

import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type PidAliveProbe = (pid: number) => boolean;
export type PidStartProbe = (pid: number) => string | null;

/**
 * Default liveness: `kill(pid, 0)` semantics — ESRCH means gone, EPERM
 * means alive-but-not-ours. Cross-platform; callers on Windows may inject
 * a creation-time probe for stronger PID-reuse evidence.
 */
export const defaultMonitorPidAlive: PidAliveProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/**
 * Default start stamp: unproven (`null`). PID-reuse detection then relies on
 * heartbeat expiry rather than identity — the safe direction, since a null
 * stamp never claims a mismatch it cannot prove. Callers that can read a
 * start time (macOS `ps`, Windows creation time) should inject the probe.
 */
export const defaultMonitorPidStartedAt: PidStartProbe = () => null;

export const MONITOR_LEASE_SCHEMA_VERSION = "ae-a8n.monitor-lease/v1";
export const MONITOR_LEASE_FILE = "monitor.lease.json";
/** Default heartbeat freshness; a holder must beat within this window. */
export const DEFAULT_MONITOR_LEASE_TTL_MS = 30 * 1000;

export type MonitorLeaseRecord = {
  readonly schemaVersion: typeof MONITOR_LEASE_SCHEMA_VERSION;
  readonly ownerId: string;
  readonly pid: number;
  readonly pidStart: string | null;
  readonly acquiredAt: string;
  /** ISO-8601; refreshed by the holder on every monitor tick. */
  readonly heartbeatAt: string;
  /** ISO-8601; heartbeatAt + ttlMs — takeover is allowed after this. */
  readonly expiresAt: string;
};

export function monitorLeasePath(sessionDir: string): string {
  return join(sessionDir, MONITOR_LEASE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeMonitorLease(value: unknown): MonitorLeaseRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value["schemaVersion"] !== MONITOR_LEASE_SCHEMA_VERSION) {
    return null;
  }
  if (
    typeof value["ownerId"] !== "string" ||
    typeof value["pid"] !== "number" ||
    typeof value["acquiredAt"] !== "string" ||
    typeof value["heartbeatAt"] !== "string" ||
    typeof value["expiresAt"] !== "string"
  ) {
    return null;
  }
  return value as unknown as MonitorLeaseRecord;
}

function readLeaseFile(path: string): MonitorLeaseRecord | null {
  try {
    return decodeMonitorLease(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

export type MonitorLeaseState =
  /** No lease file. */
  | "free"
  /** A live holder with an unexpired heartbeat. */
  | "held"
  /** Owner provably gone, or heartbeat expired — takeover allowed. */
  | "expired"
  /** File exists but cannot be understood; refuse, never guess. */
  | "ambiguous";

export function inspectMonitorLease(
  sessionDir: string,
  probes: {
    readonly pidAlive?: PidAliveProbe | undefined;
    readonly pidStartedAt?: PidStartProbe | undefined;
    readonly now?: Date | undefined;
  } = {},
): { readonly state: MonitorLeaseState; readonly record: MonitorLeaseRecord | null } {
  const path = monitorLeasePath(sessionDir);
  const record = readLeaseFile(path);
  if (record === null) {
    try {
      readFileSync(path, "utf-8");
      return { state: "ambiguous", record: null };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "free", record: null }
        : { state: "ambiguous", record: null };
    }
  }
  const pidAlive = probes.pidAlive ?? defaultMonitorPidAlive;
  const pidStartedAt = probes.pidStartedAt ?? defaultMonitorPidStartedAt;
  const now = probes.now ?? new Date();
  if (!pidAlive(record.pid)) {
    return { state: "expired", record };
  }
  const startedAt = pidStartedAt(record.pid);
  if (record.pidStart !== null && startedAt !== null && startedAt !== record.pidStart) {
    return { state: "expired", record };
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (Number.isNaN(expiresAt) || now.getTime() > expiresAt) {
    return { state: "expired", record };
  }
  return { state: "held", record };
}

export type MonitorLease = {
  readonly path: string;
  readonly record: MonitorLeaseRecord;
  /** Refresh the heartbeat; only meaningful while this process holds it. */
  heartbeat(now?: Date): MonitorLeaseRecord;
  /** Remove the lease only while it still names this holder. Idempotent. */
  release(): void;
};

function writeLeaseRecord(path: string, record: MonitorLeaseRecord): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function removeLeaseFileIfMatch(
  path: string,
  isExpected: (record: MonitorLeaseRecord) => boolean,
): void {
  const expected = readLeaseFile(path);
  if (expected === null || !isExpected(expected)) {
    return;
  }
  const trash = `${path}.releasing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, trash);
  } catch {
    return;
  }
  const moved = readLeaseFile(trash);
  if (
    moved !== null &&
    moved.ownerId === expected.ownerId &&
    moved.pid === expected.pid &&
    moved.acquiredAt === expected.acquiredAt &&
    isExpected(moved)
  ) {
    rmSync(trash);
    return;
  }
  if (!existsSync(path)) {
    try {
      linkSync(trash, path);
      rmSync(trash);
    } catch {
      // A new owner took the slot; the moved file stays quarantined.
    }
  }
}

export type AcquireMonitorLeaseResult =
  | {
      readonly ok: true;
      readonly lease: MonitorLease;
      /** The expired holder this lease replaced, when there was one. */
      readonly tookOverFrom: MonitorLeaseRecord | null;
    }
  | {
      readonly ok: false;
      readonly reason: "held" | "ambiguous";
      readonly detail: string;
      readonly holder: MonitorLeaseRecord | null;
    };

/**
 * Acquire the monitor lease for a session directory, or refuse.
 *
 * `free` and `expired` both allow acquisition; `expired` is takeover and is
 * reported via `tookOverFrom` so the caller can audit the handoff. `held`
 * and `ambiguous` refuse — the second writer must not guess.
 */
export function acquireMonitorLease(
  sessionDir: string,
  options: {
    readonly ownerId: string;
    readonly pid?: number;
    readonly ttlMs?: number;
    readonly now?: Date;
    readonly pidAlive?: PidAliveProbe | undefined;
    readonly pidStartedAt?: PidStartProbe | undefined;
  },
): AcquireMonitorLeaseResult {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_MONITOR_LEASE_TTL_MS;
  const pid = options.pid ?? process.pid;
  const pidStartedAt = options.pidStartedAt ?? defaultMonitorPidStartedAt;
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const path = monitorLeasePath(sessionDir);

  const inspected = inspectMonitorLease(sessionDir, {
    pidAlive: options.pidAlive,
    pidStartedAt,
    now,
  });
  if (inspected.state === "held") {
    const holder = inspected.record;
    return {
      ok: false,
      reason: "held",
      holder,
      detail:
        `the monitor lease is held by ${holder?.ownerId ?? "unknown"} ` +
        `(pid ${holder?.pid ?? "?"}, heartbeat ${holder?.heartbeatAt ?? "?"})`,
    };
  }
  if (inspected.state === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous",
      holder: null,
      detail: `the monitor lease file exists but cannot be understood: ${path}`,
    };
  }
  const tookOverFrom = inspected.state === "expired" ? inspected.record : null;

  const heartbeatAt = now.toISOString();
  const record: MonitorLeaseRecord = {
    schemaVersion: MONITOR_LEASE_SCHEMA_VERSION,
    ownerId: options.ownerId,
    pid,
    pidStart: pidStartedAt(pid),
    acquiredAt: heartbeatAt,
    heartbeatAt,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };

  if (tookOverFrom !== null) {
    // Takeover must not clobber a lease that changed between inspection and
    // now. Move the expired file aside, create ours exclusively, and put the
    // old record back if we lost the race — the same compare-and-swap
    // discipline the GUI lease uses.
    const trash = `${path}.takeover-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      renameSync(path, trash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // It vanished: fall through to the exclusive create below.
      } else {
        throw error;
      }
    }
    const moved = readLeaseFile(trash);
    const stillExpired =
      moved !== null &&
      moved.ownerId === tookOverFrom.ownerId &&
      moved.pid === tookOverFrom.pid &&
      moved.acquiredAt === tookOverFrom.acquiredAt;
    if (!stillExpired && moved !== null) {
      // The file changed under us: restore it untouched and refuse.
      if (!existsSync(path)) {
        try {
          linkSync(trash, path);
          rmSync(trash);
        } catch {
          // Slot taken by another acquirer; the moved file stays quarantined.
        }
      }
      return {
        ok: false,
        reason: "held",
        holder: moved,
        detail: "the monitor lease changed between inspection and takeover; it was not replaced",
      };
    }
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      // Lost the create race: restore the expired record and refuse.
      if (moved !== null && !existsSync(path)) {
        try {
          linkSync(trash, path);
          rmSync(trash);
        } catch {
          // quarantined trash is safer than a lost lease record
        }
      } else if (moved !== null) {
        rmSync(trash);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const raced = inspectMonitorLease(sessionDir, { pidAlive: options.pidAlive, pidStartedAt, now });
      return {
        ok: false,
        reason: raced.state === "ambiguous" ? "ambiguous" : "held",
        holder: raced.record,
        detail: "the monitor lease was taken between inspection and takeover",
      };
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(descriptor);
    }
    if (moved !== null) {
      rmSync(trash);
    }
  } else {
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const raced = inspectMonitorLease(sessionDir, { pidAlive: options.pidAlive, pidStartedAt, now });
      return {
        ok: false,
        reason: raced.state === "ambiguous" ? "ambiguous" : "held",
        holder: raced.record,
        detail: "the monitor lease was taken between inspection and acquisition",
      };
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(descriptor);
    }
  }

  const isOurs = (current: MonitorLeaseRecord): boolean =>
    current.ownerId === record.ownerId &&
    current.pid === record.pid &&
    current.acquiredAt === record.acquiredAt;

  return {
    ok: true,
    tookOverFrom,
    lease: {
      path,
      record,
      heartbeat: (beatAt?: Date) => {
        const at = beatAt ?? new Date();
        const current = readLeaseFile(path);
        if (current === null || !isOurs(current)) {
          throw new Error("monitor lease was lost; refusing to heartbeat another owner's lease");
        }
        const next: MonitorLeaseRecord = {
          ...current,
          heartbeatAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
        };
        writeLeaseRecord(path, next);
        return next;
      },
      release: () => {
        removeLeaseFileIfMatch(path, isOurs);
      },
    },
  };
}
