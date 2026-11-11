/**
 * The in-session agent entry point.
 *
 * It parses the identity flags, refuses to poll outside an interactive
 * session, and then runs at most one job at a time from the channel. The
 * `.mjs` wrapper stays thin; this module is the testable entry.
 */

import { join } from "node:path";

import { A8N_VERSION } from "../../version.js";
import type { JobKey } from "./auth.js";
import { assertInteractiveIdentity, runJob, type JobExecutor } from "./agent.js";
import { DirectoryChannel, type FileChannel } from "./channel.js";
import { SpawnJobExecutor, spawnProcess } from "./executor.js";
import { claimDiagnosticPath, isJobId, jobPaths, type AgentIdentity } from "./job.js";
import {
  PRESENCE_SCHEMA_VERSION,
  encodePresence,
  presencePath,
  signPresence,
} from "./presence.js";
import { loadKeyFile } from "./key-store.js";
import { measureWindowsSessionId, resolveSessionId } from "./session.js";

export type AgentMainDeps = {
  /** Injected in tests; otherwise a `DirectoryChannel` over `--channel`. */
  readonly channel?: FileChannel;
  /** Injected in tests; otherwise a `SpawnJobExecutor`. */
  readonly executor?: JobExecutor;
  /** Injected in tests; otherwise loaded from `--key-file`. */
  readonly key?: JobKey;
  /** Injected in tests; otherwise the OS measurement. */
  readonly measureSession?: () => number | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly maxAgeMs?: number;
  /** The marker secret; injected in tests, `randomBytes` otherwise. */
  readonly random?: (size: number) => Uint8Array;
  readonly signal?: AbortSignal;
  /** Diagnostics; defaults to `process.stderr`. */
  readonly stderr?: (text: string) => void;
};

type ParsedArguments = AgentIdentity & {
  readonly channelRoot: string;
  readonly keyFile: string;
};

type ParseResult =
  | { readonly ok: true; readonly value: ParsedArguments }
  | { readonly ok: false; readonly detail: string };

const FLAGS = new Set([
  "--channel",
  "--key-file",
  "--agent-id",
  "--host",
  "--user",
  "--session-id",
  "--version",
]);

export type AgentDefaults = {
  /** `--agent-id` when the flag is absent. */
  readonly agentId: string;
  /** `--version` when the flag is absent. */
  readonly version: string;
  /** `--session-id` when the flag is absent; null when none can be proved. */
  readonly sessionId: () => number | null;
};

/** The documented defaults: the command in the help runs as written. */
export function agentDefaults(measureSession?: () => number | null): AgentDefaults {
  return {
    agentId: "ae-a8n",
    version: A8N_VERSION,
    sessionId: measureSession ?? (() => null),
  };
}

function parseArguments(argv: readonly string[], defaults: AgentDefaults): ParseResult {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !FLAGS.has(flag)) {
      return { ok: false, detail: `unknown argument "${flag ?? ""}"` };
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      return { ok: false, detail: `${flag} needs a value` };
    }
    if (values.has(flag)) {
      return { ok: false, detail: `${flag} was given more than once` };
    }
    values.set(flag, value);
  }

  const required = ["--channel", "--key-file", "--host", "--user"] as const;
  for (const flag of required) {
    if (!values.has(flag)) {
      return { ok: false, detail: `${flag} is required` };
    }
  }

  // `--agent-id`, `--session-id` and `--version` are optional: the help says
  // they default, and the command in the setup plan omits them. They used to
  // be required anyway, so the documented command failed before it polled.
  const sessionRaw = values.get("--session-id");
  let sessionId: number;
  if (sessionRaw === undefined) {
    const measured = defaults.sessionId();
    if (measured === null) {
      return {
        ok: false,
        detail:
          "--session-id was not given and no interactive session could be measured; " +
          "the agent only runs in the signed-in session",
      };
    }
    sessionId = measured;
  } else {
    if (!/^\d+$/u.test(sessionRaw)) {
      return { ok: false, detail: "--session-id must be a non-negative integer" };
    }
    sessionId = Number(sessionRaw);
    if (!Number.isSafeInteger(sessionId)) {
      return { ok: false, detail: "--session-id is out of range" };
    }
  }

  return {
    ok: true,
    value: {
      channelRoot: values.get("--channel") ?? "",
      keyFile: values.get("--key-file") ?? "",
      id: values.get("--agent-id") ?? defaults.agentId,
      host: values.get("--host") ?? "",
      user: values.get("--user") ?? "",
      sessionId,
      version: values.get("--version") ?? defaults.version,
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
  const defaults = agentDefaults(deps.measureSession ?? measureWindowsSessionId);
  const parsed = parseArguments(argv, defaults);
  if (!parsed.ok) {
    stderr(`windows-agent: ${parsed.detail}\n`);
    return 2;
  }
  const { channelRoot, keyFile, ...claimedIdentity } = parsed.value;

  // The flag is a claim; the OS measurement is the fact. A session-0 task can
  // claim any number, so a mismatch or an unmeasurable session refuses.
  const measured = resolveSessionId(
    claimedIdentity.sessionId,
    deps.measureSession ?? measureWindowsSessionId,
  );
  if (!measured.ok) {
    stderr(`windows-agent: ${measured.detail}; nothing was polled\n`);
    return 1;
  }
  const identity: AgentIdentity = { ...claimedIdentity, sessionId: measured.sessionId };

  try {
    assertInteractiveIdentity(identity);
  } catch (error) {
    stderr(`windows-agent: ${messageOf(error)}\n`);
    return 1;
  }

  let key: JobKey;
  if (deps.key !== undefined) {
    key = deps.key;
  } else {
    const loaded = await loadKeyFile(keyFile);
    if (!loaded.ok) {
      stderr(`windows-agent: ${loaded.detail}; nothing was polled\n`);
      return 1;
    }
    key = loaded.key;
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

  const now = deps.now ?? (() => new Date());
  // The controller's only immediate evidence that an agent is alive, in which
  // session, at which version. Written before the first poll and refreshed
  // every poll; a controller that finds it stale refuses to send.
  const publishPresence = async (): Promise<void> => {
    const presence = signPresence(
      {
        schemaVersion: PRESENCE_SCHEMA_VERSION,
        agent: identity,
        heartbeatAt: now().toISOString(),
        interactive: identity.sessionId > 0,
      },
      key,
    );
    await channel.writeAtomic(presencePath(identity.id), encodePresence(presence));
  };
  try {
    await publishPresence();
  } catch (error) {
    stderr(`windows-agent: the heartbeat could not be written: ${messageOf(error)}\n`);
    return 1;
  }

  const stopped = (): boolean => deps.signal?.aborted === true;
  // A quarantined job stays quarantined for this process's lifetime: the
  // forensic record is written once, and polling never retries it.
  const quarantined = new Set<string>();

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
      if (quarantined.has(jobId)) {
        continue;
      }
      const result = await channel.read(jobPaths(jobId).result);
      if (result !== null) {
        continue;
      }
      try {
        const outcome = await runJob({
          channel,
          identity,
          executor,
          jobId,
          key,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          ...(deps.maxAgeMs === undefined ? {} : { maxAgeMs: deps.maxAgeMs }),
          ...(deps.random === undefined ? {} : { random: deps.random }),
        });
        if (outcome.state === "claim-unauthenticated") {
          quarantined.add(jobId);
          await channel.writeAtomic(
            claimDiagnosticPath(jobId),
            new TextEncoder().encode(
              `${JSON.stringify(
                {
                  jobId,
                  quarantinedAt: (deps.now ?? (() => new Date()))().toISOString(),
                  detail: outcome.detail,
                },
                null,
                2,
              )}\n`,
            ),
          );
          stderr(`windows-agent: job ${jobId} is quarantined: ${outcome.detail}\n`);
        }
      } catch (error) {
        stderr(`windows-agent: job ${jobId} could not be processed: ${messageOf(error)}\n`);
        return 1;
      }
    }

    if (stopped()) {
      return 0;
    }
    try {
      await publishPresence();
    } catch (error) {
      stderr(`windows-agent: the heartbeat could not be written: ${messageOf(error)}\n`);
      return 1;
    }
    await sleep(pollMs);
    if (stopped()) {
      return 0;
    }
  }
}
