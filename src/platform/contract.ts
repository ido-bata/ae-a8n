/**
 * The boundary between platform-neutral orchestration and OS-specific work.
 *
 * `cli`, `doctor`, `setup`, `runner` and `reporter` never branch on
 * `process.platform`; they ask an adapter. An adapter that cannot prove a
 * capability says so, and the runner refuses when it cannot show the target
 * session is separate: `assertProvenIdentity` is that refusal, and every
 * adapter calls it before it runs a command.
 *
 * `capabilityChecks` is *not* that refusal. It turns a backend's static
 * capability statement into diagnostic codes, for reporting; a backend that
 * has not measured non-interference in general ("unproven") can still prove a
 * particular target at run time, so refusing a run on the static value alone
 * would block backends that are safe in the configuration actually in use.
 *
 * See `specs/isolated-ae/plan.md` §3 and `specs/isolated-ae/research.md`.
 */

import type { DiagnosticCheck } from "../doctor/diagnostics.js";
import { diagnostic } from "../doctor/diagnostics.js";

export type PlatformId = "darwin" | "win32";

/** What an adapter can actually prove on this machine. */
export type Capabilities = {
  /**
   * "proven": measured on a real host in this configuration.
   * "by-construction": the target is a different machine.
   * "unproven": neither; the runner must refuse to claim non-interference.
   */
  readonly nonInterference: "proven" | "by-construction" | "unproven";
  readonly provesOwnership: boolean;
  readonly provesDestination: boolean;
  readonly guiRecovery: boolean;
  readonly sessionIdentity: "uid-asid" | "host-and-user" | "none";
};

export type TargetSpec = {
  readonly name: string;
  readonly isolation: "session" | "remote-host";
  /** The OS account that runs AE, or null when the backend has none. */
  readonly user: string | null;
  /** The remote host, or null for a local backend. */
  readonly host: string | null;
};

/**
 * Who the session belongs to. `proven` is false when any fact could not be
 * read; such an identity may be reported but must not be acted on.
 */
export type SessionIdentity = {
  readonly kind: "uid-asid" | "host-and-user";
  readonly user: string;
  readonly detail: Readonly<Record<string, string | number | null>>;
  readonly proven: boolean;
};

/** A step of `setup`. Mirrors `contracts/cli.md` §7. */
export type SetupStepState = "planned" | "done" | "skipped" | "needs-human" | "failed";

export type SetupStep = {
  readonly id: string;
  readonly state: SetupStepState;
  readonly reason: string;
  /** The exact action for a human, or null when none is required. */
  readonly action: string | null;
  /** True when `--yes` may perform it without asking again. */
  readonly automatable: boolean;
};

export type StepOutcome = {
  readonly id: string;
  readonly state: SetupStepState;
  readonly detail: string;
};

export type SetupResult = {
  readonly stateFile: string;
  readonly outcomes: readonly StepOutcome[];
};

export type RecoveryFinding = {
  readonly code: DiagnosticCheck["code"];
  readonly action: "reported" | "cleared" | "refused";
  readonly detail: string;
  /** The exact action for a human, or omitted when none is required. */
  readonly remedy?: string;
};

export type AdapterProbe = {
  readonly checks: readonly DiagnosticCheck[];
  readonly capabilities: Capabilities;
};

export type CommandOutcome = {
  readonly exitCode: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /**
   * True when the adapter itself stopped the command at its deadline. Such a
   * run is indeterminate: the runner quarantines it instead of reporting a
   * test failure or retrying.
   */
  readonly timedOut?: boolean;
};

export type RunOptions = {
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
};

export interface IsolatedSession {
  readonly identity: SessionIdentity;
  /** Idempotent. A session already open is re-probed before it is reused. */
  open(): Promise<void>;
  /** Runs argv in the target session. Never retried by the adapter. */
  run(argv: readonly string[], options: RunOptions): Promise<CommandOutcome>;
  close(): Promise<{ readonly closed: boolean; readonly reason: string | null }>;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly id: string;
  capabilities(): Promise<Capabilities>;
  probe(target: TargetSpec): Promise<AdapterProbe>;
  plan(target: TargetSpec): Promise<readonly SetupStep[]>;
  apply(
    steps: readonly SetupStep[],
    options: { readonly yes: boolean; readonly dryRun: boolean },
  ): Promise<SetupResult>;
  open(target: TargetSpec): Promise<IsolatedSession>;
  recover(runDir: string): Promise<readonly RecoveryFinding[]>;
}

/**
 * Thrown before anything is sent when the target session cannot be proven.
 * Carries the diagnostic code so the CLI can print it without a mapping.
 */
export class UnprovenTargetError extends Error {
  readonly code = "A8N-AE-003" as const;

  constructor(message: string) {
    super(message);
    this.name = "UnprovenTargetError";
  }
}

/** The one guard every adapter calls before it runs a command. */
export function assertProvenIdentity(identity: SessionIdentity): void {
  if (identity.proven) {
    return;
  }
  throw new UnprovenTargetError(
    `target session for user "${identity.user}" could not be proven; nothing was sent`,
  );
}

/**
 * The capability gaps a backend states about itself, as diagnostic codes.
 *
 * Reporting, not enforcement: it is called by the tests and by a caller that
 * wants to show the statement, and no run is refused on the strength of it.
 * The refusal for a target that cannot be shown separate is
 * {@link assertProvenIdentity}, which every adapter calls with the identity it
 * measured for the target actually in use — a backend whose static statement
 * is "unproven" may still prove the specific target it was asked for.
 */
export function capabilityChecks(
  capabilities: Capabilities,
  platform: PlatformId,
): readonly DiagnosticCheck[] {
  if (capabilities.nonInterference !== "unproven") {
    return [];
  }
  return [
    diagnostic("A8N-AE-003", {
      detail: `the ${platform} backend cannot prove that the test session is separate from the console session`,
      remedy: "Configure a target the adapter can prove, or use the dedicated-host backend.",
      remedyKind: "human",
      evidence: { platform, nonInterference: capabilities.nonInterference },
    }),
  ];
}
