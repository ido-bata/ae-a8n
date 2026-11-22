/**
 * Detached supervision supervisor entry point (#295).
 *
 * This module is not a library API — it is the child process image spawned
 * by `startDetachedSupervisor()`. It runs only inside its own OS process,
 * holds the monitor lease for one session directory, and observes the AE
 * process through the same platform probe the in-process monitor uses.
 *
 * Contract:
 *
 *   - Observation only. The child never builds a recovery path and holds
 *     no GUI mutation authority; it cannot press anything.
 *   - Lease-elected. If another live monitor already holds the session
 *     lease, `SupervisionMonitor.start` refuses and this process exits —
 *     duplicate supervisors are impossible by construction.
 *   - Fail-closed identity. The target pid is re-verified against the OS
 *     census on every observation (`censusPidVerifier`): a recycled pid or
 *     a session change degrades observation instead of watching the wrong
 *     process.
 *   - Honest death. If this process dies, the lease heartbeat goes stale
 *     and readers see `monitor-lost` — never a fabricated healthy state.
 *
 * Configuration arrives exclusively through `AE_A8N_SUPERVISOR_*`
 * environment variables set by the spawner; there is no argv surface.
 */

import { MacGuiRecovery } from "../driver/gui-recovery.js";
import { censusPidVerifier } from "../driver/supervision-session.js";
import { readUsername, type MacSession } from "../driver/mac-session.js";
import { MacGuiProbe } from "../platform/darwin/gui-probe.js";
import { SupervisionMonitor } from "./monitor.js";
import type { GuiProbe } from "./probe.js";

const ENV_PREFIX = "AE_A8N_SUPERVISOR_";

function env(name: string): string | null {
  const value = process.env[`${ENV_PREFIX}${name}`];
  return value === undefined || value === "" ? null : value;
}

/**
 * A sleep whose timer stays ref'd: unlike the in-process monitor default
 * (unref'd so it cannot hold a CLI open), this process exists *only* to
 * monitor, so its loop must keep it alive.
 */
const supervisorSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<number> {
  if (process.platform !== "darwin") {
    return 0;
  }
  const sessionDir = env("SESSION_DIR");
  const pidText = env("PID");
  const uidText = env("UID");
  const asidText = env("ASID");
  if (sessionDir === null || pidText === null || uidText === null || asidText === null) {
    return 0;
  }
  const pid = Number(pidText);
  const uid = Number(uidText);
  const asid = Number(asidText);
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !Number.isInteger(uid) ||
    uid < 0 ||
    !Number.isInteger(asid) ||
    asid < 0
  ) {
    return 0;
  }

  const session: MacSession = {
    uid,
    username: readUsername(uid),
    asid,
    kind: "Aqua",
  };
  const verifyPid = censusPidVerifier(session);

  let recovery: MacGuiRecovery;
  try {
    recovery = new MacGuiRecovery({ session, pid, verifyProcess: verifyPid });
  } catch {
    return 0;
  }
  const probe: GuiProbe = new MacGuiProbe(pid, {
    listWindows: () => recovery.listWindows(),
    pidAlive: () => verifyPid(pid),
  });

  const started = SupervisionMonitor.start({
    sessionDir,
    probe,
    ownerId: "ae-a8n-detached-supervisor",
    pid: process.pid,
    sleep: supervisorSleep,
  });
  if (!started.ok) {
    // Another monitor holds the lease — the desired end state is already
    // running, so this duplicate exits quietly.
    return 0;
  }
  await started.monitor.run();
  return 0;
}

// Entry point guard: imported for side effect only by the spawned child.
// When bundled tests import the module graph this still runs `main()`;
// the env guard makes it a no-op outside a supervisor spawn.
void main().then(
  (code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  },
  () => {
    process.exitCode = 1;
  },
);
