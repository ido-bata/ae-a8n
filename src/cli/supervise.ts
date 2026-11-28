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
 * `status` prints one report; `watch` polls the same durable document and
 * prints a line each time the phase or the evaluated observation health
 * changes — `running → blocked → recovering → resumed`, a slide into
 * `needs-human`/`quarantined`, or the monitor going lost.
 *
 * `terminate` (#451) is the ONE mutating command in this group: it wraps
 * the public `AfterEffects.terminate` path (`terminateSessionHost`)
 * for the session root it is given, under the same explicit
 * `permit: "terminate-owned-host"` consent the API requires — passed as
 * `--permit terminate-owned-host`, never defaulted. Everything else here
 * stays read-only.
 *
 * Honesty is the contract: absent, corrupt and stale-monitor states are
 * reported as `unavailable`/`monitor-lost`, never as a clean bill, and
 * the exit code reflects what was proven — not what was hoped.
 */

import { arch as osArch, platform as osPlatform, release as osRelease } from "node:os";
import { resolve } from "node:path";

import {
  supervisionReport,
  type ObservationHealth,
  type SupervisionPhase,
  type SupervisionReport,
} from "../supervision/index.js";
import { terminateSessionHost } from "../api/terminate.js";
import { AfterEffectsError } from "../api/errors.js";
import {
  TERMINATE_PERMIT,
  type TerminateOptions,
  type TerminateReport,
} from "../api/types.js";
import {
  humanAction,
  inspectAction,
  nextAction,
  type NextAction,
} from "../supervision/next-actions.js";
import { errorMessage } from "../errors.js";
import { buildEnvelope, type CliEnvelope } from "./envelope.js";
import { EXIT, type ExitCode } from "./exit-code.js";

const PLATFORM = {
  os: osPlatform(),
  release: osRelease(),
  arch: osArch(),
  backend: "none",
} as const;

const LOCAL_TARGET = { name: "local", isolation: "session" } as const;

export const SUPERVISE_HELP = [
  "Usage: ae-a8n supervise <status|watch|terminate> --session-root <dir> [--json] [options]",
  "",
  "Commands:",
  "  status     Print the durable supervision report for a session directory",
  "  watch      Poll the report and print each phase/health transition",
  "  terminate  Signal the recorded owned After Effects host to end",
  "",
  "Options:",
  "  --session-root <dir>   Session directory containing supervision.json",
  "  --interval-ms <ms>     watch poll interval (default 2000, minimum 50)",
  "  --permit <permit>      terminate: must be \"terminate-owned-host\"",
  "  --force                terminate: also permit the force kill when the",
  "                         graceful request does not end the process",
  "  --json                 status: one JSON envelope; watch: NDJSON, one",
  "                         event per line, printed only on change",
  "  --help, -h             Show this help",
  "",
  "status and watch are read-only: they never start a monitor, never touch",
  "After Effects, and never mutate the session they report on. `terminate`",
  "is the exception — it is the CLI surface of `AfterEffects.terminate` and",
  "signals the process the session's launch provenance recorded, graceful-",
  "first, only after every ownership proof holds. It still refuses without",
  "--permit terminate-owned-host, and rebuild is the separate next step.",
  "`unavailable` means no trustworthy state exists; it is not a healthy",
  "answer. `monitor-lost` means the observer stopped — the target's GUI",
  "state is unknown, not fine.",
  "",
  "Exit codes: 0 running/resumed (or host proven gone); 3 blocked/",
  "recovering/needs-human or a surviving host; 4 quarantined or a refused",
  "terminate; 6 unknown (state absent, corrupt, monitor-lost, or an",
  "unproven disappearance). watch exits with the last observed report's",
  "code when interrupted.",
].join("\n");

export type SuperviseCommandResult = { readonly exitCode: number };

type Deps = {
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
  readonly now?: () => Date;
  /** Test seam: replaces the watch sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam: bounds the watch loop; production watches until SIGINT. */
  readonly maxWatchTicks?: number;
  /**
   * Test seam: replaces the terminate call `supervise terminate` makes.
   * Production uses `terminateSessionHost` — the same body
   * `AfterEffects.terminate` runs.
   */
  readonly terminate?: (
    options: TerminateOptions,
  ) => Promise<TerminateReport>;
};

type Parsed =
  | {
      readonly ok: true;
      readonly command: "status" | "watch";
      readonly sessionRoot: string;
      readonly json: boolean;
      readonly intervalMs: number;
    }
  | {
      readonly ok: true;
      readonly command: "terminate";
      readonly sessionRoot: string;
      readonly json: boolean;
      readonly force: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly json: boolean };

const DEFAULT_WATCH_INTERVAL_MS = 2_000;
const MIN_WATCH_INTERVAL_MS = 50;

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseSuperviseArgs(argv: readonly string[]): Parsed {
  const wantsJson = argv.includes("--json");
  const [head, ...rest] = argv;
  if (head !== "status" && head !== "watch" && head !== "terminate") {
    return {
      ok: false,
      error:
        head === undefined
          ? "a command is required"
          : `unknown supervise command ${JSON.stringify(head)}`,
      json: wantsJson,
    };
  }
  let sessionRoot: string | null = null;
  let json = wantsJson;
  let intervalMs = DEFAULT_WATCH_INTERVAL_MS;
  let force = false;
  let permit: string | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index];
    if (raw === undefined) break;
    if (raw === "--json") {
      json = true;
      continue;
    }
    if (raw === "--force") {
      if (head !== "terminate") {
        return { ok: false, error: "--force is only valid for terminate", json };
      }
      force = true;
      continue;
    }
    const equals = raw.indexOf("=");
    const name = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;
    if (name === "--interval-ms") {
      const value = inline ?? rest[index + 1];
      const parsed = value === undefined ? null : parsePositiveInt(value);
      if (parsed === null || parsed < MIN_WATCH_INTERVAL_MS) {
        return {
          ok: false,
          error: `--interval-ms needs an integer >= ${MIN_WATCH_INTERVAL_MS}`,
          json,
        };
      }
      if (inline === undefined) index += 1;
      intervalMs = parsed;
      continue;
    }
    if (name === "--permit") {
      if (head !== "terminate") {
        return { ok: false, error: "--permit is only valid for terminate", json };
      }
      const value = inline ?? rest[index + 1];
      if (value === undefined || value.length === 0 || (inline === undefined && value.startsWith("--"))) {
        return { ok: false, error: "--permit needs a value", json };
      }
      if (inline === undefined) index += 1;
      permit = value;
      continue;
    }
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
    return { ok: false, error: `${head} needs --session-root <dir>`, json };
  }
  if (head === "terminate") {
    // The consent is a literal, checked at the boundary: a missing or
    // wrong permit is a usage error, never silently forwarded to an API
    // that would refuse it anyway.
    if (permit !== TERMINATE_PERMIT) {
      return {
        ok: false,
        error: `terminate needs --permit ${TERMINATE_PERMIT}`,
        json,
      };
    }
    return { ok: true, command: "terminate", sessionRoot, json, force };
  }
  return { ok: true, command: head, sessionRoot, json, intervalMs };
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

/* ------------------------------------------------------------------ */
/* watch                                                               */
/* ------------------------------------------------------------------ */

/**
 * What a watch emission is keyed on: the phase (or the unavailable
 * source) plus the evaluated health. A change in either is a transition
 * a consumer must see; heartbeat timestamps alone are not.
 */
type WatchKey = {
  readonly phase: SupervisionPhase | `unavailable:${"absent" | "corrupt"}`;
  readonly health: ObservationHealth | "unavailable";
};

function watchKeyOf(report: SupervisionReport): WatchKey {
  if (report.status === "unavailable") {
    return { phase: `unavailable:${report.source}`, health: "unavailable" };
  }
  return { phase: report.doc.phase, health: report.health };
}

/** One line of human watch output: the current key and why it matters. */
function watchLine(report: SupervisionReport, first: boolean): string {
  const stamp = report.readAt;
  const mark = first ? " " : "→";
  if (report.status === "unavailable") {
    return `${stamp} ${mark} unavailable/${report.source} — ${report.reason}\n`;
  }
  const doc = report.doc;
  const blocking = doc.blocking === null ? "" : ` — ${doc.blocking.detail}`;
  const health =
    report.health === "ok"
      ? ""
      : ` [health=${report.health}${report.healthDetail === null ? "" : `: ${report.healthDetail}`}]`;
  return `${stamp} ${mark} ${doc.phase}/${report.health}${blocking}${health}\n`;
}

/**
 * One NDJSON watch event: the full report, the current key, and the
 * state machine's own transition record when the phase moved. Emitted
 * only when the key changed, so every line is a transition a consumer
 * must see — silence means "nothing changed".
 */
function watchEvent(report: SupervisionReport): Record<string, unknown> {
  const key = watchKeyOf(report);
  const last =
    report.status === "observed" && report.doc.history.length > 0
      ? report.doc.history[report.doc.history.length - 1]!
      : null;
  return {
    ts: report.readAt,
    event: "supervision",
    phase: key.phase,
    health: key.health,
    ...(last === null
      ? {}
      : { transition: { from: last.from, to: last.to, reason: last.reason } }),
    report,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A watch must never be the reason the CLI process stays alive after
    // the last tick: unref so tests and scripted runs can exit.
    (timer as { unref?: () => void }).unref?.();
  });

/**
 * Poll the durable report and emit on every phase/health change.
 *
 * Read-only by construction: the loop only calls `supervisionReport`,
 * which validates and re-evaluates — it never writes. The first emission
 * always prints (a watcher that stayed silent until the first *change*
 * would hide the state it was started to watch). Production watches run
 * until SIGINT; the returned exit code is the last report's verdict, so
 * `watch | tail` style consumers still get an honest answer.
 */
async function watchSupervision(
  sessionRoot: string,
  options: { readonly json: boolean; readonly intervalMs: number },
  deps: Deps,
): Promise<SuperviseCommandResult> {
  const writeOut =
    deps.writeOut ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const maxTicks = deps.maxWatchTicks ?? Number.POSITIVE_INFINITY;

  // SIGINT ends the watch gracefully: the loop wakes, emits nothing more,
  // and the process exits with the last observed verdict rather than a
  // signal death that looks like a crash to a script.
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    let previous: WatchKey | null = null;
    let last: SupervisionReport | null = null;
    for (let tick = 0; tick < maxTicks && !controller.signal.aborted; tick += 1) {
      const report = supervisionReport(sessionRoot, { now: now() });
      last = report;
      const key = watchKeyOf(report);
      const first = previous === null;
      const changed =
        previous === null ||
        previous.phase !== key.phase ||
        previous.health !== key.health;
      previous = key;
      if (changed) {
        writeOut(
          options.json
            ? `${JSON.stringify(watchEvent(report))}\n`
            : watchLine(report, first),
        );
      }
      if (tick + 1 < maxTicks && !controller.signal.aborted) {
        await sleep(options.intervalMs);
      }
    }
    const final = last ?? supervisionReport(sessionRoot, { now: now() });
    return { exitCode: exitFor(final).exitCode };
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/* ------------------------------------------------------------------ */
/* terminate                                                           */
/* ------------------------------------------------------------------ */

/**
 * The exit code is the terminate report's honesty, not the command's:
 * a proven-gone host is `ok` (rebuild may proceed), a survivor is
 * `blocked` (the host is still alive — nothing was claimed), and an
 * unproven disappearance is `unknown`.
 */
function terminateExitFor(
  report: TerminateReport,
): { status: CliEnvelope["status"]; exitCode: ExitCode } {
  switch (report.outcome) {
    case "terminated":
    case "already-gone":
      return { status: "ok", exitCode: EXIT.ok };
    case "survived":
      return { status: "blocked", exitCode: EXIT.blocked };
    case "unproven":
      return { status: "unknown", exitCode: EXIT.unknown };
  }
}

/**
 * The machine-readable guidance a terminate report implies (#341/#451):
 * proven disappearance names the permitted rebuild; a survivor and an
 * unproven disappearance name inspection and a human answer instead —
 * never a resend or an assumed death.
 */
function terminateNextActions(report: TerminateReport): readonly NextAction[] {
  const OP = "session.terminate";
  if (report.outcome === "terminated" || report.outcome === "already-gone") {
    return [
      nextAction({
        kind: "automatic",
        allowed: true,
        code: "session.rebuild",
        reason: { code: "permitted" },
        action:
          "The recorded host's disappearance is proven: continue with " +
          "`AfterEffects.rebuild({ sessionRoot })` to bring the session " +
          "back on a new generation.",
      }),
    ];
  }
  if (report.outcome === "survived") {
    return [
      inspectAction(
        OP,
        "Inspect the surviving After Effects process and the session's supervision document before deciding whether to re-run terminate (optionally with --force) or resolve it by hand.",
      ),
      nextAction({
        kind: "automatic",
        allowed: false,
        code: "session.rebuild",
        reason: { code: "session-policy" },
        action:
          "Rebuild is refused while the recorded host is proven alive; " +
          "resolve the surviving process first — terminate never claims " +
          "a death the census did not prove.",
      }),
    ];
  }
  return [
    inspectAction(
      OP,
      "Read the launch-provenance record and the supervision document in the session root; the process census could not prove the recorded host is gone.",
    ),
    humanAction(
      OP,
      "evidence-unavailable",
      "Disappearance could not be proven (the census was unreadable or the environment drifted); a human decides whether the host is really gone before any rebuild.",
    ),
  ];
}

function renderTerminateHuman(envelope: CliEnvelope): string {
  const lines: string[] = [];
  lines.push(`ae-a8n supervise terminate: ${envelope.status} (exit ${envelope.exitCode})`);
  const facts = envelope.facts as TerminateReport | undefined;
  if (facts !== undefined && "outcome" in facts) {
    lines.push(`  outcome: ${facts.outcome} (pid ${facts.pid}, method ${facts.method})`);
    lines.push(`  disappearance proven: ${facts.disappearanceProven}`);
    lines.push(`  supervision: ${facts.supervision}${facts.phase === null ? "" : ` (phase ${facts.phase})`}`);
    for (const entry of facts.evidence) {
      lines.push(`    - ${entry}`);
    }
  }
  if (envelope.nextActions.length > 0) {
    lines.push("next:");
    for (const action of envelope.nextActions) {
      lines.push(`  - [${action.kind}${action.allowed ? "" : ", withheld"}] ${action.action}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function runSuperviseTerminate(
  sessionRoot: string,
  options: { readonly json: boolean; readonly force: boolean },
  deps: Deps,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
  now: () => Date,
  startedAt: Date,
): Promise<SuperviseCommandResult> {
  const terminate = deps.terminate ?? terminateSessionHost;
  const emitTerminate = (
    status: CliEnvelope["status"],
    exitCode: ExitCode,
    facts: unknown,
    nextActions: readonly NextAction[],
    notice?: string,
  ): SuperviseCommandResult => {
    const envelope = buildEnvelope({
      command: "supervise",
      status,
      exitCode,
      startedAt,
      finishedAt: now(),
      platform: PLATFORM,
      target: LOCAL_TARGET,
      checks: [],
      facts,
      nextActions,
      ...(notice === undefined ? {} : { notice }),
    });
    if (options.json) {
      writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      writeOut(renderTerminateHuman(envelope));
    }
    return { exitCode };
  };

  let report: TerminateReport;
  try {
    report = await terminate({
      sessionRoot: resolve(sessionRoot),
      permit: TERMINATE_PERMIT,
      ...(options.force ? { force: true } : {}),
    });
  } catch (error) {
    if (error instanceof AfterEffectsError) {
      // Every terminate gate refusal is an AfterEffectsError carrying its
      // own nextActions: surface them verbatim, never re-worded.
      const actions = error.nextActions ?? [];
      if (options.json) {
        writeOut(
          `${JSON.stringify(
            buildEnvelope({
              command: "supervise",
              status: "refused",
              exitCode: EXIT.refused,
              startedAt,
              finishedAt: now(),
              platform: PLATFORM,
              target: LOCAL_TARGET,
              checks: [],
              facts: { error: error.message, code: error.code ?? null },
              nextActions: actions,
            }),
            null,
            2,
          )}\n`,
        );
      } else {
        writeErr(`ae-a8n supervise terminate: refused — ${error.message}\n`);
      }
      return { exitCode: EXIT.refused };
    }
    const message = errorMessage(error);
    if (options.json) {
      writeOut(
        `${JSON.stringify(
          buildEnvelope({
            command: "supervise",
            status: "failed",
            exitCode: EXIT.failed,
            startedAt,
            finishedAt: now(),
            platform: PLATFORM,
            target: LOCAL_TARGET,
            checks: [],
            facts: { error: message },
            nextActions: [],
            notice: message,
          }),
          null,
          2,
        )}\n`,
      );
    } else {
      writeErr(`ae-a8n supervise terminate: failed — ${message}\n`);
    }
    return { exitCode: EXIT.failed };
  }

  const verdict = terminateExitFor(report);
  return emitTerminate(verdict.status, verdict.exitCode, report, terminateNextActions(report));
}

function usageFailure(
  error: string,
  json: boolean,
  startedAt: Date,
  now: () => Date,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void,
): SuperviseCommandResult {
  if (json) {
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
    writeErr(`ae-a8n supervise: ${error}\n${SUPERVISE_HELP}\n`);
  }
  return { exitCode: EXIT.usage };
}

export async function runSuperviseCommand(
  argv: readonly string[],
  deps: Deps = {},
): Promise<SuperviseCommandResult> {
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
    return usageFailure(parsed.error, parsed.json, startedAt, now, writeOut, writeErr);
  }

  if (parsed.command === "watch") {
    return watchSupervision(
      resolve(parsed.sessionRoot),
      { json: parsed.json, intervalMs: parsed.intervalMs },
      deps,
    );
  }

  if (parsed.command === "terminate") {
    return runSuperviseTerminate(
      parsed.sessionRoot,
      { json: parsed.json, force: parsed.force },
      deps,
      writeOut,
      writeErr,
      now,
      startedAt,
    );
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
    // The envelope's nextActions are the report's own (#341): the same
    // machine-readable guidance `ae.supervisionState()` returns.
    nextActions: report.nextActions,
  });
  if (parsed.json) {
    writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    writeOut(renderHuman(envelope));
  }
  return { exitCode: verdict.exitCode };
}
