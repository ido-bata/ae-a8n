/**
 * Detached supervision supervisor (#295).
 *
 * `startDetachedSupervisor` spawns `supervisor-entry` as an independent OS
 * process so GUI observation survives the exit of the request-issuing
 * process (CLI, MCP server, VSCode extension host). The child is
 * observation-only: it holds the monitor lease and publishes the durable
 * supervision document, and nothing else — it has no recovery path and no
 * GUI mutation authority.
 *
 * Lifecycle and safety:
 *
 *   - Duplicate-safe. The child acquires the same monitor lease the
 *     in-process monitor uses; if a monitor is already live the child
 *     exits immediately. Consumers may call this unconditionally.
 *   - Parent-death safe. The child is `detached` + `unref`'d with ignored
 *     stdio, so it is not tied to the parent's lifetime or event loop.
 *   - Honest failure. If the spawn itself fails or the child dies, the
 *     durable report degrades to `unavailable`/`monitor-lost` — readers
 *     never see a fabricated healthy state, and a later consumer can
 *     simply spawn again (the lease TTL bounds how long a dead child's
 *     lease blocks a replacement).
 *
 * Consumer responsibility: library sessions keep their in-process monitor
 * by default for backward compatibility. CLI/MCP/VSCode consumers that
 * want supervision to outlive a single request process call this at
 * session start; the lease makes concurrent calls harmless.
 *
 * Platform scope: the detached supervisor is macOS-only (#295). On win32
 * the in-process `SessionSupervision` monitor (#316) already publishes
 * the same durable report for the session's lifetime; a win32 detached
 * spawn — which would need its own session-id/provenance plumbing through
 * `supervisor-entry` — is a deliberate follow-up, not a gap this ticket
 * hides. Until then `startDetachedSupervisor` returns `{ pid: null }` on
 * win32 and readers see honest `unavailable`/`monitor-lost`, never a
 * fabricated healthy state.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MacSession } from "../driver/mac-session.js";

export type DetachedSupervisorOptions = {
  /** The driver's session root — the directory supervision state lives in. */
  readonly sessionDir: string;
  /** The After Effects pid to observe. */
  readonly pid: number;
  /** The GUI session (uid/asid) the pid lives in. Must be Aqua. */
  readonly session: MacSession;
  /** Test seam: replaces the actual child_process.spawn. */
  readonly spawn?: typeof spawn;
  /** Test seam: replaces the resolved supervisor entry path. */
  readonly entryPath?: string;
  /** Test seam: replaces `process.platform`. */
  readonly platform?: NodeJS.Platform;
};

export type DetachedSupervisor = {
  /** The spawned supervisor's pid, or null when the platform refuses. */
  readonly pid: number | null;
};

const SUPERVISOR_ENTRY = fileURLToPath(
  new URL("./supervisor-entry.js", import.meta.url),
);

/**
 * Spawn the detached supervisor, or return `{ pid: null }` when this host
 * cannot host one (non-macOS, non-Aqua session, missing session id). Null
 * is honest absence, not an error — the durable report stays
 * `unavailable`.
 */
export function startDetachedSupervisor(
  options: DetachedSupervisorOptions,
): DetachedSupervisor {
  const { session } = options;
  const platform = options.platform ?? process.platform;
  if (
    platform !== "darwin" ||
    session.kind !== "Aqua" ||
    session.asid === null ||
    session.uid < 0 ||
    !Number.isInteger(options.pid) ||
    options.pid <= 0
  ) {
    return { pid: null };
  }
  const spawnImpl = options.spawn ?? spawn;
  const entry = options.entryPath ?? SUPERVISOR_ENTRY;
  const child = spawnImpl(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AE_A8N_SUPERVISOR_SESSION_DIR: options.sessionDir,
      AE_A8N_SUPERVISOR_PID: String(options.pid),
      AE_A8N_SUPERVISOR_UID: String(session.uid),
      AE_A8N_SUPERVISOR_ASID: String(session.asid),
    },
  });
  child.unref();
  return { pid: child.pid ?? null };
}
