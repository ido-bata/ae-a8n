/**
 * The Windows isolated runner.
 *
 * One `run` acquires the per-run lock, submits exactly one job through the
 * file channel, and maps the result to a command outcome or a typed error. A
 * refusal and a timeout are different errors, and neither is retried. The run
 * manifest records the identities, versions and hashes the decision rests on.
 *
 * Recovery, destination proof and process ownership are deliberately absent:
 * they are T089/T090. `recover` says so instead of returning an empty list.
 */

import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DiagnosticCheck } from "../../doctor/diagnostics.js";
import {
  assertProvenIdentity,
  type AdapterProbe,
  type Capabilities,
  type CommandOutcome,
  type IsolatedSession,
  type PlatformAdapter,
  type RecoveryFinding,
  type RunOptions,
  type SessionIdentity,
  type SetupResult,
  type SetupStep,
  type StepOutcome,
  type TargetSpec,
} from "../contract.js";
import type { FileChannel } from "./channel.js";
import {
  acquireRunLock,
  releaseRunLock,
  type RunOwner,
} from "./lock.js";
import {
  writeRunManifest,
  type RunManifest,
} from "./manifest.js";
import { encodeJobPayload } from "./executor.js";
import {
  jobPaths,
  newJobId,
  sha256Hex,
  type AgentIdentity,
} from "./job.js";
import {
  probeWindows,
  type CommandRunner,
  type WindowsFacts,
} from "./probe.js";
import { submitJob, type SubmitOptions, type SubmitResult } from "./remote.js";

export const SETUP_STATE_PATH = "setup/state.json";

/** The capabilities this backend can honestly claim today. */
export function windowsCapabilities(isolation: TargetSpec["isolation"]): Capabilities {
  return {
    nonInterference: isolation === "remote-host" ? "by-construction" : "unproven",
    // T089/T090 own these proofs; claiming them now would be a lie.
    provesOwnership: false,
    provesDestination: false,
    guiRecovery: false,
    sessionIdentity: "host-and-user",
  };
}

export class WindowsJobRefusedError extends Error {
  readonly code: string;
  readonly jobId: string;

  constructor(code: string, message: string, jobId: string) {
    super(message);
    this.name = "WindowsJobRefusedError";
    this.code = code;
    this.jobId = jobId;
  }
}

/** A timed-out job is never re-sent: it may still be running. */
export class WindowsJobUnknownError extends Error {
  readonly code = "A8N-AE-004" as const;
  readonly jobId: string;

  constructor(message: string, jobId: string) {
    super(message);
    this.name = "WindowsJobUnknownError";
    this.code = "A8N-AE-004";
    this.jobId = jobId;
  }
}

/** A lock this run may not take; stale locks are reported, never reused. */
export class WindowsRunLockError extends Error {
  readonly code = "A8N-JOB-002" as const;
  readonly state: "busy" | "stale";
  readonly runId: string;

  constructor(state: "busy" | "stale", runId: string) {
    super(
      state === "busy"
        ? `run lock ${runId} is held by another run; nothing was sent`
        : `run lock ${runId} is stale and was left in place; nothing was sent`,
    );
    this.name = "WindowsRunLockError";
    this.code = "A8N-JOB-002";
    this.state = state;
    this.runId = runId;
  }
}

export class WindowsSessionNotOpenError extends Error {
  constructor() {
    super("the Windows session is not open; call open() first");
    this.name = "WindowsSessionNotOpenError";
  }
}

export type PreparedIdentity = {
  readonly identity: SessionIdentity;
  readonly facts: WindowsFacts;
  readonly checks: readonly DiagnosticCheck[];
};

export interface WindowsSessionBackend {
  prepare(): Promise<PreparedIdentity>;
  run(
    identity: SessionIdentity,
    argv: readonly string[],
    options: RunOptions,
    onRunId: (runId: string | null) => void,
  ): Promise<CommandOutcome>;
  release(runId: string): Promise<void>;
}

export type SubmitFunction = (
  channel: FileChannel,
  options: SubmitOptions,
) => Promise<SubmitResult>;

export type WindowsAdapterOptions = {
  readonly channel: FileChannel;
  /** The controller-side host name recorded in jobs and manifests. */
  readonly host: string;
  /** The controller-side user name recorded in jobs and manifests. */
  readonly user: string;
  readonly agent: AgentIdentity;
  /** The read-only probe commands. */
  readonly probe: CommandRunner;
  /** Where local stdout/stderr copies are written; `tmpdir()` by default. */
  readonly runDirectory?: string;
  readonly staleAfterMs?: number;
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
  readonly submit?: SubmitFunction;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The agent entry to check in `windows.agent`; null means "not configured". */
  readonly agentEntry?: string;
  readonly exists?: (path: string) => Promise<boolean>;
};

function defaultExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function exitCodeFromMessage(status: "ok" | "failed", message: string): number {
  const match = /exited with code (-?\d+)/u.exec(message);
  if (match?.[1] !== undefined) {
    return Number(match[1]);
  }
  return status === "ok" ? 0 : 1;
}

/**
 * The one version the probe proved. Two versions or an unreadable one is
 * null, not "the newest" — that would be a guess.
 */
export function aeVersionFromFacts(facts: WindowsFacts): string | null {
  const versions = new Set<string>();
  for (const install of facts.aeInstalls) {
    if (install.version !== null) {
      versions.add(install.version);
    }
  }
  return versions.size === 1 ? ([...versions][0] ?? null) : null;
}

export class WindowsSession implements IsolatedSession {
  readonly #target: TargetSpec;
  readonly #backend: WindowsSessionBackend;
  #identity: SessionIdentity;
  #opened = false;
  #closed = false;
  #runId: string | null = null;

  constructor(
    target: TargetSpec,
    identity: SessionIdentity,
    backend: WindowsSessionBackend,
  ) {
    this.#target = target;
    this.#identity = identity;
    this.#backend = backend;
  }

  get identity(): SessionIdentity {
    return this.#identity;
  }

  /** Re-probes before the session is considered open, so `proven` is current. */
  async open(): Promise<void> {
    if (this.#closed) {
      throw new Error(`session ${this.#target.name} was closed and cannot be reopened`);
    }
    const prepared = await this.#backend.prepare();
    this.#identity = prepared.identity;
    this.#opened = true;
  }

  async run(argv: readonly string[], options: RunOptions): Promise<CommandOutcome> {
    if (!this.#opened || this.#closed) {
      throw new WindowsSessionNotOpenError();
    }
    // Before the lock, before the payload, before anything is written.
    assertProvenIdentity(this.#identity);
    return this.#backend.run(this.#identity, argv, options, (runId) => {
      this.#runId = runId;
    });
  }

  async close(): Promise<{ readonly closed: boolean; readonly reason: string | null }> {
    if (this.#runId !== null) {
      await this.#backend.release(this.#runId);
      this.#runId = null;
    }
    this.#opened = false;
    this.#closed = true;
    // Ownership is T090: this closes the run, not After Effects.
    return { closed: true, reason: null };
  }
}

export class WindowsAdapter implements PlatformAdapter {
  readonly platform = "win32" as const;
  readonly id = "windows-remote-host";

  readonly #channel: FileChannel;
  readonly #host: string;
  readonly #user: string;
  readonly #agent: AgentIdentity;
  readonly #probeRunner: CommandRunner;
  readonly #runDirectory: string;
  readonly #staleAfterMs: number | undefined;
  readonly #now: () => Date;
  readonly #random: (size: number) => Uint8Array;
  readonly #submit: SubmitFunction;
  readonly #pollMs: number | undefined;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;
  readonly #agentEntry: string | null;
  readonly #exists: (path: string) => Promise<boolean>;

  #isolation: TargetSpec["isolation"] = "remote-host";
  #facts: WindowsFacts | null = null;

  constructor(options: WindowsAdapterOptions) {
    this.#channel = options.channel;
    this.#host = options.host;
    this.#user = options.user;
    this.#agent = options.agent;
    this.#probeRunner = options.probe;
    this.#runDirectory = options.runDirectory ?? join(tmpdir(), "ae-a8n-runs");
    this.#staleAfterMs = options.staleAfterMs;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? randomBytes;
    this.#submit = options.submit ?? submitJob;
    this.#pollMs = options.pollMs;
    this.#sleep = options.sleep;
    this.#agentEntry = options.agentEntry ?? null;
    this.#exists = options.exists ?? defaultExists;
  }

  capabilities(): Promise<Capabilities> {
    return Promise.resolve(windowsCapabilities(this.#isolation));
  }

  async probe(target: TargetSpec): Promise<AdapterProbe> {
    const prepared = await this.#prepare(target);
    return {
      checks: prepared.checks,
      capabilities: windowsCapabilities(target.isolation),
    };
  }

  async plan(target: TargetSpec): Promise<readonly SetupStep[]> {
    const prepared = await this.#prepare(target);
    const steps: SetupStep[] = [];

    let channelExists = false;
    try {
      channelExists = await this.#channel.isDirectory("");
    } catch {
      channelExists = false;
    }
    let channelReadable = false;
    if (channelExists) {
      try {
        await this.#channel.list("");
        channelReadable = true;
      } catch {
        channelReadable = false;
      }
    }
    steps.push({
      id: "windows.channel",
      state: channelReadable ? "done" : "planned",
      reason: channelReadable
        ? "the channel root exists and is readable"
        : channelExists
          ? "the channel root exists but could not be read"
          : "the channel root does not exist",
      action: channelReadable
        ? null
        : "Make the channel root readable and writable by the controller and the agent account.",
      automatable: !channelReadable,
    });

    let agentExists = false;
    if (this.#agentEntry !== null) {
      agentExists = await this.#exists(this.#agentEntry).catch(() => false);
    }
    steps.push({
      id: "windows.agent",
      state: agentExists ? "done" : "planned",
      reason: agentExists
        ? `the agent entry ${this.#agentEntry} exists`
        : this.#agentEntry === null
          ? "no agent entry is configured"
          : `the agent entry ${this.#agentEntry} does not exist`,
      action: agentExists
        ? null
        : "Install @ido-bata/ae-a8n on the target and point setup at its scripts/windows-agent.mjs.",
      automatable: false,
    });

    const version = aeVersionFromFacts(prepared.facts);
    if (prepared.facts.aeInstalls.length === 0) {
      steps.push({
        id: "windows.ae",
        state: "needs-human",
        reason: "no After Effects installation was found for the target account",
        action: "Install After Effects 2026 for the target account and sign in once.",
        automatable: false,
      });
    } else if (version === null) {
      steps.push({
        id: "windows.ae",
        state: "needs-human",
        reason:
          "After Effects is installed, but more than one version is registered; the exact version cannot be proved",
        action: "Remove or disambiguate the extra After Effects installations, then run setup again.",
        automatable: false,
      });
    } else {
      steps.push({
        id: "windows.ae",
        state: "done",
        reason: `After Effects ${version} is installed`,
        action: null,
        automatable: false,
      });
    }

    steps.push({
      id: "windows.signin",
      state: "needs-human",
      reason: "Adobe sign-in is never automated and setup never reads or writes a credential",
      action: "Sign in to Adobe in the dedicated user's interactive session.",
      automatable: false,
    });

    return steps;
  }

  async apply(
    steps: readonly SetupStep[],
    options: { readonly yes: boolean; readonly dryRun: boolean },
  ): Promise<SetupResult> {
    const completed = await this.#readCompletedSteps();
    const outcomes: StepOutcome[] = [];
    let changed = false;

    for (const step of steps) {
      if (options.dryRun) {
        outcomes.push({
          id: step.id,
          state: step.state === "planned" ? "planned" : step.state,
          detail: "dry run: nothing was changed",
        });
        continue;
      }
      if (step.state === "needs-human" || step.state === "failed") {
        outcomes.push({ id: step.id, state: step.state, detail: step.reason });
        continue;
      }
      if (completed.has(step.id)) {
        outcomes.push({
          id: step.id,
          state: "skipped",
          detail: "already applied in an earlier setup",
        });
        continue;
      }
      if (step.state === "done") {
        completed.add(step.id);
        changed = true;
        outcomes.push({ id: step.id, state: "done", detail: step.reason });
        continue;
      }
      // planned
      if (!step.automatable) {
        outcomes.push({
          id: step.id,
          state: "failed",
          detail: `${step.reason}; this step needs a human`,
        });
        continue;
      }
      try {
        await this.#applyChannelStep();
        completed.add(step.id);
        changed = true;
        outcomes.push({ id: step.id, state: "done", detail: "the channel root is writable" });
      } catch (error) {
        outcomes.push({
          id: step.id,
          state: "failed",
          detail: `the channel root could not be used: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    if (changed) {
      await this.#writeCompletedSteps(completed);
    }
    return { stateFile: SETUP_STATE_PATH, outcomes };
  }

  async open(target: TargetSpec): Promise<IsolatedSession> {
    const prepared = await this.#prepare(target);
    const backend: WindowsSessionBackend = {
      prepare: () => this.#prepare(target),
      run: (identity, argv, options, onRunId) =>
        this.#runInSession(target, identity, argv, options, onRunId),
      release: async (runId) => {
        await releaseRunLock(this.#channel, runId, this.#owner());
      },
    };
    return new WindowsSession(target, prepared.identity, backend);
  }

  recover(runDir: string): Promise<readonly RecoveryFinding[]> {
    return Promise.resolve([
      {
        code: "A8N-JOB-002",
        action: "reported",
        detail:
          `GUI recovery is not implemented on Windows (T089); nothing was acted on in ${runDir}. ` +
          "The run is left for a human to inspect.",
      },
    ]);
  }

  #owner(): RunOwner {
    return { host: this.#host, user: this.#user };
  }

  async #prepare(target: TargetSpec): Promise<PreparedIdentity> {
    const result = await probeWindows(this.#probeRunner, {
      isolation: target.isolation,
      targetUser: target.user,
    });
    this.#isolation = target.isolation;
    this.#facts = result.facts;
    const proven = !result.checks.some((check) => check.severity === "blocker");
    const identity: SessionIdentity = {
      kind: "host-and-user",
      user: target.user ?? this.#user,
      detail: {
        host: target.host ?? this.#host,
        sessionId: result.facts.sessionId,
      },
      proven,
    };
    return { identity, facts: result.facts, checks: result.checks };
  }

  async #runInSession(
    target: TargetSpec,
    _identity: SessionIdentity,
    argv: readonly string[],
    options: RunOptions,
    onRunId: (runId: string | null) => void,
  ): Promise<CommandOutcome> {
    const now = this.#now();
    const runId = newJobId(now, this.#random(4));
    const owner = this.#owner();
    const lock = await acquireRunLock(this.#channel, {
      runId,
      owner,
      now: this.#now,
      ...(this.#staleAfterMs === undefined ? {} : { staleAfterMs: this.#staleAfterMs }),
    });
    if (lock.state !== "acquired") {
      // The session never owned this lock, so close() must not release it.
      throw new WindowsRunLockError(lock.state, runId);
    }
    onRunId(runId);

    const payload = encodeJobPayload({
      argv: [...argv],
      env: { ...options.env },
    });
    const startedAt = now.toISOString();
    const writer = owner;
    const submitOptions: SubmitOptions = {
      payload,
      timeoutMs: options.timeoutMs,
      writer,
      now: this.#now,
      random: this.#random,
      ...(this.#pollMs === undefined ? {} : { pollMs: this.#pollMs }),
      ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
    };

    const submitted = await this.#submit(this.#channel, submitOptions);
    const resultBytes = await this.#channel.read(jobPaths(submitted.jobId).result);
    const facts = this.#facts ?? (await this.#prepare(target)).facts;
    const manifest: RunManifest = {
      schemaVersion: "1.0",
      runId,
      host: this.#host,
      user: this.#user,
      sessionId: facts.sessionId ?? 0,
      agentId: this.#agent.id,
      agentVersion: this.#agent.version,
      aeVersion: aeVersionFromFacts(facts),
      jobId: submitted.jobId,
      payloadSha256: sha256Hex(payload),
      // No published result (a timeout) is bound to the empty byte string; the
      // outcome says why.
      resultSha256: sha256Hex(resultBytes ?? new Uint8Array()),
      outcome: submitted.status,
      startedAt,
      finishedAt: this.#now().toISOString(),
    };
    await writeRunManifest(this.#channel, runId, manifest);

    if (submitted.status === "refused") {
      await releaseRunLock(this.#channel, runId, owner);
      throw new WindowsJobRefusedError(submitted.code, submitted.message, submitted.jobId);
    }
    if (submitted.status === "unknown") {
      // Leave the lock: the job may still be executing. close() releases it
      // only after the caller has decided what to do.
      throw new WindowsJobUnknownError(submitted.message, submitted.jobId);
    }

    const artifacts = await this.#writeLocalArtifacts(submitted.jobId, runId);
    await releaseRunLock(this.#channel, runId, owner);
    return {
      exitCode: exitCodeFromMessage(submitted.status, submitted.result.message),
      stdoutPath: artifacts.stdoutPath,
      stderrPath: artifacts.stderrPath,
    };
  }

  async #writeLocalArtifacts(
    jobId: string,
    runId: string,
  ): Promise<{ readonly stdoutPath: string; readonly stderrPath: string }> {
    const directory = join(this.#runDirectory, runId);
    await mkdir(directory, { recursive: true });
    const resultDirectory = jobPaths(jobId).resultDirectory;
    const stdout = (await this.#channel.read(`${resultDirectory}/stdout.log`)) ?? new Uint8Array();
    const stderr = (await this.#channel.read(`${resultDirectory}/stderr.log`)) ?? new Uint8Array();
    const stdoutPath = join(directory, "stdout.log");
    const stderrPath = join(directory, "stderr.log");
    await writeFile(stdoutPath, stdout);
    await writeFile(stderrPath, stderr);
    return { stdoutPath, stderrPath };
  }

  async #applyChannelStep(): Promise<void> {
    const probe = "setup/.channel-probe";
    await this.#channel.createExclusive(probe, new Uint8Array());
    await this.#channel.remove(probe);
  }

  async #readCompletedSteps(): Promise<Set<string>> {
    const bytes = await this.#channel.read(SETUP_STATE_PATH);
    if (bytes === null) {
      return new Set();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
    } catch {
      return new Set();
    }
    if (typeof parsed !== "object" || parsed === null) {
      return new Set();
    }
    const completed = (parsed as { completed?: unknown }).completed;
    if (!Array.isArray(completed)) {
      return new Set();
    }
    return new Set(completed.filter((value): value is string => typeof value === "string"));
  }

  async #writeCompletedSteps(completed: ReadonlySet<string>): Promise<void> {
    // Step ids only: setup never has a credential to record.
    const state = {
      schemaVersion: "1.0",
      completed: [...completed].sort(),
    };
    await this.#channel.writeAtomic(
      SETUP_STATE_PATH,
      Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf-8"),
    );
  }
}
