/**
 * Which macOS login session a process belongs to, and how to run something
 * inside another user's session.
 *
 * The reason this exists: Apple Events and the Accessibility API are both
 * session-scoped. `osascript "tell application …"` addresses the After Effects
 * of the *calling* session — the one that owns the console, or the one the
 * process was started in. A test that intends to drive the After Effects of a
 * second OS user but runs its Apple Event from the first user's session
 * therefore drives a *different* After Effects (or starts one), and any GUI
 * fallback that follows would click on the physical desktop.
 *
 * So the driver must know, before it sends anything:
 *
 *   - which OS user owns the session it wants to talk to (`uid`),
 *   - which login session that is (`asid`, the login session id), and
 *   - whether the process sending is inside that session at all.
 *
 * Everything here fails closed: an unknown session is never treated as "the
 * one we want".
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";

/** The kind of login session a uid has. */
export type MacSessionKind = "Aqua" | "Background" | "StandardIO" | "none";

export type MacSession = {
  /** The OS user the session belongs to. */
  readonly uid: number;
  /** The user's short name, for messages. */
  readonly username: string;
  /** The login session id. Null when the user has no session of this kind. */
  readonly asid: number | null;
  readonly kind: MacSessionKind;
};

/** A running application that owns a GUI connection. */
export type MacAppInstance = {
  /** The application name as the window server knows it (`Adobe After Effects 2026`). */
  readonly name: string;
  readonly pid: number;
  readonly uid: number;
  /** The login session id the application lives in. */
  readonly asid: number | null;
};

export class MacSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacSessionError";
  }
}

/**
 * The `launchctl print gui/<uid>` document, as far as it is needed.
 *
 * ```
 * gui/501 = {
 *     type = login
 *     handle = 100021
 *     session = Aqua
 *     …
 *         gui asid = 100021
 * ```
 */
export function parseLaunchctlGuiSession(text: string): { asid: number | null; kind: MacSessionKind } {
  const kindMatch = /^\s*session = (\w+)\s*$/m.exec(text);
  const asidMatch = /\b(?:gui )?asid = (\d+)/.exec(text);
  const kindText = kindMatch?.[1];
  const kind: MacSessionKind =
    kindText === "Aqua" || kindText === "Background" || kindText === "StandardIO" ? kindText : "none";
  return { asid: asidMatch === null ? null : Number(asidMatch[1]), kind };
}

/**
 * `lsappinfo list` as one entry per application.
 *
 * The line that carries the identity is the process line:
 *
 * ```
 *     pid = 689 token=[sess=100021 pid=689 uid:501,501,501 g:20,20 pV:1698] type="Foreground" …
 * ```
 *
 * `sess` is the login session id and `uid` the OS user, so one line answers
 * both questions the driver has about an application instance.
 */
export function parseLsappinfo(text: string): MacAppInstance[] {
  const apps: MacAppInstance[] = [];
  let name: string | null = null;
  for (const line of text.split("\n")) {
    const header = /^\s*\d+\) "(.*)" ASN:/.exec(line);
    if (header !== null) {
      name = header[1] as string;
      continue;
    }
    const entry = /^\s*pid = (\d+)(?: token=\[sess=(\d+) pid=\d+ uid:(\d+))?/.exec(line);
    if (entry === null || name === null) {
      continue;
    }
    apps.push({
      name,
      pid: Number(entry[1]),
      asid: entry[2] === undefined ? null : Number(entry[2]),
      uid: entry[3] === undefined ? -1 : Number(entry[3]),
    });
  }
  return apps;
}

/** The user name of a uid, or `uid-<n>` when the directory service has no name. */
export function readUsername(uid: number): string {
  try {
    const out = execFileSync("id", ["-un", String(uid)], { encoding: "utf-8" }).trim();
    return out.length > 0 ? out : `uid-${uid}`;
  } catch {
    return `uid-${uid}`;
  }
}

/**
 * The login session of a uid, as macOS reports it.
 *
 * Null when the user has no session in that domain: a user who is not logged
 * in has no Aqua session, and nothing can be delivered to them.
 */
export function readGuiSession(uid: number): MacSession | null {
  let text: string;
  try {
    text = execFileSync("launchctl", ["print", `gui/${uid}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const { asid, kind } = parseLaunchctlGuiSession(text);
  if (kind === "none" && asid === null) {
    return null;
  }
  return { uid, username: readUsername(uid), asid, kind };
}

/** The session of the user this process runs as. */
export function currentSession(): MacSession {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const session = readGuiSession(uid);
  return session ?? { uid, username: readUsername(uid), asid: null, kind: "none" };
}

/** Every application instance the window server knows, with its session. */
export function listAppInstances(): MacAppInstance[] {
  let text: string;
  try {
    text = execFileSync("lsappinfo", ["list"], {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  return parseLsappinfo(text);
}

/**
 * Whether this process can act inside `target`'s session.
 *
 * A process is inside a session when it runs as the session's user. macOS
 * gives a user at most one Aqua session, so the uid decides; the session id
 * is only the evidence.
 */
export function isInsideSession(target: MacSession): boolean {
  const self = currentSession();
  if (self.uid !== target.uid) {
    return false;
  }
  if (target.asid === null || self.asid === null) {
    // Without a session id on both sides the identity cannot be proven; the
    // caller must fail closed rather than assume.
    return false;
  }
  return target.asid === self.asid;
}

/** Whether this process is root, and may therefore enter another user's session. */
export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export type SessionCommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Runs a command inside `target`'s session.
 *
 * Two ways in, and nothing else:
 *
 *   - the process is already inside that session: the command runs directly;
 *   - the process is root: `launchctl asuser <uid>` enters the user's session
 *     for it.
 *
 * Anything else is refused. The failure that matters is the one this avoids:
 * a command meant for the isolated test session landing on the console
 * user's desktop.
 */
export function runInSession(
  target: MacSession,
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly input?: string } = {},
): SessionCommandResult {
  const inside = isInsideSession(target);
  let child: SessionCommandResult;
  if (inside) {
    child = run(command, args, options);
  } else if (isRoot()) {
    child = run("launchctl", ["asuser", String(target.uid), command, ...args], options);
  } else {
    throw new MacSessionError(
      `cannot run ${command} in the session of ${target.username} (uid ${target.uid}): this process runs as ` +
        `uid ${currentSession().uid} and is not root, so it cannot enter another user's session. ` +
        "Run the test from inside that user's session, or as root with launchctl asuser. " +
        "No command was sent to the console session.",
    );
  }
  return child;
}

/**
 * Starts a command inside `target`'s session, the same way `runInSession` does.
 *
 * The transport needs a child process rather than a blocking call: the
 * Apple Event it sends may take minutes to answer, and the caller's deadline
 * has to be able to stop *waiting* for it.
 */
export function spawnInSession(
  target: MacSession,
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly onStderr?: (chunk: string) => void;
    readonly onClose?: (code: number | null, stderr: string) => void;
    readonly onError?: (error: Error) => void;
  } = {},
): void {
  const inside = isInsideSession(target);
  let child: ChildProcess;
  if (inside) {
    child = spawn(command, [...args], {
      cwd: options.cwd ?? "/",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } else if (isRoot()) {
    child = spawn("launchctl", ["asuser", String(target.uid), command, ...args], {
      cwd: options.cwd ?? "/",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } else {
    throw new MacSessionError(
      `cannot run ${command} in the session of ${target.username} (uid ${target.uid}): this process runs as ` +
        `uid ${currentSession().uid} and is not root, so it cannot enter another user's session. ` +
        "Run the test from inside that user's session, or as root with launchctl asuser. " +
        "No command was sent to the console session.",
    );
  }
  let stderr = "";
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  });
  child.on("error", (error: Error) => options.onError?.(error));
  child.on("close", (code) => options.onClose?.(code, stderr));
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly input?: string },
): SessionCommandResult {
  try {
    const stdout = execFileSync(command, [...args], {
      encoding: "utf-8",
      timeout: options.timeoutMs ?? 30_000,
      input: options.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      status: typeof failure.status === "number" ? failure.status : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    };
  }
}
