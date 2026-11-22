import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { startDetachedSupervisor } from "../src/supervision/detached.js";
import type { MacSession } from "../src/driver/mac-session.js";

const session: MacSession = {
  uid: 501,
  username: "tester",
  asid: 777,
  kind: "Aqua",
};

function fakeSpawn() {
  const calls: {
    command: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }[] = [];
  const unref = vi.fn();
  const spawn = vi.fn((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return { unref, pid: 4321 } as unknown as ChildProcess;
  });
  return { calls, unref, spawn: spawn as never };
}

describe("startDetachedSupervisor (#295)", () => {
  it("spawns a detached, unref'd, stdio-ignored child with supervisor env", () => {
    const { calls, unref, spawn } = fakeSpawn();
    const result = startDetachedSupervisor({
      sessionDir: "/tmp/sess",
      pid: 1234,
      session,
      spawn,
      entryPath: "/pkg/dist/supervision/supervisor-entry.js",
      platform: "darwin",
    });
    expect(result.pid).toBe(4321);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args).toEqual(["/pkg/dist/supervision/supervisor-entry.js"]);
    expect(call.options["detached"]).toBe(true);
    expect(call.options["stdio"]).toBe("ignore");
    const env = call.options["env"] as Record<string, string>;
    expect(env["AE_A8N_SUPERVISOR_SESSION_DIR"]).toBe("/tmp/sess");
    expect(env["AE_A8N_SUPERVISOR_PID"]).toBe("1234");
    expect(env["AE_A8N_SUPERVISOR_UID"]).toBe("501");
    expect(env["AE_A8N_SUPERVISOR_ASID"]).toBe("777");
    expect(unref).toHaveBeenCalledOnce();
  });

  it("refuses on non-macOS platforms without spawning", () => {
    const { calls, spawn } = fakeSpawn();
    const result = startDetachedSupervisor({
      sessionDir: "/tmp/sess",
      pid: 1234,
      session,
      spawn,
      platform: "win32",
    });
    expect(result.pid).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refuses non-Aqua sessions, missing session ids, and bad pids", () => {
    const { calls, spawn } = fakeSpawn();
    const base = { sessionDir: "/tmp/sess", pid: 1234, spawn, platform: "darwin" as const };
    expect(
      startDetachedSupervisor({ ...base, session: { ...session, kind: "Background" } }).pid,
    ).toBeNull();
    expect(
      startDetachedSupervisor({ ...base, session: { ...session, asid: null } }).pid,
    ).toBeNull();
    expect(startDetachedSupervisor({ ...base, session, pid: 0 }).pid).toBeNull();
    expect(startDetachedSupervisor({ ...base, session, pid: -5 }).pid).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
