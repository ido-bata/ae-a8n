/**
 * Single-owner lease for GUI-mutating operations on a shared macOS session,
 * plus the audit log every GUI observation and mutation writes to.
 *
 * Why this exists: more than one agent or runner can reach the same GUI
 * session — ae-a8n consumers, ad-hoc scripts, other orchestrators. Nothing at
 * the OS level stops two of them pressing the same dialog or clicking the
 * same point. Observed on a real host 2026-11-15: independent agents were
 * enumerating windows, screenshotting and synthesizing clicks while another
 * session reported on the same dialogs, with no coordination and no record.
 *
 * The lease coordinates *cooperating* processes only. It cannot stop a
 * non-cooperating agent from clicking; detection (a census diff around an
 * action) is the mitigation for that, not prevention. That limitation is
 * stated here so no caller mistakes the lease for a guarantee.
 *
 * Scope: the lease is per GUI session (`uid` + `asid`) and lives under the
 * caller's ae-a8n state root (`~/.ae-a8n` by default). Callers running as the
 * same OS user share it; callers under a different state root do not — that
 * boundary is documented, not hidden.
 *
 * Fail-closed rules, matching the rest of the driver:
 *
 *   - A mutation without the lease refuses with the current holder's evidence.
 *   - A lease whose owner pid is dead is `stale`: reported, never silently
 *     stolen. Reaping it takes an explicit confirm and re-validates staleness.
 *   - A lease whose recorded pid now has a different start time is `stale`
 *     with PID-reuse evidence: the recorded owner is gone even though the
 *     number is alive again.
 *   - An unreadable or malformed lease file is `ambiguous`: refused, never
 *     guessed at.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
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
import { homedir } from "node:os";
import { join } from "node:path";

export const GUI_LEASE_SCHEMA_VERSION = "1.0";

/** The default state root, matching `~/.ae-a8n` used by the runner. */
export function defaultGuiLeaseRoot(): string {
  return join(homedir(), ".ae-a8n");
}

export type GuiLeaseSession = {
  readonly uid: number;
  readonly asid: number | null;
};

/**
 * The lease/audit scope for one GUI session. Two sessions of the same user
 * (different asid) do not share a lease.
 */
export function guiSessionKey(session: GuiLeaseSession): string {
  return `uid:${session.uid}:asid:${session.asid ?? "none"}`;
}

export type GuiLeasePaths = {
  readonly dir: string;
  readonly auditLog: string;
};

export function guiLeasePaths(stateRoot: string): GuiLeasePaths {
  return {
    dir: join(stateRoot, "gui-leases"),
    auditLog: join(stateRoot, "gui-audit.jsonl"),
  };
}

function leaseFileName(session: GuiLeaseSession): string {
  return `gui-${session.uid}-${session.asid ?? "none"}.json`;
}

export type GuiLeaseHolder = {
  readonly ownerId: string;
  readonly pid: number;
  readonly pidStart: string | null;
  readonly acquiredAt: string;
  readonly purpose: string;
};

type LeaseRecord = GuiLeaseHolder & {
  readonly schemaVersion: string;
  readonly sessionKey: string;
};

function isLeaseRecord(value: unknown): value is LeaseRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    r["schemaVersion"] === GUI_LEASE_SCHEMA_VERSION &&
    typeof r["sessionKey"] === "string" &&
    typeof r["ownerId"] === "string" &&
    typeof r["pid"] === "number" &&
    typeof r["acquiredAt"] === "string"
  );
}

/** Liveness probe; `kill(pid, 0)` semantics — ESRCH means gone. */
export type PidAliveProbe = (pid: number) => boolean;

/** Process start stamp for PID-reuse detection; null when unreadable. */
export type PidStartProbe = (pid: number) => string | null;

export const defaultPidAlive: PidAliveProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof of death. EPERM means the process exists but
    // belongs to another user — it is alive, just not ours to signal, and
    // calling it dead would let a live owner's lease be reaped.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export const defaultPidStartedAt: PidStartProbe = (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
};

export type GuiLease = {
  readonly path: string;
  /** Removes the lease only while it still names this holder. Idempotent. */
  release(): void;
};

/**
 * Delete the lease file only when it still holds the expected record.
 *
 * Read-then-`rm` is not enough: between the read and the delete an external
 * actor could remove the file and a new owner could acquire it, and the
 * delete would then destroy *their* lease. The delete is therefore split in
 * two atomic steps — rename the file aside (whatever sits at `path` moves,
 * nothing can slip in between), re-read the moved file, and only remove it
 * when its identity still matches. If the moved file is not the expected
 * record it is put back when the slot is free; it is never overwritten.
 */
function removeLeaseFileIfMatch(
  path: string,
  isExpected: (record: LeaseRecord) => boolean,
): "removed" | "kept" | "missing" {
  const expected = readLeaseRecord(path);
  if (expected === null) {
    // Missing, unreadable or unparseable: nothing we can prove is ours.
    return existsSync(path) ? "kept" : "missing";
  }
  if (!isExpected(expected)) {
    return "kept";
  }
  const trash = `${path}.releasing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, trash);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "kept";
  }
  const moved = readLeaseRecord(trash);
  const sameRecord =
    moved !== null &&
    moved.ownerId === expected.ownerId &&
    moved.pid === expected.pid &&
    moved.acquiredAt === expected.acquiredAt &&
    isExpected(moved);
  if (sameRecord) {
    rmSync(trash);
    return "removed";
  }
  // The file changed between our read and the rename — restore it when the
  // lease slot is still free, and never overwrite a newer file.
  //
  // The restore must be atomic AND no-clobber: `renameSync(trash, path)`
  // replaces whatever sits at `path`, so an acquirer that legitimately took
  // the slot during the rename gap would have its fresh lease overwritten
  // by the stale record we are putting back. `linkSync` fails with EEXIST
  // instead of clobbering; on success the trash name is unlinked.
  if (!existsSync(path)) {
    try {
      linkSync(trash, path);
      rmSync(trash);
    } catch {
      // EEXIST (a new owner took the slot) or any other failure: the moved
      // file stays quarantined under its trash name — never destroyed,
      // never allowed to overwrite a live lease.
    }
  }
  return "kept";
}

export type GuiLeaseRefusalReason = "held" | "stale" | "ambiguous";

export type GuiLeaseOutcome =
  | { readonly ok: true; readonly lease: GuiLease }
  | {
      readonly ok: false;
      readonly reason: GuiLeaseRefusalReason;
      readonly path: string;
      readonly detail: string;
      readonly holder: LeaseRecord | null;
    };

export type GuiLeaseOptions = {
  readonly stateRoot: string;
  readonly session: GuiLeaseSession;
  readonly owner: { readonly id: string; readonly pid: number };
  readonly purpose?: string;
  readonly pidAlive?: PidAliveProbe;
  readonly pidStartedAt?: PidStartProbe;
  readonly now?: () => Date;
};

function readLeaseRecord(path: string): LeaseRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isLeaseRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify an existing lease file without touching it.
 *
 * `stale` means the recorded owner is provably gone (dead pid, or the pid
 * was reused — the start stamp no longer matches). `ambiguous` means the
 * file exists but cannot be understood; it is never treated as free.
 */
export function inspectGuiLease(
  path: string,
  probes: { readonly pidAlive: PidAliveProbe; readonly pidStartedAt: PidStartProbe },
): { readonly state: "free" | "held" | "stale" | "ambiguous"; readonly record: LeaseRecord | null } {
  const record = readLeaseRecord(path);
  if (record === null) {
    // No usable record: distinguish "no file" (ENOENT → free) from "file we
    // cannot trust" (exists but unreadable or unparseable → ambiguous).
    try {
      readFileSync(path, "utf-8");
      return { state: "ambiguous", record: null };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "free", record: null }
        : { state: "ambiguous", record: null };
    }
  }
  if (!probes.pidAlive(record.pid)) {
    return { state: "stale", record };
  }
  const startedAt = probes.pidStartedAt(record.pid);
  if (record.pidStart !== null && startedAt !== null && startedAt !== record.pidStart) {
    // The pid is alive but is a different process than the one that took
    // the lease: the owner is gone and the number was reused.
    return { state: "stale", record };
  }
  return { state: "held", record };
}

/**
 * Take the GUI-mutation lease for a session, or refuse with evidence.
 *
 * Acquisition is atomic (`O_EXCL` create). A refused acquisition never
 * deletes or overwrites the existing file — `reapGuiLease` is the only
 * path that removes a stale lease, and only after an explicit confirm.
 */
export function acquireGuiLease(options: GuiLeaseOptions): GuiLeaseOutcome {
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const pidStartedAt = options.pidStartedAt ?? defaultPidStartedAt;
  const now = options.now ?? (() => new Date());
  const { dir } = guiLeasePaths(options.stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, leaseFileName(options.session));

  const existing = inspectGuiLease(path, { pidAlive, pidStartedAt });
  if (existing.state === "held") {
    const holder = existing.record;
    return {
      ok: false,
      reason: "held",
      path,
      holder,
      detail:
        `the GUI lease for ${guiSessionKey(options.session)} is held by ` +
        `${holder?.ownerId ?? "unknown"} (pid ${holder?.pid ?? "?"}, acquired ${holder?.acquiredAt ?? "?"})`,
    };
  }
  if (existing.state === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous",
      path,
      holder: null,
      detail: `the GUI lease file exists but cannot be understood: ${path}`,
    };
  }
  if (existing.state === "stale") {
    const holder = existing.record;
    return {
      ok: false,
      reason: "stale",
      path,
      holder,
      detail:
        `the GUI lease for ${guiSessionKey(options.session)} is stale: ` +
        `owner ${holder?.ownerId ?? "unknown"} (pid ${holder?.pid ?? "?"}) is gone; ` +
        `reap it explicitly before mutating`,
    };
  }

  const record: LeaseRecord = {
    schemaVersion: GUI_LEASE_SCHEMA_VERSION,
    sessionKey: guiSessionKey(options.session),
    ownerId: options.owner.id,
    pid: options.owner.pid,
    pidStart: pidStartedAt(options.owner.pid),
    acquiredAt: now().toISOString(),
    purpose: options.purpose ?? "gui-mutation",
  };
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    // Lost the race between inspect and create: re-classify honestly.
    const raced = inspectGuiLease(path, { pidAlive, pidStartedAt });
    return {
      ok: false,
      reason: raced.state === "free" ? "ambiguous" : raced.state,
      path,
      holder: raced.record,
      detail: `the GUI lease was taken between inspection and acquisition: ${path}`,
    };
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(descriptor);
  }
  return {
    ok: true,
    lease: {
      path,
      release: () => {
        removeLeaseFileIfMatch(
          path,
          (current) =>
            current.ownerId === record.ownerId &&
            current.pid === record.pid &&
            current.acquiredAt === record.acquiredAt,
        );
        // A lease we cannot read, or which another owner has taken over, is
        // left in place: removing it could let a second mutator in.
      },
    },
  };
}

export type GuiLeaseReapOutcome =
  | { readonly ok: true; readonly path: string; readonly detail: string }
  | { readonly ok: false; readonly path: string; readonly detail: string };

/**
 * Remove a stale lease. Requires `confirm: true` and re-validates that the
 * lease is still stale at reap time — a lease that came back to life between
 * inspection and reap is left alone.
 */
export function reapGuiLease(
  options: GuiLeaseOptions & { readonly confirm: boolean },
): GuiLeaseReapOutcome {
  const { dir } = guiLeasePaths(options.stateRoot);
  const path = join(dir, leaseFileName(options.session));
  if (!options.confirm) {
    return { ok: false, path, detail: "reaping a GUI lease requires confirm: true" };
  }
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const pidStartedAt = options.pidStartedAt ?? defaultPidStartedAt;
  const state = inspectGuiLease(path, { pidAlive, pidStartedAt });
  if (state.state === "free") {
    return { ok: true, path, detail: "no lease present" };
  }
  if (state.state !== "stale") {
    return {
      ok: false,
      path,
      detail:
        state.state === "held"
          ? `the lease is held by a live owner; it was not reaped`
          : `the lease file is unreadable; it was not reaped`,
    };
  }
  // Compare-and-delete on the inspected identity: a lease that came back to
  // life, or a different record that took the slot, is restored — never
  // removed.
  const inspected = state.record;
  const removed = removeLeaseFileIfMatch(
    path,
    (record) =>
      inspected !== null &&
      record.ownerId === inspected.ownerId &&
      record.pid === inspected.pid &&
      record.acquiredAt === inspected.acquiredAt,
  );
  if (removed !== "removed") {
    return {
      ok: false,
      path,
      detail: "the lease changed between inspection and reap; it was not removed",
    };
  }
  return {
    ok: true,
    path,
    detail: `reaped stale lease held by ${state.record?.ownerId ?? "unknown"} (pid ${state.record?.pid ?? "?"})`,
  };
}

// ---------------------------------------------------------------- audit log

export type GuiAuditKind =
  | "observe"
  | "mutate"
  | "lease-acquire"
  | "lease-release"
  | "lease-refuse"
  | "lease-reap";

export type GuiAuditEvent = {
  readonly kind: GuiAuditKind;
  readonly sessionKey: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly op?: string;
  readonly detail?: string;
  readonly outcome?: string;
};

export type GuiAuditRecord = GuiAuditEvent & {
  readonly ts: string;
  readonly schemaVersion: string;
};

/**
 * Append one audit record. Synchronous and fail-closed: callers treat a
 * thrown error as "the action must not proceed", because an unaudited GUI
 * mutation is exactly what this log exists to prevent.
 */
export function auditGuiEvent(
  stateRoot: string,
  event: GuiAuditEvent,
  now: () => Date = () => new Date(),
): string {
  const { auditLog } = guiLeasePaths(stateRoot);
  mkdirSync(join(stateRoot), { recursive: true, mode: 0o700 });
  const record: GuiAuditRecord = {
    schemaVersion: GUI_LEASE_SCHEMA_VERSION,
    ts: now().toISOString(),
    ...event,
  };
  appendFileSync(auditLog, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return auditLog;
}
