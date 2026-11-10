/**
 * The JSON envelope shared by all five commands (`contracts/cli.md` §5).
 *
 * `schemaVersion` is part of the programmatic API. Adding a field is allowed;
 * renaming or removing one is a breaking change.
 */

import type { DiagnosticCheck } from "../doctor/diagnostics.js";
import type { Capabilities, SessionIdentity } from "../platform/contract.js";
import { packageInfo } from "../runner/package-info.js";
import type { RunArtifacts, RunVerdict } from "../runner/artifacts.js";

export const SCHEMA_VERSION = "1.0";

export type EnvelopeStatus =
  | "ok"
  | "blocked"
  | "failed"
  | "unknown"
  | "refused"
  | "test-failed"
  | "setup-incomplete";

export type PlatformInfo = {
  readonly os: string;
  readonly release: string | null;
  readonly arch: string | null;
  /** The adapter that answered, e.g. `macos-session-agent`. */
  readonly backend: string;
};

export type PackageInfo = {
  readonly name: string;
  readonly version: string;
  readonly commit: string | null;
};

export type TargetInfo = {
  readonly name: string;
  readonly isolation: "session" | "remote-host";
  /** Probed for `test`; absent for commands that do not open a session. */
  readonly identity?: SessionIdentity;
};

export type NextAction = {
  readonly kind: "human" | "automatic";
  readonly code: string;
  readonly action: string;
};

export type CliEnvelope = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly command: string;
  readonly status: EnvelopeStatus;
  readonly exitCode: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly platform: PlatformInfo;
  readonly package: PackageInfo;
  readonly target: TargetInfo;
  readonly checks: readonly DiagnosticCheck[];
  readonly nextActions: readonly NextAction[];
  readonly notice?: string;
  readonly facts?: unknown;
  readonly capabilities?: Capabilities;
  /** `test` only: what the run was, where its files are, and its verdicts. */
  readonly runId?: string;
  readonly artifacts?: RunArtifacts;
  readonly verdicts?: readonly RunVerdict[];
};

export function nextActionsOf(checks: readonly DiagnosticCheck[]): readonly NextAction[] {
  const actions: NextAction[] = [];
  const seen = new Set<string>();
  for (const check of checks) {
    if (check.remedyKind === "none" || check.remedy.length === 0) {
      continue;
    }
    const key = `${check.code}\u0000${check.remedy}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    actions.push({
      kind: check.remedyKind,
      code: check.code,
      action: check.remedy,
    });
  }
  return actions;
}

export type EnvelopeInput = {
  readonly command: string;
  readonly status: EnvelopeStatus;
  readonly exitCode: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly platform: PlatformInfo;
  readonly target: TargetInfo;
  readonly checks: readonly DiagnosticCheck[];
  readonly notice?: string | undefined;
  readonly facts?: unknown;
  readonly capabilities?: Capabilities | undefined;
  readonly runId?: string | undefined;
  readonly artifacts?: RunArtifacts | undefined;
  readonly verdicts?: readonly RunVerdict[] | undefined;
  readonly env?: NodeJS.ProcessEnv;
};

export function buildEnvelope(input: EnvelopeInput): CliEnvelope {
  const project = packageInfo();
  const env = input.env ?? process.env;
  const rawCommit = env["A8N_COMMIT"];
  const commit =
    rawCommit !== undefined && rawCommit.trim().length > 0 ? rawCommit.trim() : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    command: input.command,
    status: input.status,
    exitCode: input.exitCode,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    platform: input.platform,
    package: { name: project.name, version: project.version, commit },
    target: input.target,
    checks: input.checks,
    nextActions: nextActionsOf(input.checks),
    ...(input.notice === undefined || input.notice.length === 0
      ? {}
      : { notice: input.notice }),
    ...(input.facts === undefined ? {} : { facts: input.facts }),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(input.verdicts === undefined ? {} : { verdicts: input.verdicts }),
  };
}
