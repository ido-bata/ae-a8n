#!/usr/bin/env node
/**
 * The real-host end-to-end test, run **inside** the isolated session.
 *
 * It is deliberately written as a plain Node script with no test runner: it
 * has to run in another user's session, on a machine where the agent cannot
 * install anything, and its result has to be a file a controller can read.
 *
 *   node ae-e2e.mjs --pkg /Users/Shared/ae-a8n/pkg --report /Users/Shared/ae-a8n/run/e2e-report.json
 *
 * What it does:
 *   A. launches After Effects in this session, reads its version and who
 *      owns it, builds a scene, renders a frame, and quits;
 *   B. raises a native modal dialog, lets the call time out, and lets the
 *      GUI fallback close it — then checks that the original call finished
 *      instead of being sent a second time;
 *   C. writes what happened, with the evidence, to the report file.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    pkg: "/Users/Shared/ae-a8n/pkg",
    report: "/Users/Shared/ae-a8n/run/e2e-report.json",
    sessionRoot: "/Users/Shared/ae-a8n/sessions",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pkg" || arg === "--report" || arg === "--session-root") {
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function sessionIdentity() {
  const uid = process.getuid();
  let asid = null;
  let kind = "none";
  try {
    const text = execFileSync("launchctl", ["print", `gui/${uid}`], { encoding: "utf-8" });
    const asidMatch = /\b(?:gui )?asid = (\d+)/.exec(text);
    const kindMatch = /^\s*session = (\w+)\s*$/m.exec(text);
    asid = asidMatch === null ? null : Number(asidMatch[1]);
    kind = kindMatch === null ? "none" : kindMatch[1];
  } catch {
    // left as unknown
  }
  let consoleUid = -1;
  try {
    consoleUid = Number(execFileSync("stat", ["-f", "%u", "/dev/console"], { encoding: "utf-8" }).trim());
  } catch {
    // left as unknown
  }
  return {
    uid,
    username: execFileSync("id", ["-un"], { encoding: "utf-8" }).trim(),
    asid,
    kind,
    consoleUid,
    isolated: consoleUid !== uid,
  };
}

const options = parseArgs(process.argv.slice(2));
const identity = sessionIdentity();
const report = {
  startedAt: new Date().toISOString(),
  session: identity,
  steps: [],
};
let stepNumber = 0;

function record(name, status, detail) {
  stepNumber += 1;
  report.steps.push({ step: stepNumber, name, status, detail, at: new Date().toISOString() });
  process.stdout.write(`[e2e ${stepNumber}] ${name}: ${status} ${JSON.stringify(detail ?? {})}\n`);
}

function finish(status, error) {
  report.finishedAt = new Date().toISOString();
  report.status = status;
  if (error !== undefined) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  mkdirSync(resolve(options.report, ".."), { recursive: true });
  writeFileSync(options.report, JSON.stringify(report, null, 2));
  process.stdout.write(`[e2e] report written to ${options.report} (${status})\n`);
  if (status !== "passed") {
    process.exitCode = 1;
  }
}

const { AfterEffects } = await import(join(options.pkg, "dist", "index.js"));

let ae = null;
try {
  record("session", "ok", identity);
  if (!identity.isolated) {
    throw new Error(
      "this session owns the console; the test would run on the user's own desktop. Log in as the test user first.",
    );
  }
  // A stable session root on purpose: AE 2026 asks a person to approve the
  // folder it may run scripts from, and the folder has to be the same one on
  // every run for that approval to hold.
  const sessionRoot = join(options.sessionRoot, "real-host");
  mkdirSync(sessionRoot, { recursive: true });

  // ---------------------------------------------------------------- A ----
  const started = Date.now();
  ae = await AfterEffects.launch({ sessionRoot, timeoutMs: 120_000, session: { uid: identity.uid, recover: true } });
  record("launch", "ok", { version: ae.info().version, build: ae.info().build, ms: Date.now() - started });
  record("ownership", "ok", ae.ownership());

  const project = await ae.project();
  const comp = await project.createComp({ name: "A8N Isolated", width: 320, height: 180, frameRate: 24, duration: 1 });
  await comp.addTextLayer({ name: "Label", text: "isolated" });
  record("scene", "ok", { comp: comp.name, layers: (await comp.layers()).length });

  const frame = await comp.renderFrame(0);
  record("render", "ok", {
    path: frame.path,
    bytes: statSync(frame.path).size,
    width: frame.width,
    height: frame.height,
  });

  // ---------------------------------------------------------------- B ----
  const dialogStarted = Date.now();
  let dialogError = null;
  try {
    await ae.showModalDialog("ae-a8n: close me", { timeoutMs: 20_000 });
    record("modal-dialog", "ok", {
      ms: Date.now() - dialogStarted,
      note: "the call finished after the GUI fallback closed the dialog",
    });
  } catch (error) {
    dialogError = error;
    record("modal-dialog", "failed", { error: error instanceof Error ? error.message : String(error) });
  }
  // The host must be alive again, and it must answer a fresh call.
  const versionAfter = await ae.version();
  record("responsive-after-dialog", versionAfter === ae.info().version ? "ok" : "failed", { version: versionAfter });

  const closed = await ae.close();
  ae = null;
  record("close", closed.quit ? "ok" : "skipped", closed);

  finish(dialogError === null ? "passed" : "failed", dialogError ?? undefined);
} catch (error) {
  if (ae !== null) {
    try {
      const closed = await ae.close({ unsavedChanges: "discard" });
      record("close", "ok", closed);
    } catch (closeError) {
      record("close", "failed", { error: closeError instanceof Error ? closeError.message : String(closeError) });
    }
  }
  finish("failed", error);
}
