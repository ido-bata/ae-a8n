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
 *
 * Transport re-staging (#313): a new After Effects process starts with
 * none of the delivery paths the crashed one had, so after ownership is
 * re-proven the rebuild re-establishes what the old session provably
 * used, per surface:
 *
 *   - script-invocation: nothing to re-stage. Every call delivers its
 *     entry script fresh and the driver stages the host-script copy
 *     controller-side per session; nothing persists inside After Effects.
 *     The readiness probe already proved the new process answers.
 *   - in-ae-dispatcher *as the session transport*: unreachable — that
 *     transport never records launch provenance, so rebuild refuses it
 *     before this point; and its `launch()` refuses without a live
 *     heartbeat anyway. Fail-closed both ways.
 *   - dispatcher *activation* inside the process: an owned session's
 *     `activateDispatcher()` delivery dies with the process. The session
 *     activation index (`dispatcher-activations.json`) plus each channel's
 *     `provenance.json` (#294) name exactly which channels were activated
 *     in the crashed pid; those are re-activated through the same
 *     `activateDispatcherForSession` core `activateDispatcher()` uses.
 *   - native-channel: not a session transport. The C++ plug-in is loaded
 *     by After Effects itself and its file channel persists on disk, so
 *     there is nothing ae-a8n stages per process — consumers observe the
 *     plug-in heartbeat going stale and fresh on their own.
 *
 * Re-staging never fails the rebuild: the session's own transport is
 * already probe-proven, and `resumed` describes the GUI-blocking
 * lifecycle, not transport readiness. Instead every surface's outcome is
 * reported on `rebuild.transports` (`not-required` / `restaged` /
 * `failed` / `unproven`), summarised in the `recovery-succeeded` reason,
 * and recorded in the session trace — a surface that could not be
 * re-established is never reported as available.
 */

import { resolve } from "node:path";

import { errorMessage } from "../errors.js";
import { readLaunchProvenance } from "../driver/launch-provenance.js";
import { HostLeftRunningError } from "../driver/driver.js";
import { readGuiSession, type MacSession } from "../driver/mac-session.js";
import { defaultDispatcherChannelDir } from "../driver/dispatcher-transport.js";
import {
  readDispatcherProvenance,
  type DispatcherProvenance,
} from "../driver/dispatcher-provenance.js";
import { readSessionDispatcherActivations } from "../driver/session-dispatcher-activations.js";
import {
  defaultProcessCensus,
  reconcilePendingRequests,
  verifyRebuildHost,
  type ProcessCensus,
} from "../driver/session-rebuild.js";
import type { HostProcess } from "../driver/host-processes.js";
import {
  DISPATCHER_TRANSPORT_KIND,
  ScriptingPermissionError,
} from "../driver/transport.js";
import {
  applySupervisionEvent,
  inspectMonitorLease,
  readSupervisionState,
  writeSupervisionState,
  type SupervisionEvent,
} from "../supervision/index.js";
import type { SupervisionPhase, SupervisionStateDoc } from "../supervision/types.js";
import { activateDispatcherForSession } from "./dispatcher-activation.js";
import { AfterEffectsError, contextualise } from "./errors.js";
import { openAfterEffects, type OpenedSession } from "./launch.js";
import type { Session } from "./session.js";
import type {
  DispatcherActivation,
  LaunchOptions,
  RebuildOptions,
  SessionRebuildReport,
  TransportRestage,
} from "./types.js";

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
  /**
   * Test seam for the dispatcher re-activation (#313): the channel
   * directory the *default* dispatcher channel resolves to, and the
   * activation call itself. Production uses
   * `defaultDispatcherChannelDir()` and `activateDispatcherForSession` —
   * the same core `AfterEffects.activateDispatcher` runs.
   */
  readonly dispatcherChannelDir?: string;
  readonly activateDispatcher?: (
    session: Session,
    channelDir: string,
  ) => Promise<DispatcherActivation>;
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
 * Re-stage the transport surfaces the crashed session provably used
 * inside the rebuilt After Effects process (#313). See the module
 * comment for the per-transport decisions; the short version is that
 * only dispatcher *activations* ever lived inside the old process, and
 * those are re-activated through the same `activateDispatcherForSession`
 * core `activateDispatcher()` uses — never a second delivery path.
 *
 * Nothing here throws: a surface that cannot be re-established is
 * reported `failed`/`unproven` on the returned entries, because the
 * rebuild itself already succeeded — the session's own transport was
 * proven by the launch probe. `resumed` is a GUI-lifecycle phase and is
 * not downgraded for a secondary surface; the report, the
 * `recovery-succeeded` reason, and the trace carry the honest answer.
 */
async function restageSessionTransports(input: {
  readonly session: Session;
  readonly sessionRoot: string;
  readonly previousPid: number;
  readonly platform: NodeJS.Platform;
  readonly deps: RebuildDeps;
}): Promise<readonly TransportRestage[]> {
  const { session, sessionRoot, previousPid, platform, deps } = input;
  const entries: TransportRestage[] = [];

  // The session's own transport. Whatever it is, the rebuild's readiness
  // probe already delivered a script through it to the new process —
  // that is the proof it answers. What differs is whether anything had
  // to be staged *inside* After Effects for it to work again:
  const transportKind = session.driver.transportKind;
  if (transportKind === DISPATCHER_TRANSPORT_KIND) {
    // Unreachable in practice — a dispatcher session never records launch
    // provenance, so rebuild refuses it before this point — but if it is
    // ever reached, "a dispatcher answered the probe" does not prove the
    // dispatcher lives in *this* process. Say so rather than imply it.
    entries.push({
      transport: transportKind,
      status: "unproven",
      detail:
        "the session transport is the in-AE dispatcher channel; the probe " +
        "proved a dispatcher answers, but which process hosts it is only " +
        "attested by dispatcher provenance, not by this rebuild",
    });
  } else if (session.driver.scriptTransport() !== null) {
    entries.push({
      transport: transportKind,
      status: "not-required",
      detail:
        "script invocation delivers every call fresh and the driver " +
        "re-stages the host-script copy per session; nothing persists " +
        "inside After Effects, and the readiness probe already proved " +
        "the new process answers",
    });
  } else {
    entries.push({
      transport: transportKind,
      status: "not-required",
      detail:
        "a caller-supplied transport manages its own host state; the " +
        "readiness probe already proved it answers the rebuilt process",
    });
  }

  // Dispatcher activations that lived inside the crashed process. The
  // session activation index names the channels this session activated;
  // each channel's provenance.json (#294) proves which host pid the
  // activation ran in. Only a record bound to the crashed pid needs
  // re-staging — anything else is provably not this session's to redo.
  const defaultChannelDir = deps.dispatcherChannelDir ?? defaultDispatcherChannelDir();
  const channelDirs = new Set<string>([defaultChannelDir]);
  const recorded = readSessionDispatcherActivations(sessionRoot);
  if (recorded.kind === "ok") {
    for (const dir of recorded.channelDirs) {
      channelDirs.add(dir);
    }
  } else if (recorded.kind === "corrupt") {
    entries.push({
      transport: DISPATCHER_TRANSPORT_KIND,
      status: "unproven",
      detail:
        `the session's dispatcher-activation index is corrupt ` +
        `(${recorded.detail}); channels activated under a custom ` +
        "channelDir cannot be enumerated, so only the default channel " +
        "was checked",
    });
  }

  const activate =
    deps.activateDispatcher ??
    ((target: Session, channelDir: string) =>
      activateDispatcherForSession(target, { channelDir }, "session.rebuild"));

  for (const channelDir of channelDirs) {
    let provenance: DispatcherProvenance | null;
    try {
      provenance = readDispatcherProvenance(channelDir);
    } catch (error) {
      entries.push({
        transport: DISPATCHER_TRANSPORT_KIND,
        channelDir,
        status: "unproven",
        detail: `the channel's activation provenance cannot be read (${errorMessage(error)}); whether the crashed process hosted a dispatcher here is unknown`,
      });
      continue;
    }
    if (provenance === null) {
      // No owned-activation record: either no dispatcher was ever
      // activated here by ae-a8n, or it was human-activated — which this
      // tooling never re-delivers. Nothing this session did needs
      // re-staging on this channel.
      continue;
    }
    if (provenance.host.platform !== platform) {
      entries.push({
        transport: DISPATCHER_TRANSPORT_KIND,
        channelDir,
        status: "unproven",
        detail:
          `the channel's activation provenance was recorded on ` +
          `${provenance.host.platform} but this rebuild runs on ${platform}`,
      });
      continue;
    }
    if (provenance.host.pid !== previousPid) {
      // Bound to a different (still-running or later) process: not the
      // crashed session's activation, so there is nothing to re-stage.
      continue;
    }
    try {
      const activation = await activate(session, channelDir);
      entries.push({
        transport: DISPATCHER_TRANSPORT_KIND,
        channelDir,
        status: "restaged",
        detail:
          `the crashed process hosted this channel's dispatcher ` +
          `(pid ${previousPid}); re-activated in the rebuilt process ` +
          `(instance ${activation.instance}, AE ${activation.aeVersion})`,
      });
    } catch (error) {
      entries.push({
        transport: DISPATCHER_TRANSPORT_KIND,
        channelDir,
        status: "failed",
        detail:
          `the crashed process hosted this channel's dispatcher ` +
          `(pid ${previousPid}) but re-activation failed: ${errorMessage(error)}`,
      });
    }
  }
  return entries;
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

  // 9. Re-stage the transport surfaces the crashed process hosted (#313).
  //    Runs while the document is still `recovering`: the outcome is part
  //    of the recovery record, and a surface that cannot be re-established
  //    is reported, never implied away. It cannot fail the rebuild — the
  //    session's own transport is already probe-proven.
  const transports = await restageSessionTransports({
    session: opened.session,
    sessionRoot,
    previousPid: provenance.host.pid,
    platform,
    deps,
  });
  const restageNote = transports
    .filter((entry) => entry.status !== "not-required")
    .map(
      (entry) =>
        `${entry.transport}${entry.channelDir === undefined ? "" : ` ${entry.channelDir}`} ` +
        `→ ${entry.status}`,
    )
    .join("; ");

  // 10. Recovery succeeded: the blocking host state is resolved and the
  //     pending requests were reconciled above. If the monitor already moved
  //     the session elsewhere (e.g. a crash-repair dialog on the new AE),
  //     the machine refuses and the durable phase stays the honest one.
  const phase = recordEvent(
    sessionRoot,
    opened.session.supervision,
    {
      kind: "recovery-succeeded",
      reason:
        "owned After Effects relaunched and re-proven; supervision resumes " +
        "on the new process" +
        (restageNote === "" ? "" : `; transport restage: ${restageNote}`),
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
      transports: transports.map((entry) => ({
        transport: entry.transport,
        ...(entry.channelDir === undefined ? {} : { channelDir: entry.channelDir }),
        status: entry.status,
        detail: entry.detail,
      })),
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
      transports,
    },
  };
}
