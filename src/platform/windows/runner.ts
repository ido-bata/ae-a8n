/**
 * The Windows isolated runner.
 *
 * One `run` acquires the per-run lock, submits exactly one job through the
 * file channel, and maps the result to a command outcome or a typed error. A
 * refusal and a timeout are different errors, and neither is retried. The run
 * manifest records the identities, versions, hashes and destination proof the
 * decision rests on.
 *
 * Recovery (T089) reports observable blocking states and never presses
 * anything. Destination proof (T090) is the agent's per-run session marker:
 * the close path verifies it before it would quit anything, and a marker that
 * names another run means nothing is quit. Ownership is not measured by this
 * backend, so the manifest says `ownershipProof: "unproven"`.
 */

import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { diagnostic, type DiagnosticCheck } from "../../doctor/diagnostics.js";
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
import { windowsCapabilities } from "./capabilities.js";
import { DirectoryChannel, type FileChannel } from "./channel.js";
import {
  ChannelCommandRunner,
  openComms,
  resolveComms,
  type CommsOptions,
  type CommsState,
} from "./comms.js";
import type { JobKey } from "./auth.js";
import {
  acquireRunLock,
  releaseRunLock,
  type RunOwner,
} from "./lock.js";
import {
  RUN_MANIFEST_SCHEMA_VERSION,
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
  proveRunDestination,
  type DestinationVerdict,
} from "./session-marker.js";
import {
  probeWindows,
  type CommandResult,
  type CommandRunner,
  type WindowsFacts,
} from "./probe.js";
import {
  assessWindowsRecovery,
  interpretWindowsRecoveryResult,
  WINDOWS_RECOVERY_COMMAND,
} from "./recovery.js";
import { submitJob, type SubmitOptions, type SubmitResult } from "./remote.js";

export const SETUP_STATE_PATH = "setup/state.json";

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

/** The agent could not be shown alive at the moment a job was about to be sent. */
export class WindowsAgentUnavailableError extends Error {
  readonly code = "A8N-JOB-005" as const;
  readonly checks: readonly DiagnosticCheck[];

  constructor(checks: readonly DiagnosticCheck[]) {
    super(
      `the agent is not available on the channel: ${checks.map((check) => check.detail).join("; ")}; ` +
        "nothing was sent",
    );
    this.name = "WindowsAgentUnavailableError";
    this.checks = checks;
  }
}

/** Every fact unread: the host was not reached at all. */
const UNREAD_FACTS: WindowsFacts = {
  osCaption: null,
  osVersion: null,
  sessionId: null,
  currentUser: null,
  consoleUser: null,
  aeInstalls: [],
  aeProcesses: [],
  targetUserExists: null,
  evidence: {},
};

/** This machine's own name, for the "is `--host` actually remote?" check. */
function ownHostName(): string {
  return hostname();
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

/** What the backend has learned about the run so far. */
export type RunBinding = {
  readonly runId: string;
  /** Null until a job has been submitted. */
  readonly jobId: string | null;
};

export interface WindowsSessionBackend {
  prepare(): Promise<PreparedIdentity>;
  run(
    identity: SessionIdentity,
    argv: readonly string[],
    options: RunOptions,
    onRun: (run: RunBinding) => void,
  ): Promise<CommandOutcome>;
  /** Read and verify the run's session marker; this never acts on AE. */
  destination(run: RunBinding): Promise<DestinationVerdict>;
  /** Release this run's own lock. This is not an action on After Effects. */
  release(runId: string): Promise<void>;
  /**
   * Quit the After Effects this run started, only ever after a proven
   * destination. The Windows backend starts no AE of its own, so it omits
   * this; a future GUI path must implement it behind the same check.
   */
  quit?: () => Promise<void>;
}

export type SubmitFunction = (
  channel: FileChannel,
  options: SubmitOptions,
) => Promise<SubmitResult>;

/** No channel key: without one, a job cannot be authenticated, so nothing is sent. */
export class WindowsKeyNotConfiguredError extends Error {
  readonly code = "A8N-JOB-003" as const;

  constructor() {
    super(
      "the Windows channel key is not configured, so a job could not be authenticated; " +
        "nothing was sent. Run setup to provision the key on the controller and the agent host.",
    );
    this.name = "WindowsKeyNotConfiguredError";
  }
}

export type WindowsAdapterOptions = {
  /**
   * The channel, when the caller supplies one. On a remote target it is
   * omitted and built from the host's configuration instead: a channel rooted
   * at the controller's tmpdir cannot reach the host.
   */
  readonly channel?: FileChannel;
  /** The controller-side host name recorded in jobs and manifests. */
  readonly host: string;
  /** The controller-side user name recorded in jobs and manifests. */
  readonly user: string;
  readonly agent: AgentIdentity;
  /**
   * The shared channel secret, provisioned out of band. Without it every run
   * refuses rather than sending an unauthenticated job.
   */
  readonly key?: JobKey;
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
  /**
   * How a named host is reached. When set, the adapter probes the host through
   * the channel with the agent instead of running the probe commands locally,
   * and every run first proves the agent is alive, interactive and the one the
   * target names. `null` (the default) keeps the local/no-transport behaviour:
   * a remote target then refuses at the probe rather than pretending the
   * controller's own PowerShell answers for the host.
   */
  readonly remote?: CommsOptions | null;
  /**
   * Set only where an injected `probe` already answers *for the host* — a fake
   * host in an in-process test. Production never sets it, so a `--host` target
   * there must have `remote` and cannot fall back to a local probe.
   */
  readonly simulatedHostProbe?: boolean;
  /** The agent entry to check in `windows.agent`; null means "not configured". */
  readonly agentEntry?: string;
  /** The logon entry that starts the agent; null means "not configured". */
  readonly autostartEntry?: string;
  readonly exists?: (path: string) => Promise<boolean>;
};

function defaultExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
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
  #run: RunBinding | null = null;
  #closedWith: { readonly closed: boolean; readonly reason: string | null } | null = null;

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
    return this.#backend.run(this.#identity, argv, options, (run) => {
      this.#run = run;
    });
  }

  /**
   * Closes the run, never After Effects. A quit happens only after the
   * session marker names this run; when it does not, nothing is quit and the
   * close is refused with `A8N-AE-002`. The run's own lock is still released:
   * it is this run's bookkeeping, not an action on a shared process.
   */
  async close(): Promise<{ readonly closed: boolean; readonly reason: string | null }> {
    // A second close must not turn a refusal into a clean close.
    if (this.#closedWith !== null) {
      return this.#closedWith;
    }
    const run = this.#run;
    let closed = true;
    let reason: string | null = null;
    if (run !== null) {
      let destination: DestinationVerdict;
      try {
        destination = await this.#backend.destination(run);
      } catch (error) {
        destination = {
          proven: false,
          code: "A8N-AE-002",
          detail: `the session marker could not be checked: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (destination.proven) {
        if (this.#backend.quit !== undefined) {
          await this.#backend.quit();
        }
      } else {
        closed = false;
        reason = `${destination.code}: ${destination.detail}; nothing was quit`;
      }
      await this.#backend.release(run.runId);
      this.#run = null;
    }
    this.#opened = false;
    this.#closed = true;
    this.#closedWith = { closed, reason };
    return this.#closedWith;
  }
}

export class WindowsAdapter implements PlatformAdapter {
  readonly platform = "win32" as const;
  readonly id = "windows-remote-host";

  #channel: FileChannel;
  readonly #channelInjected: boolean;
  readonly #host: string;
  #user: string;
  readonly #agent: AgentIdentity;
  readonly #key: JobKey | undefined;
  readonly #probeRunner: CommandRunner;
  readonly #runDirectory: string;
  readonly #staleAfterMs: number | undefined;
  readonly #now: () => Date;
  readonly #random: (size: number) => Uint8Array;
  readonly #submit: SubmitFunction;
  readonly #pollMs: number | undefined;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;
  readonly #agentEntry: string | null;
  readonly #autostartEntry: string | null;
  readonly #exists: (path: string) => Promise<boolean>;
  readonly #remote: CommsOptions | null;
  readonly #simulatedHostProbe: boolean;

  #isolation: TargetSpec["isolation"] = "remote-host";
  #facts: WindowsFacts | null = null;
  /** Opened once per adapter: resolving and verifying a host costs a round trip. */
  #comms: Promise<CommsState> | null = null;

  constructor(options: WindowsAdapterOptions) {
    this.#channel = options.channel ?? new DirectoryChannel(join(tmpdir(), "ae-a8n-cli-channel"));
    this.#channelInjected = options.channel !== undefined;
    this.#host = options.host;
    this.#user = options.user;
    this.#agent = options.agent;
    this.#key = options.key;
    this.#probeRunner = options.probe;
    this.#runDirectory = options.runDirectory ?? join(tmpdir(), "ae-a8n-runs");
    this.#staleAfterMs = options.staleAfterMs;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? randomBytes;
    this.#submit = options.submit ?? submitJob;
    this.#pollMs = options.pollMs;
    this.#sleep = options.sleep;
    this.#agentEntry = options.agentEntry ?? null;
    this.#autostartEntry = options.autostartEntry ?? null;
    this.#exists = options.exists ?? defaultExists;
    this.#remote = options.remote ?? null;
    this.#simulatedHostProbe = options.simulatedHostProbe ?? false;
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

    // A remote target's first question is not "does the channel directory
    // exist" but "can this controller reach it, and is the agent alive on the
    // other end". Each refusal is its own step so a human knows what to fix.
    let comms: CommsState | null = null;
    if (target.isolation === "remote-host" && this.#remote !== null && !this.#simulatedHostProbe) {
      comms = await this.#openRemote();
      if (comms.ok) {
        steps.push({
          id: "windows.comms-channel",
          state: "done",
          reason:
            `the channel ${comms.config.channel} is readable and writable from this controller`,
          action: null,
          automatable: false,
        });
        steps.push({
          id: "windows.comms-agent",
          state: "done",
          reason:
            `agent ${comms.agent.id} is alive on host "${comms.agent.host}" as ` +
            `"${comms.agent.user}", session ${String(comms.agent.sessionId)}, version ${comms.agent.version}`,
          action: null,
          automatable: false,
        });
      } else {
        for (const check of comms.checks) {
          steps.push({
            id: `windows.comms-${check.code.toLowerCase()}`,
            state: "needs-human",
            reason: check.detail,
            action: check.remedy,
            automatable: false,
          });
        }
      }
    }

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
    if (target.isolation === "remote-host" && this.#remote !== null && !this.#simulatedHostProbe) {
      // The channel was already proven above; a second, local directory check
      // would measure the controller's own filesystem and prove nothing.
    } else {
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
    }

    steps.push({
      id: "windows.channel-permissions",
      state: "needs-human",
      reason:
        "the controller account and the agent account must both be able to read and write the channel root; one account's write probe cannot prove the other's access",
      action:
        "Grant Modify on the channel root to the controller account and to the agent account " +
        "(for example with icacls). Granting it is a human decision; setup never records a credential.",
      automatable: false,
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
        : "Install @ido-bata/ae-a8n on the target, then start the agent from the logged-in " +
          "interactive session: npx --package @ido-bata/ae-a8n ae-a8n agent --channel <dir> " +
          "--key-file <file> --host <host> --user <user>. No clone is needed.",
      automatable: false,
    });

    let autostartExists = false;
    if (this.#autostartEntry !== null) {
      autostartExists = await this.#exists(this.#autostartEntry).catch(() => false);
    }
    steps.push({
      id: "windows.agent-autostart",
      state: autostartExists ? "done" : "planned",
      reason: autostartExists
        ? `the agent's logon entry ${this.#autostartEntry} exists`
        : this.#autostartEntry === null
          ? "no agent logon entry is configured"
          : `the agent's logon entry ${this.#autostartEntry} does not exist`,
      // The agent must run in the dedicated user's interactive session, so it
      // starts at that user's logon. Setup checks the entry; it does not
      // register it and never stores a password.
      action: autostartExists
        ? null
        : "Register the agent to start at the dedicated user's logon (a Startup-folder shortcut or a logon task). Sign-in stays manual.",
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
      run: (identity, argv, options, onRun) =>
        this.#runInSession(target, identity, argv, options, onRun),
      destination: (run) => this.#verifyDestination(run),
      release: async (runId) => {
        await releaseRunLock(this.#channel, runId, this.#owner());
      },
      // No `quit`: this backend never starts After Effects itself, so there is
      // no process it may quit. A future GUI path must add one behind the
      // same marker check.
    };
    return new WindowsSession(target, prepared.identity, backend);
  }

  async recover(runDir: string): Promise<readonly RecoveryFinding[]> {
    let result: CommandResult;
    try {
      result = await this.#probeRunner.run(WINDOWS_RECOVERY_COMMAND);
    } catch (error) {
      result = {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 127,
      };
    }
    const observation = interpretWindowsRecoveryResult(result);
    return assessWindowsRecovery(observation, { runDir });
  }

  #owner(): RunOwner {
    return { host: this.#host, user: this.#user };
  }

  /** The marker must name this run, this job and the configured agent. */
  #verifyDestination(run: RunBinding): Promise<DestinationVerdict> {
    if (run.jobId === null) {
      return Promise.resolve({
        proven: false,
        code: "A8N-AE-002",
        detail: "no job was submitted for this run, so it has no destination",
      });
    }
    return proveRunDestination(this.#channel, {
      runId: run.runId,
      jobId: run.jobId,
      agent: this.#agent,
    });
  }

  /**
   * Open (once) and verify the channel to a named host. The result is cached
   * for this adapter's lifetime: a heartbeat that is live for one check is not
   * re-verified for the next, so a caller that needs current liveness asks
   * `#assertAgentAlive` at the moment it sends.
   */
  #openRemote(): Promise<CommsState> {
    this.#comms ??= this.#freshComms();
    return this.#comms;
  }

  /** Resolve and verify the channel again, uncached: liveness is measured now. */
  #freshComms(): Promise<CommsState> {
    const remote = this.#remote;
    if (remote === null) {
      return Promise.reject(new Error("no remote configuration"));
    }
    return resolveComms(remote).then((resolution) => {
      // The channel the jobs go into is the one the host configuration names.
      // An injected channel (a test, or a caller that already resolved one)
      // wins, and is never replaced underneath the caller.
      if (resolution.ok && !this.#channelInjected) {
        this.#channel = new DirectoryChannel(resolution.config.channel);
      }
      if (resolution.ok && this.#user === "") {
        // The account for this host comes from its configuration when the
        // caller names none. `--host UUU` alone used to leave the writer
        // anonymous, and the agent refuses such a job (A8N-JOB-001) — which
        // reached a person as a timeout, because nothing else was wrong.
        this.#user = resolution.config.user ?? "";
      }
      return openComms(
        {
          channel: this.#channel,
          version: this.#agent.version,
          now: this.#now,
          random: this.#random,
          ...(this.#pollMs === undefined ? {} : { pollMs: this.#pollMs }),
          ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
        },
        resolution,
        resolution.ok
          ? resolution.config
          : {
              host: remote.host,
              user: remote.user,
              channel: "",
              keyFile: "",
              agentId: "",
              systemRoot: "C:\\Windows",
            },
      );
    });
  }

  /**
   * The key this run's job is signed with.
   *
   * A caller that supplied one — a test, or a backend that resolved it itself
   * — keeps it. A remote target takes the key `openComms` has just verified
   * against the host's own channel configuration: that is the same key file
   * the agent reads, and the only one it accepts. Reading `#key` alone made
   * every remote run refuse with "the key is not configured" while the
   * channel and the agent were both fine, because the CLI never has a key to
   * inject — the host's configuration is where it comes from.
   *
   * Resolving here also settles `#channel` before the run lock is written, so
   * the lock lands in the channel the job goes into rather than a local one.
   */
  async #signingKey(target: TargetSpec): Promise<JobKey> {
    if (this.#key !== undefined) {
      return this.#key;
    }
    if (target.isolation === "remote-host" && this.#remote !== null && !this.#simulatedHostProbe) {
      const comms = await this.#openRemote();
      if (!comms.ok) {
        throw new WindowsAgentUnavailableError(comms.checks);
      }
      return comms.key;
    }
    throw new WindowsKeyNotConfiguredError();
  }

  /**
   * The heartbeat that was live during `probe` may be minutes old by the time
   * a job is about to be written. Re-verify immediately before sending; a
   * stale or mismatched heartbeat refuses the send rather than leaving a job
   * for an agent that is not there.
   */
  async #assertAgentAlive(target: TargetSpec): Promise<void> {
    if (this.#remote === null || target.isolation !== "remote-host" || this.#simulatedHostProbe) {
      return;
    }
    const comms = await this.#freshComms();
    if (!comms.ok) {
      throw new WindowsAgentUnavailableError(comms.checks);
    }
  }

  async #prepare(target: TargetSpec): Promise<PreparedIdentity> {
    this.#isolation = target.isolation;
    let runner: CommandRunner = this.#probeRunner;
    if (target.isolation === "remote-host" && this.#remote !== null && !this.#simulatedHostProbe) {
      const comms = await this.#openRemote();
      if (!comms.ok) {
        // No agent, no facts about the host. Every fact stays unread and the
        // identity is unproven; nothing here guesses at the machine's state.
        this.#facts = UNREAD_FACTS;
        return {
          identity: {
            kind: "host-and-user",
            user: target.user ?? this.#user,
            detail: { host: target.host ?? this.#host, sessionId: null },
            proven: false,
          },
          facts: UNREAD_FACTS,
          checks: comms.checks,
        };
      }
      const sameMachine = comms.agent.host.toLowerCase() === ownHostName().toLowerCase();
      if (sameMachine) {
        // `remote-host` claims isolation by construction. If the "remote" host
        // is this controller, that claim is false and must block here rather
        // than ride on the word "remote" in a flag.
        this.#facts = UNREAD_FACTS;
        return {
          identity: {
            kind: "host-and-user",
            user: target.user ?? this.#user,
            detail: { host: target.host ?? this.#host, sessionId: null },
            proven: false,
          },
          facts: UNREAD_FACTS,
          checks: [
            diagnostic("A8N-SESSION-006", {
              detail:
                `the agent for --host "${target.host ?? this.#host}" reports host ` +
                `"${comms.agent.host}", which is this controller; the test session would run on the machine you are using`,
              remedy:
                "Use a different machine for --host, or target this machine with a separate account and no --host.",
              remedyKind: "human",
              evidence: { host: comms.agent.host },
            }),
          ],
        };
      }
      runner = new ChannelCommandRunner(comms, {
        now: this.#now,
        random: this.#random,
        ...(this.#pollMs === undefined ? {} : { pollMs: this.#pollMs }),
        ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
      });
    } else if (target.isolation === "remote-host" && !this.#simulatedHostProbe) {
      // A remote target with no transport configured: the local probe would
      // answer for this machine, not the host. Refuse instead of mislabeling.
      this.#facts = UNREAD_FACTS;
      return {
        identity: {
          kind: "host-and-user",
          user: target.user ?? this.#user,
          detail: { host: target.host ?? this.#host, sessionId: null },
          proven: false,
        },
        facts: UNREAD_FACTS,
        checks: [
          diagnostic("A8N-JOB-007", {
            detail:
              `--host "${target.host ?? this.#host}" names a remote host, but no channel or key is configured, ` +
              "so nothing can reach it; a local probe would answer for this machine instead",
            remedy:
              "Pass --channel <dir> --key-file <file> for the host's shared channel, or add it to ~/.ae-a8n/hosts.json.",
            remedyKind: "human",
            evidence: { host: target.host ?? this.#host },
          }),
        ],
      };
    }
    const result = await probeWindows(runner, {
      isolation: target.isolation,
      targetUser: target.user,
    });
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
    onRun: (run: RunBinding) => void,
  ): Promise<CommandOutcome> {
    const key = await this.#signingKey(target);
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
    onRun({ runId, jobId: null });

    const payload = encodeJobPayload({
      argv: [...argv],
      env: { ...options.env },
    });
    const startedAt = now.toISOString();
    const writer = owner;
    const submitOptions: SubmitOptions = {
      payload,
      runId,
      timeoutMs: options.timeoutMs,
      writer,
      key,
      now: this.#now,
      random: this.#random,
      ...(this.#pollMs === undefined ? {} : { pollMs: this.#pollMs }),
      ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
    };

    await this.#assertAgentAlive(target);
    const submitted = await this.#submit(this.#channel, submitOptions);
    onRun({ runId, jobId: submitted.jobId });
    const facts = this.#facts ?? (await this.#prepare(target)).facts;
    // Read the agent's marker back. Only a marker naming this run counts;
    // anything else is recorded as unproven, never as a measured destination.
    const destination = await this.#verifyDestination({ runId, jobId: submitted.jobId });
    // The manifest records what was proven, not what was configured: the
    // agent identity and session come from the signed result when there is
    // one. `agentVerified` says which of the two this is.
    const verified =
      submitted.status === "ok" || submitted.status === "failed" ? submitted.result.agent : null;
    const manifest: RunManifest = {
      schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
      runId,
      host: this.#host,
      user: this.#user,
      sessionId: verified === null ? facts.sessionId : verified.sessionId,
      agentId: verified?.id ?? this.#agent.id,
      agentVersion: verified?.version ?? this.#agent.version,
      agentVerified: verified !== null,
      aeVersion: aeVersionFromFacts(facts),
      jobId: submitted.jobId,
      payloadSha256: sha256Hex(payload),
      resultSha256: submitted.resultSha256,
      outcome: submitted.status,
      destinationProof: destination.proven ? destination.proof : "unproven",
      // The isolated backend never measured the AE process's pid and start
      // time, so it may not claim ownership.
      ownershipProof: "unproven",
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
      // The published exit code is authoritative; 1 is the conventional
      // fallback when the process did not exit normally (signal or kill).
      exitCode: submitted.result.exitCode ?? (submitted.status === "ok" ? 0 : 1),
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
