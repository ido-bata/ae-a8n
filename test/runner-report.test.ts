import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listRunIds, readRunReport } from "../src/runner/report-read.js";
import { stateLayout } from "../src/runner/state.js";

const RUN_ID = "20261110T120000Z-4f2a8c11";
const OTHER_RUN_ID = "20261110T130000Z-9b1c2d3e";

const roots: string[] = [];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "a8n-report-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function report(runId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: "1.0",
    runId,
    status: "test-failed",
    verdicts: [{ id: "command", verdict: "fail", message: "the command exited 1" }],
    startedAt: "2026-11-10T12:00:00.000Z",
    finishedAt: "2026-11-10T12:00:05.000Z",
    ...overrides,
  };
}

function manifest(runId: string): unknown {
  return {
    schemaVersion: "1.0",
    runId,
    command: ["node", "--test"],
    target: { name: "local", isolation: "session", user: null, host: null },
    adapter: "fake",
    identity: null,
    package: { name: "@ido-bata/ae-a8n", version: "0.1.0", commit: null },
    startedAt: "2026-11-10T12:00:00.000Z",
    finishedAt: "2026-11-10T12:00:05.000Z",
    commandStartedAt: "2026-11-10T12:00:01.000Z",
    commandFinishedAt: "2026-11-10T12:00:04.000Z",
    exitCode: 1,
    timedOut: false,
    stdout: { path: join("artifacts", "stdout.log"), sha256: "ab", bytes: 2 },
    stderr: { path: null, sha256: null, bytes: null },
    environment: { A8N_RUN_ID: runId },
  };
}

function writeRun(
  root: string,
  runId: string,
  options: { readonly report?: unknown; readonly rawReport?: string; readonly manifest?: unknown } = {},
): string {
  const directory = join(stateLayout(root).runs, runId);
  mkdirSync(join(directory, "artifacts"), { recursive: true, mode: 0o700 });
  const stored = options.rawReport ?? JSON.stringify(options.report ?? report(runId), null, 2);
  writeFileSync(join(directory, "report.json"), `${stored}\n`);
  if (options.manifest !== undefined) {
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(options.manifest));
  }
  return directory;
}

describe("reading a stored run report", () => {
  it("returns the report and the file's bytes unchanged", () => {
    const root = stateRoot();
    const directory = writeRun(root, RUN_ID, { manifest: manifest(RUN_ID) });

    const read = readRunReport({ stateRoot: root, runId: RUN_ID });

    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.runId).toBe(RUN_ID);
    expect(read.directory).toBe(directory);
    expect(read.report.status).toBe("test-failed");
    expect(read.report.verdicts).toEqual([
      { id: "command", verdict: "fail", message: "the command exited 1" },
    ]);
    // The raw text is what `--format json` prints; it must be the file itself.
    expect(read.text).toContain('"status": "test-failed"');
    expect(read.manifest?.command).toEqual(["node", "--test"]);
    expect(read.manifest?.exitCode).toBe(1);
    expect(read.manifest?.timedOut).toBe(false);
    expect(read.manifest?.stdout).toBe(join("artifacts", "stdout.log"));
    expect(read.manifest?.stderr).toBeNull();
  });

  it("chooses the most recent run when no id is given", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID);
    writeRun(root, OTHER_RUN_ID);

    expect(listRunIds(stateLayout(root))).toEqual([RUN_ID, OTHER_RUN_ID]);
    const read = readRunReport({ stateRoot: root, runId: null });
    expect(read.ok).toBe(true);
    expect(read.runId).toBe(OTHER_RUN_ID);
  });

  it("ignores a directory that is not named like a run", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID);
    mkdirSync(join(stateLayout(root).runs, "not-a-run"), { recursive: true });

    const read = readRunReport({ stateRoot: root, runId: null });
    expect(read.ok).toBe(true);
    expect(read.runId).toBe(RUN_ID);
  });

  it("refuses when there is no run at all", () => {
    const root = stateRoot();

    const read = readRunReport({ stateRoot: root, runId: null });

    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.runId).toBeNull();
    expect(read.reason).toContain("no run");
    expect(read.reason).toContain("ae-a8n test");
  });

  it("refuses a run that never wrote a report, and names recover", () => {
    const root = stateRoot();
    // A run directory the runner created but never finished writing.
    mkdirSync(join(stateLayout(root).runs, RUN_ID, "artifacts"), { recursive: true });

    const read = readRunReport({ stateRoot: root, runId: RUN_ID });

    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.reason).toContain("did not finish");
    expect(read.reason).toContain("ae-a8n recover");
    expect(read.reason).toContain("never read as a pass");
  });

  it("refuses a run id that does not exist", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID);

    const read = readRunReport({ stateRoot: root, runId: OTHER_RUN_ID });

    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.reason).toContain(`there is no run ${OTHER_RUN_ID}`);
  });

  it("refuses a report that is not valid JSON", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID, { rawReport: "{" });

    const read = readRunReport({ stateRoot: root, runId: RUN_ID });

    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.reason).toContain("not valid JSON");
  });

  it("refuses a report from another schema version", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID, { report: report(RUN_ID, { schemaVersion: "2.0" }) });

    const read = readRunReport({ stateRoot: root, runId: RUN_ID });

    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.reason).toContain("not a v1.0 run report");
  });

  it("refuses a verdict outside the contract's four", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID, {
      report: report(RUN_ID, { verdicts: [{ id: "x", verdict: "maybe", message: "" }] }),
    });

    const read = readRunReport({ stateRoot: root, runId: RUN_ID });

    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.reason).toContain("not a v1.0 run report");
  });

  it("refuses a report stored under another run's id", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID, { report: report(OTHER_RUN_ID) });

    const read = readRunReport({ stateRoot: root, runId: RUN_ID });

    expect(read.ok).toBe(false);
    if (read.ok) {
      return;
    }
    expect(read.reason).toContain(`names run ${OTHER_RUN_ID}`);
    expect(read.reason).toContain(RUN_ID);
  });

  it("still reads the report when the manifest is missing or malformed", () => {
    const root = stateRoot();
    writeRun(root, RUN_ID, { manifest: { runId: RUN_ID, command: "not-an-array" } });

    const read = readRunReport({ stateRoot: root, runId: RUN_ID });

    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.report.runId).toBe(RUN_ID);
    expect(read.manifest?.command).toBeNull();
    expect(read.manifest?.exitCode).toBeNull();
  });
});
