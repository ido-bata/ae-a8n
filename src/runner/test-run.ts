/**
 * The platform-neutral `test` runner.
 *
 * It never branches on the host OS: the adapter supplies the session, this
 * module decides what was proven. Every path ends in one of the contract's
 * statuses, and an indeterminate outcome is quarantined rather than retried
 * (`specs/isolated-ae/contracts/cli.md` §8).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DIAGNOSTIC_CODES, diagnostic, type DiagnosticCheck } from "../doctor/diagnostics.js";
import {
  UnprovenTargetError,
  type AdapterProbe,
  type CommandOutcome,
  type IsolatedSession,
  type PlatformAdapter,
  type SessionIdentity,
  type TargetSpec,
} from "../platform/contract.js";
import {
  captureFile,
  writeRunArtifacts,
  type CapturedFile,
  type RunArtifacts,
  type RunManifest,
  type RunReport,
  type RunVerdict,
  type TraceEvent,
} from "./artifacts.js";
import { packageInfo } from "./package-info.js";
import { newRunId } from "./run-id.js";
import { acquireTargetLock, readQuarantine, stateLayout, writeQuarantine } from "./state.js";

export type TestRunStatus = "ok" | "test-failed" | "unknown" | "blocked" | "refused";

export type TestRunInput = {
  readonly adapter: PlatformAdapter;
  readonly target: TargetSpec;
  /** The command after `--`; already validated as non-empty. */
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** Keep the run directory even when the run passes. */
  readonly keepOnSuccess: boolean;
  readonly stateRoot: string;
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
  readonly pid?: number;
  /** Recorded in the manifest; the caller's commit, when CI exports one. */
  readonly commit?: string | null;
};

export type TestRunResult = {
  readonly runId: string;
  readonly status: TestRunStatus;
  /** Null when the run passed and its directory was dropped. */
  readonly runDir: string | null;
  readonly artifacts: RunArtifacts | null;
  readonly checks: readonly DiagnosticCheck[];
  readonly verdicts: readonly RunVerdict[];
  readonly identity: SessionIdentity | null;
  readonly notice?: string;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

type Classified = {
  readonly status: Exclude<TestRunStatus, "ok" | "test-failed">;
  readonly verdict: RunVerdict["verdict"];
  readonly check: DiagnosticCheck | null;
  readonly message: string;
  readonly quarantine: boolean;
};

/**
 * An adapter exception is classified by the diagnostic code it carries, so
 * one table serves both platforms. An exception with no code is indeterminate:
 * it is never reported as a test failure, and it quarantines the target.
 */
function classifyError(error: unknown, doing: string): Classified {
  const message = messageOf(error);
  if (error instanceof UnprovenTargetError) {
    return {
      status: "refused",
      verdict: "blocked",
      check: diagnostic("A8N-AE-003", {
        detail: message,
        remedy: "Run `ae-a8n doctor` and resolve the session-identity blocker.",
        remedyKind: "human",
        evidence: { stage: doing },
      }),
      message,
      quarantine: false,
    };
  }
  const code = codeOf(error);
  if (code !== null && code in DIAGNOSTIC_CODES) {
    const check = diagnostic(code as keyof typeof DIAGNOSTIC_CODES, {
      detail: message,
      remedy: "Run `ae-a8n doctor`; resolve the blocker before running a test again.",
      remedyKind: "human",
      evidence: { stage: doing },
    });
    if (code === "A8N-AE-004") {
      return { status: "unknown", verdict: "unknown", check, message, quarantine: true };
    }
    if (check.severity === "blocker" && /^A8N-(ENV|SESSION|PERM)-/u.test(code)) {
      return { status: "blocked", verdict: "blocked", check, message, quarantine: false };
    }
    return { status: "refused", verdict: "blocked", check, message, quarantine: false };
  }
  return { status: "unknown", verdict: "unknown", check: null, message, quarantine: true };
}

export function runIdOf(input: TestRunInput): string {
  const now = input.now ?? (() => new Date());
  const random = input.random ?? ((size: number) => new Uint8Array(randomBytes(size)));
  return newRunId(now(), random(4));
}

export async function runTest(input: TestRunInput): Promise<TestRunResult> {
  const now = input.now ?? (() => new Date());
  const layout = stateLayout(input.stateRoot);
  const runId = runIdOf(input);
  const runDirectory = join(layout.runs, runId);
  const startedAt = now().toISOString();
  const trace: TraceEvent[] = [];
  const event = (
    name: string,
    detail: string,
    data?: Readonly<Record<string, string | number | boolean | null>>,
  ): void => {
    trace.push({ at: now().toISOString(), event: name, detail, ...(data === undefined ? {} : { data }) });
  };

  mkdirSync(join(runDirectory, "artifacts"), { recursive: true, mode: 0o700 });
  event("run.allocated", `run ${runId} for target ${input.target.name}`, {
    isolation: input.target.isolation,
    host: input.target.host,
    user: input.target.user,
  });

  let identity: SessionIdentity | null = null;
  let checks: DiagnosticCheck[] = [];
  let verdicts: RunVerdict[] = [];
  let status: TestRunStatus = "unknown";
  let notice: string | undefined;
  let commandStartedAt: string | null = null;
  let commandFinishedAt: string | null = null;
  let exitCode: number | null = null;
  let timedOut = false;
  let stdout: CapturedFile | null = null;
  let stderr: CapturedFile | null = null;

  const finish = (): TestRunResult => {
    event("run.finished", `run ${runId} ended as ${status}`, { status, quarantine: quarantined });
    const manifest: RunManifest = {
      schemaVersion: "1.0",
      runId,
      command: [...input.argv],
      target: input.target,
      adapter: input.adapter.id,
      identity,
      package: {
        name: packageInfo().name,
        version: packageInfo().version,
        commit: input.commit ?? null,
      },
      startedAt,
      finishedAt: now().toISOString(),
      commandStartedAt,
      commandFinishedAt,
      exitCode,
      timedOut,
      stdout,
      stderr,
      environment: { A8N_RUN_ID: runId },
    };
    const report: RunReport = {
      schemaVersion: "1.0",
      runId,
      status,
      verdicts,
      startedAt,
      finishedAt: manifest.finishedAt,
      ...(notice === undefined ? {} : { notice }),
    };
    const artifacts = writeRunArtifacts(runDirectory, { manifest, report, trace });
    const keep = status !== "ok" || input.keepOnSuccess;
    if (!keep) {
      rmSync(runDirectory, { recursive: true, force: true });
      return {
        runId,
        status,
        runDir: null,
        artifacts: null,
        checks,
        verdicts,
        identity,
        ...(notice === undefined ? {} : { notice }),
      };
    }
    return {
      runId,
      status,
      runDir: runDirectory,
      artifacts,
      checks,
      verdicts,
      identity,
      ...(notice === undefined ? {} : { notice }),
    };
  };

  let quarantined = false;
  const quarantine = (detail: string): void => {
    quarantined = true;
    const path = writeQuarantine(layout, input.target.name, {
      runId,
      quarantinedAt: now().toISOString(),
      detail,
    });
    event("run.quarantined", detail, { path });
    notice = `${detail}. The target is quarantined at ${path}; nothing will run until a recovery clears it.`;
  };

  const failWith = (classified: Classified, stage: string): TestRunResult => {
    status = classified.status;
    verdicts = [{ id: stage, verdict: classified.verdict, message: classified.message }];
    if (classified.check !== null) {
      checks = [classified.check];
    }
    event(`run.${classified.status}`, `${stage}: ${classified.message}`);
    if (classified.quarantine) {
      quarantine(`${stage}: ${classified.message}`);
    }
    return finish();
  };

  // 1. A target left in an unknown state is never entered again by guessing.
  const prior = readQuarantine(layout, input.target.name);
  if (prior.quarantined) {
    event("run.refused", `quarantine: ${prior.detail}`, { path: prior.path });
    status = "refused";
    checks = [
      diagnostic("A8N-JOB-002", {
        detail: prior.detail,
        remedy:
          "Inspect the quarantined run, then clear the quarantine with `ae-a8n recover` " +
          "(not implemented in this increment) before running again.",
        remedyKind: "human",
        evidence: { path: prior.path },
      }),
    ];
    verdicts = [{ id: "run-quarantine", verdict: "blocked", message: prior.detail }];
    return finish();
  }

  // 2. One run per target. A lock is never taken over silently.
  const lock = acquireTargetLock(layout, input.target.name, {
    runId,
    pid: input.pid ?? process.pid,
    startedAt,
  });
  if (!lock.ok) {
    event("run.refused", lock.detail, { path: lock.path });
    status = "refused";
    checks = [
      diagnostic("A8N-JOB-002", {
        detail: lock.detail,
        remedy:
          "Wait for the running test, or inspect and clear the lock with `ae-a8n recover` " +
          "(not implemented in this increment).",
        remedyKind: "human",
        evidence: { path: lock.path },
      }),
    ];
    verdicts = [{ id: "run-lock", verdict: "blocked", message: lock.detail }];
    return finish();
  }

  try {
    // 3. The environment is inspected before anything is opened.
    let probe: AdapterProbe;
    try {
      probe = await input.adapter.probe(input.target);
    } catch (error) {
      return failWith(classifyError(error, "probe"), "probe");
    }
    checks = [...probe.checks];
    event("probe", `${checks.length} check(s); ${blockers(checks).length} blocker(s)`);
    const blocked = blockers(checks);
    if (blocked.length > 0) {
      status = "blocked";
      verdicts = [
        {
          id: "environment",
          verdict: "blocked",
          message: blocked.map((check) => `${check.code}: ${check.detail}`).join("; "),
        },
      ];
      event("run.blocked", `nothing was opened: ${blocked.length} blocker(s)`);
      return finish();
    }

    // 4. Open the session. The adapter proves the identity before it sends.
    let session: IsolatedSession;
    try {
      session = await input.adapter.open(input.target);
      await session.open();
    } catch (error) {
      return failWith(classifyError(error, "open"), "session");
    }
    identity = session.identity;
    event("session.opened", `session for ${identity.user}`, {
      proven: identity.proven,
      kind: identity.kind,
    });

    // 5. Run the command exactly once. The adapter never retries it.
    let outcome: CommandOutcome;
    commandStartedAt = now().toISOString();
    try {
      outcome = await session.run(input.argv, {
        timeoutMs: input.timeoutMs,
        env: { A8N_RUN_ID: runId },
      });
    } catch (error) {
      // The command did finish — it threw. Record that before the artifacts
      // are written, so the manifest does not claim the run never returned.
      commandFinishedAt = now().toISOString();
      return failWith(classifyError(error, "run"), "command");
    }
    commandFinishedAt = now().toISOString();
    exitCode = outcome.exitCode;
    timedOut = outcome.timedOut === true;
    event("command.finished", `the command exited ${String(exitCode)}`, {
      exitCode,
      timedOut,
    });

    // 6. The command's own output is part of the evidence.
    stdout = captureFile(outcome.stdoutPath, "stdout.log", join(runDirectory, "artifacts"));
    stderr = captureFile(outcome.stderrPath, "stderr.log", join(runDirectory, "artifacts"));

    // 7. Map the outcome. A timeout is unknown, never a failed test.
    if (timedOut) {
      status = "unknown";
      verdicts = [
        {
          id: "command",
          verdict: "unknown",
          message: `the command did not finish within ${String(input.timeoutMs)} ms`,
        },
      ];
      quarantine(`the command timed out after ${String(input.timeoutMs)} ms and may still be running`);
    } else if (stdout.path === null || stderr.path === null) {
      status = "unknown";
      verdicts = [
        {
          id: "artifacts",
          verdict: "unknown",
          message: "the command's output could not be captured into the run directory",
        },
      ];
      quarantine("the command's output could not be captured, so the run cannot be reported");
    } else if (exitCode === 0) {
      status = "ok";
      verdicts = [{ id: "command", verdict: "pass", message: "the command exited 0" }];
    } else {
      status = "test-failed";
      verdicts = [
        { id: "command", verdict: "fail", message: `the command exited ${String(exitCode)}` },
      ];
    }
    return finish();
  } finally {
    // A lock is released last: the quarantine record and artifacts are written
    // before another run could be allowed in.
    lock.lock.release();
  }
}

function blockers(checks: readonly DiagnosticCheck[]): readonly DiagnosticCheck[] {
  return checks.filter((check) => check.severity === "blocker");
}
