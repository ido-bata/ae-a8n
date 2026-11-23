/**
 * Windows session supervision (#316): `SessionSupervision` builds the
 * `WindowsGuiProbe` path for an attested win32 target, fails closed on
 * anything it cannot prove, and publishes the same durable
 * `supervision.json` the macOS monitor does. Everything here runs against
 * an injected fake `GuiProbe` — no Windows host is required or claimed;
 * real-host verification is the #288 lane.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionSupervision } from "../src/driver/supervision-session.js";
import type { GuiProbe, ProbeSnapshot } from "../src/supervision/probe.js";
import { supervisionReport } from "../src/supervision/index.js";
import { supervisionStatePath } from "../src/supervision/state.js";

const CLEAN: ProbeSnapshot = { ok: true, windows: [], host: "none" };
const GONE: ProbeSnapshot = {
  ok: true,
  windows: [],
  host: "process-gone",
  degraded: ["target pid is not alive"],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SessionSupervision on win32 (#316)", () => {
  let sessionRoot: string;

  beforeEach(() => {
    sessionRoot = mkdtempSync(join(tmpdir(), "a8n-sup-win-"));
  });

  afterEach(() => {
    rmSync(sessionRoot, { recursive: true, force: true });
  });

  function start(
    overrides: Partial<Parameters<typeof SessionSupervision.start>[0]> = {},
  ): SessionSupervision | null {
    return SessionSupervision.start({
      sessionRoot,
      pid: 4321,
      target: { platform: "win32", session: { sessionId: 3 } },
      platform: "win32",
      probe: { observe: () => CLEAN },
      verifyPid: () => true,
      intervalMs: 10,
      ...overrides,
    });
  }

  it("starts a monitor for an attested win32 target and publishes durable state", async () => {
    const supervision = start();
    try {
      expect(supervision).not.toBeNull();
      // The monitor publishes synchronously at start: the durable document
      // exists before the first tick, which is what every consumer reads.
      expect(existsSync(supervisionStatePath(sessionRoot))).toBe(true);

      // Let a few ticks run: the first heartbeat records the monitor and
      // the injected probe's clean answer keeps the document healthy —
      // proof the monitor loop is live, not just seeded.
      await sleep(60);
      const report = supervision!.report();
      expect(report.status).toBe("observed");
      if (report.status !== "observed") {
        return;
      }
      expect(report.doc.phase).toBe("running");
      expect(report.health).toBe("ok");
      expect(report.doc.monitor).not.toBeNull();

      const again = supervisionReport(sessionRoot);
      expect(again.status).toBe("observed");
      if (again.status === "observed") {
        expect(again.doc.phase).toBe("running");
        expect(again.health).toBe("ok");
      }
    } finally {
      supervision?.stop();
    }
  });

  it("refuses a win32 target on a non-win32 host", () => {
    expect(start({ platform: "darwin" })).toBeNull();
    expect(start({ platform: "linux" })).toBeNull();
    // And on the real host when it is not win32 — the default seam.
    if (process.platform !== "win32") {
      const supervision = SessionSupervision.start({
        sessionRoot,
        pid: 4321,
        target: { platform: "win32", session: { sessionId: 3 } },
        probe: { observe: () => CLEAN },
      });
      expect(supervision).toBeNull();
    }
  });

  it("refuses a win32 target whose session id cannot be proven", () => {
    for (const sessionId of [0, -1, 1.5, Number.NaN]) {
      expect(
        start({ target: { platform: "win32", session: { sessionId } } }),
      ).toBeNull();
    }
  });

  it("still refuses a darwin target on a win32 host", () => {
    expect(
      start({
        platform: "win32",
        target: {
          platform: "darwin",
          session: { uid: 501, username: "tester", asid: 42, kind: "Aqua" },
        },
      }),
    ).toBeNull();
  });

  it("degrades — never cleans — when the pid can no longer be re-proven", async () => {
    const supervision = start({ verifyPid: () => false });
    try {
      expect(supervision).not.toBeNull();
      await sleep(60);
      const report = supervisionReport(sessionRoot);
      expect(report.status).toBe("observed");
      if (report.status !== "observed") {
        return;
      }
      // Every clean snapshot was refused by the pid re-proof wrapper, so
      // the durable health is degraded and the evidence names why.
      expect(report.health).toBe("degraded");
      expect(report.doc.evidence.join(" ")).toContain("could not be re-proven");
      expect(report.doc.phase).toBe("running");
    } finally {
      supervision?.stop();
    }
  });

  it("honours a proven process-gone even when the pid re-proof fails", async () => {
    const supervision = start({
      probe: { observe: () => GONE },
      verifyPid: () => false,
    });
    try {
      expect(supervision).not.toBeNull();
      await sleep(60);
      const report = supervisionReport(sessionRoot);
      expect(report.status).toBe("observed");
      if (report.status !== "observed") {
        return;
      }
      // The observer's own meta record proved the process gone; the pid
      // re-proof must not upgrade that to "unknown" or hide it.
      expect(report.doc.blocking?.host).toBe("process-gone");
    } finally {
      supervision?.stop();
    }
  });

  it("checks the pid re-proof after each observation, not before", async () => {
    // Ordering matters: the observer's own meta record is what proves
    // process-gone, so verifyPid must run *after* observe — a dead target
    // is reported gone, not merely "unproven".
    const order: string[] = [];
    const probe: GuiProbe = {
      observe: () => {
        order.push("observe");
        return CLEAN;
      },
    };
    const supervision = start({
      probe,
      verifyPid: () => {
        order.push("verifyPid");
        return true;
      },
    });
    try {
      expect(supervision).not.toBeNull();
      await sleep(60);
      expect(order.length).toBeGreaterThan(0);
      expect(order[0]).toBe("observe");
      expect(order).toContain("verifyPid");
      const report = supervisionReport(sessionRoot);
      expect(report.status).toBe("observed");
      if (report.status === "observed") {
        expect(report.health).toBe("ok");
      }
    } finally {
      supervision?.stop();
    }
  });
});
