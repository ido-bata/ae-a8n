/**
 * The platform-neutral part of `doctor`.
 *
 * The adapter owns every OS-specific observation. This module owns the two
 * pieces that are the same everywhere: the Node version floor, and the rule
 * that a blocker is what makes `doctor` exit 3. It calls only `probe`, so it
 * cannot start After Effects, open a session or change the machine.
 */

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

function nodeMajor(version: string): number | null {
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
    checks.push(
      diagnostic("A8N-ENV-002", {
        detail:
          major === null
            ? `the Node version "${process.version}" could not be parsed`
            : `Node ${process.version} is below the package floor (${NODE_FLOOR_MAJOR}+)`,
        remedy: `Install Node ${NODE_FLOOR_MAJOR} or later on this machine and re-run doctor.`,
        remedyKind: "human",
        evidence: { node: process.version, floor: NODE_FLOOR_MAJOR },
      }),
    );
  }

  return { probe, checks, status: aggregateDiagnosticStatus(checks) };
}
