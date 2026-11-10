/**
 * Human rendering. JSON never goes through here: with `--json`, stdout is
 * exactly one JSON document and this text is not written at all.
 */

import { join } from "node:path";

import type { RunReportRead } from "../runner/report-read.js";
import type { CommandName } from "./args.js";
import type { CliEnvelope } from "./envelope.js";

export function generalHelp(): string {
  return [
    "ae-a8n — After Effects automation",
    "",
    "Usage:",
    "  ae-a8n <command> [options]",
    "",
    "Commands:",
    "  doctor   Read-only environment check; never starts After Effects",
    "  setup    Prepare the isolated session (not implemented in this increment)",
    "  test     Run a command in the isolated session",
    "  recover  Inspect a prior run and release what can be released safely",
    "  report   Print or re-render a prior run's report; never runs After Effects",
    "",
    "Common options:",
    "  --json             Print exactly one JSON document on stdout",
    "  --help, -h         Show this help",
    "  --target <name>    Target name from the configuration",
    "  --user <name>      OS account that runs After Effects",
    "  --host <name>      Windows host; selects the remote-host backend",
    "",
    "Exit codes:",
    "  0 ok, 1 failed, 2 usage, 3 blocked, 4 refused, 5 test-failed, 6 unknown,",
    "  7 setup-incomplete",
    "",
    "Doctor is read-only: it does not start After Effects, open a session,",
    "change TCC or SIP, read a credential, or send an Apple Event.",
  ].join("\n");
}

const COMMAND_HELP: Record<CommandName, string> = {
  doctor: [
    "Usage: ae-a8n doctor [--json] [--target <name>] [--user <name>] [--host <name>] [--verbose]",
    "",
    "Read-only diagnostics for the environment an isolated After Effects session",
    "would use. It reads the OS version and architecture, the Node version, the",
    "installed After Effects, the target account, its GUI (Aqua) session and",
    "session id, the console owner, and whether another After Effects is running.",
    "",
    "It does not start After Effects, open a session, change TCC or SIP, read a",
    "credential, or send an Apple Event.",
    "",
    "Options:",
    "  --json             Print exactly one JSON document on stdout",
    "  --target <name>    Target name (recorded in the envelope)",
    "  --user <name>      OS account the target session must belong to",
    "  --host <name>      Windows host; selects the Windows remote-host adapter",
    "  --verbose          Include the raw evidence in the human output",
    "  --help, -h         Show this help",
    "",
    "Exit codes: 0 when no blocker was found; 3 when any blocker was found;",
    "2 for a usage error; 6 when doctor could not finish.",
  ].join("\n"),
  setup: [
    "Usage: ae-a8n setup [--json] [--target <name>] [--user <name>] [--host <name>] [--yes] [--resume] [--dry-run]",
    "",
    "Guided setup is not implemented in this increment (issue #55). The command",
    "fails closed with exit 7 and changes nothing.",
  ].join("\n"),
  test: [
    "Usage: ae-a8n test [--json] [--target <name>] [--user <name>] [--host <name>] [--timeout <ms>] [--keep] -- <command...>",
    "",
    "Runs the command in the isolated target session, exactly once, and collects",
    "manifest.json, report.json, trace.jsonl and the command's output under the",
    "run directory (~/.ae-a8n/runs/<runId>).",
    "",
    "Before it opens anything it refuses if a prior run left a lock or a",
    "quarantine record, and it stops when doctor would report a blocker. A",
    "timeout or an indeterminate outcome is quarantined, never retried.",
    "",
    "Options:",
    "  --json             Print exactly one JSON document on stdout",
    "  --target <name>    Target name from the configuration",
    "  --user <name>      OS account that runs After Effects",
    "  --host <name>      Windows host; selects the remote-host backend",
    "  --timeout <ms>     Deadline for the command (default 1800000)",
    "  --keep             Keep the run directory even when the run passes",
    "  --help, -h         Show this help",
    "",
    "The run directory is kept when the run fails, and always with --json.",
    "",
    "Exit codes: 0 pass; 5 test failed; 4 refused for safety; 3 environment",
    "blocked; 6 unknown and quarantined; 1 when the run could not be started.",
  ].join("\n"),
  recover: [
    "Usage: ae-a8n recover [--json] [--target <name>] [--user <name>] [--host <name>] [--run <id>] [--dry-run] [--force]",
    "",
    "Inspects what a prior run left behind: the target's lock, its quarantine",
    "record, and the run directory (the quarantined run unless --run names one).",
    "",
    "Without --force it performs only safe cleanup: a lock whose owner process is",
    "gone is released, and an incomplete run is recorded as unknown rather than",
    "as a pass. A quarantine record is reported, not cleared: it exists because",
    "nobody could prove the run had ended. --force clears it, and nothing",
    "implies --force.",
    "",
    "It never quits After Effects, never re-sends a command, and never deletes",
    "a run directory.",
    "",
    "Options:",
    "  --json             Print exactly one JSON document on stdout",
    "  --target <name>    Target whose state is inspected",
    "  --run <id>         Inspect one run instead of the quarantined one",
    "  --dry-run          Report what would be done; change nothing",
    "  --force            Clear the quarantine record",
    "  --help, -h         Show this help",
    "",
    "Exit codes: 0 when the state could be inspected; 6 when it could not be",
    "decided; 1 when recovery could not run.",
  ].join("\n"),
  report: [
    "Usage: ae-a8n report [--json] [--run <id>] [--format <summary|json|junit>]",
    "",
    "Reads a stored run and prints or re-renders its report. The run is the most",
    "recent one under ~/.ae-a8n/runs unless --run names one. It never runs After",
    "Effects and never changes the run.",
    "",
    "Formats:",
    "  summary   (default) human table",
    "  json      the stored report.json, unchanged",
    "  junit     derived for CI; one testcase per verdict",
    "",
    "Options:",
    "  --json             Print the common envelope; cannot be combined with --format",
    "  --run <id>         Read this run instead of the most recent one",
    "  --format <f>       summary, json or junit",
    "  --help, -h         Show this help",
    "",
    "A missing run, or a report that is missing or malformed, exits 1: report",
    "never returns an empty success. A run that never wrote a report is unknown;",
    "\"ae-a8n recover\" records it as such.",
  ].join("\n"),
};

export function helpFor(command: CommandName | null): string {
  return command === null ? generalHelp() : COMMAND_HELP[command];
}

export function renderUsageError(error: string): string {
  return `ae-a8n: ${error}\n\nRun "ae-a8n --help" for usage.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderFacts(facts: unknown): string[] {
  if (!isRecord(facts)) {
    return [];
  }
  const evidence = facts["evidence"];
  if (!isRecord(evidence)) {
    return [];
  }
  const lines = ["", "facts:"];
  for (const [key, value] of Object.entries(evidence)) {
    const text =
      typeof value === "string" ? value : value === null ? "unknown" : JSON.stringify(value);
    lines.push(`  ${key}: ${text}`);
  }
  return lines;
}

function renderVerdicts(envelope: CliEnvelope): string[] {
  const verdicts = envelope.verdicts;
  if (verdicts === undefined) {
    return [];
  }
  const lines = ["", "verdicts:"];
  for (const verdict of verdicts) {
    lines.push(`  [${verdict.verdict}] ${verdict.id}: ${verdict.message}`);
  }
  return lines;
}

function renderFindings(envelope: CliEnvelope): string[] {
  const findings = envelope.findings;
  if (findings === undefined) {
    return [];
  }
  const lines = ["", `findings (${envelope.cleared === true ? "cleared" : "not cleared"}):`];
  for (const finding of findings) {
    lines.push(`  [${finding.action}] ${finding.code}: ${finding.detail}`);
    if (finding.remedy !== undefined && finding.remedy.length > 0) {
      lines.push(`    next: ${finding.remedy}`);
    }
  }
  return lines;
}

function renderArtifacts(envelope: CliEnvelope): string[] {
  const artifacts = envelope.artifacts;
  if (artifacts === undefined) {
    return envelope.runId === undefined ? [] : ["", `run: ${envelope.runId} (directory not kept)`];
  }
  const lines = [
    "",
    `run: ${envelope.runId ?? "unknown"}`,
    `  manifest: ${artifacts.manifest}`,
    `  report:   ${artifacts.report}`,
    `  trace:    ${artifacts.trace}`,
  ];
  for (const file of artifacts.files) {
    lines.push(`  file:     ${file}`);
  }
  return lines;
}

function renderCapabilities(capabilities: CliEnvelope["capabilities"]): string[] {
  if (capabilities === undefined) {
    return [];
  }
  return [
    "",
    "capabilities:",
    `  non-interference: ${capabilities.nonInterference}`,
    `  proves ownership: ${capabilities.provesOwnership ? "yes" : "no"}`,
    `  proves destination: ${capabilities.provesDestination ? "yes" : "no"}`,
    `  GUI recovery: ${capabilities.guiRecovery ? "yes" : "no"}`,
    `  session identity: ${capabilities.sessionIdentity}`,
  ];
}

export function renderEnvelope(
  envelope: CliEnvelope,
  options: { readonly verbose?: boolean } = {},
): string {
  const lines: string[] = [
    `ae-a8n ${envelope.command} — ${envelope.status} (exit ${envelope.exitCode})`,
    `  target: ${envelope.target.name} (${envelope.target.isolation})`,
    `  platform: ${envelope.platform.os} ${envelope.platform.release ?? "unknown"} ` +
      `${envelope.platform.arch ?? "unknown"} (${envelope.platform.backend})`,
    `  package: ${envelope.package.name} ${envelope.package.version}` +
      (envelope.package.commit === null
        ? ""
        : ` (${envelope.package.commit.slice(0, 12)})`),
  ];

  if (envelope.notice !== undefined) {
    lines.push("", envelope.notice);
  }

  if (envelope.checks.length === 0) {
    lines.push("", "checks: none");
  } else {
    for (const severity of ["blocker", "warning", "info"] as const) {
      const matching = envelope.checks.filter((check) => check.severity === severity);
      if (matching.length === 0) {
        continue;
      }
      lines.push("", `${severity}s:`);
      for (const check of matching) {
        lines.push(`  [${check.severity}] ${check.code} ${check.title}`);
        lines.push(`    ${check.detail}`);
        lines.push(`    remedy (${check.remedyKind}): ${check.remedy}`);
      }
    }
  }

  lines.push(...renderCapabilities(envelope.capabilities));
  lines.push(...renderFacts(envelope.facts));
  lines.push(...renderVerdicts(envelope));
  lines.push(...renderFindings(envelope));
  lines.push(...renderArtifacts(envelope));

  if (options.verbose === true && envelope.facts !== undefined) {
    lines.push("", "facts (raw):");
    for (const line of JSON.stringify(envelope.facts, null, 2).split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  if (envelope.nextActions.length > 0) {
    lines.push("", "next actions:");
    for (const action of envelope.nextActions) {
      lines.push(`  [${action.kind}] ${action.code}: ${action.action}`);
    }
  }

  return lines.join("\n");
}

/** `report --format summary`: what the run was, its verdicts, and its files. */
export function renderRunReport(read: Extract<RunReportRead, { readonly ok: true }>): string {
  const { report, manifest, directory, runId } = read;
  const lines = [`ae-a8n report — run ${runId} — ${report.status}`, ""];

  const command = manifest?.command;
  if (command !== undefined && command !== null) {
    lines.push(`  command:   ${command.map((part) => shellish(part)).join(" ")}`);
  }
  lines.push(`  started:   ${report.startedAt}`);
  lines.push(`  finished:  ${report.finishedAt}`);
  if (manifest?.exitCode !== undefined && manifest.exitCode !== null) {
    lines.push(
      `  exit code: ${String(manifest.exitCode)}` +
        (manifest.timedOut === true ? " (the command timed out)" : ""),
    );
  } else if (manifest?.timedOut === true) {
    lines.push("  exit code: unknown (the command timed out)");
  }
  if (manifest?.adapter !== undefined && manifest.adapter !== null) {
    lines.push(`  backend:   ${manifest.adapter}`);
  }
  lines.push(`  directory: ${directory}`);
  lines.push(`  manifest:  ${join(directory, "manifest.json")}`);
  lines.push(`  report:    ${join(directory, "report.json")}`);
  lines.push(`  trace:     ${join(directory, "trace.jsonl")}`);
  for (const captured of [manifest?.stdout, manifest?.stderr]) {
    if (captured !== undefined && captured !== null) {
      lines.push(`  file:      ${join(directory, captured)}`);
    }
  }

  lines.push("", "verdicts:");
  if (report.verdicts.length === 0) {
    lines.push("  none");
  }
  for (const verdict of report.verdicts) {
    lines.push(`  [${verdict.verdict}] ${verdict.id}: ${verdict.message}`);
  }

  if (report.notice !== undefined && report.notice.length > 0) {
    lines.push("", `notice: ${report.notice}`);
  }
  return lines.join("\n");
}

function shellish(part: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/u.test(part) ? part : JSON.stringify(part);
}

function xml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * `report --format junit`: one testcase per verdict. A `fail` is a `<failure>`
 * and a `blocked`/`unknown` is an `<error>`, so CI does not read an
 * indeterminate run as a pass. Per-verdict timing is not recorded, so the
 * `time` attribute is omitted rather than invented.
 */
export function renderRunJunit(read: Extract<RunReportRead, { readonly ok: true }>): string {
  const { report, runId } = read;
  const failures = report.verdicts.filter((verdict) => verdict.verdict === "fail").length;
  const errors = report.verdicts.filter((verdict) => verdict.verdict !== "fail" && verdict.verdict !== "pass").length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="ae-a8n ${xml(runId)}" tests="${String(report.verdicts.length)}" ` +
      `failures="${String(failures)}" errors="${String(errors)}" skipped="0">`,
    "  <properties>",
    `    <property name="ae-a8n.status" value="${xml(report.status)}"/>`,
    `    <property name="ae-a8n.startedAt" value="${xml(report.startedAt)}"/>`,
    `    <property name="ae-a8n.finishedAt" value="${xml(report.finishedAt)}"/>`,
    "  </properties>",
  ];
  for (const verdict of report.verdicts) {
    const open = `  <testcase classname="ae-a8n" name="${xml(verdict.id)}"`;
    if (verdict.verdict === "pass") {
      lines.push(`${open}/>`);
      continue;
    }
    lines.push(`${open}>`);
    const tag = verdict.verdict === "fail" ? "failure" : "error";
    lines.push(
      `    <${tag} message="${xml(verdict.message)}">${xml(verdict.message)}</${tag}>`,
    );
    lines.push("  </testcase>");
  }
  lines.push("</testsuite>");
  return lines.join("\n");
}
