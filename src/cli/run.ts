/**
 * `ae-a8n` command dispatch.
 *
 * `doctor` (issue #55) and `test` (issue #58) are implemented in this
 * increment. The remaining commands parse their contract flags, then fail
 * closed with a notice and a documented exit code. None of them reports
 * success for work it did not do.
 *
 * The platform choice is delegated to `select.ts`; nothing here branches on
 * the host OS.
 */

import { homedir, arch as osArch, release as osRelease } from "node:os";
import { join } from "node:path";

import { A8N_VERSION } from "../index.js";
import { runDoctor } from "../doctor/index.js";
import type { AdapterProbe, PlatformAdapter, TargetSpec } from "../platform/contract.js";
import {
  selectAdapter,
  type AdapterSelection,
  type SelectOptions,
} from "../platform/select.js";
import { runTest, type TestRunResult } from "../runner/test-run.js";
import {
  parseArgs,
  type CommandName,
  type CommandOptions,
  type DoctorOptions,
  type TestOptions,
} from "./args.js";
import {
  buildEnvelope,
  type CliEnvelope,
  type EnvelopeStatus,
  type PlatformInfo,
  type TargetInfo,
} from "./envelope.js";
import { EXIT, type ExitCode } from "./exit-code.js";
import { helpFor, renderEnvelope, renderUsageError } from "./render.js";

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

function unimplemented(
  command: Exclude<CommandName, "doctor" | "test">,
  options: CommandOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): ExitCode {
  const status: EnvelopeStatus = command === "setup" ? "setup-incomplete" : "blocked";
  const exitCode: ExitCode = command === "setup" ? EXIT.setupIncomplete : EXIT.blocked;
  const target =
    command === "report" ? { ...LOCAL_TARGET, name: "local" } : targetFrom(options as {
      readonly target: string | null;
      readonly user: string | null;
      readonly host: string | null;
    });
  let selection: AdapterSelection;
  try {
    selection = deps.select({ target });
  } catch {
    selection = { ok: false, platform: "unknown", check: {
      code: "A8N-ENV-001",
      severity: "blocker",
      title: "Unsupported OS or architecture",
      detail: "the platform could not be selected",
      remedy: "Run ae-a8n on a supported platform.",
      remedyKind: "human",
      evidence: {},
    } };
  }
  const notice =
    `${command} is not implemented in this increment (issue #55); ` +
    "nothing was run or changed.";
  const envelope = buildEnvelope({
    command,
    status,
    exitCode,
    startedAt,
    finishedAt: deps.now(),
    platform: platformFromSelection(selection, target),
    target: targetInfo(target),
    checks: [],
    notice,
    env: deps.env,
  });
  emit(envelope, options.json, deps);
  return exitCode;
}

async function doctor(
  options: DoctorOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): Promise<ExitCode> {
  const target = targetFrom(options);
  let selection: AdapterSelection;
  try {
    selection = deps.select({ target });
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
    selection = deps.select({ target });
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

export async function runCli(
  argv: readonly string[],
  input: CliDependencies = {},
): Promise<ExitCode> {
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

  if (parsed.command !== "doctor") {
    return unimplemented(parsed.command, parsed.options, startedAt, deps);
  }

  return doctor(parsed.options as DoctorOptions, startedAt, deps);
}
