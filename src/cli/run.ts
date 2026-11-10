/**
 * `ae-a8n` command dispatch.
 *
 * Only `doctor` is implemented in this increment (issue #55). The other four
 * commands parse their contract flags, then fail closed with a notice and a
 * documented exit code. None of them reports success for work it did not do.
 *
 * The platform choice is delegated to `select.ts`; nothing here branches on
 * the host OS.
 */

import { arch as osArch, release as osRelease } from "node:os";

import { A8N_VERSION } from "../index.js";
import { runDoctor } from "../doctor/index.js";
import type { AdapterProbe, PlatformAdapter, TargetSpec } from "../platform/contract.js";
import {
  selectAdapter,
  type AdapterSelection,
  type SelectOptions,
} from "../platform/select.js";
import {
  parseArgs,
  type CommandName,
  type CommandOptions,
  type DoctorOptions,
  type SetupOptions,
} from "./args.js";
import {
  buildEnvelope,
  type CliEnvelope,
  type EnvelopeStatus,
  type PlatformInfo,
  type SetupStepReport,
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
};

type RequiredDependencies = {
  readonly select: (options: SelectOptions) => AdapterSelection;
  readonly now: () => Date;
  readonly writeOut: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
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
  command: Exclude<CommandName, "doctor" | "setup">,
  options: CommandOptions,
  startedAt: Date,
  deps: RequiredDependencies,
): ExitCode {
  const status: EnvelopeStatus = "blocked";
  const exitCode: ExitCode = EXIT.blocked;
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
    selection = deps.select({ target });
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

  if (parsed.command === "setup") {
    return setup(parsed.options as SetupOptions, startedAt, deps);
  }

  if (parsed.command !== "doctor") {
    return unimplemented(parsed.command, parsed.options, startedAt, deps);
  }

  return doctor(parsed.options as DoctorOptions, startedAt, deps);
}
