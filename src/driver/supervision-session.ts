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
