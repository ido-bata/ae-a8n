/**
 * Argument parsing for the five commands in `contracts/cli.md` §3.
 *
 * Parsing is deliberately strict: an unknown flag is a usage error (exit 2),
 * not something ignored. The user asked for `--user` and `--host` in addition
 * to the contract's `--target`; `--host` selects the Windows backend and
 * `--user` names the account the target session must belong to.
 */

import { RUN_ID_PATTERN } from "../runner/run-id.js";

export const COMMANDS = ["doctor", "setup", "test", "recover", "report"] as const;
export type CommandName = (typeof COMMANDS)[number];

export type CommonOptions = {
  readonly json: boolean;
  readonly help: boolean;
  readonly target: string | null;
  readonly user: string | null;
  readonly host: string | null;
  /** The channel root this controller uses to reach a named host. */
  readonly channel: string | null;
  /** The shared channel key; the same file the agent reads. */
  readonly keyFile: string | null;
  /** The agent id whose heartbeat the controller verifies. */
  readonly agentId: string | null;
  /** Where host connection settings live; `~/.ae-a8n/hosts.json` by default. */
  readonly hostConfig: string | null;
};

export type DoctorOptions = CommonOptions & {
  readonly verbose: boolean;
};

export type SetupOptions = CommonOptions & {
  readonly yes: boolean;
  readonly resume: boolean;
  readonly dryRun: boolean;
};

export type TestOptions = CommonOptions & {
  readonly timeoutMs: number | null;
  readonly keep: boolean;
  readonly command: readonly string[];
};

export type RecoverOptions = CommonOptions & {
  readonly runId: string | null;
  readonly dryRun: boolean;
  /** Permits clearing a quarantine; never implied by anything else. */
  readonly force: boolean;
};

export type ReportOptions = {
  readonly json: boolean;
  readonly help: boolean;
  readonly runId: string | null;
  readonly format: "summary" | "json" | "junit";
};

export type CommandOptions =
  | DoctorOptions
  | SetupOptions
  | TestOptions
  | RecoverOptions
  | ReportOptions;

export type ParsedArgs =
  | {
      readonly ok: true;
      readonly kind: "command";
      readonly command: CommandName;
      readonly options: CommandOptions;
    }
  | {
      readonly ok: true;
      readonly kind: "help";
      readonly command: CommandName | null;
      readonly json: boolean;
    }
  | { readonly ok: true; readonly kind: "version"; readonly json: boolean }
  | { readonly ok: false; readonly error: string; readonly json: boolean };

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

function usage(error: string, json: boolean): ParsedArgs {
  return { ok: false, error, json };
}

const BOOLEAN_FLAGS = new Set([
  "--json",
  "--verbose",
  "--yes",
  "--resume",
  "--dry-run",
  "--keep",
  "--force",
]);

const VALUE_FLAGS = new Set([
  "--target",
  "--user",
  "--host",
  "--timeout",
  "--run",
  "--format",
  "--channel",
  "--key-file",
  "--agent-id",
  "--host-config",
]);

/** The flags that describe how a named host is reached. */
const CONNECTION_FLAGS = ["--channel", "--key-file", "--agent-id", "--host-config"] as const;

/** Which flags each command accepts. `--json` and `--help` are common. */
const ALLOWED: Record<CommandName, ReadonlySet<string>> = {
  doctor: new Set([
    "--json",
    "--help",
    "-h",
    "--target",
    "--user",
    "--host",
    "--verbose",
    ...CONNECTION_FLAGS,
  ]),
  setup: new Set([
    "--json",
    "--help",
    "-h",
    "--target",
    "--user",
    "--host",
    "--yes",
    "--resume",
    "--dry-run",
    ...CONNECTION_FLAGS,
  ]),
  test: new Set([
    "--json",
    "--help",
    "-h",
    "--target",
    "--user",
    "--host",
    "--timeout",
    "--keep",
    ...CONNECTION_FLAGS,
  ]),
  recover: new Set([
    "--json",
    "--help",
    "-h",
    "--target",
    "--user",
    "--host",
    "--run",
    "--dry-run",
    "--force",
    ...CONNECTION_FLAGS,
  ]),
  report: new Set(["--json", "--help", "-h", "--run", "--format"]),
};

type Mutable = {
  json: boolean;
  help: boolean;
  target: string | null;
  user: string | null;
  host: string | null;
  channel: string | null;
  keyFile: string | null;
  agentId: string | null;
  hostConfig: string | null;
  verbose: boolean;
  yes: boolean;
  resume: boolean;
  dryRun: boolean;
  keep: boolean;
  force: boolean;
  timeoutMs: number | null;
  runId: string | null;
  /** Tracked separately: `--json` and `--format` are mutually exclusive. */
  formatGiven: boolean;
  format: "summary" | "json" | "junit";
};

function optionsFor(command: CommandName, state: Mutable): CommandOptions {
  switch (command) {
    case "doctor":
      return {
        json: state.json,
        help: state.help,
        target: state.target,
        user: state.user,
        host: state.host,
        channel: state.channel,
        keyFile: state.keyFile,
        agentId: state.agentId,
        hostConfig: state.hostConfig,
        verbose: state.verbose,
      };
    case "setup":
      return {
        json: state.json,
        help: state.help,
        target: state.target,
        user: state.user,
        host: state.host,
        channel: state.channel,
        keyFile: state.keyFile,
        agentId: state.agentId,
        hostConfig: state.hostConfig,
        yes: state.yes,
        resume: state.resume,
        dryRun: state.dryRun,
      };
    case "test":
      return {
        json: state.json,
        help: state.help,
        target: state.target,
        user: state.user,
        host: state.host,
        channel: state.channel,
        keyFile: state.keyFile,
        agentId: state.agentId,
        hostConfig: state.hostConfig,
        timeoutMs: state.timeoutMs,
        keep: state.keep,
        command: [],
      };
    case "recover":
      return {
        json: state.json,
        help: state.help,
        target: state.target,
        user: state.user,
        host: state.host,
        channel: state.channel,
        keyFile: state.keyFile,
        agentId: state.agentId,
        hostConfig: state.hostConfig,
        runId: state.runId,
        dryRun: state.dryRun,
        force: state.force,
      };
    case "report":
      return {
        json: state.json,
        help: state.help,
        runId: state.runId,
        format: state.format,
      };
  }
}

function parseCommand(
  command: CommandName,
  rest: readonly string[],
  wantsJson: boolean,
): ParsedArgs {
  const allowed = ALLOWED[command];
  const state: Mutable = {
    json: false,
    help: false,
    target: null,
    user: null,
    host: null,
    channel: null,
    keyFile: null,
    agentId: null,
    hostConfig: null,
    verbose: false,
    yes: false,
    resume: false,
    dryRun: false,
    keep: false,
    force: false,
    timeoutMs: null,
    runId: null,
    formatGiven: false,
    format: "summary",
  };
  let testCommand: readonly string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index];
    if (raw === undefined) {
      break;
    }
    if (raw === "--") {
      if (command !== "test") {
        return usage(`"${command}" does not take a command after --`, wantsJson);
      }
      testCommand = rest.slice(index + 1);
      break;
    }
    if (raw === "--help" || raw === "-h") {
      state.help = true;
      continue;
    }
    const equals = raw.indexOf("=");
    const name = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;

    if (!allowed.has(name)) {
      return usage(
        `unknown option ${name} for "${command}"; run "ae-a8n ${command} --help"`,
        wantsJson || state.json,
      );
    }

    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) {
        return usage(`${name} does not take a value`, wantsJson || state.json);
      }
      switch (name) {
        case "--json":
          state.json = true;
          break;
        case "--verbose":
          state.verbose = true;
          break;
        case "--yes":
          state.yes = true;
          break;
        case "--resume":
          state.resume = true;
          break;
        case "--dry-run":
          state.dryRun = true;
          break;
        case "--keep":
          state.keep = true;
          break;
        case "--force":
          state.force = true;
          break;
      }
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      return usage(`unknown option ${name}`, wantsJson || state.json);
    }
    // A forgotten value must not swallow the next option: `setup --channel
    // --dry-run` would set the channel to "--dry-run" and leave the dry run
    // off, which is the one combination that changes the machine while the
    // caller asked it not to. The agent's own parser refuses the same shape.
    if (inline === undefined && (rest[index + 1]?.startsWith("--") ?? false)) {
      return usage(`${name} needs a value`, wantsJson || state.json);
    }
    const value = inline ?? rest[index + 1];
    if (value === undefined) {
      return usage(`${name} needs a value`, wantsJson || state.json);
    }
    if (inline === undefined) {
      index += 1;
    }
    if (value.length === 0) {
      return usage(`${name} needs a non-empty value`, wantsJson || state.json);
    }

    switch (name) {
      case "--target":
        state.target = value;
        break;
      case "--user":
        state.user = value;
        break;
      case "--host":
        state.host = value;
        break;
      case "--channel":
        state.channel = value;
        break;
      case "--key-file":
        state.keyFile = value;
        break;
      case "--agent-id":
        state.agentId = value;
        break;
      case "--host-config":
        state.hostConfig = value;
        break;
      case "--run":
        if (!RUN_ID_PATTERN.test(value)) {
          return usage(
            `--run needs a run id like 20261110T120000Z-4f2a8c11, not "${value}"`,
            wantsJson || state.json,
          );
        }
        state.runId = value;
        break;
      case "--timeout": {
        if (!/^\d+$/.test(value)) {
          return usage("--timeout must be a positive integer in milliseconds", wantsJson || state.json);
        }
        const timeout = Number(value);
        if (!Number.isSafeInteger(timeout) || timeout <= 0) {
          return usage("--timeout must be a positive integer in milliseconds", wantsJson || state.json);
        }
        state.timeoutMs = timeout;
        break;
      }
      case "--format":
        if (value !== "summary" && value !== "json" && value !== "junit") {
          return usage('--format must be "summary", "json" or "junit"', wantsJson || state.json);
        }
        state.format = value;
        state.formatGiven = true;
        break;
    }
  }

  if (command === "report" && state.json && state.formatGiven) {
    return usage(
      "report takes either --json or --format: --json prints the envelope, " +
        "--format prints the stored report",
      wantsJson || state.json,
    );
  }

  if (command === "test") {
    if (!state.help && testCommand.length === 0) {
      return usage('test needs a command after "--", for example: ae-a8n test -- npm test', wantsJson || state.json);
    }
    const options = optionsFor(command, state) as TestOptions;
    return {
      ok: true,
      kind: "command",
      command,
      options: { ...options, command: testCommand },
    };
  }

  return {
    ok: true,
    kind: "command",
    command,
    options: optionsFor(command, state),
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const wantsJson = argv.includes("--json");
  const [first, ...rest] = argv;

  if (first === undefined) {
    return usage(
      'a command is required: doctor, setup, test, recover or report (try "ae-a8n --help")',
      wantsJson,
    );
  }
  if (first === "--help" || first === "-h") {
    return { ok: true, kind: "help", command: null, json: wantsJson };
  }
  if (first === "--version" || first === "-V") {
    return { ok: true, kind: "version", json: wantsJson };
  }
  if (!isCommand(first)) {
    return usage(
      `unknown command "${first}"; expected doctor, setup, test, recover or report`,
      wantsJson,
    );
  }
  return parseCommand(first, rest, wantsJson);
}
