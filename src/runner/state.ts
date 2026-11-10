/**
 * Run state that outlives one process: the per-target lock and the
 * per-target quarantine record.
 *
 * Both live under the state root (`~/.ae-a8n` by default). Neither is ever
 * silently cleared: a stale lock and an unreadable quarantine record are
 * refusals a human resolves, because guessing either one could allow a second
 * concurrent run or hide an unknown outcome.
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STATE_SCHEMA_VERSION = "1.0";

export type StateLayout = {
  readonly root: string;
  readonly runs: string;
  readonly locks: string;
  readonly quarantine: string;
};

export function stateLayout(root: string): StateLayout {
  return {
    root,
    runs: join(root, "runs"),
    locks: join(root, "locks"),
    quarantine: join(root, "quarantine"),
  };
}

/**
 * A target name is a user string. It is sanitised for a file name and always
 * carries a hash of the original, so two names that sanitise alike never
 * share a lock or a quarantine record.
 */
export function targetKey(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^[._]+/u, "").slice(0, 48);
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${safe.length === 0 ? "target" : safe}-${digest}`;
}

export type TargetLock = {
  readonly path: string;
  /** Removes the lock only when it still names this run. */
  release(): void;
};

export type LockOutcome =
  | { readonly ok: true; readonly lock: TargetLock }
  | { readonly ok: false; readonly path: string; readonly detail: string };

type LockRecord = {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly pid: number;
  readonly startedAt: string;
};

export function acquireTargetLock(
  layout: StateLayout,
  targetName: string,
  record: { readonly runId: string; readonly pid: number; readonly startedAt: string },
): LockOutcome {
  mkdirSync(layout.locks, { recursive: true, mode: 0o700 });
  const path = join(layout.locks, `${targetKey(targetName)}.lock`);
  const body: LockRecord = {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId: record.runId,
    pid: record.pid,
    startedAt: record.startedAt,
  };
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    let existing: string;
    try {
      existing = readFileSync(path, "utf-8").trim();
    } catch {
      return {
        ok: false,
        path,
        detail: `another run holds the lock and the file cannot be read: ${path}`,
      };
    }
    return {
      ok: false,
      path,
      detail:
        existing.length === 0
          ? `another run holds the lock (the file is empty): ${path}`
          : `another run holds the lock (${existing}): ${path}`,
    };
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(body)}\n`);
  } finally {
    closeSync(descriptor);
  }
  return {
    ok: true,
    lock: {
      path,
      release: (): void => {
        try {
          const current = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockRecord>;
          if (current.runId === record.runId) {
            rmSync(path);
          }
        } catch {
          // A lock we cannot read, or which another run has taken over, is
          // left in place: removing it could let a second run start.
        }
      },
    },
  };
}

export type QuarantineRecord = {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly runId: string;
  readonly quarantinedAt: string;
  readonly detail: string;
};

export type QuarantineState =
  | { readonly quarantined: false }
  | {
      readonly quarantined: true;
      readonly path: string;
      readonly detail: string;
      readonly record: QuarantineRecord | null;
    };

function isQuarantineRecord(value: unknown): value is QuarantineRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record["schemaVersion"] === STATE_SCHEMA_VERSION &&
    typeof record["runId"] === "string" &&
    typeof record["quarantinedAt"] === "string" &&
    typeof record["detail"] === "string"
  );
}

/** A record that exists but cannot be read still quarantines the target. */
export function readQuarantine(layout: StateLayout, targetName: string): QuarantineState {
  const path = join(layout.quarantine, `${targetKey(targetName)}.json`);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { quarantined: false };
    }
    return {
      quarantined: true,
      path,
      detail: `the quarantine record cannot be read: ${path}`,
      record: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      quarantined: true,
      path,
      detail: `the quarantine record is not valid JSON: ${path}`,
      record: null,
    };
  }
  if (!isQuarantineRecord(parsed)) {
    return {
      quarantined: true,
      path,
      detail: `the quarantine record is not a v${STATE_SCHEMA_VERSION} record: ${path}`,
      record: null,
    };
  }
  return {
    quarantined: true,
    path,
    detail: `run ${parsed.runId} left an unknown outcome: ${parsed.detail}`,
    record: parsed,
  };
}

export function writeQuarantine(
  layout: StateLayout,
  targetName: string,
  record: { readonly runId: string; readonly quarantinedAt: string; readonly detail: string },
): string {
  mkdirSync(layout.quarantine, { recursive: true, mode: 0o700 });
  const path = join(layout.quarantine, `${targetKey(targetName)}.json`);
  const body: QuarantineRecord = {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId: record.runId,
    quarantinedAt: record.quarantinedAt,
    detail: record.detail,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return path;
}
