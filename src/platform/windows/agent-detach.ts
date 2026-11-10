/**
 * `ae-a8n agent --hidden`: run the resident agent without a console window.
 *
 * The agent is a long-running background process. Started from a shortcut or a
 * logon task, `node.exe` brings a console window with it, and that window then
 * sits on the desktop for the life of the agent — or, with Windows Terminal as
 * the default terminal, it is handed to a terminal window the user did not ask
 * for. Hiding after the fact is not possible: the console belongs to the
 * process before any of its own code runs. So `--hidden` starts a second copy
 * of this process at creation time with `windowsHide` (CREATE_NO_WINDOW),
 * detached, and returns immediately.
 *
 * Nothing is swallowed: the agent's stdout and stderr go to one append-only
 * log, and its exit code is the log's last fact. A start that cannot happen is
 * reported on stderr and exits non-zero. The interactive form
 * (`ae-a8n agent …` with no `--hidden`) keeps its console, because a person
 * debugging the agent needs one.
 *
 * It lives in the Windows layer, not in `cli`, because it is the one thing
 * here that has to ask the OS what it is: a neutral layer that branched on
 * `process.platform` would be choosing behaviour the adapter is supposed to
 * own (`test/platform-neutral.test.ts`). The CLI calls this and reports its
 * answer; the refusal on a non-Windows host is the Windows backend's.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HIDDEN_FLAG = "--hidden";
export const LOG_FLAG = "--log";

/** Every flag the agent command accepts, with or without a value. */
export const AGENT_OPTIONS = new Set([
  "--channel",
  "--key-file",
  "--agent-id",
  "--host",
  "--user",
  "--session-id",
  "--version",
  HIDDEN_FLAG,
  LOG_FLAG,
]);

/** The flags a detached start needs before it can hand the work to a child. */
const REQUIRED = ["--channel", "--key-file", "--host", "--user"] as const;

export type DetachChild = {
  readonly pid: number | undefined;
  unref(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type DetachSpawnOptions = {
  readonly detached: true;
  readonly windowsHide: true;
  readonly stdio: ["ignore", number, number];
};

export type DetachDeps = {
  readonly spawn?: (
    program: string,
    args: readonly string[],
    options: DetachSpawnOptions,
  ) => DetachChild;
  readonly openLog?: (path: string) => number;
  readonly closeLog?: (fd: number) => void;
  readonly makeDirectory?: (path: string) => void;
  /** The CLI file the child re-runs; `process.argv[1]` by default. */
  readonly entry?: string;
  readonly platform?: NodeJS.Platform;
  readonly defaultLogPath?: () => string;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
};

/**
 * One log per account, appended across restarts. It is under the user's own
 * profile, next to `hosts.json`, so the agent never needs write access to a
 * shared channel just to say what happened.
 */
export function defaultAgentLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const local = env["LOCALAPPDATA"];
  const root = local === undefined ? join(homedir(), ".ae-a8n") : join(local, "ae-a8n");
  return join(root, "logs", "agent.log");
}

type Stripped = { readonly args: readonly string[]; readonly log: string | null };

/** Removes `--hidden` and `--log <file>`, which only this layer understands. */
function stripHiddenFlags(argv: readonly string[]): Stripped {
  const args: string[] = [];
  let log: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === HIDDEN_FLAG) {
      continue;
    }
    if (token === LOG_FLAG) {
      log = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token !== undefined) {
      args.push(token);
    }
  }
  return { args, log };
}

/** Pairs the remaining tokens and checks them without starting anything. */
function checkArguments(args: readonly string[]): string | null {
  const present = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !AGENT_OPTIONS.has(flag)) {
      return `unknown option ${flag ?? ""}`;
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      return `${flag} needs a value`;
    }
    present.add(flag);
  }
  for (const flag of REQUIRED) {
    if (!present.has(flag)) {
      return `${flag} is required`;
    }
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the hidden agent and returns this process's exit code.
 *
 * The returned code is about the *start*, not the agent: 0 means a child was
 * created with its output wired to the log. What the agent does next is in the
 * log file, which the caller is told about.
 */
export function detachAgent(argv: readonly string[], deps: DetachDeps = {}): number {
  const writeOut = deps.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = deps.writeErr ?? ((text: string) => void process.stderr.write(text));
  const platform = deps.platform ?? process.platform;

  if (platform !== "win32") {
    writeErr(
      "ae-a8n agent: --hidden exists to keep a Windows console window off the desktop; " +
        `on ${platform} run the agent under the service manager instead\n`,
    );
    return 2;
  }

  const { args, log } = stripHiddenFlags(argv);
  const problem = checkArguments(args);
  if (problem !== null) {
    writeErr(`ae-a8n agent: ${problem}; nothing was started\n`);
    return 2;
  }

  const entry = deps.entry ?? process.argv[1];
  if (entry === undefined || entry === "") {
    writeErr("ae-a8n agent: the CLI entry point is unknown; nothing was started\n");
    return 1;
  }

  const logPath = log ?? (deps.defaultLogPath ?? defaultAgentLogPath)();
  const openLog = deps.openLog ?? ((path: string) => openSync(path, "a", 0o600));
  const closeLog = deps.closeLog ?? ((fd: number) => closeSync(fd));
  let fd: number;
  try {
    (deps.makeDirectory ?? ((path: string) => mkdirSync(path, { recursive: true, mode: 0o700 })))(
      dirname(logPath),
    );
    fd = openLog(logPath);
  } catch (error) {
    writeErr(`ae-a8n agent: the log ${logPath} could not be opened: ${messageOf(error)}\n`);
    return 1;
  }

  const spawnChild =
    deps.spawn ??
    ((program: string, spawnArgs: readonly string[], options: DetachSpawnOptions) =>
      spawn(program, [...spawnArgs], options) as unknown as DetachChild);

  let child: DetachChild;
  try {
    child = spawnChild(process.execPath, [entry, "agent", ...args], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (error) {
    closeLog(fd);
    writeErr(`ae-a8n agent: the hidden agent could not be started: ${messageOf(error)}\n`);
    return 1;
  }
  // An error after a successful spawn must still be reported, not dropped.
  child.on("error", (error: Error) => {
    writeErr(`ae-a8n agent: the hidden agent failed: ${messageOf(error)}\n`);
  });
  child.unref();
  closeLog(fd);
  writeOut(
    `ae-a8n agent: started in the background (pid ${String(child.pid ?? "unknown")}); ` +
      `output: ${logPath}\n`,
  );
  return 0;
}
