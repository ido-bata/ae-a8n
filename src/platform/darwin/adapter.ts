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
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { NODE_FLOOR_MAJOR, nodeMajor } from "../../doctor/index.js";
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
  type ProbeIntent,
  type RecoveryFinding,
  type RunOptions,
  type SessionIdentity,
  type SetupResult,
  type SetupStep,
  type StepOutcome,
  type TargetSpec,
  UnprovenTargetError,
} from "../contract.js";
import {
  aePrefsDir,
  aeScriptingPermission,
  currentUsername,
} from "./scripting-permission.js";
import {
  deferredTccProbe,
  runTccProbe,
  type TccProbeResult,
} from "./tcc.js";

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
  /**
   * The selected install's "Allow Scripts To Write Files And Access Network"
   * preference, read from that account's AE prefs. `null` when it was not
   * evaluated: the target account is not the account doctor runs as, so its
   * prefs cannot be read honestly. "unreadable" means the prefs file or the
   * key could not be found — never treated as either allowed or blocked.
   */
  readonly aeScripting:
    | {
        readonly state: "allowed" | "blocked" | "unreadable";
        readonly prefsDir: string;
        readonly prefValue: string | null;
      }
    | null;
  /**
   * Whether the selected install carries the ExtendScript component at the
   * locations AE is known to use it. "present" means the files exist — not
   * that AE loads them (AE 2027 shipped `Scripting.plugin` yet ignored it,
   * G0 evidence 2026-11-16), so function is only proven by a real launch.
   * "absent" means none of the checked locations exist; "unproven" means the
   * question could not be answered honestly.
   */
  readonly aeScriptingComponent: {
    readonly state: "present" | "absent" | "unproven";
    /** The known component locations that exist. */
    readonly found: readonly string[];
    /** Every location checked; empty when no install could be resolved. */
    readonly checked: readonly string[];
  };
  /**
   * The per-user `Scripts/Startup` folder AE executes entries from, for the
   * selected install's version. Only the account doctor runs as can be
   * checked honestly; another account's `~/Library` is not read, so the
   * state is "unproven" there.
   */
  readonly aeStartupFolder: {
    readonly state: "present" | "absent" | "unproven";
    readonly path: string | null;
  };
  /**
   * The Screen Recording and Accessibility grant state for the session the
   * probe can honestly measure. Only the `local` intent runs the preflight
   * probe (it answers for the responsible process hosting ae-a8n); every
   * other intent defers to an in-session job (#57 T021) and stays
   * `unproven` — never guessed, never PASS.
   */
  readonly tccPermissions: TccProbeResult;
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

export { currentUsername };

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

/**
 * Read the facts the macOS doctor reports. Every command is read-only; the
 * caller never gets a value it did not observe.
 */
export function readDarwinFacts(
  user: string | null,
  exec: DarwinExec = runProcess,
  intent: ProbeIntent = "session",
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
  const selected = installs.installs.find((install) => install.selected) ?? null;
  const aeScripting = readAeScriptingPermission(installs.installs, targetUser);
  const aeScriptingComponent = readScriptingComponent(selected);
  const aeStartupFolder = readStartupFolder(selected, targetUser);
  // TCC grants belong to the session they were made in. Only the local
  // intent's session is the one this process runs in, so only it may run
  // the preflight probe; the isolated target's grants need an in-session
  // job and stay deferred (#57 T021/T025).
  const tccPermissions =
    intent === "local"
      ? runTccProbe(exec)
      : deferredTccProbe(
          "the target account's TCC grants can only be probed inside its own session",
        );

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
    tccPermissions:
      `screen=${tccPermissions.screenRecording.state};` +
      `ax=${tccPermissions.accessibility.state};` +
      `via=${tccPermissions.mechanism}`,
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
    aeScripting,
    aeScriptingComponent,
    aeStartupFolder,
    tccPermissions,
    evidence,
  };
}

/** The locations the ExtendScript component is known to occupy, per install. */
function scriptingComponentCandidates(install: DarwinAeInstall): readonly string[] {
  const bundle = join(install.location, `${basename(install.location)}.app`);
  return [
    join(install.location, "Plug-ins", "Keyframe", "Scripting.plugin"),
    join(bundle, "Contents", "Frameworks", "extendscript.framework"),
    join(bundle, "Contents", "Frameworks", "dvascripting.framework"),
  ];
}

/**
 * lstat that separates "missing" (ENOENT/ENOTDIR) from "could not look" —
 * `existsSync` answers false for both, and a permission error must never
 * read as an absent component.
 */
function pathPresence(path: string): "present" | "absent" | "unreadable" {
  try {
    statSync(path);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
  }
}

/**
 * Read-only check for the ExtendScript component inside the selected
 * install. File presence is the only thing a read-only probe can measure;
 * whether AE actually loads the component is proven only by a launch, so a
 * "present" result still feeds an unproven diagnostic.
 */
export function readScriptingComponent(
  install: DarwinAeInstall | null,
): DarwinFacts["aeScriptingComponent"] {
  if (install === null) {
    return { state: "unproven", found: [], checked: [] };
  }
  const candidates = scriptingComponentCandidates(install);
  const found: string[] = [];
  let unreadable = false;
  for (const path of candidates) {
    const presence = pathPresence(path);
    if (presence === "present") {
      found.push(path);
    } else if (presence === "unreadable") {
      unreadable = true;
    }
  }
  if (unreadable) {
    return { state: "unproven", found, checked: candidates };
  }
  return { state: found.length > 0 ? "present" : "absent", found, checked: candidates };
}

/**
 * The per-user `Scripts/Startup` folder for the selected install's version,
 * for the account doctor runs as. Another account's prefs cannot be read
 * honestly, so the state stays "unproven" — the same rule
 * `readAeScriptingPermission` follows.
 */
export function readStartupFolder(
  install: DarwinAeInstall | null,
  targetUser: string | null,
): DarwinFacts["aeStartupFolder"] {
  if (install === null || install.version === null || targetUser !== currentUsername()) {
    return { state: "unproven", path: null };
  }
  const prefsDir = aePrefsDir(install.version);
  if (prefsDir === null) {
    return { state: "unproven", path: null };
  }
  const dir = join(prefsDir, "Scripts", "Startup");
  const presence = pathPresence(dir);
  if (presence === "present") {
    try {
      return { state: statSync(dir).isDirectory() ? "present" : "unproven", path: dir };
    } catch {
      return { state: "unproven", path: dir };
    }
  }
  return { state: presence === "absent" ? "absent" : "unproven", path: dir };
}

/**
 * `Pref_SCRIPTING_FILE_NETWORK_SECURITY` for the selected install, from the
 * target account's own AE prefs. The evaluation itself lives in
 * `scripting-permission.ts`, shared with the script-invocation transport's
 * launch check so the two cannot disagree about what "blocked" means.
 */
export function readAeScriptingPermission(
  installs: readonly DarwinAeInstall[],
  targetUser: string | null,
): DarwinFacts["aeScripting"] {
  const selected = installs.find((install) => install.selected) ?? null;
  return aeScriptingPermission(selected?.version ?? null, targetUser);
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
    // This adapter starts no After Effects and its close() quits nothing, so
    // no attached instance can ever be quit through it (#129).
    quitsOnlyOwned: true,
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
export function probeDarwin(
  facts: DarwinFacts,
  intent: ProbeIntent = "session",
): DarwinProbeResult {
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

  // Session-separation checks describe the isolated-session path only. A
  // local probe (`AfterEffects.launch` in the caller's own session) targets
  // exactly the session these checks would refuse, so they are not emitted
  // for it; `doctor --user`/`--host` and `test`/`setup` keep them.
  const sessionIntent = intent === "session";

  if (sessionIntent && (facts.targetUser === null || facts.targetUid === null)) {
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

  if (sessionIntent && facts.targetUid !== null) {
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

  if (sessionIntent && facts.consoleUid === null) {
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
  } else if (sessionIntent && facts.targetUid !== null && facts.targetUid === facts.consoleUid) {
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

  if (facts.aeScripting?.state === "blocked") {
    checks.push(
      diagnostic("A8N-PERM-003", {
        detail:
          `After Effects script file/network access is off for ${selected?.location ?? "the selected install"} ` +
          `(Pref_SCRIPTING_FILE_NETWORK_SECURITY = "${facts.aeScripting.prefValue ?? "?"}" in ` +
          `${facts.aeScripting.prefsDir}); every script-driven call, including the readiness probe, will time out`,
        remedy:
          "In After Effects for this account: Settings > Scripting & Expressions, enable " +
          '"Allow Scripts to Write Files and Access Network", then re-run doctor. ' +
          "Doctor reports the state; it never changes AE preferences itself.",
        remedyKind: "human",
        evidence: {
          prefsDir: facts.aeScripting.prefsDir,
          prefValue: facts.aeScripting.prefValue,
        },
      }),
    );
  }

  // TCC grants (permissions.md §1, rows Screen Recording / Accessibility).
  // A measured denial is a blocker; a state that could not be measured is a
  // warning — never a pass, and a deferred probe is reported as unproven
  // rather than silently skipped.
  const tcc = facts.tccPermissions;
  const tccRows = [
    {
      probe: tcc.screenRecording,
      code: "A8N-PERM-001" as const,
      name: "Screen Recording",
      consequence:
        "window titles and screenshots will be unavailable to the GUI checks",
      setting: "Screen Recording",
    },
    {
      probe: tcc.accessibility,
      code: "A8N-PERM-002" as const,
      name: "Accessibility",
      consequence: "AX reads used by GUI recovery will fail",
      setting: "Accessibility",
    },
  ];
  const tccUnproven: string[] = [];
  for (const row of tccRows) {
    if (row.probe.state === "denied") {
      checks.push(
        diagnostic(row.code, {
          detail:
            `${row.name} is not granted to the responsible process hosting ae-a8n ` +
            `(measured by ${tcc.mechanism}); ${row.consequence}`,
          remedy:
            `System Settings > Privacy & Security > ${row.setting}: enable it for the ` +
            "terminal or app that runs ae-a8n, then re-run doctor. Doctor reports the " +
            "state; it never changes TCC itself.",
          remedyKind: "human",
          evidence: {
            permission: row.name,
            state: row.probe.state,
            mechanism: tcc.mechanism,
          },
        }),
      );
    } else if (row.probe.state === "unproven") {
      tccUnproven.push(`${row.name} (${row.probe.detail ?? "unproven"})`);
    }
  }
  if (tccUnproven.length > 0) {
    checks.push(
      diagnostic("A8N-PERM-009", {
        detail:
          `the TCC grant state could not be determined for: ${tccUnproven.join("; ")}` +
          ` (mechanism: ${tcc.mechanism}). An unmeasured permission is reported, never passed.`,
        remedy:
          tcc.mechanism === "deferred"
            ? "These grants belong to the target session; the guided setup probes them " +
              "inside that session (#57). Until then the state stays unproven."
            : "Re-run doctor. If it persists, install the Command Line Tools so the " +
              "preflight probe can run; doctor never guesses a grant.",
        remedyKind: "human",
        evidence: {
          screenRecording: tcc.screenRecording.state,
          accessibility: tcc.accessibility.state,
          mechanism: tcc.mechanism,
        },
      }),
    );
  }

  // The remaining script-invocation prerequisites apply to both intents:
  // the isolated path and `AfterEffects.launch` run the same kind of script
  // through the same AE gates. Each is reported as measured or "unproven" —
  // never guessed.
  const installKnown = selected !== null && selected.version !== null;

  if (installKnown && (facts.aeScripting === null || facts.aeScripting.state === "unreadable")) {
    checks.push(
      diagnostic("A8N-PERM-007", {
        detail:
          facts.aeScripting === null
            ? "the script file/network preference could not be evaluated for this account " +
              "(another account's prefs are not readable, or no install version resolved); " +
              "whether scripts may write files and use the network is unproven"
            : `the script file/network preference could not be read ` +
              `(${facts.aeScripting.prefsDir}); whether scripts may write files and ` +
              "use the network is unproven — it is not treated as either allowed or blocked",
        remedy:
          "Enable \"Allow Scripts to Write Files and Access Network\" in After Effects " +
          "(Settings > Scripting & Expressions) for the account that runs AE, then re-run doctor.",
        remedyKind: "human",
        evidence: {
          state: facts.aeScripting === null ? "not-evaluated" : facts.aeScripting.state,
          prefsDir: facts.aeScripting?.prefsDir ?? null,
        },
      }),
    );
  }

  if (installKnown) {
    // Script-trust approval (AE 26.5+ refuses DoScriptFile from locations a
    // human has not approved, with -1708 and a modal). Where the approval
    // is recorded and at what granularity is still being measured (#125),
    // so the honest state is "unproven" — the evidence fields are shaped to
    // carry a measured verdict when the tooling lands.
    checks.push(
      diagnostic("A8N-PERM-008", {
        detail:
          `whether After Effects ${selected.version} will run scripts from this package's ` +
          "session folder without a per-location approval cannot be verified without " +
          "launching AE; on AE 26.5+ an unapproved script is refused (-1708) with a modal. " +
          "The approval granularity (folder vs script) is unproven (#125).",
        remedy:
          "On the first launch, approve the session's staging folder in After Effects " +
          "(Settings > Scripting & Expressions) when AE prompts. Until the approval " +
          "granularity is measured, a new session directory may need its own approval; " +
          "keep one sessionRoot per project to minimise prompts.",
        remedyKind: "human",
        evidence: {
          state: "unproven",
          approvalGranularity: "unproven",
          aeVersion: selected.version ?? null,
        },
      }),
    );
  }

  // The component check needs only a resolved install, not a readable
  // version: an absent component is a blocker either way.
  if (selected !== null) {
    const component = facts.aeScriptingComponent;
    if (component.state === "absent") {
      checks.push(
        diagnostic("A8N-AE-006", {
          detail:
            `none of the known ExtendScript component locations exist under ${selected.location} ` +
            `(${component.checked.join("; ")}); After Effects cannot run scripts without it ` +
            "(observed on AE 2027, docs/evidence/g0-startup-2026-11-16)",
          remedy:
            "Repair or reinstall After Effects through Creative Cloud so the scripting " +
            "component is present, then re-run doctor.",
          remedyKind: "human",
          evidence: { install: selected.location, checked: component.checked.join("; ") },
        }),
      );
    } else {
      // "present" and "unproven" share the warning: neither proves the
      // component loads, and the remedy is the same real-launch check.
      checks.push(
        diagnostic("A8N-AE-007", {
          detail:
            component.state === "present"
              ? `ExtendScript component files exist under ${selected.location}, but presence ` +
                "does not prove After Effects loads them (AE 2027 shipped the plugin file " +
                "yet ignored it); only a real launch proves the component works"
              : `the ExtendScript component locations under ${selected.location} could not ` +
                "be checked, so whether the scripting component is usable is unproven",
          remedy:
            "Launch After Effects once and run a trivial script; if AE reports the " +
            "scripting plugin is not installed, repair the install through Creative Cloud.",
          remedyKind: "human",
          evidence: {
            state: component.state,
            found: component.found.join("; "),
          },
        }),
      );
    }

    if (installKnown) {
      const startup = facts.aeStartupFolder;
      checks.push(
        diagnostic("A8N-AE-008", {
          detail:
            `per-user Scripts/Startup folder for AE ${selected.version}: ` +
            (startup.state === "present"
              ? `present at ${startup.path}`
              : startup.state === "absent"
                ? `absent at ${startup.path}; whether AE creates it on demand is unverified`
                : "unproven") +
            ". Startup-folder execution is proven on macOS AE 26.5 " +
            "(docs/evidence/g0-startup-2026-11-16) and unproven on Windows and other versions.",
          remedy:
            "No action for AfterEffects.launch — the folder matters only for the in-AE " +
            "dispatcher transport (#127).",
          remedyKind: "none",
          evidence: {
            state: startup.state,
            path: startup.path,
            aeVersion: selected.version ?? null,
          },
        }),
      );
    }
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
  } else if (facts.aeProcesses.length > 0 && intent === "local") {
    // Local mode attaches to a running After Effects on purpose; it is not
    // the "another AE on the target" collision the isolated path refuses.
    checks.push(
      diagnostic("A8N-AE-009", {
        detail:
          `After Effects is already running: ${describeProcesses(facts.aeProcesses)}; ` +
          "a local launch attaches to it and reports ownership \"attached\"",
        remedy:
          "Nothing to do — AfterEffects.launch reuses the running instance and " +
          "close() will not quit it. Quit AE yourself first only if you want a fresh instance.",
        remedyKind: "none",
        evidence: { processes: facts.evidence["aeProcesses"] ?? "" },
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
  /**
   * Test seam: replaces the read-only probe. Never called with side effects.
   * `intent` is the probe intent so facts that are only honest for one
   * session (the TCC preflight probe) are not measured for another.
   */
  readonly readFacts?: (user: string | null, intent: ProbeIntent) => DarwinFacts;
  /** Test seam: replaces the in-session command runner. */
  readonly runCommand?: DarwinRunCommand;
  /** Test seam: where setup records completed step ids. Never holds secrets. */
  readonly setupStateFile?: string;
  /**
   * Test seam: the isolated-session shared root `recover` reports on.
   * Defaults to `/Users/Shared/ae-a8n`.
   */
  readonly sharedSessionRoot?: string;
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

  readonly #readFacts: (user: string | null, intent: ProbeIntent) => DarwinFacts;
  readonly #runCommand: DarwinRunCommand;
  readonly #setupStateFile: string;
  readonly #sharedSessionRoot: string;

  constructor(options: DarwinAdapterOptions = {}) {
    this.#readFacts =
      options.readFacts ?? ((user, intent) => readDarwinFacts(user, runProcess, intent));
    this.#runCommand = options.runCommand ?? defaultRunCommand;
    this.#setupStateFile = options.setupStateFile ?? MAC_SETUP_STATE_FILE;
    this.#sharedSessionRoot = options.sharedSessionRoot ?? "/Users/Shared/ae-a8n";
  }

  capabilities(): Promise<Capabilities> {
    return Promise.resolve(darwinCapabilities());
  }

  probe(target: TargetSpec, intent: ProbeIntent = "session"): Promise<DarwinProbeResult> {
    // The probe is synchronous and read-only; it cannot start AE or open a
    // session. Wrapping the call keeps a failure a rejection, as the contract
    // promises, instead of a synchronous throw.
    return Promise.resolve().then(() =>
      probeDarwin(this.#readFacts(target.user, intent), intent),
    );
  }

  plan(target: TargetSpec): Promise<readonly SetupStep[]> {
    return Promise.resolve().then(() => {
      const facts = this.#readFacts(target.user, "session");
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
      // The same four measurements `probeDarwin` makes, in the same order: an
      // Aqua session whose id could not be read is not ready (the probe
      // reports it as A8N-SESSION-002 and the identity is left unproven), and
      // a non-Aqua session is named as that rather than as "no session".
      const loginOnce =
        "Log in as the target account once (fast user switching is enough), then switch back. " +
        "The session must stay logged in while tests run.";
      const sessionProblem =
        !accountKnown
          ? user === null
            ? "no target account was named, so its session cannot be looked for"
            : `the account ${user} could not be resolved, so its session cannot be looked for`
          : gui === null
            ? (facts.guiSessionFailure ??
              "the target account has no GUI session to run After Effects in")
            : gui.uid !== facts.targetUid
              ? `the session found belongs to uid ${String(gui.uid)}, not the target account`
              : gui.kind !== "Aqua"
                ? `the account has a ${gui.kind} session, not an Aqua GUI session`
                : gui.asid === null
                  ? "the account has an Aqua session, but its session id (asid) could not be read"
                  : null;
      steps.push({
        id: "macos.session",
        state: sessionProblem === null ? "done" : "needs-human",
        reason: sessionProblem ?? `the account has an Aqua session (asid ${String(gui?.asid)})`,
        action:
          sessionProblem === null
            ? null
            : accountKnown &&
                gui !== null &&
                gui.uid === facts.targetUid &&
                gui.kind === "Aqua" &&
                gui.asid === null
              ? "Re-run setup. If the session id is still unreadable, log the target account out and " +
                "in again; setup never uses a session it cannot identify."
              : loginOnce,
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
              : installs.length === 1
                ? `After Effects was found at ${String(installs[0]?.location)} but its version could not be read`
                : "more than one After Effects version is installed, so the version cannot be proven",
        action: installed
          ? null
          : installs.length === 0
            ? "Install After Effects for the target account."
            : installs.length === 1
              ? "Check that installation's version metadata, or reinstall it."
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

      const scripting = facts.aeScripting;
      steps.push({
        id: "macos.ae-scripting",
        state: scripting?.state === "allowed" ? "done" : "needs-human",
        reason:
          scripting?.state === "allowed"
            ? `script file/network access is already allowed (${scripting.prefsDir})`
            : scripting?.state === "blocked"
              ? `script file/network access is off for the selected install (${scripting.prefsDir}); ` +
                "every script-driven call will time out until it is enabled"
              : "After Effects only runs scripts that write files when its own scripting preference allows it",
        action:
          scripting?.state === "allowed"
            ? null
            : "In After Effects for the target account: Settings > Scripting & Expressions, enable " +
              '"Allow Scripts to Write Files and Access Network". If scripts still do not run, ' +
              "the AE scripting component itself may be missing (observed on AE 2027) — reinstall or " +
              "repair After Effects through Creative Cloud.",
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
            state: step.state,
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
        resolveDarwinSession(this.#readFacts(target.user, "session"));
      return new DarwinSession(target, refresh(), this.#runCommand, refresh);
    });
  }

  recover(runDir: string): Promise<readonly RecoveryFinding[]> {
    // Everything below is synchronous and read-only; wrapping it keeps a
    // failure a rejection, as the contract promises.
    return Promise.resolve().then(() => {
    const findings: RecoveryFinding[] = [];

    // 1. The run directory, listed read-only. `recover-run` already handles
    //    report.json; anything else at the top level is a leftover this tool
    //    did not write, and it is reported — never deleted.
    const knownEntries = new Set([
      "manifest.json",
      "report.json",
      "trace.jsonl",
      "artifacts",
    ]);
    try {
      const leftovers = readdirSync(runDir, { withFileTypes: true })
        .map((entry) => entry.name)
        .filter((name) => !knownEntries.has(name));
      if (leftovers.length > 0) {
        findings.push({
          code: "A8N-JOB-002",
          action: "reported",
          detail:
            `the run directory ${runDir} holds entries this tool did not write: ` +
            leftovers.join(", "),
          remedy: "Inspect them yourself; recovery reports leftovers and never deletes them.",
        });
      }
    } catch (error) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `the run directory could not be listed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    // 2. What the platform can see: After Effects processes are reported
    //    with their uid. Recovery never quits one — an unowned AE is the
    //    human's call (T037).
    const facts = this.#readFacts(null, "session");
    if (!facts.aeProcessesReadable) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `the process list could not be read (${
          facts.aeProcessesFailure ?? "unknown"
        }); whether an After Effects from the run is still alive is unproven`,
      });
    } else if (facts.aeProcesses.length > 0) {
      const list = facts.aeProcesses
        .map((entry) => `pid ${entry.pid} uid ${entry.uid}`)
        .join(", ");
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail:
          `${facts.aeProcesses.length} After Effects process(es) are running (${list}); ` +
          "recovery never quits an unowned After Effects",
        remedy:
          "If the recovered run is finished, quit After Effects yourself; " +
          "the next run refuses while one is alive.",
      });
    }

    // 3. Scope note: leftovers of the isolated-session shared root
    //    (/Users/Shared/ae-a8n — stale jobs, orphan agents, cancelled runs)
    //    are inspected by the repository status/prune tool, not by this
    //    command. Reported only when that root actually exists, so a machine
    //    that never ran an isolated session is not told to go look.
    if (existsSync(this.#sharedSessionRoot)) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail:
          `the isolated-session shared root ${this.#sharedSessionRoot} exists; its stale jobs, ` +
          "orphan agents and interrupted runs are inspected by " +
          "scripts/isolated-session/run-in-isolated-session.mjs status|prune, which this " +
          "command does not drive",
        remedy:
          "Run `node scripts/isolated-session/run-in-isolated-session.mjs status --user <account>` " +
          "to inspect it; `prune --dry-run` shows what may be removed.",
      });
    }

    if (findings.length === 0) {
      findings.push({
        code: "A8N-JOB-002",
        action: "reported",
        detail: `nothing platform-specific was found for ${runDir}`,
      });
    }
    return findings;
    });
  }
}
