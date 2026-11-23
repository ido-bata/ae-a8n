/**
 * `ae-a8n supervise`: read the durable supervision state of a session
 * directory (#287, specs/gui-supervision/spec.md §API / CLI surface).
 *
 * This command is a reader, nothing more: it never starts a monitor,
 * never presses a button, and never mutates the session it reports on.
 * Every consumer — CLI, MCP, editor — reads the same `supervision.json`
 * the monitor publishes, so the answer here is identical to
 * `ae.supervisionState()` for the same session root.
 *
 * Honesty is the contract: absent, corrupt and stale-monitor states are
 * reported as `unavailable`/`monitor-lost`, never as a clean bill, and
 * the exit code reflects what was proven — not what was hoped.
 */

import { resolve } from "node:path";

import { supervisionReport, type SupervisionReport } from "../supervision/index.js";
import { buildEnvelope, type CliEnvelope, type NextAction } from "./envelope.js";
import { EXIT, type ExitCode } from "./exit-code.js";

const PLATFORM = {
  os: process.platform,
  release: null,
  arch: process.arch,
  backend: "none",
} as const;

const LOCAL_TARGET = { name: "local", isolation: "session" } as const;

export const SUPERVISE_HELP = [
  "Usage: ae-a8n supervise status --session-root <dir> [--json]",
  "",
  "Commands:",
  "  status    Print the durable supervision report for a session directory",
  "",
  "Options:",
  "  --session-root <dir>  Session directory containing supervision.json",
  "  --json                Print exactly one JSON document on stdout",
  "  --help, -h            Show this help",
  "",
  "The report is read-only: this command never starts a monitor and never",
  "touches After Effects. `unavailable` means no trustworthy state exists;",
  "it is not a healthy answer.",
  "",
  "Exit codes: 0 running/resumed; 3 blocked/recovering/needs-human;",
  "4 quarantined; 6 unknown (state absent, corrupt, or monitor-lost).",
].join("\n");

export type SuperviseCommandResult = { readonly exitCode: number };

type Deps = {
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly now?: () => Date;
};

type Parsed =
  | {
      readonly ok: true;
      readonly command: "status";
      readonly sessionRoot: string;
      readonly json: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly json: boolean };

function parseSuperviseArgs(argv: readonly string[]): Parsed {
  const wantsJson = argv.includes("--json");
  const [head, ...rest] = argv;
  if (head !== "status") {
    return {
      ok: false,
      error: head === undefined ? "a command is required" : `unknown supervise command ${JSON.stringify(head)}`,
      json: wantsJson,
    };
  }
  let sessionRoot: string | null = null;
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
    if (name !== "--session-root") {
      return { ok: false, error: `unknown option ${name}`, json };
    }
    const value = inline ?? rest[index + 1];
    if (value === undefined || value.length === 0 || (inline === undefined && value.startsWith("--"))) {
      return { ok: false, error: "--session-root needs a non-empty value", json };
    }
    if (inline === undefined) index += 1;
    sessionRoot = value;
  }
  if (sessionRoot === null) {
    return { ok: false, error: "status needs --session-root <dir>", json };
  }
  return { ok: true, command: "status", sessionRoot, json };
}

/**
 * The exit code is the supervision answer, not the command's health: a
 * blocked session is a successful read that must stop automation (3),
 * quarantine refuses mutation (4), and an unobservable session is unknown
 * (6) — matching the envelope status vocabulary.
 */
function exitFor(report: SupervisionReport): { status: CliEnvelope["status"]; exitCode: ExitCode } {
  if (report.status === "unavailable") {
    return { status: "unknown", exitCode: EXIT.unknown };
  }
  const doc = report.doc;
  switch (doc.phase) {
    case "running":
    case "resumed":
      return report.health === "monitor-lost"
        ? { status: "unknown", exitCode: EXIT.unknown }
        : { status: "ok", exitCode: EXIT.ok };
    case "blocked":
    case "recovering":
    case "needs-human":
      return { status: "blocked", exitCode: EXIT.blocked };
    case "quarantined":
      return { status: "refused", exitCode: EXIT.refused };
  }
}

function nextActionsFor(report: SupervisionReport): NextAction[] {
  if (report.status !== "observed") {
    return [
      {
        kind: "human",
        code: "supervision.unavailable",
        action:
          "No trustworthy supervision state exists for this session root. " +
          "Confirm the directory is the session's own sessionRoot; if a session is live, its monitor may not have started.",
      },
    ];
  }
  const doc = report.doc;
  if (doc.phase === "needs-human" || doc.phase === "quarantined") {
    const windows = doc.blocking?.windows ?? [];
    const detail =
      windows.length > 0
        ? windows.map((w) => w.title || w.dialogClass || w.role).join(", ")
        : (doc.blocking?.detail ?? doc.phase);
    return [
      {
        kind: "human",
        code: `supervision.${doc.phase}`,
        action:
          `After Effects needs a human: ${detail}. ` +
          "Resolve it in the After Effects window, then re-run `ae-a8n supervise status` — " +
          "automation never presses unmeasured dialogs.",
      },
    ];
  }
  if (doc.phase === "blocked" || doc.phase === "recovering") {
    return [
      {
        kind: "human",
        code: "supervision.blocked",
        action:
          `After Effects is ${doc.phase}: ${doc.blocking?.detail ?? "blocking state observed"}. ` +
          "Wait for recovery or inspect `ae-a8n supervise status` again; the wait is bounded by the phase deadline.",
      },
    ];
  }
  return [];
}

function renderHuman(envelope: CliEnvelope): string {
  const lines: string[] = [];
  const facts = envelope.facts as SupervisionReport | undefined;
  lines.push(`ae-a8n supervise status: ${envelope.status} (exit ${envelope.exitCode})`);
  if (facts === undefined) {
    return `${lines.join("\n")}\n`;
  }
  if (facts.status === "unavailable") {
    lines.push(`  status: unavailable (${facts.source})`);
    lines.push(`  reason: ${facts.reason}`);
  } else {
    const doc = facts.doc;
    lines.push(`  phase: ${doc.phase}`);
    lines.push(`  health: ${facts.health}${facts.healthDetail === null ? "" : ` — ${facts.healthDetail}`}`);
    if (doc.blocking !== null) {
      lines.push(`  blocking: ${doc.blocking.detail}`);
      for (const window of doc.blocking.windows) {
        if (!window.blocking) continue;
        lines.push(
          `    - ${window.title === "" ? window.role : window.title} ` +
            `[tier=${window.tier}${window.dialogClass === null ? "" : ` class=${window.dialogClass}`}${window.code === null ? "" : ` ${window.code}`}]`,
        );
      }
    }
    if (doc.pendingRequests.length > 0) {
      lines.push(`  pending: ${doc.pendingRequests.map((r) => `${r.method}(${r.state})`).join(", ")}`);
    }
    if (doc.deadline !== null) {
      lines.push(`  deadline: ${doc.deadline}`);
    }
    if (doc.monitor !== null) {
      lines.push(`  monitor: ${doc.monitor.ownerId} pid=${doc.monitor.pid} heartbeat=${doc.monitor.heartbeatAt}`);
    }
  }
  if (envelope.nextActions.length > 0) {
    lines.push("next:");
    for (const action of envelope.nextActions) {
      lines.push(`  - [${action.kind}] ${action.action}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function runSuperviseCommand(
  argv: readonly string[],
  deps: Deps = {},
): SuperviseCommandResult {
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
  const startedAt = now();

  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    writeOut(`${SUPERVISE_HELP}\n`);
    return { exitCode: EXIT.ok };
  }

  const parsed = parseSuperviseArgs(argv);
  if (!parsed.ok) {
    if (parsed.json) {
      writeOut(
        `${JSON.stringify(
          buildEnvelope({
            command: "supervise",
            status: "failed",
            exitCode: EXIT.usage,
            startedAt,
            finishedAt: now(),
            platform: PLATFORM,
            target: LOCAL_TARGET,
            checks: [],
            facts: undefined,
            nextActions: [],
          }),
          null,
          2,
        )}\n`,
      );
    } else {
      writeErr(`ae-a8n supervise: ${parsed.error}\n${SUPERVISE_HELP}\n`);
    }
    return { exitCode: EXIT.usage };
  }

  const report = supervisionReport(resolve(parsed.sessionRoot), { now: now() });
  const verdict = exitFor(report);
  const envelope = buildEnvelope({
    command: "supervise",
    status: verdict.status,
    exitCode: verdict.exitCode,
    startedAt,
    finishedAt: now(),
    platform: PLATFORM,
    target: LOCAL_TARGET,
    checks: [],
    facts: report,
    nextActions: nextActionsFor(report),
  });
  if (parsed.json) {
    writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    writeOut(renderHuman(envelope));
  }
  return { exitCode: verdict.exitCode };
}
