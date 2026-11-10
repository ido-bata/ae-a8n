/**
 * An in-repo adapter for testing the neutral layers without a host.
 *
 * It is not exported from the package entry point: it exists so `doctor`,
 * `setup`, `runner` and `reporter` can be exercised with no OS, no AE and no
 * session edge cases leaking into their tests. It records every call, so a
 * test can assert that a refusal happened *before* anything was sent.
 */

import type { DiagnosticCheck } from "../doctor/diagnostics.js";
import {
  assertProvenIdentity,
  type AdapterProbe,
  type Capabilities,
  type CommandOutcome,
  type IsolatedSession,
  type PlatformAdapter,
  type PlatformId,
  type RecoveryFinding,
  type RunOptions,
  type SessionIdentity,
  type SetupResult,
  type SetupStep,
  type StepOutcome,
  type TargetSpec,
} from "./contract.js";

export const FAKE_CAPABILITIES: Capabilities = {
  nonInterference: "proven",
  provesOwnership: true,
  provesDestination: true,
  guiRecovery: true,
  sessionIdentity: "uid-asid",
};

export const FAKE_IDENTITY: SessionIdentity = {
  kind: "uid-asid",
  user: "fake-test",
  detail: { uid: 900, asid: 1 },
  proven: true,
};

export type FakeAdapterOptions = {
  readonly capabilities?: Partial<Capabilities>;
  readonly identity?: SessionIdentity;
  readonly checks?: readonly DiagnosticCheck[];
  readonly exitCode?: number;
};

export class FakeAdapter implements PlatformAdapter {
  readonly platform: PlatformId;
  readonly id: string;
  readonly calls: string[] = [];

  private readonly capabilityValue: Capabilities;
  private readonly identityValue: SessionIdentity;
  private readonly checksValue: readonly DiagnosticCheck[];
  private readonly exitCodeValue: number;
  private opened = false;
  private closed = false;

  constructor(platform: PlatformId, options: FakeAdapterOptions = {}) {
    this.platform = platform;
    this.id = `fake-${platform}`;
    this.capabilityValue = { ...FAKE_CAPABILITIES, ...options.capabilities };
    this.identityValue = options.identity ?? FAKE_IDENTITY;
    this.checksValue = options.checks ?? [];
    this.exitCodeValue = options.exitCode ?? 0;
  }

  capabilities(): Promise<Capabilities> {
    this.calls.push("capabilities");
    return Promise.resolve(this.capabilityValue);
  }

  probe(target: TargetSpec): Promise<AdapterProbe> {
    this.calls.push(`probe:${target.name}`);
    return Promise.resolve({ checks: this.checksValue, capabilities: this.capabilityValue });
  }

  plan(target: TargetSpec): Promise<readonly SetupStep[]> {
    this.calls.push(`plan:${target.name}`);
    return Promise.resolve([
      {
        id: "fake.noop",
        state: "planned",
        reason: "the fake adapter has nothing to install",
        action: null,
        automatable: true,
      },
    ]);
  }

  apply(
    steps: readonly SetupStep[],
    options: { readonly yes: boolean; readonly dryRun: boolean },
  ): Promise<SetupResult> {
    this.calls.push(`apply:${options.dryRun ? "dry-run" : "apply"}`);
    const outcomes: StepOutcome[] = steps.map((step) => ({
      id: step.id,
      state: options.dryRun ? "planned" : "done",
      detail: options.dryRun ? "not changed" : "fake step applied",
    }));
    return Promise.resolve({ stateFile: "/fake/setup-state.json", outcomes });
  }

  open(target: TargetSpec): Promise<IsolatedSession> {
    this.calls.push(`open:${target.name}`);
    this.opened = false;
    this.closed = false;
    const identity = this.identityValue;
    const session: IsolatedSession = {
      identity,
      open: (): Promise<void> => {
        this.calls.push("session.open");
        this.opened = true;
        return Promise.resolve();
      },
      run: (argv: readonly string[], _options: RunOptions): Promise<CommandOutcome> => {
        try {
          assertProvenIdentity(identity);
          if (!this.opened || this.closed) {
            throw new Error("the fake session is not open");
          }
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        this.calls.push(`run:${argv.join(" ")}`);
        return Promise.resolve({
          exitCode: this.exitCodeValue,
          stdoutPath: "/fake/stdout.log",
          stderrPath: "/fake/stderr.log",
        });
      },
      close: (): Promise<{ readonly closed: boolean; readonly reason: string | null }> => {
        this.calls.push("session.close");
        this.closed = true;
        return Promise.resolve({ closed: true, reason: null });
      },
    };
    return Promise.resolve(session);
  }

  recover(runDir: string): Promise<readonly RecoveryFinding[]> {
    this.calls.push(`recover:${runDir}`);
    return Promise.resolve([
      {
        code: "A8N-JOB-002",
        action: "reported",
        detail: `the fake adapter found nothing to recover in ${runDir}`,
      },
    ]);
  }
}
