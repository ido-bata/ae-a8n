/**
 * `ae-a8n` command dispatch.
 *
 * All five contract commands are implemented: `doctor` (#55), `setup` (#56),
 * `test` (#58), `recover` (#59) and `report`.
 *
 * The platform choice is delegated to `select.ts`; nothing here branches on
 * the host OS.
 */

import { homedir, arch as osArch, platform as osPlatform, release as osRelease } from "node:os";
import { join } from "node:path";

import { A8N_VERSION } from "../index.js";
import { runDoctor } from "../doctor/index.js";
import type { AdapterProbe, PlatformAdapter, TargetSpec } from "../platform/contract.js";
import type { CommsOptions } from "../platform/windows/comms.js";
import {
  selectAdapter,
  type AdapterSelection,
  type SelectOptions,
} from "../platform/select.js";
import type { RunArtifacts } from "../runner/artifacts.js";
import { recoverRun, type RecoverResult } from "../runner/recover-run.js";
import { readRunReport, type RunReportRead } from "../runner/report-read.js";
import { runTest, type TestRunResult } from "../runner/test-run.js";
import {
  parseArgs,
  type DoctorOptions,
  type RecoverOptions,
  type ReportOptions,
  type SetupOptions,
  type TestOptions,
} from "./args.js";
import {
  buildEnvelope,
  type CliEnvelope,
  type NextAction,
  type PlatformInfo,
  type SetupStepReport,
  type TargetInfo,
} from "./envelope.js";
import { runAgentCommand } from "./agent.js";
import { runExtensionCommand } from "./extension.js";
import { EXIT, type ExitCode } from "./exit-code.js";
import {
  helpFor,
  renderEnvelope,
  renderRunJunit,
  renderRunReport,
  renderUsageError,
} from "./render.js";

export type CliDependencies = {
  /** Test seam: replaces platform selection. */
  readonly select?: (options: SelectOptions) => AdapterSelection;
  /** Test seam: fixes the clock in the envelope. */
  readonly now?: () => Date;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: where run locks, quarantine records and run directories live. */
  readonly stateRoot?: string;
};

type RequiredDependencies = {
  readonly select: (options: SelectOptions) => AdapterSelection;
  readonly now: () => Date;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly stateRoot: string;
};

const UNKNOWN_PLATFORM: PlatformInfo = {
  os: "unknown",
  release: null,
  arch: null,
  backend: "none",
};

/** `report` reads a stored run: no backend is chosen and none is implied. */
function localPlatform(): PlatformInfo {
  return { os: osPlatform(), release: osRelease(), arch: osArch(), backend: "none" };
}

const LOCAL_TARGET: TargetSpec = {
  name: "local",
  isolation: "session",
  user: null,
  host: null,
};

function dependencies(input: CliDependencies): RequiredDependencies {
  return {
    select: input.select ?? selectAdapter,
    now: input.now ?? (() => new Date()),
    writeOut:
      input.writeOut ??
      ((text) => {
        process.stdout.write(text);
      }),
    writeErr:
      input.writeErr ??
      ((text) => {
        process.stderr.write(text);
      }),
    env: input.env ?? process.env,
    stateRoot: input.stateRoot ?? join(homedir(), ".ae-a8n"),
  };
}

/** Everything a named host needs to be reached; null when no host was named. */
function remoteFrom(options: {
  readonly user: string | null;
  readonly host: string | null;
  readonly channel: string | null;
  readonly keyFile: string | null;
  readonly agentId: string | null;
  readonly hostConfig: string | null;
}): CommsOptions | null {
  if (options.host === null) {
    return null;
  }
  return {
    host: options.host,
    user: options.user,
    channel: options.channel,
    keyFile: options.keyFile,
    agentId: options.agentId,
    ...(options.hostConfig === null ? {} : { configPath: options.hostConfig }),
  };
}

function targetFrom(options: {
  readonly target: string | null;
  readonly user: string | null;
  readonly host: string | null;
}): TargetSpec {
  const host = options.host;
  return {
    name: options.target ?? host ?? "local",
    isolation: host === null ? "session" : "remote-host",
    user: options.user,
    host,
  };
}

function targetInfo(target: TargetSpec): TargetInfo {
  return { name: target.name, isolation: target.isolation };
}

function attemptedCommand(argv: readonly string[]): string {
  const first = argv[0];
  return first !== undefined && !first.startsWith("-") ? first : "unknown";
}

function emit(
  envelope: CliEnvelope,
  json: boolean,
  deps: RequiredDependencies,
  verbose = false,
): void {
  if (json) {
    // Exactly one JSON document on stdout; no human text is mixed in.
    deps.writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  deps.writeOut(`${renderEnvelope(envelope, { verbose })}\n`);
}

function factsOf(probe: AdapterProbe): unknown {
  return (probe as AdapterProbe & { readonly facts?: unknown }).facts;
}

function factString(facts: unknown, key: string): string | null {
  if (typeof facts !== "object" || facts === null) {
    return null;
  }
  const value = (facts as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function platformFromProbe(
  adapter: PlatformAdapter,
  facts: unknown,
  remote: boolean,
): PlatformInfo {
  return {
    os: adapter.platform,
    release:
      factString(facts, "release") ?? factString(facts, "osVersion") ??
      (remote ? null : osRelease()),
    arch: factString(facts, "arch") ?? (remote ? null : osArch()),
    backend: adapter.id,
  };
}

function platformFromSelection(
  selection: AdapterSelection,
  target: TargetSpec,
): PlatformInfo {
  if (selection.ok) {
    return platformFromProbe(selection.adapter, null, target.host !== null);
  }
  return {
    os: selection.platform,
    release: target.host === null ? osRelease() : null,
    arch: target.host === null ? osArch() : null,
    backend: "unsupported",
  };
}

function usageFailure(
  argv: readonly string[],
  error: string,
  json: boolean,
  startedAt: Date,
  deps: RequiredDependencies,
): ExitCode {
  if (json) {
    const envelope = buildEnvelope({
      command: attemptedCommand(argv),
      status: "failed",
      exitCode: EXIT.usage,
      startedAt,
      finishedAt: deps.now(),
      platform: UNKNOWN_PLATFORM,
      target: targetInfo(LOCAL_TARGET),
      checks: [],
      notice: error,
      env: deps.env,
    });
    deps.writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
  }
  deps.writeErr(`${renderUsageError(error)}\n`);
  return EXIT.usage;
}

function setupStepReports(
  planned: Awaited<ReturnType<PlatformAdapter["plan"]>>,
  outcomes: Awaited<ReturnType<PlatformAdapter["apply"]>>["outcomes"],
  dryRun: boolean,
): readonly SetupStepReport[] {
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const reports: SetupStepReport[] = planned.map((step) => {
    const outcome = byId.get(step.id);
    return {
      id: step.id,
      // An adapter that reports nothing for a planned step has not shown the
      // step was done; that is a failure, never a silent pass.
      state: outcome?.state ?? (dryRun ? "planned" : "failed"),
      reason: step.reason,
      action: step.action,
      automatable: step.automatable,
      detail: outcome?.detail ?? "the adapter reported no outcome for this step",
    };
  });
  // An outcome the plan does not describe (for example "the state file is
  // unreadable") still has to reach the user; dropping it would hide a refusal.
  for (const outcome of outcomes) {
    if (planned.some((step) => step.id === outcome.id)) {
      continue;
    }
    reports.push({
      id: outcome.id,
      state: outcome.state,
      reason: outcome.detail,
      action: null,
      automatable: false,
      detail: outcome.detail,
    });
  }
  return reports;
}

async function setup(
  options: SetupOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): Promise<ExitCode> {
  const target = targetFrom(options);
  let selection: AdapterSelection;
  try {
    selection = deps.select({ target, remote: remoteFrom(options) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = buildEnvelope({
      command: "setup",
      status: "failed",
      exitCode: EXIT.failed,
      startedAt,
      finishedAt: deps.now(),
      platform: UNKNOWN_PLATFORM,
      target: targetInfo(target),
      checks: [],
      notice:
        `setup could not select a platform backend: ${message}. ` +
        "Nothing was changed and no step is being reported as done.",
      env: deps.env,
    });
    emit(envelope, options.json, deps);
    return EXIT.failed;
  }

  if (!selection.ok) {
    const envelope = buildEnvelope({
      command: "setup",
      status: "blocked",
      exitCode: EXIT.blocked,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromSelection(selection, target),
      target: targetInfo(target),
      checks: [selection.check],
      env: deps.env,
    });
    emit(envelope, options.json, deps);
    return EXIT.blocked;
  }

  try {
    const planned = await selection.adapter.plan(target);
    const applied = await selection.adapter.apply(planned, {
      yes: options.yes,
      dryRun: options.dryRun,
    });
    const steps = setupStepReports(planned, applied.outcomes, options.dryRun);
    const incomplete = steps.some(
      (step) => step.state === "needs-human" || step.state === "failed",
    );
    const exitCode = incomplete ? EXIT.setupIncomplete : EXIT.ok;
    const envelope = buildEnvelope({
      command: "setup",
      status: incomplete ? "setup-incomplete" : "ok",
      exitCode,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromProbe(selection.adapter, null, target.host !== null),
      target: targetInfo(target),
      checks: [],
      steps,
      stateFile: applied.stateFile,
      ...(options.dryRun
        ? { notice: "dry run: nothing was changed; the steps below are what setup would do." }
        : {}),
      env: deps.env,
    });
    emit(envelope, options.json, deps);
    return exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = buildEnvelope({
      command: "setup",
      status: "failed",
      exitCode: EXIT.failed,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromProbe(selection.adapter, null, target.host !== null),
      target: targetInfo(target),
      checks: [],
      notice:
        `setup could not finish: ${message}. No step is being reported as done.`,
      env: deps.env,
    });
    emit(envelope, options.json, deps);
    return EXIT.failed;
  }
}

async function doctor(
  options: DoctorOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): Promise<ExitCode> {
  const target = targetFrom(options);
  let selection: AdapterSelection;
  try {
    selection = deps.select({ target, remote: remoteFrom(options) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = buildEnvelope({
      command: "doctor",
      status: "unknown",
      exitCode: EXIT.unknown,
      startedAt,
      finishedAt: deps.now(),
      platform: UNKNOWN_PLATFORM,
      target: targetInfo(target),
      checks: [],
      notice:
        `doctor could not select a platform backend: ${message}. ` +
        "No result is being reported as success.",
      env: deps.env,
    });
    emit(envelope, options.json, deps, options.verbose);
    return EXIT.unknown;
  }

  if (!selection.ok) {
    const envelope = buildEnvelope({
      command: "doctor",
      status: "blocked",
      exitCode: EXIT.blocked,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromSelection(selection, target),
      target: targetInfo(target),
      checks: [selection.check],
      env: deps.env,
    });
    emit(envelope, options.json, deps, options.verbose);
    return EXIT.blocked;
  }

  try {
    const result = await runDoctor(selection.adapter, target);
    const exitCode = result.status === "blocked" ? EXIT.blocked : EXIT.ok;
    const facts = factsOf(result.probe);
    const envelope = buildEnvelope({
      command: "doctor",
      status: result.status,
      exitCode,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromProbe(selection.adapter, facts, target.host !== null),
      target: targetInfo(target),
      checks: result.checks,
      facts,
      capabilities: result.probe.capabilities,
      env: deps.env,
    });
    emit(envelope, options.json, deps, options.verbose);
    return exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const envelope = buildEnvelope({
      command: "doctor",
      status: "unknown",
      exitCode: EXIT.unknown,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromProbe(selection.adapter, null, target.host !== null),
      target: targetInfo(target),
      checks: [],
      notice:
        `doctor could not finish: ${message}. No result is being reported as success.`,
      env: deps.env,
    });
    emit(envelope, options.json, deps, options.verbose);
    return EXIT.unknown;
  }
}

const DEFAULT_TEST_TIMEOUT_MS = 30 * 60 * 1000;

const TEST_EXIT: Readonly<Record<TestRunResult["status"], ExitCode>> = {
  ok: EXIT.ok,
  "test-failed": EXIT.testFailed,
  unknown: EXIT.unknown,
  blocked: EXIT.blocked,
  refused: EXIT.refused,
};

/** A one-line-per-fact summary for stderr; never mixed into the JSON stream. */
function testSummary(result: TestRunResult, exitCode: ExitCode): string {
  const lines = [`ae-a8n: run ${result.runId} — ${result.status} (exit ${exitCode})`];
  for (const verdict of result.verdicts) {
    lines.push(`ae-a8n:   [${verdict.verdict}] ${verdict.id}: ${verdict.message}`);
  }
  if (result.artifacts !== null) {
    lines.push(`ae-a8n: report: ${result.artifacts.report}`);
  } else {
    lines.push("ae-a8n: the run directory was not kept");
  }
  if (result.notice !== undefined) {
    lines.push(`ae-a8n: ${result.notice}`);
  }
  return `${lines.join("\n")}\n`;
}

async function test(
  options: TestOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): Promise<ExitCode> {
  const target = targetFrom(options);
  let selection: AdapterSelection;
  try {
    selection = deps.select({ target, remote: remoteFrom(options) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(
      buildEnvelope({
        command: "test",
        status: "unknown",
        exitCode: EXIT.unknown,
        startedAt,
        finishedAt: deps.now(),
        platform: UNKNOWN_PLATFORM,
        target: targetInfo(target),
        checks: [],
        notice:
          `test could not select a platform backend: ${message}. ` +
          "Nothing was run and no outcome is being reported as success.",
        env: deps.env,
      }),
      options.json,
      deps,
    );
    return EXIT.unknown;
  }

  if (!selection.ok) {
    emit(
      buildEnvelope({
        command: "test",
        status: "blocked",
        exitCode: EXIT.blocked,
        startedAt,
        finishedAt: deps.now(),
        platform: platformFromSelection(selection, target),
        target: targetInfo(target),
        checks: [selection.check],
        env: deps.env,
      }),
      options.json,
      deps,
    );
    return EXIT.blocked;
  }

  let result: TestRunResult;
  try {
    result = await runTest({
      adapter: selection.adapter,
      target,
      argv: options.command,
      timeoutMs: options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
      keepOnSuccess: options.keep || options.json,
      stateRoot: deps.stateRoot,
      now: deps.now,
      commit: deps.env["A8N_COMMIT"] ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(
      buildEnvelope({
        command: "test",
        status: "failed",
        exitCode: EXIT.failed,
        startedAt,
        finishedAt: deps.now(),
        platform: platformFromProbe(selection.adapter, null, target.host !== null),
        target: targetInfo(target),
        checks: [],
        notice: `test could not run: ${message}. No outcome is being reported as success.`,
        env: deps.env,
      }),
      options.json,
      deps,
    );
    return EXIT.failed;
  }

  const exitCode = TEST_EXIT[result.status];
  const withIdentity: TargetInfo =
    result.identity === null
      ? targetInfo(target)
      : { ...targetInfo(target), identity: result.identity };
  emit(
    buildEnvelope({
      command: "test",
      status: result.status,
      exitCode,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromProbe(selection.adapter, null, target.host !== null),
      target: withIdentity,
      checks: result.checks,
      verdicts: result.verdicts,
      runId: result.runId,
      ...(result.artifacts === null ? {} : { artifacts: result.artifacts }),
      ...(result.notice === undefined ? {} : { notice: result.notice }),
      env: deps.env,
    }),
    options.json,
    deps,
  );
  deps.writeErr(testSummary(result, exitCode));
  return exitCode;
}

/** The findings' remedies, in order, as the envelope's `nextActions[]`. */
function recoveryActions(result: RecoverResult): NextAction[] {
  const actions: NextAction[] = [];
  for (const finding of result.findings) {
    if (finding.remedy === undefined || finding.remedy.length === 0) {
      continue;
    }
    actions.push({ kind: "human", code: finding.code, action: finding.remedy });
  }
  return actions;
}

async function recover(
  options: RecoverOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): Promise<ExitCode> {
  const target = targetFrom(options);
  let selection: AdapterSelection;
  try {
    selection = deps.select({ target, remote: remoteFrom(options) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(
      buildEnvelope({
        command: "recover",
        status: "unknown",
        exitCode: EXIT.unknown,
        startedAt,
        finishedAt: deps.now(),
        platform: UNKNOWN_PLATFORM,
        target: targetInfo(target),
        checks: [],
        notice:
          `recover could not select a platform backend: ${message}. ` +
          "Nothing was inspected or changed.",
        env: deps.env,
      }),
      options.json,
      deps,
    );
    return EXIT.unknown;
  }

  let result: RecoverResult;
  try {
    result = await recoverRun({
      adapter: selection.ok ? selection.adapter : null,
      target,
      runId: options.runId,
      dryRun: options.dryRun,
      force: options.force,
      stateRoot: deps.stateRoot,
      now: deps.now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(
      buildEnvelope({
        command: "recover",
        status: "failed",
        exitCode: EXIT.failed,
        startedAt,
        finishedAt: deps.now(),
        platform: platformFromSelection(selection, target),
        target: targetInfo(target),
        checks: [],
        notice: `recover could not inspect the run state: ${message}. Nothing was changed.`,
        env: deps.env,
      }),
      options.json,
      deps,
    );
    return EXIT.failed;
  }

  const exitCode = result.status === "ok" ? EXIT.ok : EXIT.unknown;
  emit(
    buildEnvelope({
      command: "recover",
      status: result.status,
      exitCode,
      startedAt,
      finishedAt: deps.now(),
      platform: platformFromSelection(selection, target),
      target: targetInfo(target),
      checks: selection.ok ? [] : [selection.check],
      findings: result.findings,
      cleared: result.cleared,
      nextActions: recoveryActions(result),
      ...(result.runId === null ? {} : { runId: result.runId }),
      ...(result.notice === undefined ? {} : { notice: result.notice }),
      env: deps.env,
    }),
    options.json,
    deps,
  );
  return exitCode;
}

/** What `report` found on disk, for the envelope's `artifacts`. */
function artifactsOf(read: Extract<RunReportRead, { readonly ok: true }>): RunArtifacts {
  const files: string[] = [];
  for (const captured of [read.manifest?.stdout, read.manifest?.stderr]) {
    if (typeof captured === "string" && captured.length > 0) {
      files.push(captured);
    }
  }
  return {
    manifest: join(read.directory, "manifest.json"),
    report: join(read.directory, "report.json"),
    trace: join(read.directory, "trace.jsonl"),
    files,
  };
}

function reportFailure(
  read: Extract<RunReportRead, { readonly ok: false }>,
  options: ReportOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): ExitCode {
  if (options.json) {
    emit(
      buildEnvelope({
        command: "report",
        status: "failed",
        exitCode: EXIT.failed,
        startedAt,
        finishedAt: deps.now(),
        platform: localPlatform(),
        target: targetInfo(LOCAL_TARGET),
        checks: [],
        notice: `${read.reason}. Nothing is being reported as a success.`,
        ...(read.runId === null ? {} : { runId: read.runId }),
        env: deps.env,
      }),
      true,
      deps,
    );
  } else {
    // A `--format` reader (CI) must not get an envelope where a report or a
    // JUnit document was asked for: the failure goes to stderr and stdout stays
    // empty, so a pipeline sees the exit code, not a plausible-looking file.
    deps.writeErr(`ae-a8n: report: ${read.reason}\n`);
  }
  return EXIT.failed;
}

function report(
  options: ReportOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): ExitCode {
  let read: RunReportRead;
  try {
    read = readRunReport({ stateRoot: deps.stateRoot, runId: options.runId });
  } catch (error) {
    read = {
      ok: false,
      runId: options.runId,
      directory: null,
      reason: `the run state could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!read.ok) {
    return reportFailure(read, options, startedAt, deps);
  }

  if (options.json) {
    emit(
      buildEnvelope({
        command: "report",
        status: "ok",
        exitCode: EXIT.ok,
        startedAt,
        finishedAt: deps.now(),
        platform: localPlatform(),
        target: targetInfo(LOCAL_TARGET),
        checks: [],
        runId: read.runId,
        artifacts: artifactsOf(read),
        verdicts: read.report.verdicts,
        report: read.report,
        env: deps.env,
      }),
      true,
      deps,
    );
    return EXIT.ok;
  }

  if (options.format === "json") {
    // The stored document, byte for byte: this is what a script that already
    // understands report.json wants, not a re-serialisation of it.
    deps.writeOut(read.text.endsWith("\n") ? read.text : `${read.text}\n`);
    return EXIT.ok;
  }
  if (options.format === "junit") {
    deps.writeOut(`${renderRunJunit(read)}\n`);
    return EXIT.ok;
  }
  deps.writeOut(`${renderRunReport(read)}\n`);
  return EXIT.ok;
}

export async function runCli(
  argv: readonly string[],
  input: CliDependencies = {},
): Promise<ExitCode> {
  // `agent` is not one of the five contract commands: it runs the in-session
  // agent on a Windows host and takes its own flags. It is dispatched before
  // the contract parser, which would otherwise reject every one of them.
  if (argv[0] === "agent") {
    const result = await runAgentCommand(argv.slice(1));
    return result.exitCode as ExitCode;
  }

  if (argv[0] === "extension") {
    const result = await runExtensionCommand(argv.slice(1));
    return result.exitCode as ExitCode;
  }
  const deps = dependencies(input);
  const startedAt = deps.now();
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    return usageFailure(argv, parsed.error, parsed.json, startedAt, deps);
  }

  if (parsed.kind === "help") {
    deps.writeOut(`${helpFor(parsed.command)}\n`);
    return EXIT.ok;
  }

  if (parsed.kind === "version") {
    deps.writeOut(`ae-a8n ${A8N_VERSION}\n`);
    return EXIT.ok;
  }

  if (parsed.options.help) {
    deps.writeOut(`${helpFor(parsed.command)}\n`);
    return EXIT.ok;
  }

  if (parsed.command === "test") {
    return test(parsed.options as TestOptions, startedAt, deps);
  }

  if (parsed.command === "recover") {
    return recover(parsed.options as RecoverOptions, startedAt, deps);
  }

  if (parsed.command === "report") {
    return report(parsed.options as ReportOptions, startedAt, deps);
  }

  if (parsed.command === "setup") {
    return setup(parsed.options as SetupOptions, startedAt, deps);
  }

  return doctor(parsed.options as DoctorOptions, startedAt, deps);
}
