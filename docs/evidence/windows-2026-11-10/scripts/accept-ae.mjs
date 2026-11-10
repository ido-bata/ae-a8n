#!/usr/bin/env node
/**
 * One minimal After Effects operation, run on the Windows host as a job.
 *
 * This is verification-only tooling: it ships in neither package. It is the
 * script a person approves before it runs, so it does as little as possible:
 *
 *   refuse, if After Effects is already running or a project is already open
 *   launch 26.5, prove the instance is the one this run started
 *   create a temp comp and a text layer, read the scene back
 *   render one frame to a temp directory
 *   prove ownership again, quit normally, assert no AfterFX.exe is left
 *
 * It never opens, saves or overwrites a project, never re-sends a timed-out
 * call, never kills a process and never touches a dialog. Everything it
 * creates is under the OS temp directory and named with its start time.
 *
 * Run it from inside the installed package tree so `@ido-bata/ae-a8n`
 * resolves, or name the package explicitly:
 *
 *   node accept-ae.mjs
 *   A8N_PACKAGE=file:///C:/path/to/dist/index.js node accept-ae.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGE = process.env.A8N_PACKAGE ?? "@ido-bata/ae-a8n";
/** The job's own timeout is 180 s; stop early enough to write a summary. */
const DEADLINE_MS = Number(process.env.A8N_ACCEPT_DEADLINE_MS ?? 140_000);
const COMP = { name: "A8N-ACCEPT", width: 320, height: 240, duration: 1, frameRate: 30 };
const TEXT = "A8N";

const startedAt = new Date();
const tag = startedAt.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const outDir = join(tmpdir(), `a8n-accept-${tag}`);

const steps = [];
const problems = [];

function note(text) {
  process.stdout.write(`[accept ${new Date().toISOString()}] ${text}\n`);
}

function elapsed() {
  return Date.now() - startedAt.getTime();
}

/** AfterFX.exe count, or -1 when the list cannot be read. */
function aeProcesses() {
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq AfterFX.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf-8", windowsHide: true, timeout: 15_000 },
    );
    // One quoted CSV line per process; the "no tasks" notice is a plain line.
    return out.split(/\r?\n/).filter((line) => line.trim().startsWith('"')).length;
  } catch {
    return -1;
  }
}

async function step(name, run) {
  if (elapsed() > DEADLINE_MS) {
    throw new Error(`the ${String(DEADLINE_MS)}ms deadline passed before "${name}"`);
  }
  const before = Date.now();
  const value = await run();
  const ms = Date.now() - before;
  steps.push({ name, ms, ok: true });
  note(`${name}: ${String(ms)}ms`);
  return value;
}

function check(name, condition, detail) {
  if (!condition) {
    problems.push(`${name}: ${detail}`);
    note(`FAILED ${name}: ${detail}`);
  } else {
    note(`ok ${name} ${detail}`);
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const facts = { package: PACKAGE, host: process.env["COMPUTERNAME"] ?? null, user: process.env["USERNAME"] ?? null, sessionName: process.env["SESSIONNAME"] ?? null, node: process.version };
  note(`host ${String(facts.host)} user ${String(facts.user)} node ${facts.node}`);

  const before = aeProcesses();
  note(`AfterFX.exe before: ${String(before)}`);
  if (before !== 0) {
    // Someone else's session, or a previous run's leftover. Launching now
    // would make ownership unprovable and could attach to their instance.
    problems.push(
      before < 0
        ? "the process list could not be read, so ownership cannot be proven"
        : `After Effects was already running (${String(before)} process(es)); nothing was launched`,
    );
    return { status: "refused", facts: { ...facts, processesBefore: before } };
  }

  const { AfterEffects } = await import(PACKAGE);
  const ae = await step("launch", () => AfterEffects.launch({ timeoutMs: 60_000 }));
  let scene = null;
  let frame = null;
  let closed = null;
  try {
    const afterLaunch = aeProcesses();
    note(`AfterFX.exe after launch: ${String(afterLaunch)}`);
    check("one AfterFX.exe after launch", afterLaunch === 1, `${String(afterLaunch)} process(es)`);

    const ownership = await step("ownership", () => ae.ownership());
    check("owned", ownership.kind === "owned", `ownership is "${ownership.kind}"`);

    const version = await step("version", () => ae.version());
    check("After Effects 26.5", String(version).startsWith("26.5"), `version "${String(version)}"`);

    const project = await step("project", () => ae.project());
    const projectInfo = await step("project info", () => project.info());
    if (projectInfo.file !== null) {
      // An open project is someone else's work. Nothing is created in it.
      problems.push(
        `a project was already open (${projectInfo.file}); nothing was created in it`,
      );
      return { status: "refused", facts: { ...facts, processesBefore: before, version, ownership, project: projectInfo } };
    }

    const comp = await step("create comp", () => project.createComp(COMP));
    const added = await step("add text layer", () => comp.addTextLayer({ text: TEXT, font: "ArialMT", fontSize: 96 }));
    const compInfo = await step("comp info", () => comp.info());
    const layers = await step("layers", () => comp.layers());
    frame = await step("render frame 0", () => comp.renderFrame(0));

    const layer = layers.find((entry) => entry.id === added.info.id) ?? null;
    scene = {
      comp: compInfo,
      layer: added.info,
      layers: layers.map((entry) => ({ id: entry.id, name: entry.name, type: entry.type })),
    };
    check("comp name", compInfo.name === COMP.name, `"${compInfo.name}"`);
    check("comp size", compInfo.width === COMP.width && compInfo.height === COMP.height, `${String(compInfo.width)}x${String(compInfo.height)}`);
    check("one layer", layers.length === 1, `${String(layers.length)} layer(s)`);
    check("text layer", layer !== null && layer.type === "text", layer === null ? "not in comp.layers()" : `type "${layer.type}"`);
    check("layer name", layer !== null && layer.name === added.info.name, `"${String(layer?.name)}" vs "${added.info.name}"`);

    const png = await stat(frame.path);
    check("frame size", frame.width === COMP.width && frame.height === COMP.height, `${String(frame.width)}x${String(frame.height)}`);
    check("png written", png.size > 0, `${String(png.size)} bytes at ${frame.path}`);

    const ownershipBeforeClose = await step("ownership before quit", () => ae.ownership());
    closed = await step("close", () => ae.close({ unsavedChanges: "discard" }));
    check("quit", closed.quit === true, JSON.stringify(closed));
    check("owned at quit", ownershipBeforeClose.kind === "owned", `ownership is "${ownershipBeforeClose.kind}"`);

    const afterClose = aeProcesses();
    note(`AfterFX.exe after quit: ${String(afterClose)}`);
    check("no AfterFX.exe left", afterClose === 0, `${String(afterClose)} process(es)`);

    return { status: problems.length === 0 ? "ok" : "failed", facts: { ...facts, processesBefore: before, processesAfterLaunch: afterLaunch, processesAfterClose: afterClose, version, ownership, project: projectInfo, scene, frame, closed } };
  } finally {
    if (closed === null) {
      // A failed step leaves After Effects to a person: it is never killed.
      note("the run did not reach a normal quit; After Effects may still be running");
    }
  }
}

let result;
try {
  result = await main();
} catch (error) {
  problems.push(`error: ${error instanceof Error ? error.message : String(error)}`);
  result = { status: "failed", facts: {} };
}

const summary = {
  schemaVersion: "1.0",
  kind: "ae-acceptance",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: elapsed(),
  ...result,
  steps,
  problems,
  createdFiles: [join(outDir, "summary.json")],
  processId: process.pid,
};
await writeFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
note(`summary written to ${join(outDir, "summary.json")}`);
process.exitCode = summary.status === "ok" ? 0 : 1;
