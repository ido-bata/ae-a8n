import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TargetSpec } from "../src/platform/contract.js";
import { FakeAdapter } from "../src/platform/fake-adapter.js";
import { recoverRun, type RecoverInput } from "../src/runner/recover-run.js";
import {
  acquireTargetLock,
  readQuarantine,
  stateLayout,
  targetKey,
  writeQuarantine,
} from "../src/runner/state.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const RUN_ID = "20261110T120000Z-4f2a8c11";

const TARGET: TargetSpec = {
  name: "local-test-user",
  isolation: "session",
  user: "fake-test",
  host: null,
};

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function quarantineFile(stateRoot: string): string {
  return join(stateLayout(stateRoot).quarantine, `${targetKey(TARGET.name)}.json`);
}

function lockFile(stateRoot: string): string {
  return join(stateLayout(stateRoot).locks, `${targetKey(TARGET.name)}.lock`);
}

function runDirectory(stateRoot: string, runId = RUN_ID): string {
  return join(stateLayout(stateRoot).runs, runId);
}

function quarantine(stateRoot: string): void {
  writeQuarantine(stateLayout(stateRoot), TARGET.name, {
    runId: RUN_ID,
    quarantinedAt: NOW.toISOString(),
    detail: "the command timed out and may still be running",
  });
}

function lock(stateRoot: string, pid: number): void {
  const outcome = acquireTargetLock(stateLayout(stateRoot), TARGET.name, {
    runId: "20261110T110000Z-aaaaaaaa",
    pid,
    startedAt: NOW.toISOString(),
  });
  if (!outcome.ok) {
    throw new Error(outcome.detail);
  }
}

async function recover(
  stateRoot: string,
  options: Partial<Omit<RecoverInput, "stateRoot" | "target">> = {},
): Promise<Awaited<ReturnType<typeof recoverRun>>> {
  return recoverRun({
    adapter: new FakeAdapter("darwin"),
    target: TARGET,
    runId: null,
    dryRun: false,
    force: false,
    stateRoot,
    now: () => NOW,
    ...options,
  });
}

describe("run recovery", () => {
  it("reports that there is nothing to recover, and changes nothing", async () => {
    const stateRoot = tempDir("a8n-recover-");
    const result = await recover(stateRoot);

    expect(result.status).toBe("ok");
    expect(result.cleared).toBe(false);
    expect(result.findings).toEqual([
      {
        code: "A8N-JOB-002",
        action: "reported",
        detail: "nothing to recover for target local-test-user: no lock, quarantine or run state",
      },
    ]);
    expect(existsSync(quarantineFile(stateRoot))).toBe(false);
  });

  it("reports a quarantine record but does not clear it without --force", async () => {
    const stateRoot = tempDir("a8n-recover-");
    quarantine(stateRoot);
    const result = await recover(stateRoot);

    expect(result.cleared).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.runId).toBe(RUN_ID);
    expect(result.findings[0]).toMatchObject({
      code: "A8N-JOB-002",
      action: "reported",
    });
    expect(result.findings[0]?.remedy).toContain("--force");
    expect(existsSync(quarantineFile(stateRoot))).toBe(true);
  });

  it("clears the quarantine only when --force is passed", async () => {
    const stateRoot = tempDir("a8n-recover-");
    quarantine(stateRoot);
    const result = await recover(stateRoot, { force: true });

    expect(result.cleared).toBe(true);
    expect(result.findings[0]).toMatchObject({ action: "cleared" });
    expect(existsSync(quarantineFile(stateRoot))).toBe(false);
    expect(readQuarantine(stateLayout(stateRoot), TARGET.name).quarantined).toBe(false);
  });

  it("changes nothing on a dry run, even with --force", async () => {
    const stateRoot = tempDir("a8n-recover-");
    quarantine(stateRoot);
    lock(stateRoot, 999_999);
    const result = await recover(stateRoot, { force: true, dryRun: true });

    expect(result.cleared).toBe(false);
    expect(result.notice).toBe("dry run: nothing was changed");
    expect(result.findings.map((finding) => finding.detail).join("\n")).toContain("dry run");
    expect(existsSync(quarantineFile(stateRoot))).toBe(true);
    expect(existsSync(lockFile(stateRoot))).toBe(true);
  });

  it("releases a lock whose owner process is gone", async () => {
    const stateRoot = tempDir("a8n-recover-");
    lock(stateRoot, 999_999);
    const result = await recover(stateRoot);

    expect(result.cleared).toBe(true);
    expect(result.findings[0]).toMatchObject({ action: "cleared" });
    expect(existsSync(lockFile(stateRoot))).toBe(false);
  });

  it("never takes over a lock whose owner is still running", async () => {
    const stateRoot = tempDir("a8n-recover-");
    lock(stateRoot, process.pid);
    const result = await recover(stateRoot);

    expect(result.cleared).toBe(false);
    expect(result.findings[0]).toMatchObject({ action: "reported" });
    expect(result.findings[0]?.detail).toContain("still running");
    expect(existsSync(lockFile(stateRoot))).toBe(true);
  });

  it("refuses to guess about a lock it cannot read, and reports status unknown", async () => {
    const stateRoot = tempDir("a8n-recover-");
    mkdirSync(stateLayout(stateRoot).locks, { recursive: true, mode: 0o700 });
    writeFileSync(lockFile(stateRoot), "{not json");

    const result = await recover(stateRoot);

    expect(result.status).toBe("unknown");
    expect(result.findings[0]).toMatchObject({ action: "refused" });
    expect(existsSync(lockFile(stateRoot))).toBe(true);
  });

  it("records an incomplete run as unknown, never as a pass, and only once", async () => {
    const stateRoot = tempDir("a8n-recover-");
    mkdirSync(join(runDirectory(stateRoot), "artifacts"), { recursive: true, mode: 0o700 });
    writeFileSync(join(runDirectory(stateRoot), "trace.jsonl"), "{}\n");

    const result = await recover(stateRoot, { runId: RUN_ID });
    expect(result.findings[0]).toMatchObject({ action: "recorded" });

    const report = JSON.parse(
      readFileSync(join(runDirectory(stateRoot), "report.json"), "utf-8"),
    ) as { status: string; verdicts: readonly { id: string }[] };
    expect(report.status).toBe("unknown");
    expect(report.verdicts[0]?.id).toBe("recovery");

    const again = await recover(stateRoot, { runId: RUN_ID });
    expect(again.findings[0]?.detail).toContain("already has a report");
  });

  it("writes no report for an incomplete run on a dry run", async () => {
    const stateRoot = tempDir("a8n-recover-");
    mkdirSync(runDirectory(stateRoot), { recursive: true, mode: 0o700 });
    await recover(stateRoot, { runId: RUN_ID, dryRun: true });

    expect(existsSync(join(runDirectory(stateRoot), "report.json"))).toBe(false);
  });

  it("reports an unreadable quarantine record as unknown and leaves it in place", async () => {
    const stateRoot = tempDir("a8n-recover-");
    mkdirSync(stateLayout(stateRoot).quarantine, { recursive: true, mode: 0o700 });
    writeFileSync(quarantineFile(stateRoot), "{not json");

    const result = await recover(stateRoot, { force: true });

    expect(result.status).toBe("unknown");
    expect(result.cleared).toBe(false);
    expect(result.findings[0]).toMatchObject({ action: "reported" });
    expect(existsSync(quarantineFile(stateRoot))).toBe(true);
  });

  it("carries what the platform reported for the run directory", async () => {
    const stateRoot = tempDir("a8n-recover-");
    mkdirSync(runDirectory(stateRoot), { recursive: true, mode: 0o700 });
    writeFileSync(join(runDirectory(stateRoot), "report.json"), "{}\n");

    const adapter = new FakeAdapter("darwin");
    const result = await recover(stateRoot, { runId: RUN_ID, adapter });

    expect(adapter.calls).toContain(`recover:${runDirectory(stateRoot)}`);
    expect(result.findings.some((finding) => finding.detail.includes("fake adapter"))).toBe(true);
  });

  it("still inspects the files when no backend could be selected", async () => {
    const stateRoot = tempDir("a8n-recover-");
    quarantine(stateRoot);
    const result = await recover(stateRoot, { adapter: null });

    expect(result.findings[0]).toMatchObject({ action: "reported" });
    // The quarantine names a run with no directory; that is reported, not acted on.
    expect(result.findings[1]?.detail).toContain("no run directory");
    expect(result.cleared).toBe(false);
  });
});
