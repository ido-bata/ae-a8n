/**
 * The JSON envelope shared by all five commands (`contracts/cli.md` §5).
 *
 * `schemaVersion` is part of the programmatic API. Adding a field is allowed;
 * renaming or removing one is a breaking change.
 */

import type { DiagnosticCheck } from "../doctor/diagnostics.js";
import type { Capabilities, SessionIdentity, SetupStepState } from "../platform/contract.js";
import { packageInfo } from "../runner/package-info.js";
import type { RunArtifacts, RunReport, RunVerdict } from "../runner/artifacts.js";
import type { Finding } from "../runner/recover-run.js";
import {
  nextAction,
  type NextAction,
  type NextActionReasonCode,
} from "../supervision/next-actions.js";

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

/**
 * One `nextActions[]` entry (#341). The canonical contract lives in
 * `src/supervision/next-actions.ts` and is shared by the API, the
 * supervision report and every CLI command: `kind` says who acts,
 * `allowed` whether automation may do it now, `code` identifies the
 * action/condition, `reason.code` is the stable reason, and `action` is
 * display prose — never the machine contract. Re-exported here so CLI
 * consumers keep one import site.
 */
export type { NextAction } from "../supervision/next-actions.js";

/**
 * One `setup` step as the CLI reports it: the plan's description plus what
 * `apply` actually did. `state` is the outcome; `detail` says why.
 */
export type SetupStepReport = {
  readonly id: string;
  readonly state: SetupStepState;
  readonly reason: string;
  readonly action: string | null;
  readonly automatable: boolean;
  readonly detail: string;
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
  /** `recover` only: what was found, and whether anything was cleared. */
  readonly findings?: readonly Finding[];
  readonly cleared?: boolean;
  /** `report` only: the stored `report.json`, as it was read. */
  readonly report?: RunReport;
  /** `setup` only: the plan, and what applying it did. */
  readonly steps?: readonly SetupStepReport[];
  readonly stateFile?: string;
};

/**
 * Map a check's remedy onto the next-action contract (#341). `remedyKind`
 * already says who can clear the condition; `allowed` restates it for
 * automation and `reason.code` gives the stable why, so a consumer never
 * has to parse `action` prose.
 */
function reasonCodeFor(remedyKind: DiagnosticCheck["remedyKind"]): NextActionReasonCode {
  switch (remedyKind) {
    case "automatic":
      return "permitted";
    case "human":
      return "requires-human";
    case "none":
      return "permitted";
  }
}

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
    actions.push(
      nextAction({
        kind: check.remedyKind === "automatic" ? "automatic" : "human",
        allowed: check.remedyKind === "automatic",
        code: check.code,
        reason: reasonCodeFor(check.remedyKind),
        action: check.remedy,
      }),
    );
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
  readonly findings?: readonly Finding[] | undefined;
  readonly cleared?: boolean | undefined;
  readonly report?: RunReport | undefined;
  readonly steps?: readonly SetupStepReport[] | undefined;
  readonly stateFile?: string | undefined;
  /** Overrides the actions derived from `checks` (used by `recover`). */
  readonly nextActions?: readonly NextAction[] | undefined;
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
    nextActions: input.nextActions ?? nextActionsOf(input.checks),
    ...(input.notice === undefined || input.notice.length === 0
      ? {}
      : { notice: input.notice }),
    ...(input.facts === undefined ? {} : { facts: input.facts }),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(input.verdicts === undefined ? {} : { verdicts: input.verdicts }),
    ...(input.findings === undefined ? {} : { findings: input.findings }),
    ...(input.cleared === undefined ? {} : { cleared: input.cleared }),
    ...(input.report === undefined ? {} : { report: input.report }),
    ...(input.steps === undefined ? {} : { steps: input.steps }),
    ...(input.stateFile === undefined ? {} : { stateFile: input.stateFile }),
  };
}
