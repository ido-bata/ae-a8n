/**
 * The one place the macOS/Windows choice is made.
 *
 * `cli`, `doctor`, `setup`, `runner` and `reporter` are neutral: they call this
 * module and never look at `process.platform` themselves. A host target selects
 * the Windows adapter wherever this code runs; a local target selects the
 * adapter for the machine the command runs on.
 *
 * A host target on a machine that cannot run the Windows probe commands is not
 * assumed to be healthy. The probe's commands fail to start and every fact that
 * depends on the host is reported as unreadable, so the command exits blocked.
 */

import { hostname, userInfo } from "node:os";

import { A8N_VERSION } from "../index.js";
import { diagnostic, type DiagnosticCheck } from "../doctor/diagnostics.js";
import type { PlatformAdapter, TargetSpec } from "./contract.js";
import { DarwinAdapter } from "./darwin/adapter.js";
import type { FileChannel } from "./windows/channel.js";
import type { CommandRunner } from "./windows/probe.js";
import type { CommsOptions } from "./windows/comms.js";
import { WindowsAdapter } from "./windows/runner.js";
import { SpawnCommandRunner } from "./windows/spawn-runner.js";

export type SelectOptions = {
  readonly target: TargetSpec;
  /**
   * How a named host is reached. Without it a `--host` target still selects
   * the Windows adapter, but the adapter refuses every probe: a local probe
   * would answer for this machine, not for the host.
   */
  readonly remote?: CommsOptions | null;
  /** Test seam: answers the Windows probe without a Windows host. */
  readonly probeRunner?: CommandRunner;
  /** Test seam: the Windows channel. `probe` never touches it. */
  readonly channel?: FileChannel;
};

/** A platform this package cannot drive, reported as a typed refusal. */
export type UnsupportedPlatform = {
  readonly ok: false;
  readonly platform: string;
  readonly check: DiagnosticCheck;
};

export type AdapterSelection =
  | { readonly ok: true; readonly adapter: PlatformAdapter }
  | UnsupportedPlatform;

export function unsupportedPlatformCheck(platform: string): DiagnosticCheck {
  return diagnostic("A8N-ENV-001", {
    detail: `this machine runs ${platform}, which ae-a8n cannot drive for isolated tests`,
    remedy:
      "Run this command on macOS, or pass --host <name> for a Windows target. Linux is explicitly unsupported.",
    remedyKind: "human",
    evidence: { platform },
  });
}

/**
 * Who writes a job for a Windows target.
 *
 * `user` is the writer, not the account After Effects runs as: the agent
 * refuses a job whose writer is anonymous (`A8N-JOB-001`), and the run lock
 * and manifest record the same pair. For a named host the account comes from
 * the host's configuration when the caller names none, so `""` is kept and
 * `#freshComms` fills it. A **local** target has no such configuration to
 * repair it from, so this machine's own host and account are recorded: the
 * local agent runs as this account, and `""` would turn the missing identity
 * into a refusal that blames the channel.
 */
export function writerFor(target: TargetSpec): { readonly host: string; readonly user: string } {
  if (target.host !== null) {
    return { host: target.host, user: target.user ?? "" };
  }
  return { host: localHostname(), user: target.user ?? localUsername() };
}

/** This machine's own name, or "local" when the OS will not give one. */
function localHostname(): string {
  try {
    const name = hostname().trim();
    return name === "" ? "local" : name;
  } catch {
    return "local";
  }
}

/**
 * The account running this process. `userInfo` is preferred; the environment
 * is the fallback Windows and POSIX both always set. The environment is not
 * a stronger proof of identity, but a job needs a name, and the agent cannot
 * verify which source produced it.
 */
function localUsername(): string {
  const sources = [() => userInfo().username, () => process.env.USERNAME ?? "", () => process.env.USER ?? ""];
  for (const source of sources) {
    try {
      const name = source().trim();
      if (name !== "") {
        return name;
      }
    } catch {
      // Try the next source.
    }
  }
  return "";
}

function windowsAdapter(options: SelectOptions): WindowsAdapter {
  const { target } = options;
  const { host, user } = writerFor(target);
  return new WindowsAdapter({
    // No channel here for a remote target: the adapter builds it from the
    // host's configuration, because a tmpdir on this machine cannot reach it.
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    host,
    user,
    agent: {
      id: "ae-a8n-cli",
      host,
      user,
      sessionId: 0,
      version: A8N_VERSION,
    },
    // The probe runs the platform's own read-only commands. On a non-Windows
    // machine they fail to start; the probe reports the facts as unreadable.
    probe: options.probeRunner ?? new SpawnCommandRunner(),
    remote: options.remote ?? null,
    // An injected probe runner answers for the host, which is how a fake
    // Windows host stands in for a real one in-process.
    ...(options.probeRunner === undefined ? {} : { simulatedHostProbe: true }),
  });
}

export function selectAdapter(options: SelectOptions): AdapterSelection {
  // A named host always means the Windows remote-host backend, regardless of
  // the controller. The probe then reports what could actually be read.
  if (options.target.host !== null) {
    return { ok: true, adapter: windowsAdapter(options) };
  }
  if (process.platform === "darwin") {
    return { ok: true, adapter: new DarwinAdapter() };
  }
  if (process.platform === "win32") {
    return { ok: true, adapter: windowsAdapter(options) };
  }
  return {
    ok: false,
    platform: process.platform,
    check: unsupportedPlatformCheck(process.platform),
  };
}
