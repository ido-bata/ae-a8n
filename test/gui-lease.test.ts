import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSync } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
      readTargetSession: () => foreignSession,
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
      readTargetSession: () => foreignSession,
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
      readTargetSession: () => foreignSession,
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
  // EPERM from kill(pid, 0) and `sleep` are POSIX semantics; Windows has
  // neither, so this probe's EPERM branch is only exercisable there.
  it.runIf(process.platform !== "win32")("defaultPidAlive treats EPERM as alive and ESRCH as dead", async () => {
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
      session: { uid: 501, asid: 100015 },
      ownerId: "agent-a",
    });
    expect(() => controller.acquire("pressButton")).toThrow(/audit record could not be written/);
    // The acquired lease was released: nothing is left holding the session.
    const { dir } = guiLeasePaths(stateRoot);
    const leftovers = existsSync(dir) ? readdirSync(dir) : [];
    expect(leftovers.filter((name) => name.startsWith("gui-"))).toHaveLength(0);
  });
});

describe("parallel lease races (real processes)", () => {
  /**
   * The lease primitives are synchronous, so in-process tests cannot hit
   * the rename/reap/acquire interleavings. These tests bundle the module
   * with esbuild and run real worker processes against one state root.
   */
  const here = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = join(here, "..");

  type WorkerSpec = {
    ownerId: string;
    iterations: number;
    mode: "mutate" | "reap";
  };

  /** Bundle gui-lease.ts into `stateRoot` so worker processes can import it. */
  function bundleInto(stateRoot: string): string {
    const out = join(stateRoot, "lease.mjs");
    // The JS API, not the `.bin` shim: the shim is a shell script on
    // Windows and does not spawn there.
    buildSync({
      entryPoints: [join(repoRoot, "src", "platform", "darwin", "gui-lease.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: out,
    });
    return out;
  }

  function workerSource(): string {
    return `import { appendFileSync } from "node:fs";
import { acquireGuiLease, reapGuiLease } from LEASE_MODULE;
const [,, stateRoot, uid, asid, ownerId, iterations, mode, logPath] = process.argv;
const session = { uid: Number(uid), asid: Number(asid) };
const owner = { id: ownerId, pid: process.pid };
for (let i = 0; i < Number(iterations); i++) {
  if (mode === "reap") {
    reapGuiLease({ stateRoot, session, owner, confirm: true });
    continue;
  }
  const out = acquireGuiLease({ stateRoot, session, owner, purpose: "race" });
  if (!out.ok) continue;
  appendFileSync(logPath, "in " + ownerId + "\\n");
  const until = Date.now() + 3 + Math.floor(Math.random() * 10);
  while (Date.now() < until) { /* hold the lease briefly */ }
  appendFileSync(logPath, "out " + ownerId + "\\n");
  out.lease.release();
}
`;
  }

  function runWorkers(
    stateRoot: string,
    modulePath: string,
    workers: WorkerSpec[],
  ): Promise<void> {
    const workerPath = join(stateRoot, "worker.mjs");
    // A file: URL, not a bare path: Windows paths contain backslashes that
    // are not valid inside a module specifier string.
    const specifier = JSON.stringify(pathToFileURL(modulePath).href);
    writeFileSync(workerPath, workerSource().replace("LEASE_MODULE", specifier));
    const logPath = join(stateRoot, "mutations.log");
    writeFileSync(logPath, "");
    const children = workers.map((w) =>
      spawn(process.execPath, [
        workerPath, stateRoot, String(SESSION.uid), String(SESSION.asid),
        w.ownerId, String(w.iterations), w.mode, logPath,
      ]),
    );
    return Promise.all(
      children.map(
        (c) =>
          new Promise<void>((resolve, reject) => {
            c.once("error", reject);
            c.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
          }),
      ),
    ).then(() => undefined);
  }

  /** Max simultaneous "in" markers without an intervening "out". */
  function maxConcurrentHolders(logPath: string): number {
    let depth = 0;
    let max = 0;
    for (const line of readFileSync(logPath, "utf-8").trim().split("\n")) {
      if (line.startsWith("in ")) { depth += 1; max = Math.max(max, depth); }
      else if (line.startsWith("out ")) depth -= 1;
    }
    return max;
  }

  function leaseDirFiles(stateRoot: string): string[] {
    const { dir } = guiLeasePaths(stateRoot);
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  it("never lets two processes hold the lease at once across acquire/release cycles", async () => {
    const stateRoot = root();
    const localModule = bundleInto(stateRoot);
    const workers: WorkerSpec[] = [0, 1, 2, 3].map((i) => ({
      ownerId: `racer-${i}`,
      iterations: 60,
      mode: "mutate",
    }));
    await runWorkers(stateRoot, localModule, workers);
    expect(maxConcurrentHolders(join(stateRoot, "mutations.log"))).toBeLessThanOrEqual(1);
    // Every acquired lease was released; no trash quarantines remain.
    const leftovers = leaseDirFiles(stateRoot).filter(
      (n) => n.includes(".releasing-") || (n.startsWith("gui-") && n.endsWith(".json")),
    );
    expect(leftovers).toHaveLength(0);
  }, 60_000);

  it("reap racing acquire never removes a live owner's fresh lease", async () => {
    const stateRoot = root();
    const localModule = bundleInto(stateRoot);
    // Seed a stale lease: pid far above the macOS pid ceiling cannot exist.
    const { dir } = guiLeasePaths(stateRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "gui-501-100015.json"),
      `${JSON.stringify({
        schemaVersion: "1.0",
        sessionKey: guiSessionKey(SESSION),
        ownerId: "ghost",
        pid: 400000,
        pidStart: null,
        acquiredAt: "2026-11-15T00:00:00.000Z",
        purpose: "gui-mutation",
      })}\n`,
    );
    const workers: WorkerSpec[] = [
      { ownerId: "reaper-0", iterations: 40, mode: "reap" },
      { ownerId: "reaper-1", iterations: 40, mode: "reap" },
      { ownerId: "mutator-0", iterations: 60, mode: "mutate" },
      { ownerId: "mutator-1", iterations: 60, mode: "mutate" },
    ];
    await runWorkers(stateRoot, localModule, workers);
    expect(maxConcurrentHolders(join(stateRoot, "mutations.log"))).toBeLessThanOrEqual(1);
    // Whatever remains must be a valid record owned by a live worker or
    // nothing at all — never a ghost record resurrected over a live lease.
    const remaining = leaseDirFiles(stateRoot).filter((n) => n.startsWith("gui-") && n.endsWith(".json"));
    for (const name of remaining) {
      const record = JSON.parse(readFileSync(join(dir, name), "utf-8")) as { ownerId?: string };
      expect(["mutator-0", "mutator-1"]).toContain(record.ownerId);
    }
    // No quarantined trash files: restores must have found their slot or
    // the moved record matched and was removed.
    expect(leaseDirFiles(stateRoot).filter((n) => n.includes(".releasing-"))).toHaveLength(0);
  }, 60_000);
});
