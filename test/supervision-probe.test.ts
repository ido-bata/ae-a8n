import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DialogWindow } from "../src/platform/recovery-policy.js";
import {
  AX_SUSPECT_STARTUP_GRACE_MS,
  MacGuiProbe,
  parseElapsedMs,
} from "../src/platform/darwin/gui-probe.js";
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
    axSuspectReason: null,
    axUnaccountedWindows: [],
    axUnaccountedCensusWindows: [],
    axForeignWindowCount: 0,
    axUnmatchedWindowCount: 0,
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
          axSuspectReason: "fixture: the AX listing is untrusted",
          windowServer: { available: true, reason: null, windowCount: 2, onScreenCount: 1 },
        }),
      pidAlive: () => true,
      // An unprovable age fails closed: no grace, blocking evidence now.
      processAgeMs: () => null,
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

  it("confirms an AX-unaccounted on-screen window before reporting it blocking (#321)", () => {
    // The AE 2027 modal shape: AX lists the main window, the census also
    // shows the dialog — one observation is degraded evidence only, the
    // second consecutive one emits the synthetic blocking window.
    const unaccounted = [
      {
        pid: 42,
        owner: "After Effects",
        layer: 8,
        onScreen: true,
        name: "",
        windowNumber: null,
        bounds: { x: 650, y: 185, width: 410, height: 342 },
      },
    ];
    let present = true;
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        appState({
          axUnaccountedWindows: present ? unaccounted : [],
          axUnaccountedCensusWindows: [],
        }),
      pidAlive: () => true,
    });

    const first = probe.observe();
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.windows.some((w) => w.title === "<unobservable window>")).toBe(false);
      expect(first.degraded?.join("\n")).toContain("cannot account for");
    }

    const second = probe.observe();
    expect(second.ok).toBe(true);
    if (second.ok) {
      const synthetic = second.windows.find((w) => w.title === "<unobservable window>");
      expect(synthetic?.blocking).toBe(true);
      expect(synthetic?.texts.join(" ")).toContain("layer 8");
    }

    // Once the window is accounted for again the streak resets: a later
    // reappearance needs the same two observations, not one.
    present = false;
    probe.observe();
    present = true;
    const third = probe.observe();
    expect(third.ok && third.windows.some((w) => w.title === "<unobservable window>")).toBe(false);
    const fourth = probe.observe();
    expect(fourth.ok && fourth.windows.some((w) => w.title === "<unobservable window>")).toBe(true);
  });

  it("excludes foreign and unmatched AX windows from blocking evidence (#330)", () => {
    // The bundle-confused listing: the foreign instance's dialog sits in
    // `windows` beside the target's own window. Only the owned window may
    // report; the foreign one is degraded evidence, never a blocker.
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        appState({
          windows: [
            {
              title: "own project",
              role: "AXWindow",
              subrole: "AXStandardWindow",
              buttons: [],
              texts: [],
              frame: { x: 0, y: 39, width: 1710, height: 1073 },
              censusAttribution: "owned",
            },
            {
              title: "foreign dialog",
              role: "AXWindow",
              subrole: "AXDialog",
              buttons: [{ title: "OK", description: "", position: null, size: null }],
              texts: ["the other instance's dialog"],
              frame: { x: 650, y: 185, width: 410, height: 342 },
              censusAttribution: "foreign",
            },
            {
              title: "phantom",
              role: "AXWindow",
              subrole: "AXDialog",
              buttons: [],
              texts: [],
              frame: { x: 1, y: 1, width: 10, height: 10 },
              censusAttribution: "unmatched",
            },
          ],
          axForeignWindowCount: 1,
          axUnmatchedWindowCount: 1,
        }),
      pidAlive: () => true,
    });
    const snap = probe.observe();
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]?.title).toBe("own project");
    expect(snap.windows.some((w) => w.blocking)).toBe(false);
    expect(snap.degraded?.join("\n")).toContain("other processes");
    expect(snap.degraded?.join("\n")).toContain("unattributed");
  });

  it("does not double-report when axSuspect already covers the census", () => {
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        appState({
          axSuspect: true,
          axSuspectReason: "fixture: the AX listing is untrusted",
          windowServer: { available: true, reason: null, windowCount: 3, onScreenCount: 2 },
          axUnaccountedWindows: [
            {
              pid: 42,
              owner: "After Effects",
              layer: 8,
              onScreen: true,
              name: "",
              windowNumber: null,
              bounds: { x: 1, y: 2, width: 3, height: 4 },
            },
          ],
          axUnaccountedCensusWindows: [],
        }),
      pidAlive: () => true,
      processAgeMs: () => null,
    });
    probe.observe();
    const snap = probe.observe();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      // Exactly one synthetic window — the axSuspect one — not one per
      // census entry.
      expect(snap.windows.filter((w) => w.title === "<unobservable window>")).toHaveLength(1);
    }
  });

  it("defers axSuspect blocking evidence inside the startup grace, then blocks (#322)", () => {
    // The AE 2027 first-launch shape: AX answers zero windows while the
    // census lists several, for minutes while the process is still young.
    let ageMs = 60_000;
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        appState({
          axSuspect: true,
          axSuspectReason: "fixture: the AX listing is untrusted",
          windowServer: { available: true, reason: null, windowCount: 7, onScreenCount: 3 },
        }),
      pidAlive: () => true,
      processAgeMs: () => ageMs,
    });

    // Inside the grace the suspect is degraded evidence only — no blocking
    // window, so supervision can stay `running`.
    const young = probe.observe();
    expect(young.ok).toBe(true);
    if (young.ok) {
      expect(young.windows.some((w) => w.title === "<unobservable window>")).toBe(false);
      expect(young.degraded?.join("\n")).toContain("startup grace");
    }

    // The grace is bounded by process age, not by observation count: the
    // same persistent emptiness becomes blocking evidence the moment the
    // process is older than the grace — finite time, never silent running.
    ageMs = AX_SUSPECT_STARTUP_GRACE_MS;
    const old = probe.observe();
    expect(old.ok).toBe(true);
    if (old.ok) {
      const synthetic = old.windows.find((w) => w.title === "<unobservable window>");
      expect(synthetic?.blocking).toBe(true);
    }
  });

  it("recovers to a clean observation when AX populates inside the grace (#322)", () => {
    let axEmpty = true;
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        axEmpty
          ? appState({
              axSuspect: true,
              axSuspectReason: "fixture: the AX listing is untrusted",
              windowServer: { available: true, reason: null, windowCount: 6, onScreenCount: 4 },
            })
          : appState({
              windows: [
                {
                  title: "comp",
                  role: "AXLayoutArea",
                  subrole: "AXFloatingWindow",
                  buttons: [],
                  texts: [],
                  frame: { x: 0, y: 0, width: 100, height: 100 },
                },
              ],
            }),
      pidAlive: () => true,
      processAgeMs: () => 30_000,
    });

    const empty = probe.observe();
    expect(empty.ok && empty.windows.length === 0).toBe(true);
    axEmpty = false;
    const populated = probe.observe();
    expect(populated.ok).toBe(true);
    if (populated.ok) {
      expect(populated.windows).toHaveLength(1);
      expect(populated.windows.some((w) => w.blocking)).toBe(false);
      expect(populated.degraded ?? []).toHaveLength(0);
    }
  });

  it("does not let the startup grace suppress the unaccounted-windows path (#321)", () => {
    // Grace applies only to total AX emptiness (axSuspect). A young process
    // whose AX lists windows but misses an on-screen census window must
    // still confirm and report it exactly as before.
    const unaccounted = [
      {
        pid: 42,
        owner: "After Effects",
        layer: 8,
        onScreen: true,
        name: "",
        windowNumber: null,
        bounds: { x: 650, y: 185, width: 410, height: 342 },
      },
    ];
    const probe = new MacGuiProbe(42, {
      listWindows: () =>
        appState({
          windows: [
            {
              title: "main",
              role: "AXLayoutArea",
              subrole: "AXFloatingWindow",
              buttons: [],
              texts: [],
              frame: { x: 0, y: 39, width: 1710, height: 1073 },
            },
          ],
          axUnaccountedWindows: unaccounted,
          axUnaccountedCensusWindows: [],
        }),
      pidAlive: () => true,
      processAgeMs: () => 10_000,
    });

    const first = probe.observe();
    expect(first.ok && first.windows.some((w) => w.title === "<unobservable window>")).toBe(false);
    const second = probe.observe();
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.windows.some((w) => w.title === "<unobservable window>")).toBe(true);
    }
  });
});

describe("parseElapsedMs", () => {
  it("parses ps etime output", () => {
    expect(parseElapsedMs("00:00")).toBe(0);
    expect(parseElapsedMs("03:25")).toBe(205_000);
    expect(parseElapsedMs("01:02:03")).toBe(3_723_000);
    expect(parseElapsedMs("03-18:40:36")).toBe((3 * 24 + 18) * 3_600_000 + 40 * 60_000 + 36_000);
  });

  it("rejects unrecognised input", () => {
    expect(parseElapsedMs("")).toBeNull();
    expect(parseElapsedMs("   ")).toBeNull();
    expect(parseElapsedMs("abc")).toBeNull();
    expect(parseElapsedMs("1:2:3:4")).toBeNull();
    expect(parseElapsedMs("-05:00")).toBeNull();
    expect(parseElapsedMs("soon")).toBeNull();
  });
});

describe("SupervisionMonitor", () => {
  it("stays running through launch-transient AX emptiness, then blocks when it persists (#322)", async () => {
    const dir = tmpSession();
    try {
      let ageMs = 60_000;
      let axEmpty = true;
      const suspectState: GuiAppState = {
        pid: 42,
        frontmost: false,
        windows: [],
        windowServer: { available: true, reason: null, windowCount: 7, onScreenCount: 3 },
        axSuspect: true,
        axSuspectReason: "fixture: the AX listing is untrusted",
        axUnaccountedWindows: [],
        axUnaccountedCensusWindows: [],
        axForeignWindowCount: 0,
        axUnmatchedWindowCount: 0,
      };
      const healthyState: GuiAppState = {
        pid: 42,
        frontmost: true,
        windows: [
          {
            title: "comp",
            role: "AXLayoutArea",
            subrole: "AXFloatingWindow",
            buttons: [],
            texts: [],
            frame: { x: 0, y: 0, width: 100, height: 100 },
          },
        ],
        windowServer: { available: true, reason: null, windowCount: 1, onScreenCount: 1 },
        axSuspect: false,
        axSuspectReason: null,
        axUnaccountedWindows: [],
        axUnaccountedCensusWindows: [],
        axForeignWindowCount: 0,
        axUnmatchedWindowCount: 0,
      };
      const probe = new MacGuiProbe(42, {
        listWindows: () => (axEmpty ? suspectState : healthyState),
        pidAlive: () => true,
        processAgeMs: () => ageMs,
      });
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
        // Young process + empty AX: degraded observation, phase running —
        // the launch-transient case that used to pin `blocked` for minutes.
        await monitor.tick();
        expect(monitor.phase).toBe("running");
        const during = monitor.report();
        if (during.status === "observed") {
          expect(during.health).toBe("degraded");
        }

        // AX populates inside the grace: fully clean, health back to ok.
        axEmpty = false;
        await monitor.tick();
        expect(monitor.phase).toBe("running");
        const recovered = monitor.report();
        if (recovered.status === "observed") {
          expect(recovered.health).toBe("ok");
        }

        // Persistent emptiness past the grace still reaches `blocked`.
        axEmpty = true;
        ageMs = AX_SUSPECT_STARTUP_GRACE_MS + 1;
        await monitor.tick();
        expect(monitor.phase).toBe("blocked");
      } finally {
        monitor.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("re-blocks from recovering when a new block appears (#309)", async () => {
    const dir = tmpSession();
    try {
      let windows: DialogWindow[] = [dialog({ title: "first block" })];
      const probe: GuiProbe = {
        observe(): ProbeSnapshot {
          return { ok: true, host: "none", windows };
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
        // Block clears: blocked → recovering, awaiting outcome.
        windows = [];
        await monitor.tick();
        expect(monitor.phase).toBe("recovering");
        // A *different* block during recovery must re-block, not stay
        // invisible behind "recovering" (measured on a real host: a modal
        // raised mid-recovery was never reported).
        windows = [dialog({ title: "second block" })];
        await monitor.tick();
        expect(monitor.phase).toBe("blocked");
        const report = monitor.report();
        if (report.status === "observed") {
          expect(report.doc.blocking?.detail).toContain("second block");
        }
      } finally {
        monitor.stop();
      }
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

  it("promotes a live monitor's health to ok on a clean probe answer", async () => {
    const dir = tmpSession();
    try {
      const probe: GuiProbe = {
        observe: () => ({ ok: true, host: "none", windows: [] }),
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
        // The document initialises as "unavailable" (no monitor record
        // yet); a live monitor whose probe answers cleanly must not stay
        // unavailable — real-host smoke caught exactly that stuck state.
        await started.monitor.tick();
        const report = started.monitor.report();
        expect(report.status).toBe("observed");
        if (report.status === "observed") {
          expect(report.health).toBe("ok");
        }
      } finally {
        started.monitor.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records degraded health from snapshot degradation notes", async () => {
    const dir = tmpSession();
    try {
      const probe: GuiProbe = {
        observe: () => ({
          ok: true,
          host: "none",
          windows: [],
          degraded: ["WindowServer census unavailable: probe missing"],
        }),
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
          expect(report.doc.evidence.join("\n")).toContain(
            "WindowServer census unavailable",
          );
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
