/**
 * Session-scoped supervision wiring (#285).
 *
 * `SessionSupervision` is the seam between a live `AeDriver` session and
 * the platform-neutral supervision core: it builds the macOS probe from the
 * same `MacGuiRecovery` observation `ae.guiState()` uses, starts the
 * lease-elected monitor against the session directory, and exposes the
 * durable report the driver consults while requests wait.
 *
 * It is deliberately narrow:
 *
 *   - Observation only. The monitor never presses a button; recovery stays
 *     on the driver's existing `HostRecovery` path, which holds the GUI
 *     mutation lease and audit trail.
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
import { MacGuiRecovery } from "./gui-recovery.js";
import { MacGuiProbe } from "../platform/darwin/gui-probe.js";
import {
  SupervisionMonitor,
  supervisionReport,
  type GuiProbe,
  type SupervisionReport,
} from "../supervision/index.js";
import type { PendingRequest } from "../supervision/types.js";

export type SessionSupervisionOptions = {
  /** The driver's session root — the same directory supervision state lives in. */
  readonly sessionRoot: string;
  /** The After Effects pid this session targets. */
  readonly pid: number;
  /** The GUI session the pid lives in; must be Aqua. */
  readonly session: MacSession;
  /**
   * Re-proves the pid immediately before each observation, same contract as
   * the recovery path's `verifyProcess`: a reused pid is never the target.
   */
  readonly verifyPid?: (pid: number) => boolean;
  /** Live pending requests the driver wants reflected in the document. */
  readonly pendingRequests?: () => readonly PendingRequest[];
  readonly intervalMs?: number;
  readonly ownerId?: string;
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

function isAeAppInstance(app: MacAppInstance): boolean {
  return /\bafter effects\b/i.test(app.name);
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
): CensusAttribution | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
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

  private constructor(sessionRoot: string, monitor: SupervisionMonitor) {
    this.#sessionRoot = sessionRoot;
    this.#monitor = monitor;
  }

  /**
   * Start monitoring, or return null when this host cannot be observed
   * honestly (non-macOS, non-Aqua session, or an observation stack that
   * refuses to initialise). Null is not an error: the durable report stays
   * `unavailable`, which is the truthful answer.
   */
  static start(options: SessionSupervisionOptions): SessionSupervision | null {
    if (process.platform !== "darwin" || options.session.kind !== "Aqua") {
      return null;
    }
    const verifyPid = options.verifyPid ?? (() => true);
    let recovery: MacGuiRecovery;
    try {
      recovery = new MacGuiRecovery({
        session: options.session,
        pid: options.pid,
        verifyProcess: verifyPid,
      });
    } catch {
      return null;
    }
    const probe: GuiProbe = new MacGuiProbe(options.pid, {
      listWindows: () => recovery.listWindows(),
      pidAlive: () => verifyPid(options.pid),
    });
    const started = SupervisionMonitor.start({
      sessionDir: options.sessionRoot,
      probe,
      ownerId: options.ownerId ?? "ae-a8n-session",
      pid: process.pid,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      ...(options.pendingRequests === undefined
        ? {}
        : { pendingRequests: options.pendingRequests }),
    });
    if (!started.ok) {
      return null;
    }
    // The loop is fire-and-forget: tick failures are contained inside
    // `run`, and `stop()` releases the lease. The sleep timer is unref'd so
    // a monitor can never hold the process open.
    void started.monitor.run().catch(() => undefined);
    return new SessionSupervision(options.sessionRoot, started.monitor);
  }

  /** The current durable report, health re-evaluated at read time. */
  report(): SupervisionReport {
    return supervisionReport(this.#sessionRoot);
  }

  /** The live phase, for callers that only need the headline. */
  get phase(): string {
    return this.#monitor.phase;
  }

  /** Stop monitoring and release the lease. Idempotent. */
  stop(): void {
    this.#monitor.stop();
  }
}
