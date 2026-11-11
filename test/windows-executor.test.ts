import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { SpawnJobExecutor, type ExecutorChild, type SpawnFunction } from "../src/platform/windows/executor.js";
import { signJob, type JobKey } from "../src/platform/windows/auth.js";
import {
  JOB_SCHEMA_VERSION,
  sha256Hex,
  type Job,
} from "../src/platform/windows/job.js";

const ROOTS: string[] = [];
const PAYLOAD = new TextEncoder().encode('{"argv":["/bin/echo","hi"]}\n');
const KEY: JobKey = { keyId: "test-key", secret: new Uint8Array(32).fill(7) };

const JOB: Job = signJob(
  {
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId: "20261110T120000Z-abcdef01",
    runId: "20261110T120000Z-run00001",
    createdAt: "2026-11-10T12:00:00.000Z",
    payloadSha256: sha256Hex(PAYLOAD),
    payloadFile: "payload.json",
    writer: { host: "controller", user: "tester" },
  },
  KEY,
);

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
      readProcessStart: () => Promise.resolve("2026-11-10T12:00:00.0000000Z"),
      kill: (child) => {
        if (child.pid !== undefined) {
          kills.push(child.pid);
        }
        child.kill();
        return { killed: true };
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
      readProcessStart: () => Promise.resolve("2026-11-10T12:00:00.0000000Z"),
      kill: (child) => {
        child.kill();
        return { killed: true };
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

  it("does not kill a pid whose process identity changed while it ran", async () => {
    const directory = await runDirectory();
    const kills: number[] = [];
    const plan = spawnPlan(() => undefined);
    let reads = 0;
    const executor = new SpawnJobExecutor({
      spawn: plan.spawn,
      runDirectory: directory,
      timeoutMs: 5,
      // First read is the child this run started; the second is a process
      // that recycled the pid. Nothing may be killed.
      readProcessStart: () => {
        reads += 1;
        return Promise.resolve(
          reads === 1 ? "2026-11-10T12:00:00.0000000Z" : "2026-11-10T12:00:09.0000000Z",
        );
      },
      kill: (child) => {
        if (child.pid !== undefined) {
          kills.push(child.pid);
        }
        child.kill();
        return { killed: true };
      },
    });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/sleep", "30"] }),
    });
    expect(outcome).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    expect(outcome.message).toContain("the pid now names a different process");
    expect(outcome.message).toContain("nothing was killed");
    expect(kills).toEqual([]);
    expect(plan.children[0]?.killed).toBe(false);
  });

  it("does not kill when the process identity cannot be read at all", async () => {
    const directory = await runDirectory();
    const kills: number[] = [];
    const plan = spawnPlan(() => undefined);
    const executor = new SpawnJobExecutor({
      spawn: plan.spawn,
      runDirectory: directory,
      timeoutMs: 5,
      readProcessStart: () => Promise.resolve(null),
      kill: (child) => {
        kills.push(child.pid ?? -1);
        return { killed: true };
      },
    });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/sleep", "30"] }),
    });
    expect(outcome.status).toBe("unknown");
    expect(kills).toEqual([]);
    // Without a verified identity nothing is killed; the record still names
    // the child a human would have to find.
    expect(outcome.message).toContain("nothing was killed (pid 4242)");
    expect(outcome.message).toContain("may still be running");
  });

  it("does not claim a kill the OS refused", async () => {
    // `taskkill` can fail (access denied, the reader lacks the right). The
    // outcome is unknown either way, but the message must not assert a kill
    // nobody observed.
    const directory = await runDirectory();
    const plan = spawnPlan(() => undefined);
    const executor = new SpawnJobExecutor({
      spawn: plan.spawn,
      runDirectory: directory,
      timeoutMs: 5,
      readProcessStart: () => Promise.resolve("2026-11-10T12:00:00.0000000Z"),
      kill: () => Promise.resolve({ killed: false, detail: "Access is denied." }),
    });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/sleep", "30"] }),
    });
    expect(outcome).toMatchObject({ status: "unknown", code: "A8N-AE-004" });
    expect(outcome.message).toContain("the kill of the child's process tree failed");
    expect(outcome.message).toContain("Access is denied.");
    expect(outcome.message).toContain("pid 4242");
    expect(outcome.message).toContain("started 2026-11-10T12:00:00.0000000Z");
    expect(outcome.message).not.toContain("was sent a kill request");
    expect(outcome.message).toContain("may still be running");
  });

  it("treats a kill that throws as a failed kill, not as a killed child", async () => {
    const directory = await runDirectory();
    const plan = spawnPlan(() => undefined);
    const executor = new SpawnJobExecutor({
      spawn: plan.spawn,
      runDirectory: directory,
      timeoutMs: 5,
      readProcessStart: () => Promise.resolve("2026-11-10T12:00:00.0000000Z"),
      kill: () => {
        throw new Error("spawn taskkill.exe ENOENT");
      },
    });
    const outcome = await executor.execute({
      job: JOB,
      payload: payload({ argv: ["/bin/sleep", "30"] }),
    });
    expect(outcome.status).toBe("unknown");
    expect(outcome.message).toContain("the kill of the child's process tree failed");
    expect(outcome.message).toContain("spawn taskkill.exe ENOENT");
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
