import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { SpawnJobExecutor, type ExecutorChild, type SpawnFunction } from "../src/platform/windows/executor.js";
import {
  JOB_SCHEMA_VERSION,
  sha256Hex,
  type Job,
} from "../src/platform/windows/job.js";

const ROOTS: string[] = [];
const PAYLOAD = new TextEncoder().encode('{"argv":["/bin/echo","hi"]}\n');

const JOB: Job = {
  schemaVersion: JOB_SCHEMA_VERSION,
  jobId: "20261110T120000Z-abcdef01",
  runId: "20261110T120000Z-run00001",
  createdAt: "2026-11-10T12:00:00.000Z",
  payloadSha256: sha256Hex(PAYLOAD),
  payloadFile: "payload.json",
  writer: { host: "controller", user: "tester" },
};

type SpawnCall = {
  readonly program: string;
  readonly args: readonly string[];
  readonly options: Parameters<SpawnFunction>[2];
};

class FakeChild extends EventEmitter implements ExecutorChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }
}

function spawnPlan(plan: (child: FakeChild) => void): {
  readonly spawn: SpawnFunction;
  readonly calls: SpawnCall[];
  readonly children: FakeChild[];
} {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  return {
    calls,
    children,
    spawn: (program, args, options) => {
      calls.push({ program, args, options });
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => plan(child));
      return child;
    },
  };
}

function payload(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function runDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "a8n-executor-"));
  ROOTS.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the spawn job executor", () => {
  it("spawns the program directly, without a shell, and records its exit code", async () => {
    const directory = await runDirectory();
    const plan = spawnPlan((child) => {
      child.stdout.write("hello");
      child.stderr.write("oops");
      child.emit("close", 3, null);
    });
    const executor = new SpawnJobExecutor({ spawn: plan.spawn, runDirectory: directory });

    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/echo", "hi"], env: { A8N_RUN: "1" } }),
    });

    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]).toMatchObject({
      program: "/bin/echo",
      args: ["hi"],
      options: { shell: false, windowsHide: true },
    });
    expect(plan.calls[0]?.options.env["A8N_RUN"]).toBe("1");
    expect(outcome).toMatchObject({
      status: "failed",
      message: "exited with code 3",
    });
    expect(new TextDecoder().decode(outcome.artifacts?.["stdout.log"])).toBe("hello");
    expect(new TextDecoder().decode(outcome.artifacts?.["stderr.log"])).toBe("oops");
    expect(await readFile(join(directory, "stdout.log"), "utf8")).toBe("hello");
    expect(await readFile(join(directory, "stderr.log"), "utf8")).toBe("oops");
  });

  it("reports a zero exit as ok", async () => {
    const directory = await runDirectory();
    const plan = spawnPlan((child) => {
      child.emit("close", 0, null);
    });
    const executor = new SpawnJobExecutor({ spawn: plan.spawn, runDirectory: directory });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/true"] }),
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.message).toBe("exited with code 0");
  });

  it("refuses an invalid payload before spawning anything", async () => {
    const directory = await runDirectory();
    const cases: readonly unknown[] = [
      { argv: [] },
      { argv: ["relative/program"] },
      { argv: ["/bin/echo", "bad\u0000argument"] },
      { argv: ["/bin/echo", "new\nline"] },
      { argv: ["/bin/echo"], env: { A: 1 } },
      { argv: ["/bin/echo"], cwd: "relative" },
      { argv: ["/bin/echo"], unexpected: true },
      { not: "a payload" },
    ];

    for (const value of cases) {
      const plan = spawnPlan(() => undefined);
      const executor = new SpawnJobExecutor({ spawn: plan.spawn, runDirectory: directory });
      const outcome = await executor.execute({ job: JOB, payload: payload(value) });
      expect(outcome).toMatchObject({ status: "failed", code: "A8N-JOB-001" });
      expect(plan.calls).toEqual([]);
    }

    const plan = spawnPlan(() => undefined);
    const executor = new SpawnJobExecutor({ spawn: plan.spawn, runDirectory: directory });
    expect(
      await executor.execute({ job: JOB, payload: new TextEncoder().encode("{") }),
    ).toMatchObject({ status: "failed", code: "A8N-JOB-001" });
    expect(plan.calls).toEqual([]);
  });

  it("caps each stream and says so", async () => {
    const directory = await runDirectory();
    const plan = spawnPlan((child) => {
      child.stdout.write("abcdef");
      child.stderr.write("ghijkl");
      child.emit("close", 0, null);
    });
    const executor = new SpawnJobExecutor({
      spawn: plan.spawn,
      runDirectory: directory,
      maxOutputBytes: 4,
    });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/echo"] }),
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.message).toContain("stdout truncated to 4 bytes");
    expect(outcome.message).toContain("stderr truncated to 4 bytes");
    expect(outcome.artifacts?.["stdout.log"]).toHaveLength(4);
    expect(outcome.artifacts?.["stderr.log"]).toHaveLength(4);
  });

  it("kills a timed-out child and reports unknown, never failed or ok", async () => {
    const directory = await runDirectory();
    const kills: number[] = [];
    const plan = spawnPlan(() => undefined);
    const executor = new SpawnJobExecutor({
      spawn: plan.spawn,
      runDirectory: directory,
      timeoutMs: 5,
      kill: (child) => {
        if (child.pid !== undefined) {
          kills.push(child.pid);
        }
        child.kill();
      },
    });

    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/sleep", "30"] }),
    });
    expect(outcome).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    expect(outcome.message).toContain("timed out after 5ms");
    expect(kills).toEqual([4242]);
    expect(plan.children[0]?.killed).toBe(true);
  });

  it("keeps unknown even if the killed child later exits", async () => {
    const directory = await runDirectory();
    const plan = spawnPlan((child) => {
      setTimeout(() => {
        child.emit("close", 1, null);
      }, 20);
    });
    const executor = new SpawnJobExecutor({
      spawn: plan.spawn,
      runDirectory: directory,
      timeoutMs: 5,
      kill: (child) => {
        child.kill();
      },
    });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/sleep", "30"] }),
    });
    expect(outcome.status).toBe("unknown");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(outcome.status).toBe("unknown");
  });

  it("turns a spawn error into a failed result", async () => {
    const directory = await runDirectory();
    const plan = spawnPlan((child) => {
      child.emit("error", new Error("ENOENT"));
    });
    const executor = new SpawnJobExecutor({ spawn: plan.spawn, runDirectory: directory });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/missing/program"] }),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("ENOENT");
  });
});
