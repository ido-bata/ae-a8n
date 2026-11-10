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

import { tmpdir } from "node:os";
import { join } from "node:path";

import { A8N_VERSION } from "../index.js";
import { diagnostic, type DiagnosticCheck } from "../doctor/diagnostics.js";
import type { PlatformAdapter, TargetSpec } from "./contract.js";
import { DarwinAdapter } from "./darwin/adapter.js";
import type { FileChannel } from "./windows/channel.js";
import { DirectoryChannel } from "./windows/channel.js";
import type { CommandRunner } from "./windows/probe.js";
import { WindowsAdapter } from "./windows/runner.js";
import { SpawnCommandRunner } from "./windows/spawn-runner.js";

export type SelectOptions = {
  readonly target: TargetSpec;
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

function windowsAdapter(options: SelectOptions): WindowsAdapter {
  const { target } = options;
  const host = target.host ?? "local";
  const user = target.user ?? "";
  return new WindowsAdapter({
    channel:
      options.channel ??
      new DirectoryChannel(join(tmpdir(), "ae-a8n-cli-channel")),
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
