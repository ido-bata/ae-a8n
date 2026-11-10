/**
 * The in-session agent entry point.
 *
 * It parses the identity flags, refuses to poll outside an interactive
 * session, and then runs at most one job at a time from the channel. The
 * `.mjs` wrapper stays thin; this module is the testable entry.
 */

import { join } from "node:path";

import { assertInteractiveIdentity, runJob, type JobExecutor } from "./agent.js";
import { DirectoryChannel, type FileChannel } from "./channel.js";
import { SpawnJobExecutor, spawnProcess } from "./executor.js";
import { isJobId, jobPaths, type AgentIdentity } from "./job.js";

export type AgentMainDeps = {
  /** Injected in tests; otherwise a `DirectoryChannel` over `--channel`. */
  readonly channel?: FileChannel;
  /** Injected in tests; otherwise a `SpawnJobExecutor`. */
  readonly executor?: JobExecutor;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly maxAgeMs?: number;
  readonly signal?: AbortSignal;
  /** Diagnostics; defaults to `process.stderr`. */
  readonly stderr?: (text: string) => void;
};

type ParsedArguments = AgentIdentity & { readonly channelRoot: string };

type ParseResult =
  | { readonly ok: true; readonly value: ParsedArguments }
  | { readonly ok: false; readonly detail: string };

const FLAGS = new Set([
  "--channel",
  "--agent-id",
  "--host",
  "--user",
  "--session-id",
  "--version",
]);

function parseArguments(argv: readonly string[]): ParseResult {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !FLAGS.has(flag)) {
      return { ok: false, detail: `unknown argument "${flag ?? ""}"` };
    }
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, detail: `${flag} needs a value` };
    }
    if (values.has(flag)) {
      return { ok: false, detail: `${flag} was given more than once` };
    }
    values.set(flag, value);
  }

  const required = [
    "--channel",
    "--agent-id",
    "--host",
    "--user",
    "--session-id",
    "--version",
  ] as const;
  for (const flag of required) {
    if (!values.has(flag)) {
      return { ok: false, detail: `${flag} is required` };
    }
  }

  const sessionRaw = values.get("--session-id") ?? "";
  if (!/^\d+$/u.test(sessionRaw)) {
    return { ok: false, detail: "--session-id must be a non-negative integer" };
  }
  const sessionId = Number(sessionRaw);
  if (!Number.isSafeInteger(sessionId)) {
    return { ok: false, detail: "--session-id is out of range" };
  }

  return {
    ok: true,
    value: {
      channelRoot: values.get("--channel") ?? "",
      id: values.get("--agent-id") ?? "",
      host: values.get("--host") ?? "",
      user: values.get("--user") ?? "",
      sessionId,
      version: values.get("--version") ?? "",
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs until the signal aborts. Returns the process exit code: 0 on a clean
 * stop, non-zero when the arguments or the channel are unusable or a job
 * could not be claimed.
 */
export async function main(
  argv: readonly string[],
  deps: AgentMainDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? ((text: string) => void process.stderr.write(text));
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    stderr(`windows-agent: ${parsed.detail}\n`);
    return 2;
  }
  const { channelRoot, ...identity } = parsed.value;

  try {
    assertInteractiveIdentity(identity);
  } catch (error) {
    stderr(`windows-agent: ${messageOf(error)}\n`);
    return 1;
  }

  const channel = deps.channel ?? new DirectoryChannel(channelRoot);
  const executor: JobExecutor =
    deps.executor ??
    new SpawnJobExecutor({
      spawn: spawnProcess,
      runDirectory: join(channelRoot, "agent-runs"),
    });
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 1000;

  // Fail before entering the loop if the channel root or `jobs/` cannot be read.
  try {
    if (!(await channel.isDirectory(""))) {
      stderr("windows-agent: the channel root does not exist or is not a directory\n");
      return 1;
    }
    await channel.listDirectories("jobs");
  } catch (error) {
    stderr(`windows-agent: the channel could not be read: ${messageOf(error)}\n`);
    return 1;
  }

  const stopped = (): boolean => deps.signal?.aborted === true;

  for (;;) {
    let jobIds: readonly string[];
    try {
      jobIds = await channel.listDirectories("jobs");
    } catch (error) {
      stderr(`windows-agent: the channel could not be read: ${messageOf(error)}\n`);
      return 1;
    }

    for (const jobId of [...jobIds].sort()) {
      // A directory that is not a job id is not a job; never run it.
      if (!isJobId(jobId)) {
        continue;
      }
      const result = await channel.read(jobPaths(jobId).result);
      if (result !== null) {
        continue;
      }
      try {
        await runJob({
          channel,
          identity,
          executor,
          jobId,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.maxAgeMs === undefined ? {} : { maxAgeMs: deps.maxAgeMs }),
        });
      } catch (error) {
        stderr(`windows-agent: job ${jobId} could not be processed: ${messageOf(error)}\n`);
        return 1;
      }
    }

    if (stopped()) {
      return 0;
    }
    await sleep(pollMs);
    if (stopped()) {
      return 0;
    }
  }
}
