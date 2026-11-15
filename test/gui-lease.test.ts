import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { spawn } from "node:child_process";

import {
  acquireGuiLease,
  auditGuiEvent,
  defaultPidAlive,
  guiLeasePaths,
  guiSessionKey,
  inspectGuiLease,
  reapGuiLease,
  type GuiLease,
  type PidAliveProbe,
  type PidStartProbe,
} from "../src/platform/darwin/gui-lease.js";
import {
  defaultLeaseController,
  GuiMutationError,
  GuiRecoveryError,
  MacGuiRecovery,
  MacSessionError,
  type GuiLeaseController,
} from "../src/driver/gui-recovery.js";

const SESSION = { uid: 501, asid: 100015 };
const OTHER_UID_SESSION = { uid: 502, asid: 100016 };

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "a8n-gui-lease-"));
}

const alive: PidAliveProbe = () => true;
const dead: PidAliveProbe = () => false;
const startA: PidStartProbe = () => "Mon Nov 10 09:00:00 2026";
const startB: PidStartProbe = () => "Tue Nov 11 10:00:00 2026";

const roots: string[] = [];
function root(): string {
  const r = makeRoot();
  roots.push(r);
  return r;
}
afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("guiSessionKey", () => {
  it("scopes the lease to uid and asid", () => {
    expect(guiSessionKey(SESSION)).toBe("uid:501:asid:100015");
    expect(guiSessionKey({ uid: 501, asid: null })).toBe("uid:501:asid:none");
    expect(guiSessionKey(SESSION)).not.toBe(guiSessionKey(OTHER_UID_SESSION));
  });
});

describe("acquireGuiLease", () => {
  it("takes a free lease and releases it", () => {
    const stateRoot = root();
    const out = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { dir } = guiLeasePaths(stateRoot);
    expect(existsSync(join(dir, "gui-501-100015.json"))).toBe(true);
    out.lease.release();
    expect(existsSync(join(dir, "gui-501-100015.json"))).toBe(false);
  });

  it("refuses a second owner while the first holds it", () => {
    const stateRoot = root();
    const first = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(first.ok).toBe(true);
    const second = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-b", pid: 222 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("held");
    expect(second.detail).toContain("agent-a");
    expect(second.holder?.pid).toBe(111);
    if (first.ok) first.lease.release();
  });

  it("does not let a different session contend for the same lease", () => {
    const stateRoot = root();
    const a = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    const b = acquireGuiLease({
      stateRoot,
      session: OTHER_UID_SESSION,
      owner: { id: "agent-b", pid: 222 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) a.lease.release();
    if (b.ok) b.lease.release();
  });

  it("reports a dead owner as stale and refuses to steal it", () => {
    const stateRoot = root();
    const first = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(first.ok).toBe(true);
    // The owner dies: the pid no longer exists.
    const second = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-b", pid: 222 },
      pidAlive: dead,
      pidStartedAt: startA,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("stale");
    // The stale file is still there — acquisition never deletes it.
    const { dir } = guiLeasePaths(stateRoot);
    expect(existsSync(join(dir, "gui-501-100015.json"))).toBe(true);
  });

  it("treats a reused pid with a different start stamp as stale", () => {
    const stateRoot = root();
    const first = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(first.ok).toBe(true);
    // pid 111 is alive again but is a different process now.
    const second = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-b", pid: 222 },
      pidAlive: alive,
      pidStartedAt: startB,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("stale");
  });

  it("refuses an unreadable lease file as ambiguous, never as free", () => {
    const stateRoot = root();
    const { dir } = guiLeasePaths(stateRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gui-501-100015.json"), "not json{{{");
    const out = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-b", pid: 222 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("ambiguous");
  });

  it("release only removes a lease that still names the holder", () => {
    const stateRoot = root();
    const first = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Someone else overwrites the file; release must not delete it.
    const { dir } = guiLeasePaths(stateRoot);
    writeFileSync(
      join(dir, "gui-501-100015.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        sessionKey: "uid:501:asid:100015",
        ownerId: "agent-z",
        pid: 999,
        acquiredAt: new Date().toISOString(),
      }),
    );
    first.lease.release();
    expect(existsSync(join(dir, "gui-501-100015.json"))).toBe(true);
  });
});

describe("reapGuiLease", () => {
  it("requires confirm and re-validates staleness", () => {
    const stateRoot = root();
    acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    // Still alive → reap refuses even with confirm.
    const held = reapGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-b", pid: 222 },
      confirm: true,
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(held.ok).toBe(false);
    // Owner died → reap succeeds.
    const reaped = reapGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-b", pid: 222 },
      confirm: true,
      pidAlive: dead,
      pidStartedAt: startA,
    });
    expect(reaped.ok).toBe(true);
    const { dir } = guiLeasePaths(stateRoot);
    expect(existsSync(join(dir, "gui-501-100015.json"))).toBe(false);
  });

  it("refuses without confirm", () => {
    const stateRoot = root();
    acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    const out = reapGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-b", pid: 222 },
      confirm: false,
      pidAlive: dead,
      pidStartedAt: startA,
    });
    expect(out.ok).toBe(false);
  });
});

describe("inspectGuiLease", () => {
  it("classifies free / held / stale / ambiguous", () => {
    const stateRoot = root();
    const { dir } = guiLeasePaths(stateRoot);
    const path = join(dir, "gui-501-100015.json");
    const probes = { pidAlive: alive, pidStartedAt: startA };
    expect(inspectGuiLease(path, probes).state).toBe("free");
    const out = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "a", pid: 1 },
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(out.ok).toBe(true);
    expect(inspectGuiLease(path, probes).state).toBe("held");
    expect(inspectGuiLease(path, { pidAlive: dead, pidStartedAt: startA }).state).toBe("stale");
    expect(inspectGuiLease(path, { pidAlive: alive, pidStartedAt: startB }).state).toBe("stale");
    writeFileSync(path, "{");
    expect(inspectGuiLease(path, probes).state).toBe("ambiguous");
  });
});

describe("MacGuiRecovery lease gating", () => {
  // A session this process cannot enter: uid differs from ours and we are
  // not root, so runInSession refuses before anything reaches System Events.
  const foreignSession = { uid: 502, username: "other", asid: 100040, kind: "Aqua" as const };

  function recoveryWith(lease: GuiLeaseController): MacGuiRecovery {
    return new MacGuiRecovery({
      session: foreignSession,
      pid: 4242,
      allowConsoleSession: true,
      lease,
    });
  }

  function recordingLease(acquireImpl?: () => GuiLease): {
    lease: GuiLeaseController;
    events: { kind: string; op?: string | undefined; outcome?: string | undefined }[];
    acquisitions: string[];
  } {
    const events: { kind: string; op?: string | undefined; outcome?: string | undefined }[] = [];
    const acquisitions: string[] = [];
    return {
      events,
      acquisitions,
      lease: {
        acquire(op) {
          acquisitions.push(op);
          if (acquireImpl !== undefined) {
            return acquireImpl();
          }
          return {
            path: "/fake/lease",
            release: () => events.push({ kind: "lease-release", op }),
          };
        },
        audit(event) {
          events.push({ kind: event.kind, op: event.op, outcome: event.outcome });
        },
      },
    };
  }

  it("a mutation is refused before anything is pressed when the lease is held", () => {
    const { lease, acquisitions } = recordingLease(() => {
      throw new GuiRecoveryError("GUI mutation refused: held by agent-x (pid 1)");
    });
    const gui = recoveryWith(lease);
    expect(() => gui.pressButton(1, "OK")).toThrow(/held by agent-x/);
    expect(acquisitions).toEqual(["pressButton"]);
    expect(() => gui.clickAt(10, 10)).toThrow(/held by agent-x/);
  });

  it("a mutation holds the lease across the action and releases it after", () => {
    const { lease, events, acquisitions } = recordingLease();
    const gui = recoveryWith(lease);
    // runInSession refuses (foreign session, not root): the action errors,
    // but the lease lifecycle around it is what is under test.
    expect(() => gui.pressButton(1, "OK")).toThrow();
    expect(acquisitions).toEqual(["pressButton"]);
    const kinds = events.map((e) => `${e.kind}:${e.op ?? ""}:${e.outcome ?? ""}`);
    expect(kinds).toContain("mutate:pressButton:not-performed");
    expect(kinds).toContain("lease-release:pressButton:");
    // Observation is audited but never takes the lease: listWindows writes
    // an observe record and no acquisition happens.
    events.length = 0;
    acquisitions.length = 0;
    expect(() => gui.listWindows()).toThrow();
    expect(acquisitions).toHaveLength(0);
    expect(events.map((e) => e.kind)).toContain("observe");
  });

  it("wraps a mid-mutation failure as GuiMutationError and audits it unknown", () => {
    const { lease, events } = recordingLease();
    const gui = new MacGuiRecovery({
      session: foreignSession,
      pid: 4242,
      allowConsoleSession: true,
      lease,
      runSession: () => ({ status: 1, stdout: "", stderr: "press failed", timedOut: false }),
    });
    // The osascript ran (and failed) inside the mutation: the press may have
    // reached the screen, so this is NOT a pre-mutation refusal.
    expect(() => gui.pressButton(1, "OK")).toThrow(GuiMutationError);
    const kinds = events.map((e) => `${e.kind}:${e.op ?? ""}:${e.outcome ?? ""}`);
    expect(kinds).toContain("mutate:pressButton:unknown");
    expect(kinds).toContain("lease-release:pressButton:");
  });

  it("a session-entry failure stays a plain error, not GuiMutationError", () => {
    const { lease } = recordingLease();
    const gui = new MacGuiRecovery({
      session: foreignSession,
      pid: 4242,
      allowConsoleSession: true,
      lease,
      runSession: () => {
        throw new MacSessionError("cannot enter the session");
      },
    });
    expect(() => gui.pressButton(1, "OK")).toThrow(MacSessionError);
    expect(() => gui.pressButton(1, "OK")).not.toThrow(GuiMutationError);
  });
});

describe("auditGuiEvent", () => {
  it("appends one JSONL record per event", () => {
    const stateRoot = root();
    auditGuiEvent(stateRoot, {
      kind: "observe",
      sessionKey: "uid:501:asid:100015",
      ownerId: "agent-a",
      pid: 42,
      op: "listWindows",
    });
    auditGuiEvent(stateRoot, {
      kind: "mutate",
      sessionKey: "uid:501:asid:100015",
      ownerId: "agent-a",
      pid: 42,
      op: "pressButton",
      outcome: "performed",
    });
    const lines = readFileSync(guiLeasePaths(stateRoot).auditLog, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first["kind"]).toBe("observe");
    expect(first["op"]).toBe("listWindows");
    expect(typeof first["ts"]).toBe("string");
    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(second["outcome"]).toBe("performed");
  });
});

describe("review fixes", () => {
  it("defaultPidAlive treats EPERM as alive and ESRCH as dead", async () => {
    // pid 1 (launchd) is root-owned: kill(pid, 0) raises EPERM for a normal
    // user. EPERM means the process exists — it must never read as dead,
    // or a live owner's lease could be reaped.
    expect(defaultPidAlive(1)).toBe(true);
    const child = spawn("sleep", ["30"]);
    const childPid = child.pid;
    expect(childPid).toBeDefined();
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(defaultPidAlive(childPid as number)).toBe(false);
  });

  it("release never deletes a lease another owner took over", () => {
    const stateRoot = root();
    const out = acquireGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "agent-a", pid: 111 },
      pidAlive: alive,
      pidStartedAt: startA,
      now: () => new Date("2026-11-15T00:00:00Z"),
    });
    if (!out.ok) throw new Error("setup failed");
    // Simulate the TOCTOU window: our file was removed externally and a new
    // owner acquired the slot before our release ran.
    const { dir } = guiLeasePaths(stateRoot);
    const path = join(dir, "gui-501-100015.json");
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: "1.0",
        sessionKey: guiSessionKey(SESSION),
        ownerId: "agent-b",
        pid: 222,
        pidStart: "start-b",
        acquiredAt: "2026-11-15T01:00:00.000Z",
        purpose: "gui-mutation",
      })}\n`,
    );
    out.lease.release();
    const after = inspectGuiLease(path, {
      pidAlive: alive,
      pidStartedAt: () => "start-b",
    });
    expect(after.state).toBe("held");
    expect(after.record?.ownerId).toBe("agent-b");
  });

  it("reap removes a genuinely stale lease and refuses a revived one", () => {
    const stateRoot = root();
    const { dir } = guiLeasePaths(stateRoot);
    const path = join(dir, "gui-501-100015.json");
    mkdirSync(dir, { recursive: true });
    const staleRecord = {
      schemaVersion: "1.0",
      sessionKey: guiSessionKey(SESSION),
      ownerId: "ghost",
      pid: 999,
      pidStart: null,
      acquiredAt: "2026-11-15T00:00:00.000Z",
      purpose: "gui-mutation",
    };
    writeFileSync(path, `${JSON.stringify(staleRecord)}\n`);
    const reaped = reapGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "reaper", pid: 1 },
      confirm: true,
      pidAlive: dead,
      pidStartedAt: startA,
    });
    expect(reaped.ok).toBe(true);
    expect(existsSync(path)).toBe(false);

    // A lease whose owner is alive is never reaped, even with confirm.
    writeFileSync(path, `${JSON.stringify(staleRecord)}\n`);
    const held = reapGuiLease({
      stateRoot,
      session: SESSION,
      owner: { id: "reaper", pid: 1 },
      confirm: true,
      pidAlive: alive,
      pidStartedAt: startA,
    });
    expect(held.ok).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("an audit failure after acquire releases the lease and refuses", () => {
    const stateRoot = root();
    // Make the audit log path a directory: every append fails, but the
    // lease directory itself stays writable.
    mkdirSync(join(stateRoot, "gui-audit.jsonl"), { recursive: true });
    const controller = defaultLeaseController({
      stateRoot,
      session: { uid: 501, asid: 100015, username: "tester", kind: "Aqua" },
      ownerId: "agent-a",
    });
    expect(() => controller.acquire("pressButton")).toThrow(/audit record could not be written/);
    // The acquired lease was released: nothing is left holding the session.
    const { dir } = guiLeasePaths(stateRoot);
    const leftovers = existsSync(dir) ? readdirSync(dir) : [];
    expect(leftovers.filter((name) => name.startsWith("gui-"))).toHaveLength(0);
  });
});
