/**
 * Verified session rebuild after proven process loss (#286,
 * specs/gui-supervision/spec.md US5, ADR-0005 §5).
 *
 * This module is the *evidence* half of a rebuild: given the durable
 * supervision document, the launch-provenance record, and a fresh process
 * census, it decides — fail-closed — whether an owned After Effects that
 * supervision proved gone may be relaunched through the normal launch path.
 * It performs no I/O of its own beyond what the caller injects, so every
 * refusal rule is unit-testable without a host.
 *
 * The rules, in order of what they protect:
 *
 *   - Ownership is proven by *records plus live re-checks*, never by either
 *     alone. The provenance file says an earlier session owned a launch;
 *     the census must now agree the recorded process is gone and that no
 *     other instance of the install is running to be confused with it.
 *   - A pid is not an identity. The recorded pid may have been recycled by
 *     an unrelated process; that is fine (the AE is still gone) as long as
 *     pid+start-time cannot be matched — but a live process matching the
 *     recorded identity means process-gone was never true, and a record
 *     without a start time cannot tell a reused pid from the original.
 *   - Nothing here kills, signals, or mutates a process. Rebuild only ever
 *     *starts* a new After Effects through the ordinary launch path, which
 *     re-proves ownership itself; attached or ambiguous states refuse
 *     before anything is spawned.
 */

import { parseResultEnvelope } from "../protocol/envelope.js";
import { createSessionPaths, probeResult } from "../protocol/workspace.js";
import type { LaunchProvenance } from "./launch-provenance.js";
import {
  psProcesses,
  sameProcess,
  windowsProcesses,
  type HostProcess,
} from "./host-processes.js";
import type { PendingRequest } from "../supervision/types.js";

/** A live process census, injectable for tests. */
export type ProcessCensus = () => readonly HostProcess[];

/**
 * The census the rebuild pre-check reads: the same listings the
 * script-invocation transport scopes its ownership decisions with.
 */
export function defaultProcessCensus(platform: NodeJS.Platform): ProcessCensus {
  return platform === "win32" ? windowsProcesses : psProcesses;
}

export type RebuildHostVerdict =
  | { readonly ok: true; readonly evidence: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether `candidate`'s executable names the recorded install closely
 * enough to count as "another instance of the same After Effects".
 *
 * macOS compares full paths (the transport scopes further by uid, applied
 * by the caller's filter). Windows script delivery hands `-r` to *any*
 * AfterFX.exe, so every AfterFX.exe image counts as in-scope — the same
 * conservatism `ScriptInvocationTransport` applies. Other platforms match
 * the recorded executable path only.
 */
function isInstallInstance(
  candidate: HostProcess,
  recordedExecutable: string,
  platform: NodeJS.Platform,
): boolean {
  if (candidate.executable === recordedExecutable) {
    return true;
  }
  if (platform === "win32") {
    return /afterfx\.exe$/i.test(candidate.executable.trim());
  }
  return false;
}

/**
 * Re-prove, against a fresh census, that the recorded owned host is gone
 * and that nothing else of the install is running to be confused with a
 * rebuild.
 *
 * `sessionUid` scopes the macOS census the same way the transport does:
 * another OS user's After Effects is a different instance in a different
 * session — neither a blocker nor a candidate.
 */
export function verifyRebuildHost(input: {
  readonly platform: NodeJS.Platform;
  readonly provenance: LaunchProvenance;
  readonly processes: readonly HostProcess[];
  readonly sessionUid: number;
}): RebuildHostVerdict {
  const { platform, provenance, processes, sessionUid } = input;
  const recorded = provenance.host;
  const evidence: string[] = [];

  // 1. The recorded process must be gone — pid AND start time/identity.
  const pidReused = processes.some((p) => p.pid === recorded.pid);
  if (recorded.startedAt === null) {
    // Without a start time a live pid cannot be told apart from the
    // original: presence is ambiguity, absence is the only proof of loss.
    if (pidReused) {
      return {
        ok: false,
        reason:
          `pid ${recorded.pid} is still running and the launch record has no process ` +
          "start time, so the recorded After Effects cannot be told apart from a " +
          "reused pid; refusing to rebuild on an ambiguous identity",
      };
    }
    evidence.push(`pid ${recorded.pid} is absent from the process list`);
  } else {
    const recordedProcess: HostProcess = {
      pid: recorded.pid,
      startedAt: recorded.startedAt,
      executable: recorded.executable,
      ...(recorded.identity === null || recorded.identity === undefined
        ? {}
        : { identity: recorded.identity }),
    };
    const same = processes.filter((p) => sameProcess(platform, p, recordedProcess));
    if (same.length > 0) {
      return {
        ok: false,
        reason:
          `the recorded After Effects (pid ${recorded.pid}, started ` +
          `${new Date(recorded.startedAt).toISOString()}) is still running; ` +
          "process-gone was never proven — refusing to rebuild a live host",
      };
    }
    if (pidReused) {
      evidence.push(
        `pid ${recorded.pid} was reused by an unrelated process; the recorded ` +
          "start time proves the original is gone",
      );
    } else {
      evidence.push(
        `pid ${recorded.pid} with the recorded start time is absent from the process list`,
      );
    }
  }

  // 2. Single-instance: no other process of this install may be running
  //    in scope. A manually restarted or leftover AE would make "which
  //    instance answers" unprovable — the launch path itself would only
  //    attach to it, which is exactly what rebuild must never do silently.
  const inScope = processes.filter((p) => {
    if (!isInstallInstance(p, recorded.executable, platform)) {
      return false;
    }
    if (platform === "darwin") {
      return p.uid === undefined || p.uid === sessionUid;
    }
    return true;
  });
  if (inScope.length > 0) {
    return {
      ok: false,
      reason:
        `${inScope.length} other instance(s) of this install are running ` +
        `(pids ${inScope.map((p) => p.pid).join(", ")}); a rebuild cannot prove ` +
        "which After Effects would answer, so it refuses rather than attach",
    };
  }
  evidence.push("no other instance of the recorded install is running in scope");

  return { ok: true, evidence };
}

export type PendingReconciliation = {
  /** Requests still unproven; each is marked `unknown`, never resent. */
  readonly pendingRequests: readonly PendingRequest[];
  /** Requests whose result file proves an outcome; dropped from pending. */
  readonly resolved: readonly string[];
  /** Requests left `unknown`: no provable outcome exists. */
  readonly unknown: readonly string[];
  /** Evidence lines for the supervision document. */
  readonly evidence: readonly string[];
};

/**
 * Reconcile the pending requests the crashed session left behind (#286).
 *
 * The result file is the only authoritative outcome record: a request
 * whose `<id>.result.json` parses as a result envelope completed — its
 * outcome is known and it leaves the pending list. Everything else stays
 * pending as `unknown`: the process died mid-flight, so whether the work
 * ran is unprovable, and the rebuild must never resend it.
 */
export function reconcilePendingRequests(
  sessionRoot: string,
  pending: readonly PendingRequest[],
): PendingReconciliation {
  if (pending.length === 0) {
    return { pendingRequests: [], resolved: [], unknown: [], evidence: [] };
  }
  const paths = createSessionPaths(sessionRoot);
  const resolved: string[] = [];
  const unknown: PendingRequest[] = [];
  for (const request of pending) {
    const probe = probeResult(paths, request.id);
    let outcomeKnown = false;
    if (probe.state === "read") {
      try {
        parseResultEnvelope(probe.envelope);
        outcomeKnown = true;
      } catch {
        // A file that does not parse as a result envelope proves nothing.
        outcomeKnown = false;
      }
    }
    if (outcomeKnown) {
      resolved.push(request.id);
    } else {
      unknown.push({ ...request, state: "unknown" });
    }
  }
  const evidence: string[] = [];
  if (resolved.length > 0) {
    evidence.push(
      `rebuild reconciled ${resolved.length} pending request(s) with a recorded result: ` +
        resolved.join(", "),
    );
  }
  if (unknown.length > 0) {
    evidence.push(
      `${unknown.length} pending request(s) left UNKNOWN after process loss; ` +
        "they are never resent: " +
        unknown.map((request) => request.id).join(", "),
    );
  }
  return {
    pendingRequests: unknown,
    resolved,
    unknown: unknown.map((request) => request.id),
    evidence,
  };
}

