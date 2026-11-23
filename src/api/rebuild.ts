/**
 * Verified session rebuild after proven process loss (#286,
 * specs/gui-supervision/spec.md US5).
 *
 * `AfterEffects.rebuild` shares `openAfterEffects` with `launch`/`resume`,
 * but gates it behind proof that an *owned* host is gone and that nothing
 * else could be mistaken for it:
 *
 *   1. The durable supervision document must show `blocked` with host
 *      `process-gone` — the observation-level proof of loss. `quarantined`
 *      and `needs-human` refuse: a human decision is pending.
 *   2. The monitor lease must be free or expired. A live monitor still
 *      observes the dead pid and would overwrite every rebuild transition;
 *      rebuilding under it would produce a document that immediately
 *      reverts, so it refuses instead.
 *   3. Launch provenance must exist — only a session that proved
 *      `owned` ever records one, so attached and unknown sessions refuse
 *      here without anything being spawned.
 *   4. A fresh census must agree the recorded pid+start identity is gone
 *      and that no other instance of the install runs in scope.
 *   5. On macOS the target uid must still have an Aqua login session.
 *
 * Only then does the ordinary launch path run — which re-proves
 * pid identity, single instance, readiness and provenance on its own —
 * and ownership is checked *again* afterwards. Anything short of `owned`
 * fails closed: the session is torn down without quitting (an unowned
 * host is never this session's to quit), the supervision document records
 * `recovery-failed`, and the error says why.
 *
 * Pending requests the crashed session left behind are reconciled, never
 * resent: a recorded result file proves an outcome; everything else stays
 * `unknown`.
 */

import { resolve } from "node:path";

import { errorMessage } from "../errors.js";
import { readLaunchProvenance } from "../driver/launch-provenance.js";
import { HostLeftRunningError } from "../driver/driver.js";
import { readGuiSession, type MacSession } from "../driver/mac-session.js";
import {
  defaultProcessCensus,
  reconcilePendingRequests,
  verifyRebuildHost,
  type ProcessCensus,
} from "../driver/session-rebuild.js";
import type { HostProcess } from "../driver/host-processes.js";
import { ScriptingPermissionError } from "../driver/transport.js";
import {
  applySupervisionEvent,
  inspectMonitorLease,
  readSupervisionState,
  writeSupervisionState,
  type SupervisionEvent,
} from "../supervision/index.js";
import type { SupervisionPhase, SupervisionStateDoc } from "../supervision/types.js";
import { AfterEffectsError, contextualise } from "./errors.js";
import { openAfterEffects, type OpenedSession } from "./launch.js";
import type { LaunchOptions, RebuildOptions, SessionRebuildReport } from "./types.js";

export type RebuiltSession = OpenedSession & {
  readonly rebuild: SessionRebuildReport;
};

/**
 * Test seams. Production callers pass nothing; tests inject the census,
 * the GUI-session reader, the clock, and the launch itself so the whole
 * verify → relaunch → re-verify sequence runs against fakes.
 */
export type RebuildDeps = {
  readonly platform?: NodeJS.Platform;
  readonly processes?: ProcessCensus;
  readonly readGuiSession?: (uid: number) => MacSession | null;
  readonly open?: (options: LaunchOptions, op: string) => Promise<OpenedSession>;
  readonly now?: () => Date;
};

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/**
 * Record one supervision event for the rebuild. When the new session has
 * a live monitor the event goes through it — the monitor is the lease
 * holder and the only writer the durable document recognises. Without one
 * (non-macOS hosts never start a monitor) the same machine transition is
 * applied and published directly; no monitor exists to disagree.
 */
function recordEvent(
  sessionRoot: string,
  supervision: { dispatch(event: SupervisionEvent): boolean } | null,
  event: SupervisionEvent,
  now: () => Date,
): SupervisionPhase | null {
  if (supervision !== null) {
    supervision.dispatch(event);
    const report = supervisionReportPhase(sessionRoot);
    return report;
  }
  const current = readSupervisionState(sessionRoot);
  if (current.kind !== "state") {
    return null;
  }
  const applied = applySupervisionEvent(current.doc, event, now());
  if (!applied.ok) {
    return current.doc.phase;
  }
  try {
    writeSupervisionState(sessionRoot, applied.doc);
  } catch {
    // The transition was computed but could not be published; the phase
    // reported is the last durable one, which is the honest answer.
    return current.doc.phase;
  }
  return applied.doc.phase;
}

function supervisionReportPhase(sessionRoot: string): SupervisionPhase | null {
  const current = readSupervisionState(sessionRoot);
  return current.kind === "state" ? current.doc.phase : null;
}

/** Merge caller evidence into the document about to be published. */
function withEvidence(
  doc: SupervisionStateDoc,
  evidence: readonly string[],
  now: Date,
): SupervisionStateDoc {
  if (evidence.length === 0) {
    return doc;
  }
  return {
    ...doc,
    evidence: [...doc.evidence, ...evidence].slice(-50),
    updatedAt: now.toISOString(),
  };
}

/**
 * Rebuild the session `options.sessionRoot` names. See the module comment
 * for the verification order; every refusal throws `AfterEffectsError`
 * with `code === op` (`"session.rebuild"`) before anything is spawned.
 */
export async function openRebuiltSession(
  options: RebuildOptions,
  deps: RebuildDeps = {},
): Promise<RebuiltSession> {
  const op = "session.rebuild";
  const sessionRoot = resolve(options.sessionRoot);
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => new Date());
  function fail(reason: string): never {
    throw new AfterEffectsError(reason, op);
  }

  // 1. Supervision must have proven process loss. Anything else — running,
  //    a dialog block, quarantined, needs-human, absent or corrupt state —
  //    is not proof, and unproven is refused.
  const state = readSupervisionState(sessionRoot);
  if (state.kind === "absent") {
    fail(
      `no supervision state in ${sessionRoot}: process loss was never proven, ` +
        "so there is nothing to rebuild from. Use launch() for a new session.",
    );
  }
  if (state.kind === "corrupt") {
    fail(
      `the supervision state in ${sessionRoot} cannot be trusted (${state.detail}); ` +
        "refusing to rebuild on unreadable evidence",
    );
  }
  const doc = state.doc;
  if (doc.phase === "quarantined") {
    fail(
      "supervision is quarantined: the blocking state could not be classified " +
        "safely and a human must resolve it before any rebuild",
    );
  }
  if (doc.phase === "needs-human") {
    fail(
      "supervision is waiting on a human decision; resolve it " +
        "(supervision state → recovering) before rebuilding",
    );
  }
  if (doc.phase !== "blocked" || doc.blocking?.host !== "process-gone") {
    fail(
      `rebuild requires proven process loss, but supervision reports phase ` +
        `"${doc.phase}" with host state "${doc.blocking?.host ?? "none"}"`,
    );
  }

  // 2. A live monitor still observes the dead pid: it would overwrite the
  //    rebuild's transitions on its next tick and hold the lease so the new
  //    session gets no monitor. Refuse until it is gone.
  const lease = inspectMonitorLease(sessionRoot, { now: now() });
  if (lease.state === "held") {
    fail(
      `the monitor lease is held by ${lease.record?.ownerId ?? "unknown"} ` +
        `(pid ${lease.record?.pid ?? "?"}), which still observes the previous ` +
        "host; stop that session's monitor or let its lease expire before rebuilding",
    );
  }
  if (lease.state === "ambiguous") {
    fail(
      "the monitor lease file cannot be understood; refusing to rebuild " +
        "under uncertain observation authority",
    );
  }

  // 3. Ownership: only a session that proved `owned` ever wrote provenance.
  //    Its absence is the attached/unknown answer — refuse without spawning.
  let provenance: ReturnType<typeof readLaunchProvenance>;
  try {
    provenance = readLaunchProvenance(sessionRoot);
  } catch (error) {
    fail(`launch provenance is unusable: ${errorMessage(error)}`);
  }
  if (provenance === null) {
    fail(
      `no launch provenance in ${sessionRoot}: this session never proved it ` +
        "owned an After Effects process, so there is no owned host to rebuild. " +
        "Attached and unknown sessions are never restarted.",
    );
  }
  if (provenance.host.platform !== platform) {
    fail(
      `the launch record names platform ${provenance.host.platform} but this ` +
        `host is ${platform}; cross-platform rebuild is not provable`,
    );
  }

  // 4. Fresh census: the recorded identity must be gone and no sibling
  //    instance may be running to be confused with the rebuild.
  const census = deps.processes ?? defaultProcessCensus(platform);
  let processes: readonly HostProcess[] | undefined;
  try {
    processes = census();
  } catch (error) {
    fail(
      `the After Effects process list could not be read ` +
        `(${errorMessage(error)}); process loss cannot be re-proven`,
    );
  }
  const targetUid = options.session?.uid ?? currentUid();
  const hostCheck = verifyRebuildHost({
    platform,
    provenance,
    processes,
    sessionUid: targetUid,
  });
  if (!hostCheck.ok) {
    fail(hostCheck.reason);
  }

  // 5. macOS: the rebuild must land in a live Aqua session — the same
  //    session the transport will deliver into.
  if (platform === "darwin") {
    const guiSession = (deps.readGuiSession ?? readGuiSession)(targetUid);
    if (guiSession === null || guiSession.kind !== "Aqua") {
      fail(
        `uid ${targetUid} has no Aqua login session ` +
          `${guiSession === null ? "" : `(kind ${guiSession.kind}) `}` +
          "to rebuild into; nothing was started",
      );
    }
  }

  // 6. Reconcile what the crashed session left pending, then record the
  //    recovery action in the durable document *before* launching: the
  //    audit trail must show the rebuild was attempted, not just its result.
  const pending = reconcilePendingRequests(sessionRoot, doc.pendingRequests);
  const started = applySupervisionEvent(
    doc,
    {
      kind: "recovery-started",
      reason:
        `verified rebuild: owned pid ${provenance.host.pid} proven gone ` +
        `(${hostCheck.evidence.join("; ")}); relaunching`,
    },
    now(),
  );
  if (!started.ok) {
    fail(`supervision refused the rebuild transition: ${started.reason}`);
  }
  const startedDoc = withEvidence(
    {
      ...started.doc,
      pendingRequests: pending.pendingRequests,
    },
    pending.evidence,
    now(),
  );
  try {
    writeSupervisionState(sessionRoot, startedDoc);
  } catch (error) {
    fail(`the rebuild could not be recorded in supervision state: ${errorMessage(error)}`);
  }

  // 7. Relaunch through the ordinary path. It re-proves everything a
  //    launch proves — process identity, single instance, readiness probe,
  //    provenance — and writes fresh provenance over the stale record.
  const open = deps.open ?? ((launchOptions, launchOp) => openAfterEffects(launchOptions, null, launchOp));
  const began = Date.now();
  let opened: OpenedSession;
  try {
    opened = await open({ ...options, sessionRoot }, op);
  } catch (error) {
    // The rebuild failed. A host that appeared but was never proven is a
    // human's problem (needs-human); anything else leaves the session
    // blocked on the still-unresolved process loss.
    const to: SupervisionPhase =
      error instanceof HostLeftRunningError || error instanceof ScriptingPermissionError
        ? "needs-human"
        : "blocked";
    recordEvent(
      sessionRoot,
      null,
      {
        kind: "recovery-failed",
        to,
        reason: `verified rebuild failed: ${errorMessage(error)}`,
        ...(to === "blocked"
          ? {
              blocking: {
                host: "unknown" as const,
                windows: [],
                detail: `rebuild attempt failed: ${errorMessage(error)}`,
              },
            }
          : {}),
      },
      now,
    );
    contextualise(op, error);
  }

  // 8. Re-verify ownership on the rebuilt session. Anything but `owned`
  //    fails closed: the host is left running untouched (an attached or
  //    ambiguous instance may hold someone's unsaved work) and the
  //    supervision document records the failure for a human.
  const ownership = opened.session.driver.ownership();
  if (ownership.kind !== "owned") {
    // Record first, release the monitor second: dispatching after stop()
    // would publish without holding the lease.
    recordEvent(
      sessionRoot,
      opened.session.supervision,
      {
        kind: "recovery-failed",
        to: "needs-human",
        reason:
          `rebuild launched a host but ownership could not be re-proven ` +
          `(${ownership.kind}: ${ownership.evidence}); the instance was left ` +
          "running untouched for a human to inspect",
      },
      now,
    );
    opened.session.supervision?.stop();
    try {
      // Never quits: ownership is not "owned", so stop() only closes the
      // session bookkeeping and records why the host was left alone.
      await opened.session.driver.stop({});
    } catch {
      // The close error is secondary to the ownership refusal.
    }
    fail(
      `the rebuilt After Effects could not be proven owned ` +
        `(${ownership.evidence}); it was left running and nothing was quit`,
    );
  }

  // 9. Recovery succeeded: the blocking host state is resolved and the
  //    pending requests were reconciled above. If the monitor already moved
  //    the session elsewhere (e.g. a crash-repair dialog on the new AE),
  //    the machine refuses and the durable phase stays the honest one.
  const phase = recordEvent(
    sessionRoot,
    opened.session.supervision,
    {
      kind: "recovery-succeeded",
      reason:
        "owned After Effects relaunched and re-proven; supervision resumes " +
        "on the new process",
    },
    now,
  );

  const pid = opened.session.driver.hostAttestation().pid;
  opened.session.trace.record("session.rebuild", "ok", Date.now() - began, {
    result: {
      previousPid: provenance.host.pid,
      pid,
      phase,
      pendingResolved: pending.resolved.length,
      pendingUnknown: pending.unknown.length,
    },
  });

  return {
    ...opened,
    rebuild: {
      previousPid: provenance.host.pid,
      pid,
      phase,
      pendingResolved: pending.resolved.length,
      pendingUnknown: pending.unknown.length,
    },
  };
}
