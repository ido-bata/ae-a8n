/**
 * `ae-a8n dispatcher`: the in-AE dispatcher lifecycle as a public command
 * (#147).
 *
 * The commands cover everything that is machine-checkable — channel
 * preparation, heartbeat status, per-user `Scripts/Startup` registration —
 * and say plainly which step is a human's: running `activate.jsx` inside
 * After Effects. Nothing here launches, quits, or automates After Effects,
 * and nothing claims a behaviour that has not been proven on a real host
 * (Startup execution on macOS/Windows stays marked unverified).
 *
 * Output follows the contract envelope: `--json` prints exactly one JSON
 * document; the default is a short human rendering of the same facts.
 */

import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";

import {
  DispatcherTransport,
  defaultDispatcherChannelDir,
  type DispatcherChannelStatus,
} from "../driver/dispatcher-transport.js";
import { buildEnvelope, type CliEnvelope, type NextAction } from "./envelope.js";
import { EXIT, type ExitCode } from "./exit-code.js";

const PLATFORM = {
  os: osPlatform(),
  release: osRelease(),
  arch: osArch(),
  backend: "none",
} as const;

const LOCAL_TARGET = { name: "local", isolation: "session" } as const;

export const DISPATCHER_HELP = [
  "Usage: ae-a8n dispatcher <command> [options]",
  "",
  "Commands:",
  "  prepare                     Create/prep the channel and activate.jsx (idempotent)",
  "  status                      Report the dispatcher heartbeat honestly; no answer is not a pass",
  "  startup install|remove      Register/remove the per-user Scripts/Startup entry",
  "",
  "Options:",
  "  --channel-dir <dir>   Channel directory (default ~/.ae-a8n/dispatcher)",
  "  --ae-version <v>      AE version for Startup placement, e.g. 26.5",
  "  --install-dir <path>  AE install dir or .app path (macOS only; derives the version)",
  "  --json                Print exactly one JSON document on stdout",
  "  --help, -h            Show this help",
  "",
  "The dispatcher itself is activated by a human inside After Effects:",
  "File > Scripts > Run Script File on the printed activate.jsx path, or",
  "install it into Scripts/Startup first. ae-a8n never launches or quits AE.",
  "",
  "Exit codes: 0 ok; 1 failed; 2 usage; 3 blocked (no dispatcher answering);",
  "4 refused; 6 unknown (heartbeat went stale).",
].join("\n");

export type DispatcherCommandResult = { readonly exitCode: number };

type Deps = {
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly now?: () => Date;
  /** Test seam: home directory for the default channel and Startup paths. */
  readonly homeDir?: string;
  /** Test seam: the platform Startup placement targets. */
  readonly platform?: NodeJS.Platform;
};

type Parsed =
  | {
      readonly ok: true;
      readonly command: "prepare" | "status" | "startup";
      readonly action: "install" | "remove" | null;
      readonly channelDir: string | null;
      readonly aeVersion: string | null;
      readonly installDir: string | null;
      readonly json: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly json: boolean };

const VALUE_FLAGS = new Set(["--channel-dir", "--ae-version", "--install-dir"]);

function parseDispatcherArgs(argv: readonly string[]): Parsed {
  const wantsJson = argv.includes("--json");
  const [head, ...rest] = argv;
  if (head === "--help" || head === "-h" || argv.length === 0) {
    return {
      ok: true,
      command: "status",
      action: null,
      channelDir: null,
      aeVersion: null,
      installDir: null,
      json: wantsJson,
    };
  }
  if (head !== "prepare" && head !== "status" && head !== "startup") {
    return { ok: false, error: `unknown dispatcher command ${JSON.stringify(head)}`, json: wantsJson };
  }
  let action: "install" | "remove" | null = null;
  if (head === "startup") {
    const sub = rest[0];
    if (sub !== "install" && sub !== "remove") {
      return {
        ok: false,
        error: 'startup needs "install" or "remove"',
        json: wantsJson,
      };
    }
    action = sub;
    rest.shift();
  }
  let channelDir: string | null = null;
  let aeVersion: string | null = null;
  let installDir: string | null = null;
  let json = wantsJson;
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index];
    if (raw === undefined) break;
    if (raw === "--json") {
      json = true;
      continue;
    }
    const equals = raw.indexOf("=");
    const name = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;
    if (!VALUE_FLAGS.has(name)) {
      return { ok: false, error: `unknown option ${name}`, json };
    }
    const value = inline ?? rest[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      return { ok: false, error: `${name} needs a value`, json };
    }
    if (inline === undefined) index += 1;
    if (name === "--channel-dir") channelDir = value;
    else if (name === "--ae-version") aeVersion = value;
    else installDir = value;
  }
  if (head !== "startup" && (aeVersion !== null || installDir !== null)) {
    return { ok: false, error: `${head} does not take --ae-version or --install-dir`, json };
  }
  if (head === "startup" && aeVersion !== null && installDir !== null) {
    return { ok: false, error: "pass either --ae-version or --install-dir, not both", json };
  }
  if (head === "startup" && aeVersion === null && installDir === null) {
    return {
      ok: false,
      error: "startup needs --ae-version <v> or --install-dir <path>",
      json,
    };
  }
  return {
    ok: true,
    command: head === "startup" ? "startup" : head,
    action,
    channelDir,
    aeVersion,
    installDir,
    json,
  };
}

/** The human steps a prepared channel still needs, in order. */
function activationSteps(activateScriptPath: string, channelDir: string): NextAction[] {
  return [
    {
      kind: "human",
      code: "dispatcher.activate",
      action:
        `In After Effects: File > Scripts > Run Script File, select ${activateScriptPath}`,
    },
    {
      kind: "human",
      code: "dispatcher.verify",
      action: `Then check the connection: ae-a8n dispatcher status --channel-dir ${channelDir}`,
    },
    {
      kind: "human",
      code: "dispatcher.consent",
      action:
        "AE may ask once for 'Allow Scripts to Write Files and Access Network'; that consent is yours to give.",
    },
  ];
}

function envelopeFor(
  command: string,
  status: CliEnvelope["status"],
  exitCode: ExitCode,
  startedAt: Date,
  finishedAt: Date,
  facts: unknown,
  nextActions: readonly NextAction[],
  notice?: string,
): CliEnvelope {
  return buildEnvelope({
    command,
    status,
    exitCode,
    startedAt,
    finishedAt,
    platform: PLATFORM,
    target: LOCAL_TARGET,
    checks: [],
    facts,
    nextActions,
    ...(notice === undefined ? {} : { notice }),
  });
}

function renderHuman(envelope: CliEnvelope): string {
  const lines: string[] = [];
  const facts = envelope.facts as Record<string, unknown> | undefined;
  lines.push(`ae-a8n dispatcher ${envelope.command}: ${envelope.status} (exit ${envelope.exitCode})`);
  if (facts !== undefined) {
    for (const [key, value] of Object.entries(facts)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        lines.push(`  ${key}: ${String(value)}`);
      } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        lines.push(`  ${key}: ${value.join(", ")}`);
      } else if (value !== null && typeof value === "object") {
        lines.push(`  ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  if (envelope.nextActions.length > 0) {
    lines.push("next:");
    for (const action of envelope.nextActions) {
      lines.push(`  - [${action.kind}] ${action.action}`);
    }
  }
  if (envelope.notice !== undefined) {
    lines.push(`note: ${envelope.notice}`);
  }
  return `${lines.join("\n")}\n`;
}

function emit(
  envelope: CliEnvelope,
  json: boolean,
  deps: Required<Deps>,
): void {
  if (json) {
    deps.writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  deps.writeOut(renderHuman(envelope));
}

function usageError(
  error: string,
  json: boolean,
  deps: Required<Deps>,
  startedAt: Date,
): ExitCode {
  if (json) {
    deps.writeOut(
      `${JSON.stringify(
        envelopeFor("dispatcher", "failed", EXIT.usage, startedAt, deps.now?.() ?? new Date(), undefined, [], error),
        null,
        2,
      )}\n`,
    );
  } else {
    deps.writeErr(`ae-a8n dispatcher: ${error}\n${DISPATCHER_HELP}\n`);
  }
  return EXIT.usage;
}

export async function runDispatcherCommand(
  argv: readonly string[],
  deps: Deps = {},
): Promise<DispatcherCommandResult> {
  const writeOut =
    deps.writeOut ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const writeErr =
    deps.writeErr ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const now = deps.now ?? (() => new Date());
  const fullDeps = { writeOut, writeErr, now };
  const startedAt = now();

  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    writeOut(`${DISPATCHER_HELP}\n`);
    return { exitCode: EXIT.ok };
  }

  const parsed = parseDispatcherArgs(argv);
  if (!parsed.ok) {
    return { exitCode: usageError(parsed.error, parsed.json, fullDeps, startedAt) };
  }

  const channelDir = parsed.channelDir ?? defaultDispatcherChannelDir(deps.homeDir);
  const transport = new DispatcherTransport({
    channelDir,
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  });
  const command =
    parsed.command === "startup" ? `dispatcher.startup.${parsed.action}` : `dispatcher.${parsed.command}`;

  try {
    if (parsed.command === "prepare") {
      await transport.prepare();
      const finishedAt = now();
      const envelope = envelopeFor(
        command,
        "ok",
        EXIT.ok,
        startedAt,
        finishedAt,
        {
          channelDir: transport.channelDir,
          activateScriptPath: transport.activateScriptPath,
          inboxDir: transport.inboxDir,
          outboxDir: transport.outboxDir,
        },
        activationSteps(transport.activateScriptPath, transport.channelDir),
      );
      emit(envelope, parsed.json, fullDeps);
      return { exitCode: EXIT.ok };
    }

    if (parsed.command === "status") {
      const status: DispatcherChannelStatus = await transport.status();
      const finishedAt = now();
      if (status.heartbeat === null) {
        const envelope = envelopeFor(
          command,
          "blocked",
          EXIT.blocked,
          startedAt,
          finishedAt,
          {
            channelDir: status.channelDir,
            activateScriptPath: status.activateScriptPath,
            heartbeat: null,
          },
          activationSteps(status.activateScriptPath, status.channelDir),
          "no dispatcher has answered on this channel; that is unproven, not a pass",
        );
        emit(envelope, parsed.json, fullDeps);
        return { exitCode: EXIT.blocked };
      }
      const beat = status.heartbeat;
      const facts = {
        channelDir: status.channelDir,
        activateScriptPath: status.activateScriptPath,
        instance: beat.instance,
        aeVersion: beat.aeVersion,
        activatedAt: beat.activatedAt,
        lastTick: beat.lastTick,
        ageMs: beat.ageMs,
        fresh: beat.fresh,
        extensionMethods: beat.extensionMethods,
        extensionsRegistration: beat.extensionsRegistration,
      };
      if (!beat.fresh) {
        const envelope = envelopeFor(
          command,
          "unknown",
          EXIT.unknown,
          startedAt,
          finishedAt,
          facts,
          [
            {
              kind: "human",
              code: "dispatcher.reactivate",
              action:
                "the heartbeat went stale: the dispatcher is not answering. If After Effects " +
                "was restarted, activate again with the activate.jsx above; if it is running, " +
                "the dispatcher may be busy — check again shortly.",
            },
          ],
          "a stale heartbeat is unproven, not a pass",
        );
        emit(envelope, parsed.json, fullDeps);
        return { exitCode: EXIT.unknown };
      }
      const envelope = envelopeFor(command, "ok", EXIT.ok, startedAt, finishedAt, facts, [
        {
          kind: "automatic",
          code: "dispatcher.launch",
          action:
            `connect with AfterEffects.launch({ transport: { kind: "in-ae-dispatcher", ` +
            `channelDir: ${JSON.stringify(status.channelDir)} } })`,
        },
      ]);
      emit(envelope, parsed.json, fullDeps);
      return { exitCode: EXIT.ok };
    }

    // startup install | remove
    const action = parsed.action;
    if (action === "install") {
      const installed = await transport.installStartupScript({
        ...(parsed.aeVersion === null ? {} : { aeVersion: parsed.aeVersion }),
        ...(parsed.installDir === null ? {} : { installDir: parsed.installDir }),
      });
      const envelope = envelopeFor(
        command,
        "ok",
        EXIT.ok,
        startedAt,
        now(),
        {
          installed,
          channelDir: transport.channelDir,
          activateScriptPath: transport.activateScriptPath,
        },
        [
          {
            kind: "human",
            code: "dispatcher.startup.verify",
            action:
              "AE startup execution of this entry is unverified on real hosts; confirm with " +
              "ae-a8n dispatcher status after an AE restart.",
          },
        ],
        "Startup placement is a path computation; whether AE runs it is unproven until observed",
      );
      emit(envelope, parsed.json, fullDeps);
      return { exitCode: EXIT.ok };
    }
    const removed = transport.uninstallStartupScript({
      ...(parsed.aeVersion === null ? {} : { aeVersion: parsed.aeVersion }),
      ...(parsed.installDir === null ? {} : { installDir: parsed.installDir }),
    });
    const envelope = envelopeFor(
      command,
      "ok",
      EXIT.ok,
      startedAt,
      now(),
      {
        removed,
        channelDir: transport.channelDir,
        note: removed === null ? "no ae-a8n Startup entry was installed" : undefined,
      },
      [],
    );
    emit(envelope, parsed.json, fullDeps);
    return { exitCode: EXIT.ok };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const refused = /refusing to (overwrite|remove)/.test(message);
    const status = refused ? "refused" : "failed";
    const exitCode = refused ? EXIT.refused : EXIT.failed;
    const envelope = envelopeFor(command, status, exitCode, startedAt, now(), undefined, [], message);
    emit(envelope, parsed.json, fullDeps);
    return { exitCode };
  }
}
