/**
 * The macOS adapter: a read-only probe plus a thin wrapper over the session
 * code PR #50 already delivered (`src/driver/mac-session.ts`).
 *
 * The probe is the part `doctor` depends on, and it is deliberately read-only:
 * it runs `sw_vers`, `uname`, `id`, `launchctl print`, `stat /dev/console`,
 * `ps` and `plutil`. It starts no After Effects, opens no session, reads no
 * credential, sends no Apple Event and changes no TCC/SIP state.
 *
 * Every fact the probe cannot read is reported as a blocker or a warning with
 * an `A8N-*` code and a remedy. None of them is silently treated as success.
 *
 * The rest of `PlatformAdapter` is deliberately thin in this increment. `run`
 * delegates to the reviewed session runner and asserts the identity first;
 * `plan`/`apply`/`recover` say which issue owns them rather than pretending
 * they did nothing successfully.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import {
  NODE_FLOOR_MAJOR,
} from "../../doctor/index.js";
import { diagnostic, type DiagnosticCheck } from "../../doctor/diagnostics.js";
import {
  MAC_APPLICATIONS_ROOT,
  aeDirectoriesNewestFirst,
} from "../../driver/install-path.js";
import {
  consoleSessionUid,
  readGuiSession,
  readGuiSessionFailure,
  runInSession,
  type MacSession,
} from "../../driver/mac-session.js";
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
  UnprovenTargetError,
} from "../contract.js";

/** The package's Node floor; the neutral doctor owns the constant. */
export { NODE_FLOOR_MAJOR };

export type DarwinAeInstall = {
  readonly location: string;
  readonly version: string | null;
  readonly selected: boolean;
};

export type DarwinProcess = {
  readonly pid: number;
  readonly uid: number;
  readonly name: string;
};

export type DarwinFacts = {
  readonly release: string | null;
  readonly arch: string | null;
  readonly nodeVersion: string;
  readonly nodeFloorMajor: number;
  readonly aeInstalls: readonly DarwinAeInstall[];
  /** Why the installation folder could not be read, or null. */
  readonly installLookupFailure: string | null;
  readonly targetUser: string | null;
  readonly targetUid: number | null;
  readonly targetUserFailure: string | null;
  readonly guiSession: MacSession | null;
  readonly guiSessionFailure: string | null;
  readonly consoleUid: number | null;
  readonly aeProcesses: readonly DarwinProcess[];
  readonly aeProcessesReadable: boolean;
  readonly aeProcessesFailure: string | null;
  /** Raw output the conclusions rest on, for a human to check. */
  readonly evidence: Readonly<Record<string, string>>;
};

export type DarwinProbeResult = AdapterProbe & {
  readonly facts: DarwinFacts;
};

export type CommandRun = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Injected in tests so no probe fixture needs a Mac. */
export type DarwinExec = (
  program: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => CommandRun;

function runProcess(
  program: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): CommandRun {
  try {
    const stdout = execFileSync(program, [...args], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env === undefined ? {} : { env }),
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}

function textOrNull(result: CommandRun): string | null {
  if (result.status !== 0) {
    return null;
  }
  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
}

function failureOf(result: CommandRun): string {
  const text = result.stderr.trim();
  return text.length > 0 ? text : `command exited with ${result.status}`;
}

/** The current account, or null when the directory service will not say. */
export function currentUsername(): string | null {
  try {
    const name = userInfo().username;
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** `ps -axo pid=,uid=,comm=` output, filtered to After Effects executables. */
export function parseAeProcesses(text: string): DarwinProcess[] {
  const processes: DarwinProcess[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null) {
      continue;
    }
    const name = (match[3] as string).trim();
    // `comm` is the executable path. Matching "After Effects" in a helper's
    // command line is not enough: that is the application *name* here.
    if (!/(^|\/)After Effects$/.test(name)) {
      continue;
    }
    processes.push({
      pid: Number(match[1]),
      uid: Number(match[2]),
      name,
    });
  }
  return processes;
}

function readBundleVersion(bundle: string, exec: DarwinExec): string | null {
  const plist = join(bundle, "Contents", "Info.plist");
  const result = exec("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    plist,
  ]);
  return textOrNull(result);
}

function readInstalls(exec: DarwinExec): {
  readonly installs: readonly DarwinAeInstall[];
  readonly failure: string | null;
} {
  let entries: string[];
  try {
    entries = readdirSync(MAC_APPLICATIONS_ROOT);
  } catch (error) {
    return {
      installs: [],
      failure: `the Applications folder could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const installs: DarwinAeInstall[] = [];
  for (const name of aeDirectoriesNewestFirst(entries)) {
    const location = join(MAC_APPLICATIONS_ROOT, name);
    const bundle = join(location, `${name}.app`);
    if (!existsSync(join(bundle, "Contents", "MacOS"))) {
      continue;
    }
    installs.push({
      location,
      version: readBundleVersion(bundle, exec),
      selected: installs.length === 0,
    });
  }
  return { installs, failure: null };
}

function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Read the facts the macOS doctor reports. Every command is read-only; the
 * caller never gets a value it did not observe.
 */
export function readDarwinFacts(
  user: string | null,
  exec: DarwinExec = runProcess,
): DarwinFacts {
  const release = textOrNull(exec("sw_vers", ["-productVersion"]));
  const arch = textOrNull(exec("uname", ["-m"]));

  const targetUser = user ?? currentUsername();
  let targetUid: number | null = null;
  let targetUserFailure: string | null = null;
  if (targetUser === null) {
    targetUserFailure = "the current account could not be resolved";
  } else {
    const uidResult = exec("id", ["-u", targetUser]);
    if (uidResult.status === 0) {
      const parsed = Number(uidResult.stdout.trim());
      if (Number.isInteger(parsed) && parsed >= 0) {
        targetUid = parsed;
      } else {
        targetUserFailure = `id -u ${targetUser} did not answer with a uid`;
      }
    } else {
      targetUserFailure = failureOf(uidResult);
    }
  }

  let guiSession: MacSession | null = null;
  let guiSessionFailure: string | null = null;
  if (targetUid !== null) {
    guiSession = readGuiSession(targetUid);
    if (guiSession === null) {
      guiSessionFailure = readGuiSessionFailure(targetUid);
    }
  }

  const console = consoleSessionUid();
  const consoleUid = console >= 0 ? console : null;

  const psResult = exec("ps", ["-axo", "pid=,uid=,comm="], {
    ...process.env,
    LC_ALL: "C",
    LANG: "C",
  });
  const aeProcessesReadable = psResult.status === 0;
  const aeProcesses = aeProcessesReadable ? parseAeProcesses(psResult.stdout) : [];
  const aeProcessesFailure = aeProcessesReadable ? null : failureOf(psResult);

  const installs = readInstalls(exec);

  const evidence: Record<string, string> = {
    os: [release ?? "", arch ?? ""].join("|"),
    node: process.version,
    installs:
      installs.installs
        .map(
          (install) =>
            `${install.location}|${install.version ?? ""}|${install.selected ? "selected" : ""}`,
        )
        .join("; ") || (installs.failure ?? "none"),
    targetUser:
      targetUser === null
        ? (targetUserFailure ?? "unreadable")
        : `${targetUser}|${targetUid ?? ""}`,
    guiSession:
      guiSession !== null
        ? `${guiSession.kind}|${guiSession.asid ?? ""}`
        : (guiSessionFailure ?? "none"),
    consoleUid: consoleUid === null ? "unreadable" : String(consoleUid),
    aeProcesses: aeProcessesReadable
      ? aeProcesses.map((entry) => `${entry.pid}|${entry.uid}|${entry.name}`).join("; ") ||
        "none"
      : (aeProcessesFailure ?? "unreadable"),
  };

  return {
    release,
    arch,
    nodeVersion: process.version,
    nodeFloorMajor: NODE_FLOOR_MAJOR,
    aeInstalls: installs.installs,
    installLookupFailure: installs.failure,
    targetUser,
    targetUid,
    targetUserFailure,
    guiSession,
    guiSessionFailure,
    consoleUid,
    aeProcesses,
    aeProcessesReadable,
    aeProcessesFailure,
    evidence,
  };
}

/** The capabilities this backend can honestly claim today. */
export function darwinCapabilities(): Capabilities {
  return {
    // Not measured by a read-only probe; see the runner (#58) for the
    // instrumented measurement that can make this "proven".
    nonInterference: "unproven",
    // The adapter proves a uid/asid, not the AE process or the destination
    // marker. Those remain with the driver and #58/#59.
    provesOwnership: false,
    provesDestination: false,
    // GUI recovery exists in the driver, but this adapter's `recover` does not
    // wire it yet (#59). Claiming it here would tell a user a recovery works.
    guiRecovery: false,
    sessionIdentity: "uid-asid",
  };
}

function describeProcesses(processes: readonly DarwinProcess[]): string {
  return processes
    .map((entry) => `pid ${entry.pid} (uid ${entry.uid}, ${entry.name})`)
    .join(", ");
}

/**
 * Turn the facts into diagnostics. Pure: the same facts always produce the
 * same checks, and nothing here can change the machine.
 */
export function probeDarwin(facts: DarwinFacts): DarwinProbeResult {
  const checks: DiagnosticCheck[] = [];

  if (facts.release === null || facts.arch === null) {
    checks.push(
      diagnostic("A8N-ENV-001", {
        detail:
          `the macOS version or architecture could not be read ` +
          `(version: ${facts.release ?? "unreadable"}, architecture: ${facts.arch ?? "unreadable"})`,
        remedy:
          "Run doctor from a terminal on the Mac itself and re-run it. Nothing was started or changed.",
        remedyKind: "human",
        evidence: { release: facts.release, arch: facts.arch },
      }),
    );
  } else if (facts.arch !== "arm64" && facts.arch !== "x64") {
    checks.push(
      diagnostic("A8N-ENV-001", {
        detail: `macOS architecture "${facts.arch}" is not supported`,
        remedy: "Use a macOS host on arm64 or x64.",
        remedyKind: "human",
        evidence: { release: facts.release, arch: facts.arch },
      }),
    );
  }

  const major = nodeMajor(facts.nodeVersion);
  if (major === null || major < facts.nodeFloorMajor) {
    checks.push(
      diagnostic("A8N-ENV-002", {
        detail:
          major === null
            ? `the Node version "${facts.nodeVersion}" could not be parsed`
            : `Node ${facts.nodeVersion} is below the package floor (${facts.nodeFloorMajor}+)`,
        remedy: `Install Node ${facts.nodeFloorMajor} or later on this machine and re-run doctor.`,
        remedyKind: "human",
        evidence: { node: facts.nodeVersion, floor: facts.nodeFloorMajor },
      }),
    );
  }

  const selected = facts.aeInstalls.find((install) => install.selected) ?? null;
  if (facts.aeInstalls.length === 0) {
    checks.push(
      diagnostic("A8N-ENV-003", {
        detail:
          facts.installLookupFailure !== null
            ? `the After Effects installation folder could not be read: ${facts.installLookupFailure}`
            : `no After Effects installation was found in ${MAC_APPLICATIONS_ROOT}`,
        remedy:
          facts.installLookupFailure !== null
            ? "Check that the Applications folder is readable by this account, then re-run doctor. Doctor does not assume AE is absent."
            : "Install After Effects 2026 on this Mac, or pass an explicit installation directory when the runner is available.",
        remedyKind: "human",
        evidence: { installs: facts.evidence["installs"] ?? "" },
      }),
    );
  } else if (selected === null) {
    checks.push(
      diagnostic("A8N-ENV-003", {
        detail: "After Effects installations were found, but none could be selected",
        remedy: "Inspect the Applications folder and re-run doctor.",
        remedyKind: "human",
        evidence: { installs: facts.evidence["installs"] ?? "" },
      }),
    );
  } else if (selected.version === null) {
    checks.push(
      diagnostic("A8N-ENV-003", {
        detail:
          `After Effects was found at ${selected.location}, but its version could not be read, ` +
          "so the installation could not be confirmed",
        remedy:
          "Check that the .app bundle is intact, or reinstall After Effects. Doctor does not assume a version it could not read.",
        remedyKind: "human",
        evidence: { location: selected.location, version: null },
      }),
    );
  }

  const locations = new Set(
    facts.aeInstalls.map((install) => install.location.toLowerCase()),
  );
  if (locations.size > 1 && selected !== null) {
    checks.push(
      diagnostic("A8N-ENV-004", {
        detail:
          `found ${locations.size} After Effects installation locations; the selected one is ` +
          `${selected.location}${selected.version === null ? "" : ` (${selected.version})`}`,
        remedy:
          "Keep one installation, or configure the runner's installation directory so the selected install is explicit.",
        remedyKind: "human",
        evidence: { installs: facts.evidence["installs"] ?? "" },
      }),
    );
  }

  if (facts.targetUser === null || facts.targetUid === null) {
    checks.push(
      diagnostic("A8N-SESSION-001", {
        detail:
          facts.targetUser === null
            ? `the target account could not be determined (${facts.targetUserFailure ?? "unknown"})`
            : `the target account "${facts.targetUser}" could not be resolved to a uid ` +
              `(${facts.targetUserFailure ?? "unknown"})`,
        remedy:
          "Create the account, or pass --user <name> with an account that exists on this Mac.",
        remedyKind: "human",
        evidence: {
          targetUser: facts.targetUser,
          uid: facts.targetUid,
          failure: facts.targetUserFailure,
        },
      }),
    );
  }

  if (facts.targetUid !== null) {
    if (facts.guiSession === null) {
      checks.push(
        diagnostic("A8N-SESSION-002", {
          detail:
            facts.guiSessionFailure !== null
              ? `the login session of ${facts.targetUser ?? `uid ${facts.targetUid}`} could not be read: ` +
                `${facts.guiSessionFailure}. Doctor does not assume the account is logged in or out.`
              : `${facts.targetUser ?? `uid ${facts.targetUid}`} (uid ${facts.targetUid}) has no GUI (Aqua) session`,
          remedy:
            facts.guiSessionFailure !== null
              ? "Run doctor from inside the target session, or as root, so launchd will answer for that uid. Nothing was started."
              : "Log the target account in once with fast user switching, then switch back. Doctor never logs it in for you.",
          remedyKind: "human",
          evidence: {
            uid: facts.targetUid,
            asid: null,
            failure: facts.guiSessionFailure,
          },
        }),
      );
    } else if (facts.guiSession.kind !== "Aqua") {
      checks.push(
        diagnostic("A8N-SESSION-002", {
          detail:
            `${facts.guiSession.username} (uid ${facts.guiSession.uid}) has a ` +
            `${facts.guiSession.kind} session, not an Aqua GUI session`,
          remedy:
            "Log the target account in at the graphical login window once, then switch back to your own account.",
          remedyKind: "human",
          evidence: {
            uid: facts.guiSession.uid,
            asid: facts.guiSession.asid,
            kind: facts.guiSession.kind,
          },
        }),
      );
    } else if (facts.guiSession.asid === null) {
      checks.push(
        diagnostic("A8N-SESSION-002", {
          detail:
            `${facts.guiSession.username} (uid ${facts.guiSession.uid}) has an Aqua session, ` +
            "but its session id (asid) could not be read",
          remedy:
            "Re-run doctor; if it persists, log the target account out and in again. An unproven session id is never used.",
          remedyKind: "human",
          evidence: { uid: facts.guiSession.uid, asid: null },
        }),
      );
    }
  }

  if (facts.consoleUid === null) {
    checks.push(
      diagnostic("A8N-SESSION-003", {
        detail:
          "the owner of /dev/console could not be read, so doctor cannot show that the target " +
          "session is separate from the console session",
        remedy:
          "Run doctor on the Mac's own console session so the console owner can be read. Nothing was changed.",
        remedyKind: "human",
        evidence: { consoleUid: null, targetUid: facts.targetUid },
      }),
    );
  } else if (facts.targetUid !== null && facts.targetUid === facts.consoleUid) {
    checks.push(
      diagnostic("A8N-SESSION-003", {
        detail:
          `the target account ${facts.targetUser ?? `uid ${facts.targetUid}`} (uid ${facts.targetUid}) ` +
          "is the console user, the screen a person is looking at",
        remedy:
          "Use a separate OS account for the isolated session, or a dedicated host. Doctor will not run tests on the console desktop.",
        remedyKind: "human",
        evidence: { targetUid: facts.targetUid, consoleUid: facts.consoleUid },
      }),
    );
  }

  if (!facts.aeProcessesReadable) {
    checks.push(
      diagnostic("A8N-AE-001", {
        detail:
          `the process list could not be read (${facts.aeProcessesFailure ?? "unknown"}), ` +
          "so doctor cannot rule out another After Effects",
        remedy:
          "Quit After Effects yourself if it is running, then re-run doctor. Doctor never starts or stops After Effects.",
        remedyKind: "human",
        evidence: { processes: facts.evidence["aeProcesses"] ?? "unreadable" },
      }),
    );
  } else if (facts.aeProcesses.length > 0) {
    checks.push(
      diagnostic("A8N-AE-001", {
        detail: `After Effects is already running: ${describeProcesses(facts.aeProcesses)}`,
        remedy:
          "Quit After Effects yourself. No test AE is started while another instance is running, and doctor does not quit one it did not start.",
        remedyKind: "human",
        evidence: { processes: facts.evidence["aeProcesses"] ?? "" },
      }),
    );
  }

  return {
    checks,
    capabilities: darwinCapabilities(),
    facts,
  };
}

export type DarwinRunCommand = (
  session: MacSession,
  argv: readonly string[],
  options: RunOptions,
) => Promise<CommandOutcome>;

export type DarwinAdapterOptions = {
  /** Test seam: replaces the read-only probe. Never called with side effects. */
  readonly readFacts?: (user: string | null) => DarwinFacts;
  /** Test seam: replaces the in-session command runner. */
  readonly runCommand?: DarwinRunCommand;
  /** Test seam: where setup records completed step ids. Never holds secrets. */
  readonly setupStateFile?: string;
};

/** Only step ids and outcomes are stored; no credential ever reaches this file. */
export const MAC_SETUP_STATE_SCHEMA = "1.0";
export const MAC_SETUP_STATE_FILE = join(homedir(), ".ae-a8n", "setup-state.json");

type SetupStateRead =
  | { readonly ok: true; readonly completed: ReadonlySet<string> }
  | { readonly ok: false; readonly detail: string };

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSetupState(stateFile: string): SetupStateRead {
  let text: string;
  try {
    text = readFileSync(stateFile, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, completed: new Set() };
    }
    return {
      ok: false,
      detail: `the setup state file ${stateFile} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, detail: `the setup state file ${stateFile} is not valid JSON` };
  }
  if (!isRecordValue(parsed) || parsed["schemaVersion"] !== MAC_SETUP_STATE_SCHEMA) {
    return {
      ok: false,
      detail: `the setup state file ${stateFile} has an unsupported schema`,
    };
  }
  const completed = parsed["completed"];
  if (!Array.isArray(completed) || !completed.every((id) => typeof id === "string")) {
    return {
      ok: false,
      detail: `the setup state file ${stateFile} does not hold a list of step ids`,
    };
  }
  return { ok: true, completed: new Set(completed) };
}

function writeSetupState(stateFile: string, completed: ReadonlySet<string>): void {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(
    { schemaVersion: MAC_SETUP_STATE_SCHEMA, completed: [...completed].sort() },
    null,
    2,
  )}\n`;
  // The file records no secret, but it names the user's machine layout; keep it
  // private anyway.
  writeFileSync(stateFile, body, { mode: 0o600 });
}

function defaultRunCommand(
  session: MacSession,
  argv: readonly string[],
  options: RunOptions,
): Promise<CommandOutcome> {
  const [program, ...args] = argv;
  if (program === undefined) {
    return Promise.reject(new Error("run needs a program"));
  }
  const envPairs = Object.entries(options.env).map(([key, value]) => `${key}=${value}`);
  const useEnv = envPairs.length > 0;
  const command = useEnv ? "/usr/bin/env" : program;
  const commandArgs = useEnv ? [...envPairs, program, ...args] : args;
  const result = runInSession(session, command, commandArgs, {
    timeoutMs: options.timeoutMs,
  });
  const directory = mkdtempSync(join(tmpdir(), "ae-a8n-darwin-run-"));
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  writeFileSync(stdoutPath, result.stdout);
  writeFileSync(stderrPath, result.stderr);
  return Promise.resolve({
    exitCode: result.status,
    stdoutPath,
    stderrPath,
    ...(result.timedOut ? { timedOut: true } : {}),
  });
}

type ResolvedSession = {
  readonly session: MacSession | null;
  readonly identity: SessionIdentity;
};

/** Build the identity from facts the probe already read; no extra commands. */
export function resolveDarwinSession(facts: DarwinFacts): ResolvedSession {
  const session = facts.guiSession;
  const proven =
    facts.targetUid !== null &&
    session !== null &&
    session.kind === "Aqua" &&
    session.asid !== null &&
    // A readable console owner that differs is part of the proof. "Unknown"
    // is not proven, and the console session itself is never a target.
    facts.consoleUid !== null &&
    facts.consoleUid !== facts.targetUid;
  return {
    session,
    identity: {
      kind: "uid-asid",
      user: facts.targetUser ?? "unknown",
      detail: {
        uid: facts.targetUid,
        asid: session?.asid ?? null,
        consoleUid: facts.consoleUid,
      },
      proven,
    },
  };
}

class DarwinSession implements IsolatedSession {
  readonly #target: TargetSpec;
  readonly #refresh: () => ResolvedSession;
  readonly #runCommand: DarwinRunCommand;
  #identity: SessionIdentity;
  #session: MacSession | null;
  #opened = false;

  constructor(
    target: TargetSpec,
    resolved: ResolvedSession,
    runCommand: DarwinRunCommand,
    refresh: () => ResolvedSession,
  ) {
    this.#target = target;
    this.#identity = resolved.identity;
    this.#session = resolved.session;
    this.#runCommand = runCommand;
    this.#refresh = refresh;
  }

  get identity(): SessionIdentity {
    return this.#identity;
  }

  /** Re-probes before the session is considered open, so `proven` is current. */
  open(): Promise<void> {
    // A synchronous refusal becomes a rejection, as the contract promises.
    return Promise.resolve().then(() => {
      const resolved = this.#refresh();
      this.#identity = resolved.identity;
      this.#session = resolved.session;
      this.#opened = true;
    });
  }

  async run(
    argv: readonly string[],
    options: RunOptions,
  ): Promise<CommandOutcome> {
    // Before the open check, before any command, before anything is written.
    // `async` turns the refusal into a rejection, so a caller always sees the
    // contract's Promise rather than a synchronous throw.
    assertProvenIdentity(this.#identity);
    if (!this.#opened) {
      throw new Error(
        `the macOS session for ${this.#target.name} is not open; call open() first`,
      );
    }
    const session = this.#session;
    if (session === null) {
      // assertProvenIdentity already rejected an unproven identity; this is a
      // defensive check so a proven identity can never carry no session.
      throw new UnprovenTargetError(
        `the macOS session for ${this.#target.name} has no login session; nothing was sent`,
      );
    }
    return this.#runCommand(session, argv, options);
  }

  close(): Promise<{ readonly closed: boolean; readonly reason: string | null }> {
    this.#opened = false;
    // This adapter starts no After Effects in this increment, so closing the
    // session cannot quit anything.
    return Promise.resolve({
      closed: true,
      reason: "the macOS adapter started no After Effects in this increment",
    });
  }
}

export class DarwinAdapter implements PlatformAdapter {
  readonly platform: PlatformId = "darwin";
  readonly id = "macos-session-agent";

  readonly #readFacts: (user: string | null) => DarwinFacts;
  readonly #runCommand: DarwinRunCommand;
  readonly #setupStateFile: string;

  constructor(options: DarwinAdapterOptions = {}) {
    this.#readFacts = options.readFacts ?? ((user) => readDarwinFacts(user));
    this.#runCommand = options.runCommand ?? defaultRunCommand;
    this.#setupStateFile = options.setupStateFile ?? MAC_SETUP_STATE_FILE;
  }

  capabilities(): Promise<Capabilities> {
    return Promise.resolve(darwinCapabilities());
  }

  probe(target: TargetSpec): Promise<DarwinProbeResult> {
    // The probe is synchronous and read-only; it cannot start AE or open a
    // session. Wrapping the call keeps a failure a rejection, as the contract
    // promises, instead of a synchronous throw.
    return Promise.resolve().then(() => probeDarwin(this.#readFacts(target.user)));
  }

  plan(target: TargetSpec): Promise<readonly SetupStep[]> {
    return Promise.resolve().then(() => {
      const facts = this.#readFacts(target.user);
      const user = target.user;
      const accountKnown =
        user !== null && facts.targetUser === user && facts.targetUid !== null;
      const steps: SetupStep[] = [];

      steps.push({
        id: "macos.target-user",
        state: accountKnown ? "done" : "needs-human",
        reason:
          user === null
            ? "no target account was named; the isolated session must belong to a separate OS account"
            : accountKnown
              ? `the account ${user} exists (uid ${String(facts.targetUid)})`
              : facts.targetUserFailure !== null
                ? `the account ${user} could not be resolved: ${facts.targetUserFailure}`
                : `the account ${user} could not be resolved`,
        action: accountKnown
          ? null
          : "Create a dedicated macOS account for the isolated session (System Settings > Users & Groups, " +
            "or sysadminctl as an administrator), then pass --user <name>. Setup never creates an account.",
        automatable: false,
      });

      const gui = facts.guiSession;
      const sessionReady =
        accountKnown && gui !== null && gui.uid === facts.targetUid && gui.kind === "Aqua";
      steps.push({
        id: "macos.session",
        state: sessionReady ? "done" : "needs-human",
        reason: sessionReady
          ? `the account has an Aqua session (asid ${String(gui.asid)})`
          : !accountKnown
            ? user === null
              ? "no target account was named, so its session cannot be looked for"
              : `the account ${user} could not be resolved, so its session cannot be looked for`
            : (facts.guiSessionFailure ??
              "the target account has no GUI session to run After Effects in"),
        action: sessionReady
          ? null
          : "Log in as the target account once (fast user switching is enough), then switch back. " +
            "The session must stay logged in while tests run.",
        automatable: false,
      });

      const separated =
        facts.targetUid !== null &&
        facts.consoleUid !== null &&
        facts.targetUid !== facts.consoleUid;
      steps.push({
        id: "macos.console-separation",
        state: separated ? "done" : "needs-human",
        reason: separated
          ? `the target uid ${String(facts.targetUid)} is not the console user ${String(facts.consoleUid)}`
          : facts.consoleUid === null
            ? "the console session owner could not be read, so separation cannot be proven"
            : `the target account is the console user (uid ${String(facts.consoleUid)}); tests would appear on the screen a person is using`,
        action: separated
          ? null
          : "Run tests in a separate OS account, or on a dedicated host; do not run them on the console desktop.",
        automatable: false,
      });

      const installs = facts.aeInstalls;
      const installed = installs.length === 1 && installs[0]?.version !== null;
      steps.push({
        id: "macos.ae",
        state: installed ? "done" : "needs-human",
        reason: installed
          ? `After Effects ${String(installs[0]?.version)} is installed at ${String(installs[0]?.location)}`
          : facts.installLookupFailure !== null
            ? `the installation folder could not be read: ${facts.installLookupFailure}`
            : installs.length === 0
              ? "no After Effects installation was found"
              : "more than one After Effects version is installed, so the version cannot be proven",
        action: installed
          ? null
          : installs.length === 0
            ? "Install After Effects for the target account."
            : "Disambiguate the installed After Effects versions, then run setup again.",
        automatable: false,
      });

      steps.push({
        id: "macos.permissions",
        state: "needs-human",
        reason:
          "Screen Recording and Accessibility must be granted in the target session; setup cannot " +
          "grant them and never writes TCC.db",
        action:
          "In the target session, open System Settings > Privacy & Security and allow Screen Recording " +
          "and Accessibility for the runner (the terminal or Node process that runs ae-a8n). Approve the " +
          "Automation prompt on the first run.",
        automatable: false,
      });

      steps.push({
        id: "macos.ae-scripting",
        state: "needs-human",
        reason:
          "After Effects only runs scripts that write files when its own scripting preference allows it",
        action:
          "In After Effects for the target account: Settings > Scripting & Expressions, enable " +
          '"Allow Scripts to Write Files and Access Network".',
        automatable: false,
      });

      steps.push({
        id: "macos.signin",
        state: "needs-human",
        reason: "Adobe sign-in is never automated and setup never reads or writes a credential",
        action: "Sign in to Adobe in the target account's interactive session.",
        automatable: false,
      });

      return steps;
    });
  }

  apply(
    steps: readonly SetupStep[],
    options: { readonly yes: boolean; readonly dryRun: boolean },
  ): Promise<SetupResult> {
    return Promise.resolve().then(() => {
      if (options.dryRun) {
        return {
          stateFile: this.#setupStateFile,
          outcomes: steps.map((step) => ({
            id: step.id,
            state: step.state === "planned" ? "planned" : step.state,
            detail: "dry run: nothing was changed",
          })),
        };
      }

      const state = readSetupState(this.#setupStateFile);
      if (!state.ok) {
        // A state file that exists but cannot be read is not "no state":
        // resetting it would silently forget what an earlier setup did.
        return {
          stateFile: this.#setupStateFile,
          outcomes: [
            { id: "macos.setup-state", state: "failed", detail: state.detail },
          ],
        };
      }

      const completed = new Set(state.completed);
      const outcomes: StepOutcome[] = [];
      let changed = false;
      for (const step of steps) {
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
        // `planned`: this increment has no automatable macOS step, so a
        // planned step that reached here is one the adapter cannot perform.
        outcomes.push({
          id: step.id,
          state: "failed",
          detail: `${step.reason}; setup cannot perform this step`,
        });
      }
      if (changed) {
        writeSetupState(this.#setupStateFile, completed);
      }
      return { stateFile: this.#setupStateFile, outcomes };
    });
  }

  open(target: TargetSpec): Promise<IsolatedSession> {
    return Promise.resolve().then(() => {
      const refresh = (): ResolvedSession =>
        resolveDarwinSession(this.#readFacts(target.user));
      return new DarwinSession(target, refresh(), this.#runCommand, refresh);
    });
  }

  recover(runDir: string): Promise<readonly RecoveryFinding[]> {
    return Promise.resolve([
      {
        code: "A8N-JOB-002",
        action: "reported",
        detail:
          `the macOS adapter cannot yet inspect a run for recovery (issue #59: ` +
          `T037/T039); nothing in ${runDir} was acted on and no lock was cleared`,
      },
    ]);
  }
}
