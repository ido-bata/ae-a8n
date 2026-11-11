/**
 * The controller side of a real remote host.
 *
 * A `--host` target used to mean "the Windows adapter with a local tmpdir
 * channel": the probe ran `powershell.exe` on the controller and jobs were
 * written nowhere the host could see. Nothing crossed the network. This module
 * is the part that does.
 *
 * The transport is deliberately the channel that already existed — a
 * directory of signed job files — because it is the one the protocol,
 * quarantine and size limits are written against. What a remote target adds
 * is a channel root that is not the controller's tmpdir (an SMB share, or a
 * mount of one), a key file the host also has, and a signed heartbeat from the
 * agent before anything is submitted.
 *
 * The transport choice is not visible above this module: SMB, a mounted
 * share, or a local directory all appear as the same `FileChannel`. Nothing
 * here requires `herdr` or any other developer tool.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiagnosticCheck } from "../../doctor/diagnostics.js";
import { diagnostic } from "../../doctor/diagnostics.js";
import type { JobKey } from "./auth.js";
import { ChannelFileTooLargeError, type FileChannel } from "./channel.js";
import { channelAclVerdict, parseIcacls, type AccessControlEntry } from "./acl.js";
import { loadKeyFile } from "./key-store.js";
import { encodeJobPayload } from "./executor.js";
import { jobPaths, newJobId, sha256Hex, type AgentIdentity } from "./job.js";
import {
  checkPresence,
  presencePath,
  readPresenceBytes,
  type Presence,
  type PresenceVerdict,
} from "./presence.js";
import type { CommandResult, CommandRunner, ProbeCommand } from "./probe.js";
import { submitJob, type SubmitOptions, type SubmitResult } from "./remote.js";

/** The controller's submit seam; the same signature `WindowsAdapter` takes. */
export type SubmitFunction = (
  channel: FileChannel,
  options: SubmitOptions,
) => Promise<SubmitResult>;

export const HOST_CONFIG_SCHEMA_VERSION = "1.0";
export const DEFAULT_AGENT_ID = "ae-a8n";
export const HOST_CONFIG_PATH = join(homedir(), ".ae-a8n", "hosts.json");
/** A probe command is short; a longer answer is a host problem, not a fact. */
export const MAX_PROBE_OUTPUT_BYTES = 512 * 1024;

export type RemoteHostConfig = {
  readonly host: string;
  readonly user: string | null;
  /** The channel root as this controller sees it. */
  readonly channel: string;
  readonly keyFile: string;
  readonly agentId: string;
  /** Where Windows lives on the host; only unusual images need to set it. */
  readonly systemRoot: string;
};

export type HostConfigLoad =
  | { readonly ok: true; readonly config: RemoteHostConfig }
  | { readonly ok: false; readonly detail: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOST_FIELDS = new Set(["name", "user", "channel", "keyFile", "agentId", "systemRoot"]);
const DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const TOP_FIELDS = new Set(["schemaVersion", "hosts"]);

/**
 * Read one host's entry from a hosts file. Unknown fields are refused: a typo
 * in a channel path must fail loudly rather than silently select a default.
 */
export function decodeHostConfig(
  bytes: Uint8Array,
  host: string,
): HostConfigLoad {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf-8"));
  } catch {
    return { ok: false, detail: "the host configuration is not valid JSON" };
  }
  if (!isObject(parsed)) {
    return { ok: false, detail: "the host configuration is not an object" };
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_FIELDS.has(key)) {
      return { ok: false, detail: `unknown host configuration field "${key}"` };
    }
  }
  if (parsed["schemaVersion"] !== HOST_CONFIG_SCHEMA_VERSION) {
    return {
      ok: false,
      detail: `unsupported host configuration schema "${String(parsed["schemaVersion"])}"`,
    };
  }
  const hosts = parsed["hosts"];
  if (!Array.isArray(hosts)) {
    return { ok: false, detail: "the host configuration has no hosts array" };
  }
  const wanted = host.toLowerCase();
  for (const entry of hosts) {
    if (!isObject(entry)) {
      return { ok: false, detail: "a host entry is not an object" };
    }
    for (const key of Object.keys(entry)) {
      if (!HOST_FIELDS.has(key)) {
        return { ok: false, detail: `unknown host entry field "${key}"` };
      }
    }
    const name = entry["name"];
    if (typeof name !== "string" || name === "") {
      return { ok: false, detail: "a host entry has no name" };
    }
    if (name.toLowerCase() !== wanted) {
      continue;
    }
    const channel = entry["channel"];
    const keyFile = entry["keyFile"];
    const user = entry["user"] ?? null;
    const agentId = entry["agentId"] ?? DEFAULT_AGENT_ID;
    const systemRoot = entry["systemRoot"] ?? DEFAULT_SYSTEM_ROOT;
    if (typeof channel !== "string" || channel === "") {
      return { ok: false, detail: `host "${name}" has no channel path` };
    }
    if (typeof keyFile !== "string" || keyFile === "") {
      return { ok: false, detail: `host "${name}" has no key file` };
    }
    if (user !== null && typeof user !== "string") {
      return { ok: false, detail: `host "${name}" has a user that is not a string` };
    }
    if (typeof agentId !== "string" || agentId === "") {
      return { ok: false, detail: `host "${name}" has an agentId that is not a string` };
    }
    if (typeof systemRoot !== "string" || !/^[A-Za-z]:\\/u.test(systemRoot)) {
      return {
        ok: false,
        detail: `host "${name}" has a systemRoot that is not an absolute Windows path`,
      };
    }
    return { ok: true, config: { host: name, user, channel, keyFile, agentId, systemRoot } };
  }
  return { ok: false, detail: `the host configuration has no entry named "${host}"` };
}

export type CommsOptions = {
  /** The host name the target named. */
  readonly host: string;
  readonly user: string | null;
  /** Explicit channel root; otherwise the host configuration's. */
  readonly channel: string | null;
  /** Explicit key file; otherwise the host configuration's. */
  readonly keyFile: string | null;
  readonly agentId: string | null;
  /** Where the hosts file lives; injected in tests. */
  readonly configPath?: string;
};

export type CommsResolution =
  | {
      readonly ok: true;
      readonly config: RemoteHostConfig;
      /** Where the values came from, for `doctor --verbose`. */
      readonly source: "flags" | "config";
    }
  | { readonly ok: false; readonly detail: string };

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Resolve a remote target's connection settings.
 *
 * Flags win over the hosts file, but a channel or key path given by a flag does
 * not silently borrow the other half from the file: mixing them would pair one
 * host's key with another host's channel.
 */
export async function resolveComms(options: CommsOptions): Promise<CommsResolution> {
  const configPath = options.configPath ?? HOST_CONFIG_PATH;
  const anyFlag =
    options.channel !== null || options.keyFile !== null || options.agentId !== null;
  let fileConfig: RemoteHostConfig | null = null;
  if (options.channel === null || options.keyFile === null) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(configPath));
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown";
      return {
        ok: false,
        detail:
          `no channel was given and the host configuration ${configPath} could not be read (${code}). ` +
          "Pass --channel <dir> --key-file <file>, or write a hosts.json entry for this host.",
      };
    }
    const decoded = decodeHostConfig(bytes, options.host);
    if (!decoded.ok) {
      return decoded;
    }
    fileConfig = decoded.config;
  }
  if (anyFlag && options.channel !== null && options.keyFile === null) {
    return {
      ok: false,
      detail: "--channel was given without --key-file; jobs on a remote host cannot be authenticated without a key",
    };
  }
  if (anyFlag && options.keyFile !== null && options.channel === null) {
    // `fileConfig` cannot be null here in practice, but the check says what is
    // meant: a key given alone must not borrow the channel from the hosts
    // file, because the two may belong to different hosts.
    return {
      ok: false,
      detail: "--key-file was given without --channel; there is no channel to put a job in",
    };
  }
  const channel = options.channel ?? fileConfig?.channel ?? "";
  const keyFile = options.keyFile ?? fileConfig?.keyFile ?? "";
  const agentId = options.agentId ?? fileConfig?.agentId ?? DEFAULT_AGENT_ID;
  const systemRoot = fileConfig?.systemRoot ?? DEFAULT_SYSTEM_ROOT;
  const user = options.user ?? fileConfig?.user ?? null;
  if (channel === "" || keyFile === "") {
    return { ok: false, detail: "a remote target needs both a channel root and a key file" };
  }
  return {
    ok: true,
    config: {
      host: options.host,
      user,
      channel: expandHome(channel),
      keyFile: expandHome(keyFile),
      agentId,
      systemRoot,
    },
    source: options.channel !== null && options.keyFile !== null ? "flags" : "config",
  };
}

export type CommsState =
  | {
      readonly ok: true;
      readonly config: RemoteHostConfig;
      readonly key: JobKey;
      readonly channel: FileChannel;
      readonly agent: AgentIdentity;
      readonly presence: Presence;
      /** How long ago the agent's heartbeat was written. */
      readonly ageMs: number;
    }
  | { readonly ok: false; readonly checks: readonly DiagnosticCheck[]; readonly detail: string };

/** The OS's own ACL, or null when it cannot be read. */
async function defaultAclReader(path: string): Promise<readonly AccessControlEntry[] | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("icacls", [path], { windowsHide: true });
    return parseIcacls(stdout, path);
  } catch {
    return null;
  }
}

export type OpenCommsOptions = {
  readonly channel: FileChannel;
  readonly submit?: SubmitFunction;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly random?: (size: number) => Uint8Array;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The version this controller is; the agent must match exactly. */
  readonly version: string;
  /** Injected in tests. Defaults to `icacls` on Windows, unused elsewhere. */
  readonly acl?: (path: string) => Promise<readonly AccessControlEntry[] | null>;
};

/**
 * Assemble and verify everything a remote job depends on, before a job is
 * written: the channel is reachable, the key parses, the agent's heartbeat is
 * signed, fresh, interactive and names this host and user at this version.
 *
 * Every failure is one or more `checks`; there is no "probably fine" state.
 */
export async function openComms(
  options: OpenCommsOptions,
  resolution: CommsResolution,
  config: RemoteHostConfig,
): Promise<CommsState> {
  const now = options.now ?? (() => new Date());
  const checks: DiagnosticCheck[] = [];

  if (!resolution.ok) {
    return {
      ok: false,
      checks: [
        diagnostic("A8N-JOB-007", {
          detail: resolution.detail,
          remedy:
            "Pass --channel <dir> and --key-file <file>, or write a hosts.json entry for this host.",
          remedyKind: "human",
          evidence: { host: config.host },
        }),
      ],
      detail: resolution.detail,
    };
  }

  // 1. The channel must be there and writable from here. A mounted share that
  //    dropped looks exactly like this, and must not be mistaken for "no jobs".
  let reachable = false;
  try {
    reachable = await options.channel.isDirectory("");
  } catch {
    reachable = false;
  }
  if (!reachable) {
    const detail =
      `the channel root ${config.channel} is not a readable directory from this controller; ` +
      "a share that is not mounted, or a wrong path, is indistinguishable here";
    return {
      ok: false,
      checks: [
        diagnostic("A8N-JOB-007", {
          detail,
          remedy:
            "Mount or fix the channel (an SMB share both sides can read and write), then run doctor again.",
          remedyKind: "human",
          evidence: { channel: config.channel, host: config.host },
        }),
      ],
      detail,
    };
  }
  try {
    const probe = "setup/.controller-write-probe";
    await options.channel.createExclusive(probe, new Uint8Array());
    await options.channel.remove(probe);
  } catch {
    const detail = `the channel root ${config.channel} is not writable from this controller`;
    checks.push(
      diagnostic("A8N-JOB-007", {
        detail,
        remedy: "Grant this controller's account write access to the channel root, then run doctor again.",
        remedyKind: "human",
        evidence: { channel: config.channel },
      }),
    );
  }

  // 2. On Windows the channel's own ACL is the sticky-bit equivalent: an
  //    account that can write there can plant a job, so a channel left open
  //    to Users or Everyone is refused before the key is even considered.
  if (process.platform === "win32") {
    const readAcl = options.acl ?? defaultAclReader;
    const entries = await readAcl(config.channel);
    const verdict =
      entries === null
        ? { ok: false as const, detail: "the channel's access control list could not be read" }
        : channelAclVerdict(entries);
    if (!verdict.ok) {
      checks.push(
        diagnostic("A8N-PERM-006", {
          detail: `${verdict.detail}; channel ${config.channel}`,
          remedy:
            "Remove write access to the channel for every account but the controller's and the agent's, then run doctor again.",
          remedyKind: "human",
          evidence: { channel: config.channel },
        }),
      );
    }
  }

  // 3. The shared key. Without it a job would be unauthenticated, so nothing
  //    is sent — this is the same refusal the adapter already makes.
  const loaded = await loadKeyFile(
    config.keyFile,
    options.acl === undefined ? {} : { acl: options.acl },
  );
  if (!loaded.ok) {
    checks.push(
      // The refusal says which property failed: a key with a readable-by-others
      // ACL is A8N-PERM-005, not a missing-file A8N-JOB-003. Reporting every
      // failure as the latter buried the permission blocker.
      diagnostic(loaded.code, {
        detail: loaded.detail,
        remedy:
          "Provision the channel key for this host: copy the same key file the agent reads, readable only by you.",
        remedyKind: "human",
        evidence: { keyFile: config.keyFile },
      }),
    );
  }

  if (checks.length > 0) {
    return { ok: false, checks, detail: checks.map((check) => check.detail).join("; ") };
  }
  const key = (loaded as { ok: true; key: JobKey }).key;

  // 3. The agent's signed heartbeat: alive, interactive, this host, this
  //    version. Absent is not "idle" — it is an agent that is not running.
  let bytes: Uint8Array | null;
  try {
    bytes = await options.channel.read(presencePath(config.agentId));
  } catch (error) {
    const detail =
      error instanceof ChannelFileTooLargeError
        ? `the agent heartbeat is larger than the channel allows`
        : `the agent heartbeat could not be read: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ok: false,
      checks: [
        diagnostic("A8N-JOB-005", {
          detail,
          remedy: "Check the channel's permissions and the agent's log on the host.",
          remedyKind: "human",
          evidence: { agentId: config.agentId },
        }),
      ],
      detail,
    };
  }
  if (bytes === null) {
    const detail =
      `no heartbeat from agent "${config.agentId}" is in the channel; ` +
      "the agent is not running in an interactive session on the host";
    return {
      ok: false,
      checks: [
        diagnostic("A8N-JOB-005", {
          detail,
          remedy:
            "Start the agent on the host from a logged-in interactive session (setup names the exact command).",
          remedyKind: "human",
          evidence: { agentId: config.agentId, channel: config.channel },
        }),
      ],
      detail,
    };
  }
  const decoded = readPresenceBytes(bytes, [key]);
  if (!decoded.ok) {
    return {
      ok: false,
      checks: [
        diagnostic("A8N-JOB-003", {
          detail: `the agent heartbeat is not authentic: ${decoded.detail}`,
          remedy:
            "The controller and the agent disagree about the channel key, or the file was planted. " +
            "Re-provision the same key on both sides; nothing will be sent until they match.",
          remedyKind: "human",
          evidence: { agentId: config.agentId, keyFile: config.keyFile },
        }),
      ],
      detail: decoded.detail,
    };
  }
  const verdict: PresenceVerdict = checkPresence(
    decoded.presence,
    [key],
    { host: config.host, user: config.user, version: options.version },
    now(),
  );
  if (!verdict.ok) {
    return {
      ok: false,
      checks: [
        diagnostic(verdict.code, {
          detail: verdict.detail,
          remedy:
            verdict.code === "A8N-JOB-006"
              ? "Point --host/--user at the host the agent actually runs on, and install matching versions."
              : "Start, restart or upgrade the agent in the target's interactive session, then run doctor again.",
          remedyKind: "human",
          evidence: {
            agentId: config.agentId,
            host: verdict.code === "A8N-JOB-006" ? decoded.presence.agent.host : config.host,
          },
        }),
      ],
      detail: verdict.detail,
    };
  }
  return {
    ok: true,
    config,
    key,
    channel: options.channel,
    agent: decoded.presence.agent,
    presence: decoded.presence,
    ageMs: verdict.ageMs,
  };
}

/**
 * `CommandRunner` backed by the channel: every probe command is a signed job
 * the agent runs on the host. `probeWindows` is unchanged and still does not
 * know whether it is talking to a local or a remote machine.
 */
export class ChannelCommandRunner implements CommandRunner {
  constructor(
    private readonly state: Extract<CommsState, { ok: true }>,
    private readonly options: {
      readonly timeoutMs?: number;
      readonly submit?: SubmitFunction;
      readonly pollMs?: number;
      readonly now?: () => Date;
      readonly random?: (size: number) => Uint8Array;
      readonly sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  async run(command: ProbeCommand): Promise<CommandResult> {
    const { state, options } = this;
    // The payload contract requires an absolute program, and the agent runs on
    // the host: a bare "powershell.exe" would be refused, and accepting it
    // would let PATH decide which binary runs.
    const program = hostProgramPath(command.program, state.config.systemRoot);
    const now = options.now ?? (() => new Date());
    const random = options.random ?? (() => new Uint8Array([0, 0, 0, 0]));
    const runId = newJobId(now(), random(4));
    const submitted = await (options.submit ?? submitJob)(state.channel, {
      payload: encodeJobPayload({ argv: [program, ...command.args], env: {} }),
      runId,
      timeoutMs: options.timeoutMs ?? 60_000,
      writer: { host: state.agent.host, user: state.agent.user },
      key: state.key,
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    if (submitted.status === "refused" || submitted.status === "unknown") {
      throw new RemoteProbeError(
        submitted.status === "refused" ? "A8N-JOB-001" : "A8N-AE-004",
        submitted.message,
      );
    }
    const directory = jobPaths(submitted.jobId).resultDirectory;
    const stdout = await state.channel.read(`${directory}/stdout.log`);
    const stderr = await state.channel.read(`${directory}/stderr.log`);
    return {
      stdout: decodeUtf8(stdout, submitted.result.exitCode),
      stderr: decodeUtf8(stderr, submitted.result.exitCode),
      exitCode: submitted.result.exitCode ?? 1,
    };
  }
}

/**
 * Where a probe utility lives on the host. The controller never lets PATH pick
 * the program: an unknown bare name is refused rather than guessed.
 */
export function hostProgramPath(program: string, systemRoot: string): string {
  const root = systemRoot.replace(/[\\/]+$/u, "");
  switch (program.toLowerCase()) {
    case "powershell.exe":
      return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    case "tasklist.exe":
      return `${root}\\System32\\tasklist.exe`;
    case "net.exe":
      return `${root}\\System32\\net.exe`;
    default:
      if (/^[A-Za-z]:[\\/]/u.test(program)) {
        return program;
      }
      throw new RemoteProbeError(
        "A8N-JOB-001",
        `the probe command "${program}" is not a known Windows utility and not an absolute path; nothing was sent`,
      );
  }
}

/** A probe command that did not produce a usable answer on the host. */
export class RemoteProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteProbeError";
    this.code = code;
  }
}

function decodeUtf8(bytes: Uint8Array | null, exitCode: number | null): string {
  if (bytes === null) {
    return exitCode === null ? "" : "";
  }
  if (bytes.length > MAX_PROBE_OUTPUT_BYTES) {
    throw new RemoteProbeError(
      "A8N-JOB-004",
      `a probe command wrote ${String(bytes.length)} bytes, beyond the ${String(MAX_PROBE_OUTPUT_BYTES)}-byte limit`,
    );
  }
  return Buffer.from(bytes).toString("utf-8");
}

/** A stable description of a channel root, for an evidence record. */
export function describeChannel(channel: string): string {
  return createHash("sha256").update(channel).digest("hex").slice(0, 16);
}

export { sha256Hex };
