import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import * as acorn from "acorn";

const script = resolve("scripts/inprocess-proof.mjs");
const dirs: string[] = [];

function channel(): string {
  const dir = mkdtempSync(join(tmpdir(), "a8n-inprocess-"));
  dirs.push(dir);
  return dir;
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("read-only in-AE proof (not a production transport)", () => {
  it("prepares a private, ES3-only manually activated host script", () => {
    const dir = channel();
    const result = run("prepare", dir);
    expect(result.status, result.stderr).toBe(0);
    const host = readFileSync(join(dir, "bridge-start.jsx"), "utf8");
    expect(() => acorn.parse(host, { ecmaVersion: 3 })).not.toThrow();
    expect(host).toContain("app.scheduleTask(");
    expect(host).toContain("app.version");
    expect(host).not.toContain("__A8N_PROOF_ROOT__");
    expect(host).not.toContain("__A8N_PROOF_TOKEN__");
    expect(host).not.toContain("app.quit(");
    expect(host).not.toContain("eval(request");
    expect(readFileSync(join(dir, "a8n-json.js"), "utf8")).toContain("A8NJson");

    const second = run("prepare", dir);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("already prepared");
  });

  it("accepts a bound response from a fake AE without an OS automation command", async () => {
    const dir = channel();
    expect(run("prepare", dir).status).toBe(0);
    const child = spawn(process.execPath, [script, "ping", dir, "5000"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (data: Uint8Array) => stdout.push(data));
    child.stderr.on("data", (data: Uint8Array) => stderr.push(data));

    let requestFile = "";
    for (let i = 0; i < 50; i++) {
      const requests = readdirSync(join(dir, "inbox")).filter((s) => s.endsWith(".request.json"));
      if (requests.length > 0) {
        requestFile = requests[0] ?? "";
        break;
      }
      await sleep(20);
    }
    expect(requestFile).not.toBe("");
    const request = JSON.parse(readFileSync(join(dir, "inbox", requestFile), "utf8")) as {
      v: number;
      id: string;
      token: string;
      method: string;
    };
    expect(request.v).toBe(1);
    expect(request.method).toBe("app.version");
    expect(request.id).toMatch(/^[a-f0-9]{32}$/);
    writeFileSync(
      join(dir, "outbox", request.id + ".result.json"),
      JSON.stringify({ v: 1, id: request.id, token: request.token, ok: true, aeVersion: "27.0" }),
    );

    await new Promise<void>((resolveClose) => child.on("close", () => resolveClose()));
    expect(child.exitCode, Buffer.concat(stderr).toString()).toBe(0);
    const value = JSON.parse(Buffer.concat(stdout).toString()) as {
      requestId: string;
      aeVersion: string;
    };
    expect(value.aeVersion).toBe("27.0");
    expect(value.requestId).toBe(request.id);
  });

  it("reports UNKNOWN without replay when no AE is listening", () => {
    const dir = channel();
    expect(run("prepare", dir).status).toBe(0);
    const outcome = run("ping", dir, "100");
    expect(outcome.status).not.toBe(0);
    expect(outcome.stderr).toContain("UNKNOWN");
    expect(readdirSync(join(dir, "inbox")).filter((s) => s.endsWith(".request.json"))).toHaveLength(1);
  });

  it("refuses a channel accessible by other users on POSIX", () => {
    if (process.platform === "win32") return;
    const dir = channel();
    expect(run("prepare", dir).status).toBe(0);
    chmodSync(dir, 0o777);
    const result = run("ping", dir, "100");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("accessible to group/other");
  });
});
