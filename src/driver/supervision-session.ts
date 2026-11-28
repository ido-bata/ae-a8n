/**
 * Session-scoped supervision wiring (#285, win32 in #316).
 *
 * `SessionSupervision` is the seam between a live `AeDriver` session and
 * the platform-neutral supervision core: it builds the platform's GUI
 * probe — `MacGuiProbe` over `MacGuiRecovery` on macOS, `WindowsGuiProbe`
 * over the Win32 census + UIA observer on Windows — starts the
 * lease-elected monitor against the session directory, and exposes the
 * durable report the driver consults while requests wait.
 *
 * It is deliberately narrow:
 *
 *   - Observation only. The monitor never presses a button; recovery stays
 *     on the driver's existing `HostRecovery` path, which holds the GUI
 *     mutation lease and audit trail. On Windows that is
 *     `WindowsGuiRecovery`/`WindowsHostRecovery` (#283/#315) — supervision
 *     shares no code path with it beyond the read-only observation, and
 *     gains no mutation authority from it.
 *   - Honest absence. Any platform/session/observation it cannot support
 *     returns `null`, and `report()` then reads the durable state — which
 *     is `unavailable`, never a fabricated clean bill.
 *   - Lifecycle = session lifecycle. `stop()` releases the monitor lease;
 *     a crashed monitor is detected by readers through the stale heartbeat.
 */

import type { MacSession } from "./mac-session.js";
import {
  currentSession,
  listAppInstances,
  type MacAppInstance,
} from "./mac-session.js";
import {
  boundedObservationRunSession,
  MacGuiRecovery,
} from "./gui-recovery.js";
import { MacGuiProbe } from "../platform/darwin/gui-probe.js";
import { createTesseractOcr } from "../platform/darwin/ocr.js";
import { readDialogSurfaces } from "../platform/darwin/dialog-perception.js";
import { join } from "node:path";
import { WindowsGuiProbe } from "../platform/windows/gui-probe.js";
import type { WindowsGuiSession } from "./windows-gui-recovery.js";
import {
  SupervisionMonitor,
  supervisionReport,
  type GuiProbe,
  type ProbeSnapshot,
  type SupervisionReport,
} from "../supervision/index.js";
import type { PendingRequest, SupervisionStateDoc } from "../supervision/types.js";
import type { SupervisionEvent } from "../supervision/machine.js";
import {
  SupervisionSessionTracer,
  type SupervisionTraceSink,
} from "../supervision/session-trace.js";

/**
 * The proven GUI target a session monitor observes (#316): the platform
 * plus the session shape that platform's attestation produced — the same
 * split `HostRecoveryTarget` uses for the mutation path. A `MacSession`
 * names a login session by uid/asid; a `WindowsGuiSession` names an
 * interactive session by id.
 */
export type SessionSupervisionTarget =
  | { readonly platform: "darwin"; readonly session: MacSession }
  | { readonly platform: "win32"; readonly session: WindowsGuiSession };

export type SessionSupervisionOptions = {
  /** The driver's session root — the same directory supervision state lives in. */
  readonly sessionRoot: string;
  /** The After Effects pid this session targets. */
  readonly pid: number;
  /**
   * The attested target: which platform's probe to build and which GUI
   * session the pid was proven to live in. The caller — never this class —
   * decides the target is proven; `start` only refuses what it cannot
   * honour (wrong host platform, unmeasurable session id, non-Aqua
   * session).
   */
  readonly target: SessionSupervisionTarget;
  /**
   * Re-proves the pid immediately before each observation, same contract as
   * the recovery path's `verifyProcess`: a reused pid is never the target.
   * On Windows the check runs *after* the observer answers: a snapshot that
   * already proves `process-gone` stays process-gone, while any other
   * answer that cannot re-prove the pid is refused as degraded evidence.
   */
  readonly verifyPid?: (pid: number) => boolean;
  /** Live pending requests the driver wants reflected in the document. */
  readonly pendingRequests?: () => readonly PendingRequest[];
  readonly intervalMs?: number;
  readonly ownerId?: string;
  /**
   * Session trace the monitor's publishes and read-side health evaluations
   * are recorded into (#287). Optional: without it supervision still
   * publishes durable state, it just leaves no trace rows.
   */
  readonly trace?: SupervisionTraceSink;
  /** Test seam: replaces `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * Test seam: replaces the platform-built `GuiProbe`. Platform and
   * session proof still gate `start`, and on Windows the pid re-proof
   * wrapper still applies around the injected probe.
   */
  readonly probe?: GuiProbe;
};

/**
 * A pid/session pair attributed to the After Effects process by OS census
 * rather than by transport self-report (#294).
 *
 * Census correlation proves *which process to observe*, nothing more. It is
 * not proof of ownership and grants no GUI mutation authority — the driver
 * recovery path still requires its own `recoveryTarget()` attestation
 * before it may press anything.
 */
export type CensusAttribution = {
  readonly pid: number;
  readonly session: MacSession;
  /** Re-proves the pid still belongs to an AE app instance in this session. */
  readonly verifyPid: (pid: number) => boolean;
};

/**
 * The After Effects bundle id family (`com.adobe.AfterEffects.application`
 * on observed hosts). Bundle id is the strong signal: processes that only
 * *mention* After Effects — autofill helpers, hubs — carry unrelated ids.
 */
const AE_BUNDLE_ID = "com.adobe.AfterEffects";

/**
 * Whether a census entry is the After Effects application itself.
 *
 * With a bundle id the prefix decides. Without one (older parsers, test
 * fixtures) the name must *start* with the app name — "After Effects" or
 * "Adobe After Effects <version>" — so "自動入力（After Effects）"-style
 * helpers that merely contain the words do not count.
 */
function isAeAppInstance(app: MacAppInstance): boolean {
  if (app.bundleId !== undefined) {
    return (
      app.bundleId === AE_BUNDLE_ID ||
      app.bundleId.startsWith(`${AE_BUNDLE_ID}.`)
    );
  }
  return /^(?:adobe\s+)?after effects\b/i.test(app.name.trim());
}

/**
 * Build a `verifyPid` that re-runs the census: the pid keeps verifying only
 * while it still belongs to an AE app instance owned by `session.uid` in
 * `session.asid`. A recycled pid or a session move stops verifying on the
 * next call. Shared by census attribution (#294) and the detached
 * supervisor (#295), which observes a pid it did not launch.
 */
export function censusPidVerifier(
  session: MacSession,
  list: () => MacAppInstance[] = listAppInstances,
): (pid: number) => boolean {
  const uid = session.uid;
  return (pid) =>
    session.asid !== null &&
    list().some(
      (app) =>
        app.pid === pid &&
        app.uid === uid &&
        app.asid === session.asid &&
        isAeAppInstance(app),
    );
}

/**
 * Attribute the AE process for transports that cannot self-report a pid
 * (dispatcher, native channel) by correlating the OS app census (#294).
 *
 * The dispatcher/native channel runs inside an After Effects process owned
 * by the same OS user as this session, so the census is filtered to this
 * uid. Attribution succeeds only when the census proves exactly one AE app
 * instance in the caller's Aqua session:
 *
 *   - zero candidates  → AE is not running (or not a GUI app): `null`.
 *   - several candidates → ambiguous (multiple AE versions/processes):
 *     `null`. A single AE process is never treated as ownership proof on
 *     its own — it is only an observation target, and only when it is the
 *     *sole* candidate, because the channel gives no way to pick between
 *     several.
 *   - session id mismatch → the candidate lives in another login session:
 *     `null`.
 *
 * `verifyPid` re-runs the census so a recycled pid belonging to a
 * non-AE app — or an AE that moved sessions — stops verifying immediately.
 */
export function attributeAeByCensus(
  list: () => MacAppInstance[] = listAppInstances,
  session: MacSession = currentSession(),
  selfUid: number = typeof process.getuid === "function" ? process.getuid() : -1,
): CensusAttribution | null {
  const uid = selfUid;
  if (session.kind !== "Aqua" || session.uid !== uid || session.asid === null) {
    return null;
  }
  const candidates = list().filter(
    (app) => app.uid === uid && app.asid === session.asid && isAeAppInstance(app),
  );
  if (candidates.length !== 1) {
    return null;
  }
  const pid = candidates[0]!.pid;
  return { pid, session, verifyPid: censusPidVerifier(session, list) };
}

export class SessionSupervision {
  readonly #sessionRoot: string;
  readonly #monitor: SupervisionMonitor;
  readonly #probe: GuiProbe;
  readonly #tracer: SupervisionSessionTracer | null;

  private constructor(
    sessionRoot: string,
    monitor: SupervisionMonitor,
    probe: GuiProbe,
    tracer: SupervisionSessionTracer | null,
  ) {
    this.#sessionRoot = sessionRoot;
    this.#monitor = monitor;
    this.#probe = probe;
    this.#tracer = tracer;
  }

  /**
   * Start monitoring, or return null when this host cannot be observed
   * honestly (host platform or session shape the target cannot be
   * honoured on, or an observation stack that refuses to initialise).
   * Null is not an error: the durable report stays `unavailable`, which
   * is the truthful answer.
   */
  static start(options: SessionSupervisionOptions): SessionSupervision | null {
    const platform = options.platform ?? process.platform;
    const probe = SessionSupervision.#buildProbe(options, platform);
    if (probe === null) {
      return null;
    }
    const tracer =
      options.trace === undefined ? null : new SupervisionSessionTracer(options.trace);
    const started = SupervisionMonitor.start({
      sessionDir: options.sessionRoot,
      probe,
      ownerId: options.ownerId ?? "ae-a8n-session",
      pid: process.pid,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.pendingRequests === undefined
        ? {}
        : { pendingRequests: options.pendingRequests }),
      // Phase transitions are traced from the publish side: the monitor is
      // the only writer, so every phase it enters lands here exactly once.
      ...(tracer === null
        ? {}
        : { onPublish: (doc: SupervisionStateDoc) => tracer.notePublished(doc) }),
    });
    if (!started.ok) {
      return null;
    }
    // The loop is fire-and-forget: tick failures are contained inside
    // `run`, and `stop()` releases the lease. The sleep timer is unref'd so
    // a monitor can never hold the process open.
    void started.monitor.run().catch(() => undefined);
    return new SessionSupervision(
      options.sessionRoot,
      started.monitor,
      probe,
      tracer,
    );
  }

  /**
   * Build the platform probe for an attested target, or null when the
   * target cannot be honoured on this host. The checks here are the last
   * line before a monitor exists: a mismatched host platform, a session
   * the platform cannot name, or a probe that refuses to initialise all
   * yield null — never a guessed target.
   */
  static #buildProbe(
    options: SessionSupervisionOptions,
    platform: NodeJS.Platform,
  ): GuiProbe | null {
    const target = options.target;
    if (target.platform === "darwin") {
      if (platform !== "darwin" || target.session.kind !== "Aqua") {
        return null;
      }
      if (options.probe !== undefined) {
        return options.probe;
      }
      const verifyPid = options.verifyPid ?? (() => true);
      let recovery: MacGuiRecovery;
      try {
        recovery = new MacGuiRecovery({
          session: target.session,
          pid: options.pid,
          verifyProcess: verifyPid,
          // Observation only: this instance exists to feed `listWindows()`
          // to the probe and never presses anything, so the console-session
          // mutation guard must not silence it — the console session is the
          // common case a supervised AE lives in. Same allowance as
          // `ae.guiState()`.
          allowConsoleSession: true,
          // Same bound as the detached supervisor (#450): a session command
          // that hangs past the monitor TTL would make this live monitor
          // report `monitor-lost`; bounding it degrades the tick instead.
          runSession: boundedObservationRunSession(),
        });
      } catch {
        return null;
      }
      // Dialog perception (#462): pull-based readings over the same
      // recovery instance — never inside the monitor tick. Captures land
      // under the session's artifacts dir; OCR is the bounded tesseract
      // subprocess (absent/slow engine degrades to `unreadable`, never
      // a hang).
      const ocr = createTesseractOcr();
      const evidenceDir = join(options.sessionRoot, "artifacts");
      return new MacGuiProbe(options.pid, {
        listWindows: () => recovery.listWindows(),
        pidAlive: () => verifyPid(options.pid),
        readings: async () => {
          const state = recovery.listWindows();
          const report = await readDialogSurfaces(state, {
            captureWindow: (path, windowNumber) =>
              recovery.captureWindowById(path, windowNumber),
            ocr,
            evidenceDir,
          });
          return report.readings;
        },
      });
    }

    // win32 (#316): `WindowsGuiProbe` is already the platform-neutral
    // `GuiProbe` — Win32 census plus UIA, read-only by construction. What
    // it cannot prove alone is target identity: its observer script sees
    // *a* process at the pid, not *the* process this session proved. The
    // wrapper below closes that gap with the caller's `verifyPid`
    // re-proof — the same `sameProcess` creation-identity check the
    // recovery path uses — and `expectedSessionId` makes a foreign-session
    // pid fail closed inside the probe itself.
    if (platform !== "win32") {
      return null;
    }
    const sessionId = target.session.sessionId;
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return null;
    }
    const verifyPid = options.verifyPid ?? (() => true);
    const observer =
      options.probe ??
      new WindowsGuiProbe(options.pid, { expectedSessionId: sessionId });
    return {
      observe: async () => {
        const snapshot = await observer.observe();
        if (!snapshot.ok || snapshot.host === "process-gone") {
          // A proven-gone target stays process-gone: the observer's own
          // meta record is the evidence, and the pid re-proof cannot make
          // a dead process "unknown".
          return snapshot;
        }
        if (!verifyPid(options.pid)) {
          // The pid now names something else — reused, or ambiguous
          // against a second instance. Whatever windows were just listed
          // are not this session's After Effects, so the whole snapshot
          // is refused as degraded evidence, never a clean screen.
          return {
            ok: false,
            reason:
              `pid ${options.pid} could not be re-proven as this session's ` +
              "After Effects (reused, gone, or ambiguous)",
          };
        }
        return snapshot;
      },
    };
  }

  /**
   * One bounded read-only observation through the same probe the monitor
   * ticks with (#452). Launch readiness classification uses this when the
   * durable document is still blind — inside the probe's startup grace —
   * so the launch error can carry census/AX evidence a `timeout` label
   * alone cannot. This is a single `observe()` call, never a restarted
   * monitor, and it cannot press: the probe is observation-only by
   * contract. Returns null when the probe itself throws; the snapshot's
   * own `ok:false` is the honest "could not see" answer.
   */
  async observeOnce(): Promise<ProbeSnapshot | null> {
    try {
      return await this.#probe.observe();
    } catch {
      return null;
    }
  }

  /** The current durable report, health re-evaluated at read time. */
  report(): SupervisionReport {
    const report = supervisionReport(this.#sessionRoot);
    // Evaluated health is traced from the read side: a stale heartbeat
    // (`monitor-lost`) is only visible here, because the monitor that would
    // have reported it is already gone.
    this.#tracer?.noteReport(report);
    return report;
  }

  /** The live phase, for callers that only need the headline. */
  get phase(): string {
    return this.#monitor.phase;
  }

  /**
   * Apply a supervision event outside the monitor's tick loop (#286) —
   * the rebuild path records its recovery transitions through here so the
   * durable document and the live monitor never disagree. Returns whether
   * the machine accepted the transition.
   */
  dispatch(event: SupervisionEvent): boolean {
    return this.#monitor.dispatch(event);
  }

  /**
   * Replace the pending-request list (#286): rebuild reconciliation marks
   * crashed-session requests resolved-or-unknown, which the tick merge
   * cannot express.
   */
  setPendingRequests(requests: readonly PendingRequest[]): void {
    this.#monitor.setPendingRequests(requests);
  }

  /** Stop monitoring and release the lease. Idempotent. */
  stop(): void {
    this.#monitor.stop();
  }
}
