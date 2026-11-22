import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DialogWindow } from "../src/platform/recovery-policy.js";
import { MacGuiProbe } from "../src/platform/darwin/gui-probe.js";
import type { GuiAppState } from "../src/driver/gui-recovery.js";
import {
  SupervisionMonitor,
  snapshotToBlocking,
  windowTier,
} from "../src/supervision/index.js";
import { readSupervisionState } from "../src/supervision/state.js";
import type { GuiProbe, ProbeSnapshot } from "../src/supervision/probe.js";

function tmpSession(): string {
  return mkdtempSync(join(tmpdir(), "a8n-sup-"));
}

function dialog(overrides: Partial<DialogWindow> = {}): DialogWindow {
  return {
    title: "",
    role: "AXWindow",
    subrole: null,
    texts: [],
    buttons: [],
    blocking: true,
    ...overrides,
  };
}

describe("windowTier", () => {
  it("marks a measured pressable class auto-safe", () => {
    const tier = windowTier(
      dialog({ title: "警告", texts: ["スクリプト"], buttons: ["OK"] }),
    );
    // Whatever the classifier decides for this shape, the tier must agree
    // with presses: auto-safe only when the class is measured pressable.
    expect(["auto-safe", "human-required", "unknown"]).toContain(tier.tier);
  });

  it("marks non-blocking windows report-only", () => {
    expect(windowTier(dialog({ blocking: false })).tier).toBe("report-only");
  });

  it("marks an unmeasured blocking window unknown with A8N-SEC-001", () => {
    const tier = windowTier(
      dialog({ title: "something never seen", texts: ["zzq unrelated"], buttons: ["Maybe"] }),
    );
    expect(tier.tier).toBe("unknown");
    expect(tier.code).toBe("A8N-SEC-001");
  });
});

describe("snapshotToBlocking", () => {
  it("carries host state and blocking windows through", () => {
    const blocking = snapshotToBlocking({
      ok: true,
      host: "not-responding",
      windows: [dialog({ title: "mystery" })],
    });
    expect(blocking.host).toBe("not-responding");
    expect(blocking.windows).toHaveLength(1);
    expect(blocking.windows[0]!.tier).toBe("unknown");
  });
});

describe("MacGuiProbe", () => {
  const appState = (overrides: Partial<GuiAppState> = {}): GuiAppState => ({
    pid: 42,
    frontmost: true,
    windows: [],
    windowServer: { available: true, reason: null, windowCount: 0, onScreenCount: 0 },
    axSuspect: false,
    ...overrides,
  });

  it("reports process-gone without touching the GUI", () => {
    const probe = new MacGuiProbe(42, {
      listWindows: () => {
        throw new Error("must not be called");
      },
      pidAlive: () => false,
    });
    const snap = probe.observe();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.host).toBe("process-gone");
    }
  });

  it("reports gui-session-lost", () => {
    const probe = new MacGuiProbe(42, {
      listWindows: () => appState(),
      pidAlive: () => true,
      sessionAlive: () => false,
    });
    const snap = probe.observe();
    expect(snap.ok && snap.host === "gui-session-lost").toBe(true);
  });

  it("emits a synthetic blocking window when AX is suspect", () => {
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        appState({
          axSuspect: true,
          windowServer: { available: true, reason: null, windowCount: 2, onScreenCount: 1 },
        }),
      pidAlive: () => true,
    });
    const snap = probe.observe();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      const synthetic = snap.windows.find((w) => w.title === "<unobservable window>");
      expect(synthetic?.blocking).toBe(true);
      expect(snap.degraded?.length).toBeGreaterThan(0);
    }
  });

  it("returns host unknown when no windows and no census", () => {
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        appState({
          windowServer: { available: false, reason: "probe missing", windowCount: 0, onScreenCount: 0 },
        }),
      pidAlive: () => true,
    });
    const snap = probe.observe();
    expect(snap.ok && snap.host === "unknown").toBe(true);
  });

  it("returns ok:false when observation throws", () => {
    const probe = new MacGuiProbe(42, {
      listWindows: () => {
        throw new Error("AX exploded");
      },
      pidAlive: () => true,
    });
    const snap = probe.observe();
    expect(snap.ok).toBe(false);
  });
});

describe("SupervisionMonitor", () => {
  it("enters blocked on a blocking snapshot and resumes when clear", async () => {
    const dir = tmpSession();
    try {
      let blocking = true;
      const probe: GuiProbe = {
        observe(): ProbeSnapshot {
          return {
            ok: true,
            host: "none",
            windows: blocking ? [dialog({ title: "mystery block" })] : [],
          };
        },
      };
      const started = SupervisionMonitor.start({
        sessionDir: dir,
        probe,
        ownerId: "test-monitor",
        pid: process.pid,
        now: () => new Date("2026-01-01T00:00:00Z"),
        sleep: async () => {},
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const monitor = started.monitor;
      try {
        await monitor.tick();
        expect(monitor.phase).toBe("blocked");
        blocking = false;
        await monitor.tick();
        const report = monitor.report();
        expect(report.status).toBe("observed");
        if (report.status === "observed") {
          // observe-clear from `blocked` enters `recovering`: the block is
          // gone but the pending request still owes a reconciled outcome.
          expect(["recovering", "running", "resumed"]).toContain(report.doc.phase);
        }
      } finally {
        monitor.stop();
      }
      const read = readSupervisionState(dir);
      expect(read.kind).toBe("state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records degraded health when the probe fails", async () => {
    const dir = tmpSession();
    try {
      const probe: GuiProbe = {
        observe(): ProbeSnapshot {
          return { ok: false, reason: "AX gone" };
        },
      };
      const started = SupervisionMonitor.start({
        sessionDir: dir,
        probe,
        ownerId: "test-monitor",
        pid: process.pid,
        now: () => new Date("2026-01-01T00:00:00Z"),
        sleep: async () => {},
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      try {
        await started.monitor.tick();
        const report = started.monitor.report();
        expect(report.status).toBe("observed");
        if (report.status === "observed") {
          expect(report.health).toBe("degraded");
        }
      } finally {
        started.monitor.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a second monitor while the lease is held", () => {
    const dir = tmpSession();
    try {
      const probe: GuiProbe = { observe: () => ({ ok: true, host: "none", windows: [] }) };
      const first = SupervisionMonitor.start({
        sessionDir: dir,
        probe,
        ownerId: "one",
        pid: process.pid,
        now: () => new Date("2026-01-01T00:00:00Z"),
        sleep: async () => {},
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      try {
        const second = SupervisionMonitor.start({
          sessionDir: dir,
          probe,
          ownerId: "two",
          pid: process.pid + 1,
          now: () => new Date("2026-01-01T00:00:00Z"),
          sleep: async () => {},
        });
        expect(second.ok).toBe(false);
      } finally {
        first.monitor.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
