/**
 * Host-side diagnostics for #107: telling "AE died" from "AE did not
 * answer", and collecting the evidence a bug report needs.
 *
 * Everything here runs against fakes and temp directories — no real
 * After Effects. The real-host behaviour of the process probe is covered
 * by the transport's own process-identity tests; what is new is the
 * classification and the collection contract.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects } from "../src/index.js";
import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import type { HostRecovery } from "../src/driver/recovery.js";
import {
  collectSessionDiagnostics,
  darwinDiagnosticSources,
  unsupportedDiagnosticSources,
} from "../src/driver/session-diagnostics.js";
import { ScriptInvocationTransport } from "../src/driver/script-invocation.js";
import type { HostOwnership, HostState, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-diag-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A host that accepts every request and never answers — the shape of a
 * timed-out call. `hostStateKind` plays the process probe.
 */
class SilentTransport implements HostTransport {
  readonly kind = "silent";
  hostStateKind: HostState = "alive";
  invocations = 0;

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  launch(): Promise<void> {
    return Promise.resolve();
  }
  invoke(_entry: string, _options?: InvokeOptions): Promise<void> {
    this.invocations += 1;
    return Promise.resolve();
  }
  ownership(): HostOwnership {
    return { kind: "owned", evidence: "silent test host" };
  }
  hostState(): HostState {
    return this.hostStateKind;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A transport with no hostState at all: the old shape, unclassified. */
class LegacyTransport implements HostTransport {
  readonly kind = "legacy";

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  launch(): Promise<void> {
    return Promise.resolve();
  }
  invoke(_entry: string, _options?: InvokeOptions): Promise<void> {
    return Promise.resolve();
  }
  ownership(): HostOwnership {
    return { kind: "owned", evidence: "legacy test host" };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function driverFor(transport: HostTransport, recovery?: HostRecovery): AeDriver {
  return new AeDriver({
    transport,
    sessionRoot: root,
    trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
    defaultTimeoutMs: 150,
    ...(recovery === undefined ? {} : { recovery, recoveryGraceMs: 300 }),
  });
}

async function timeoutOf(promise: Promise<unknown>): Promise<TimeoutError> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(TimeoutError);
  return error as TimeoutError;
}

describe("timeout host classification", () => {
  it("reports gone when the transport proves the host process is absent", async () => {
    const transport = new SilentTransport();
    transport.hostStateKind = "gone";
    const error = await timeoutOf(driverFor(transport).call("app.info", {}));
    expect(error.hostCondition).toBe("gone");
    expect(error.message).toContain("process is gone");
  });

  it("reports unresponsive when the host process is alive but silent", async () => {
    const transport = new SilentTransport();
    transport.hostStateKind = "alive";
    const error = await timeoutOf(driverFor(transport).call("app.info", {}));
    expect(error.hostCondition).toBe("unresponsive");
  });

  it("reports unknown when the probe cannot attribute a process", async () => {
    const transport = new SilentTransport();
    transport.hostStateKind = "unknown";
    const error = await timeoutOf(driverFor(transport).call("app.info", {}));
    expect(error.hostCondition).toBe("unknown");
  });

  it("reports unknown for a transport that cannot probe at all", async () => {
    const error = await timeoutOf(driverFor(new LegacyTransport()).call("app.info", {}));
    expect(error.hostCondition).toBe("unknown");
  });

  it("reports modal when the recovery saw a blocking window, even over a live probe", async () => {
    const transport = new SilentTransport();
    transport.hostStateKind = "alive";
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({
          recovered: false,
          outcome: "refused",
          evidence: "a window is up",
          window: 'AXDialog "" [OK] says "ae-a8n: hi"',
        }),
    };
    const error = await timeoutOf(driverFor(transport, recovery).call("app.info", {}));
    expect(error.hostCondition).toBe("modal");
  });

  it("modal wins over gone: a window was seen, so the process state is beside the point", async () => {
    const transport = new SilentTransport();
    transport.hostStateKind = "gone";
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({
          recovered: false,
          outcome: "refused",
          evidence: "a window is up",
          window: 'AXDialog "" [OK]',
        }),
    };
    const error = await timeoutOf(driverFor(transport, recovery).call("app.info", {}));
    expect(error.hostCondition).toBe("modal");
  });

  it("never resends the timed-out request, whatever the host looked like", async () => {
    const transport = new SilentTransport();
    transport.hostStateKind = "gone";
    const driver = driverFor(transport);
    await timeoutOf(driver.call("app.info", {}));
    expect(transport.invocations).toBe(1);
  });
});

describe("ScriptInvocationTransport.hostState", () => {
  const executable =
    "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
  const install = { executable, versionName: "Adobe After Effects 2026.app", renderExecutable: null };
  const T0 = Date.parse("2026-10-15T00:00:00Z");
  type P = { pid: number; startedAt: number; executable: string };
  const ae = (pid: number, startedAt = T0 + 1_000): P => ({ pid, startedAt, executable });

  function transportLaunched(launchedPid: number | null, ...lists: P[][]) {
    let i = 0;
    return new ScriptInvocationTransport({
      platform: "darwin",
      install,
      now: () => T0,
      processes: () => lists[Math.min(i++, lists.length - 1)] as P[],
      launchMacHost: () => Promise.resolve(launchedPid === null ? undefined : launchedPid),
    });
  }

  it("is unknown before launch", () => {
    const t = transportLaunched(42, [ae(42)]);
    expect(t.hostState()).toBe("unknown");
  });

  it("is alive while the owned process is still the one that started", async () => {
    const t = transportLaunched(42, [], [ae(42)], [ae(42)]);
    await t.launch();
    t.confirmLaunched();
    expect(t.hostState()).toBe("alive");
  });

  it("is gone once the owned process is absent, even with others running", async () => {
    const t = transportLaunched(42, [], [ae(42)], [ae(43)]);
    await t.launch();
    t.confirmLaunched();
    expect(t.hostState()).toBe("gone");
  });

  it("is gone when the pid was reused by a different start time", async () => {
    const t = transportLaunched(42, [], [ae(42)], [ae(42, T0 + 90_000)]);
    await t.launch();
    t.confirmLaunched();
    expect(t.hostState()).toBe("gone");
  });

  it("tracks the spawned pid before the probe confirms ownership", async () => {
    const t = transportLaunched(42, [], [ae(42)]);
    await t.launch();
    // No confirmLaunched(): the probe never answered.
    expect(t.hostState()).toBe("alive");
  });

  it("is gone when the spawned process vanished before the probe answered", async () => {
    const t = transportLaunched(42, [], []);
    await t.launch();
    expect(t.hostState()).toBe("gone");
  });

  it("is unknown for an attached host with candidates still running", async () => {
    const t = transportLaunched(42, [ae(7, T0 - 60_000)], [ae(7, T0 - 60_000)]);
    await t.launch();
    t.confirmLaunched();
    expect(t.ownership().kind).toBe("attached");
    expect(t.hostState()).toBe("unknown");
  });

  it("is gone for an attached host when no instance of this install remains", async () => {
    const t = transportLaunched(42, [ae(7, T0 - 60_000)], []);
    await t.launch();
    t.confirmLaunched();
    expect(t.hostState()).toBe("gone");
  });

  it("is unknown when the process list cannot be read", async () => {
    const t = new ScriptInvocationTransport({
      platform: "darwin",
      install,
      now: () => T0,
      processes: () => {
        throw new Error("ps failed");
      },
      launchMacHost: () => Promise.resolve(42),
    });
    await t.launch();
    expect(t.hostState()).toBe("unknown");
  });
});

describe("collectSessionDiagnostics", () => {
  const since = Date.now() - 60_000;

  function homeWith(files: Record<string, string>): string {
    const home = join(root, "home");
    for (const [rel, contents] of Object.entries(files)) {
      const path = join(home, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, contents);
      const when = new Date(Date.now() - 30_000);
      utimesSync(path, when, when);
    }
    return home;
  }

  it("collects crash reports and logs touched during the session, and the trace", () => {
    const home = homeWith({
      "Library/Logs/DiagnosticReports/After Effects-2026-11-15-101010.ips": "crash",
      "Library/Logs/DiagnosticReports/Safari-2026-11-15-101010.ips": "not ours",
      "Library/Logs/Adobe/After Effects/main.log": "log line\n",
    });
    const artifacts = join(root, "artifacts");
    const tracePath = join(root, "trace.jsonl");
    writeFileSync(tracePath, '{"seq":0}\n{"seq":1}\n');

    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: artifacts,
      tracePath,
      host: { state: "gone", ownership: { kind: "owned", evidence: "test" }, pid: 42, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });

    expect(report.crashReports).toHaveLength(1);
    expect(report.crashReports[0]?.name).toBe("After Effects-2026-11-15-101010.ips");
    expect(report.crashReports[0]?.bundlePath).toContain("crash-reports");
    expect(existsSync(report.crashReports[0]?.bundlePath ?? "")).toBe(true);
    // The original stays where the OS put it: copies, never moves.
    expect(existsSync(join(home, "Library/Logs/DiagnosticReports/After Effects-2026-11-15-101010.ips"))).toBe(true);

    expect(report.logs.map((l) => l.sourcePath)).toContain(join(home, "Library/Logs/Adobe/After Effects/main.log"));
    expect(report.logs.some((l) => l.sourcePath.includes("Safari"))).toBe(false);

    expect(report.trace?.events).toBe(2);
    expect(report.trace?.bundlePath).toContain("trace.jsonl");
    expect(existsSync(join(report.bundleDir, "trace-tail.jsonl"))).toBe(true);
    expect(existsSync(join(report.bundleDir, "summary.json"))).toBe(true);
    expect(report.host).toMatchObject({ state: "gone", pid: 42 });
  });

  it("skips files older than the session", () => {
    const home = homeWith({});
    const old = join(home, "Library/Logs/DiagnosticReports/After Effects-old.ips");
    mkdirSync(join(old, ".."), { recursive: true });
    writeFileSync(old, "old crash");
    const ancient = new Date(Date.now() - 24 * 3600_000);
    utimesSync(old, ancient, ancient);

    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "test" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    expect(report.crashReports).toHaveLength(0);
  });

  it("keeps only the tail of a large log, within the byte cap", () => {
    const home = homeWith({});
    const big = join(home, "Library/Logs/Adobe/After Effects/big.log");
    mkdirSync(join(big, ".."), { recursive: true });
    writeFileSync(big, `${"x".repeat(5_000)}TAIL-MARKER`);
    const sources = { ...darwinDiagnosticSources(home), maxLogBytes: 100 };

    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources,
      platform: "darwin",
    });
    const log = report.logs.find((l) => l.sourcePath === big);
    expect(log?.truncated).toBe(true);
    expect(log?.bytes).toBe(100);
  });

  it("says so when a platform has no collector, instead of reporting empty", () => {
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "unknown", ownership: { kind: "unknown", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: unsupportedDiagnosticSources(),
      platform: "win32",
    });
    expect(report.notes.join(" ")).toMatch(/no diagnostics collector for win32/);
    expect(report.crashReports).toHaveLength(0);
  });

  it("collects only After Effects logs — other Adobe apps in the window stay out", () => {
    const home = homeWith({
      "Library/Logs/Adobe/After Effects/main.log": "ae log\n",
      "Library/Logs/Adobe/Adobe Photoshop 2026/ps.log": "ps log\n",
      "Library/Logs/Adobe/creative-cloud.log": "cc log\n",
      "Library/Caches/Adobe/After Effects/sentry/breadcrumbs.log": "sentry\n",
      "Library/Caches/Adobe/Adobe Illustrator/cache.dat": "ai cache\n",
    });
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    const paths = report.logs.map((l) => l.sourcePath);
    expect(paths).toContain(join(home, "Library/Logs/Adobe/After Effects/main.log"));
    expect(paths).toContain(join(home, "Library/Caches/Adobe/After Effects/sentry/breadcrumbs.log"));
    expect(paths.some((p) => p.includes("Photoshop"))).toBe(false);
    expect(paths.some((p) => p.includes("creative-cloud"))).toBe(false);
    expect(paths.some((p) => p.includes("Illustrator"))).toBe(false);
  });

  it("never follows a symbolic link out of the log tree", () => {
    const home = homeWith({
      "Library/Logs/Adobe/After Effects/main.log": "ae log\n",
    });
    const outside = join(root, "outside-secret.txt");
    writeFileSync(outside, "not for the bundle\n");
    const linkPath = join(home, "Library/Logs/Adobe/After Effects/leak.log");
    symlinkSync(outside, linkPath);
    const linkedDir = join(home, "Library/Logs/Adobe/After Effects/linked");
    symlinkSync(join(root, "linked-target"), linkedDir);
    mkdirSync(join(root, "linked-target"), { recursive: true });
    writeFileSync(join(root, "linked-target", "inner.log"), "via link\n");

    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    const paths = report.logs.map((l) => l.sourcePath);
    expect(paths).toContain(join(home, "Library/Logs/Adobe/After Effects/main.log"));
    expect(paths).not.toContain(linkPath);
    expect(paths.some((p) => p.includes("linked-target"))).toBe(false);
    expect(report.notes.join(" ")).toMatch(/symbolic link/);
    expect(report.logs.every((l) => !readFileSyncSafe(l.bundlePath ?? "").includes("not for the bundle"))).toBe(true);
  });

  it("does not collect a crash report that is a symbolic link", () => {
    const home = homeWith({});
    const real = join(root, "real.ips");
    writeFileSync(real, "crash body");
    const link = join(home, "Library/Logs/DiagnosticReports/After Effects-2026-11-15-101010.ips");
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(real, link);

    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "gone", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    expect(report.crashReports).toHaveLength(0);
    expect(report.notes.join(" ")).toMatch(/symbolic link/);
  });

  it("attributes a crash report to the session only when its content names the host pid", () => {
    const home = homeWith({
      "Library/Logs/DiagnosticReports/After Effects-mine.ips": '{"pid" : 42, "procName":"After Effects"}',
      "Library/Logs/DiagnosticReports/After Effects-other.ips": '{"pid" : 777, "procName":"After Effects"}',
    });
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "gone", ownership: { kind: "owned", evidence: "t" }, pid: 42, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    expect(report.crashReports).toHaveLength(2);
    const mine = report.crashReports.find((r) => r.name === "After Effects-mine.ips");
    const other = report.crashReports.find((r) => r.name === "After Effects-other.ips");
    expect(mine?.attribution).toBe("session");
    // A different pid in the window is still collected — it is AE evidence —
    // but it is classified as app-level, never as this session's.
    expect(other?.attribution).toBe("app");
    expect(report.logs.every((l) => l.attribution === "app")).toBe(true);
  });

  it("bounds a crash report to its byte cap, keeping the tail", () => {
    const home = homeWith({});
    const big = join(home, "Library/Logs/DiagnosticReports/After Effects-big.ips");
    mkdirSync(join(big, ".."), { recursive: true });
    writeFileSync(big, `${"y".repeat(5_000)}CRASH-TAIL`);
    const sources = { ...darwinDiagnosticSources(home), maxCrashReportBytes: 64 };

    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "gone", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources,
      platform: "darwin",
    });
    expect(report.crashReports).toHaveLength(1);
    expect(report.crashReports[0]?.truncated).toBe(true);
    expect(report.crashReports[0]?.bytes).toBe(64);
  });

  it("stops collecting when the bundle byte budget is spent, and says so", () => {
    const home = homeWith({
      "Library/Logs/DiagnosticReports/After Effects-a.ips": "aaa",
      "Library/Logs/DiagnosticReports/After Effects-b.ips": "bbb",
      "Library/Logs/Adobe/After Effects/main.log": "log\n",
    });
    const sources = { ...darwinDiagnosticSources(home), maxBundleBytes: 2 };

    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources,
      platform: "darwin",
    });
    const total = report.crashReports.reduce((n, r) => n + r.bytes, 0) + report.logs.reduce((n, l) => n + l.bytes, 0);
    expect(total).toBeLessThanOrEqual(2);
    expect(report.notes.join(" ")).toMatch(/byte budget/);
  });

  it("gives same-named files in different directories distinct bundle paths", () => {
    const home = homeWith({
      "Library/Logs/Adobe/After Effects/a/main.log": "one\n",
      "Library/Logs/Adobe/After Effects/b/main.log": "two\n",
    });
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    expect(report.logs).toHaveLength(2);
    const bundlePaths = report.logs.map((l) => l.bundlePath);
    expect(new Set(bundlePaths).size).toBe(2);
    for (const log of report.logs) {
      expect(existsSync(log.bundlePath ?? "")).toBe(true);
    }
  });

  it("always carries the unsanitised-content contract in notes", () => {
    const home = homeWith({});
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    expect(report.notes.join(" ")).toMatch(/unsanitised/);
    expect(report.notes.join(" ")).toMatch(/never uploaded/);
  });

  it("does not let an empty crash-report list pose as a clean exit", () => {
    const home = homeWith({});
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "gone", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(home),
      platform: "darwin",
    });
    expect(report.crashReports).toHaveLength(0);
    const notes = report.notes.join(" ");
    expect(notes).toMatch(/not evidence of how the host ended/);
    // Process absence (the probe) and OS report generation stay separate facts.
    expect(notes).toMatch(/process was absent at collection time/);
  });

  it("marks a truncated trace copy honestly", () => {
    const home = homeWith({});
    const tracePath = join(root, "trace.jsonl");
    writeFileSync(tracePath, `${"z".repeat(2_000)}\n`);
    const sources = { ...darwinDiagnosticSources(home), maxTraceBytes: 100 };
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      tracePath,
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources,
      platform: "darwin",
    });
    expect(report.trace?.truncated).toBe(true);
    expect(report.trace?.bundlePath).not.toBeNull();
  });

  it("notes directories that do not exist rather than silently finding nothing", () => {
    const report = collectSessionDiagnostics({
      sessionRoot: root,
      artifactsDir: join(root, "artifacts"),
      host: { state: "alive", ownership: { kind: "owned", evidence: "t" }, pid: null, transport: "fake" },
      since,
      sources: darwinDiagnosticSources(join(root, "no-such-home")),
      platform: "darwin",
    });
    expect(report.notes.join(" ")).toMatch(/no crash-report directory/);
    expect(report.notes.join(" ")).toMatch(/no host-log directory/);
  });
});

describe("ae.diagnostics()", () => {
  it("returns the report with host state, bundle path and trace count", async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "a8n-diag-session-"));
    try {
      const transport = new FakeAfterEffectsTransport();
      transport.hostPidValue = 4242;
      const ae = await AfterEffects.launch({ transport, sessionRoot });
      const report = ae.diagnostics();
      expect(report.host.state).toBe("alive");
      expect(report.host.pid).toBe(4242);
      expect(report.host.ownership.kind).toBe("owned");
      expect(report.bundleDir.startsWith(join(sessionRoot, "artifacts"))).toBe(true);
      expect(report.trace?.events ?? 0).toBeGreaterThan(0);
      expect(existsSync(join(report.bundleDir, "summary.json"))).toBe(true);
      await ae.close();
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("reports a gone host through the public API", async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "a8n-diag-session-"));
    try {
      const transport = new FakeAfterEffectsTransport();
      transport.hostStateKind = "gone";
      const ae = await AfterEffects.launch({ transport, sessionRoot });
      expect(ae.diagnostics().host.state).toBe("gone");
      await ae.close();
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });
});
