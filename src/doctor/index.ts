/**
 * The platform-neutral part of `doctor`.
 *
 * The adapter owns every OS-specific observation. This module owns the two
 * pieces that are the same everywhere: the Node version floor, and the rule
 * that a blocker is what makes `doctor` exit 3. It calls only `probe`, so it
 * cannot start After Effects, open a session or change the machine.
 */

import { hostname } from "node:os";

import {
  aggregateDiagnosticStatus,
  diagnostic,
  type DiagnosticCheck,
  type DiagnosticStatus,
} from "./diagnostics.js";
import type { AdapterProbe, PlatformAdapter, TargetSpec } from "../platform/contract.js";

/** The package's Node floor, mirrored from `package.json` `engines`. */
export const NODE_FLOOR_MAJOR = 22;

export type DoctorResult = {
  /** The adapter's probe, including any facts it chose to expose. */
  readonly probe: AdapterProbe;
  /** The probe checks plus the neutral Node-floor check. */
  readonly checks: readonly DiagnosticCheck[];
  readonly status: DiagnosticStatus;
};

/**
 * The major version of a Node version string, or null when it cannot be read.
 *
 * Exported so the macOS adapter — which reports the same floor and the same
 * diagnostic — does not carry a second copy of this parser. Two copies would
 * have to be fixed twice, and the edge cases (a bare `v22`, surrounding
 * whitespace) are exactly where they would drift apart.
 */
export function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Run the read-only checks. The adapter is the only thing that observes the
 * host; this function cannot issue a command of its own.
 */
export async function runDoctor(
  adapter: PlatformAdapter,
  target: TargetSpec,
): Promise<DoctorResult> {
  const probe = await adapter.probe(target);
  const checks: DiagnosticCheck[] = [...probe.checks];

  const major = nodeMajor(process.version);
  if (
    (major === null || major < NODE_FLOOR_MAJOR) &&
    !checks.some((check) => check.code === "A8N-ENV-002")
  ) {
    // This checks the process running `doctor`, not the machine After Effects
    // runs on. For a remote target that is the controller, and saying so is
    // the difference between "install Node here" and "install Node over
    // there" — the remedy is only actionable on the machine actually named.
    const machine = target.host === null ? "this machine" : `the controller (${hostname()})`;
    checks.push(
      diagnostic("A8N-ENV-002", {
        detail:
          major === null
            ? `the Node version "${process.version}" on ${machine} could not be parsed`
            : `Node ${process.version} on ${machine} is below the package floor (${NODE_FLOOR_MAJOR}+)`,
        remedy: `Install Node ${NODE_FLOOR_MAJOR} or later on ${machine} and re-run doctor.`,
        remedyKind: "human",
        evidence: { node: process.version, floor: NODE_FLOOR_MAJOR, machine },
      }),
    );
  }

  return { probe, checks, status: aggregateDiagnosticStatus(checks) };
}
