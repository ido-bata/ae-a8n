/**
 * The per-run lock between controllers that share one Windows channel.
 *
 * A lock is a file created with `createExclusive`. The holder never deletes or
 * overwrites another owner's lock, and a stale lock is reported — never reused
 * silently. Removing a stale lock is a human/recovery decision, not this
 * module's.
 */

import type { FileChannel } from "./channel.js";

export const LOCK_SCHEMA_VERSION = "1.0";
/** A lock older than this is reported as stale; it is never removed here. */
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Run ids become one path component, so `.` and path separators are refused. */
export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value) && value !== "." && value !== "..";
}

export type RunOwner = {
  readonly host: string;
  readonly user: string;
};

export type RunLock = {
  readonly schemaVersion: typeof LOCK_SCHEMA_VERSION;
  readonly runId: string;
  readonly owner: RunOwner;
  /** ISO-8601. */
  readonly acquiredAt: string;
};

export type AcquireRunLockInput = {
  readonly runId: string;
  readonly owner: RunOwner;
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
};

export type AcquireRunLockResult =
  | { readonly state: "acquired"; readonly lock: RunLock }
  /** A fresh lock held by someone else (or with an unreadable timestamp). */
  | { readonly state: "busy"; readonly lock: RunLock }
  /** Older than the threshold, or unreadable. It is still on disk. */
  | { readonly state: "stale"; readonly lock: RunLock | null };

export function lockPath(runId: string): string {
  if (!isRunId(runId)) {
    throw new Error(`run id "${runId}" cannot be used as a path component`);
  }
  return `locks/${runId}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function decodeRunLock(bytes: Uint8Array): RunLock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["schemaVersion"] !== LOCK_SCHEMA_VERSION) {
    return null;
  }
  const runId = stringField(parsed, "runId");
  const acquiredAt = stringField(parsed, "acquiredAt");
  const owner = parsed["owner"];
  if (runId === null || acquiredAt === null || !isRecord(owner)) {
    return null;
  }
  const host = stringField(owner, "host");
  const user = stringField(owner, "user");
  if (host === null || user === null || Number.isNaN(Date.parse(acquiredAt))) {
    return null;
  }
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    runId,
    owner: { host, user },
    acquiredAt,
  };
}

export function encodeRunLock(lock: RunLock): Uint8Array {
  return Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf-8");
}

function sameOwner(left: RunOwner, right: RunOwner): boolean {
  // Windows account and host names are case-insensitive.
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.user.toLowerCase() === right.user.toLowerCase()
  );
}

/**
 * Try to take the lock. It writes only when the file does not exist; an
 * existing lock is read and classified, never replaced.
 */
export async function acquireRunLock(
  channel: FileChannel,
  input: AcquireRunLockInput,
): Promise<AcquireRunLockResult> {
  const now = input.now ?? (() => new Date());
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const path = lockPath(input.runId);
  const lock: RunLock = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    runId: input.runId,
    owner: { host: input.owner.host, user: input.owner.user },
    acquiredAt: now().toISOString(),
  };

  if (await channel.createExclusive(path, encodeRunLock(lock))) {
    return { state: "acquired", lock };
  }

  const existingBytes = await channel.read(path);
  if (existingBytes === null) {
    // It disappeared between the exclusive create and the read. Fail closed:
    // do not pretend the lock was acquired, and do not write again.
    return { state: "stale", lock: null };
  }
  const existing = decodeRunLock(existingBytes);
  if (existing === null || existing.runId !== input.runId) {
    return { state: "stale", lock: null };
  }
  const acquiredAt = Date.parse(existing.acquiredAt);
  const age = now().getTime() - acquiredAt;
  // A timestamp in the future is treated as fresh: the safe direction is not
  // to claim someone else's lock.
  if (age > staleAfterMs) {
    return { state: "stale", lock: existing };
  }
  return { state: "busy", lock: existing };
}

/**
 * Remove the lock only when the file still names `owner` and `runId`. A
 * mismatched or unreadable lock is left untouched.
 */
export async function releaseRunLock(
  channel: FileChannel,
  runId: string,
  owner: RunOwner,
): Promise<boolean> {
  const path = lockPath(runId);
  const bytes = await channel.read(path);
  if (bytes === null) {
    return false;
  }
  const lock = decodeRunLock(bytes);
  if (lock === null || lock.runId !== runId || !sameOwner(lock.owner, owner)) {
    return false;
  }
  await channel.remove(path);
  return true;
}
