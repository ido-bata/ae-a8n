#!/usr/bin/env node
/**
 * The job runner for an isolated macOS session.
 *
 * It runs **inside** the session of the test user — the one that was logged
 * in through a fast user switch, not the console session. Everything it does
 * therefore happens in that session: the After Effects it starts is that
 * user's, the Apple Events it sends go to that user's After Effects, and the
 * screen it captures is that user's screen.
 *
 * The controller (another session, often the console one) writes a job file;
 * this agent picks it up, runs it, and writes the result back. No root, no
 * `launchctl asuser`, no TCC database editing: the agent is an ordinary
 * program in an ordinary logged-in session.
 *
 *   node session-agent.mjs --root /Users/Shared/ae-a8n
 *
 * Job file:   <root>/jobs/<id>.job.json   { "id": "...", "command": ["node", "..."] }
 * Result:     <root>/results/<id>.result.json
 * Log:        <root>/logs/<id>.log
 */
import { readdir, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { execFile, execFileSync as syncExecFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { assertJobSession } from "./session-rules.mjs";

const DEFAULT_ROOT = "/Users/Shared/ae-a8n";
const POLL_MS = 500;

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      root = argv[index + 1];
      index += 1;
    }
  }
  return { root: resolve(root) };
}

/** The login session this process is in, as macOS reports it. */
function readSession() {
  try {
    const text = syncExecFileSync("launchctl", ["print", `gui/${process.getuid()}`], { encoding: "utf-8" });
    const asid = /\b(?:gui )?asid = (\d+)/.exec(text);
    const kind = /^\s*session = (\w+)\s*$/m.exec(text);
    return {
      uid: process.getuid(),
      username: syncExecFileSync("id", ["-un"], { encoding: "utf-8" }).trim(),
      asid: asid === null ? null : Number(asid[1]),
      kind: kind === null ? "none" : kind[1],
    };
  } catch {
    return { uid: process.getuid(), username: "unknown", asid: null, kind: "none" };
  }
}

/** The user who owns the console right now. */
function readConsoleUid() {
  try {
    return Number(syncExecFileSync("stat", ["-f", "%u", "/dev/console"], { encoding: "utf-8" }).trim());
  } catch {
    return -1;
  }
}

async function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const jobs = join(root, "jobs");
  const results = join(root, "results");
  const logs = join(root, "logs");
  for (const dir of [jobs, results, logs]) {
    await mkdir(dir, { recursive: true, mode: 0o1777 });
  }
  const session = readSession();
  const consoleUid = readConsoleUid();
  const banner = {
    startedAt: new Date().toISOString(),
    session,
    consoleUid,
    isolated: session.uid !== consoleUid,
  };
  await writeFile(join(results, "agent.json"), JSON.stringify(banner, null, 2));
  process.stdout.write(
    `[ae-a8n session agent] uid ${session.uid} (${session.username}), session ${session.kind} asid ${session.asid}, ` +
      `console uid ${consoleUid}. Waiting for jobs in ${jobs}\n`,
  );
  if (!banner.isolated) {
    process.stdout.write(
      "[ae-a8n session agent] WARNING: this is the console session. Stop and log in as the test user first.\n",
    );
  }

  for (;;) {
    let entries = [];
    try {
      entries = await readdir(jobs);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".job.json")) continue;
      const id = entry.slice(0, -".job.json".length);
      const jobPath = join(jobs, entry);
      const resultPath = join(results, `${id}.result.json`);
      if (existsSync(resultPath)) {
        // Already done; the controller has not collected it yet.
        continue;
      }
      let job;
      try {
        job = JSON.parse(await readFile(jobPath, "utf-8"));
      } catch (error) {
        await writeResult(resultPath, {
          id,
          ok: false,
          error: `the job file could not be read: ${error instanceof Error ? error.message : String(error)}`,
          session,
          startedAt: new Date().toISOString(),
        });
        continue;
      }
      try {
        assertJobSession(job, session);
      } catch (error) {
        await writeResult(resultPath, {
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          session,
          startedAt: new Date().toISOString(),
        });
        continue;
      }
      await runJob({ id, job, resultPath, logs, session });
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

async function writeResult(path, payload) {
  await writeFile(path, JSON.stringify(payload, null, 2));
}

async function runJob({ id, job, resultPath, logs, session }) {
  const startedAt = new Date().toISOString();
  const logPath = join(logs, `${id}.log`);
  const command = Array.isArray(job.command) ? job.command : [];
  if (command.length === 0) {
    await writeResult(resultPath, { id, ok: false, error: "the job has no command", session, startedAt });
    return;
  }
  const cwd = typeof job.cwd === "string" ? job.cwd : process.cwd();
  await appendFile(logPath, `--- ${startedAt} ${command.join(" ")}\n`);
  const outcome = await new Promise((done) => {
    const child = execFile(
      command[0],
      command.slice(1),
      { cwd, env: { ...process.env, ...(job.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        done({ error, stdout, stderr });
      },
    );
    child.stdout?.on("data", (chunk) => {
      void appendFile(logPath, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      void appendFile(logPath, chunk);
    });
  });
  await writeResult(resultPath, {
    id,
    ok: outcome.error === null || outcome.error === undefined,
    exitCode: typeof outcome.error?.code === "number" ? outcome.error.code : outcome.error === null || outcome.error === undefined ? 0 : 1,
    error: outcome.error === null || outcome.error === undefined ? undefined : String(outcome.error.message ?? outcome.error),
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    session,
    startedAt,
    endedAt: new Date().toISOString(),
  });
  process.stdout.write(`[ae-a8n session agent] job ${id} finished\n`);
}

await main();
