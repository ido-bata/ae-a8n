/**
 * `ae.supervisionState()` (#287): the public read of the durable
 * supervision contract — unavailable when nothing trustworthy exists,
 * observed when a monitor (or a written document) proves a phase.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects } from "../src/api/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { initialSupervisionDoc, applySupervisionEvent } from "../src/supervision/machine.js";
import { writeSupervisionState } from "../src/supervision/state.js";

let root: string;
let sessionRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-supapi-"));
  sessionRoot = join(root, "session");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ae.supervisionState()", () => {
  it("reports unavailable when no supervision state exists", async () => {
    const ae = await AfterEffects.launch({
      sessionRoot,
      transport: new FakeAfterEffectsTransport(),
    });
    try {
      const report = ae.supervisionState();
      // The fake transport attests no pid/session, so no monitor can run:
      // the honest answer is unavailable, never a clean bill.
      expect(report.status).toBe("unavailable");
    } finally {
      await ae.close();
    }
  });

  it("reports the durable phase another writer recorded", async () => {
    const ae = await AfterEffects.launch({
      sessionRoot,
      transport: new FakeAfterEffectsTransport(),
    });
    try {
      const now = new Date();
      const blocked = applySupervisionEvent(
        initialSupervisionDoc({ now }),
        {
          kind: "blocking-observed",
          blocking: {
            host: "none",
            windows: [
              {
                title: "crash repair",
                role: "AXWindow",
                subrole: null,
                texts: ["recover project"],
                buttons: ["OK"],
                blocking: true,
                tier: "human-required",
                dialogClass: "crash-repair",
                code: "A8N-SEC-001",
              },
            ],
            detail: "1 blocking window(s): crash-repair",
          },
          reason: "fixture",
        },
        now,
      );
      expect(blocked.ok).toBe(true);
      if (blocked.ok) {
        writeSupervisionState(sessionRoot, blocked.doc);
      }
      const report = ae.supervisionState();
      expect(report.status).toBe("observed");
      if (report.status === "observed") {
        expect(report.doc.phase).toBe("blocked");
        expect(report.doc.blocking?.windows[0]?.dialogClass).toBe("crash-repair");
      }
    } finally {
      await ae.close();
    }
  });
});
