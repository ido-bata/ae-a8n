/**
 * Opt-in interop check for #238 Slice B: the REAL ae-a8n client
 * (prepareNativeChannel / publishNativeRequest / awaitNativeResult)
 * against the REAL ae-devtools intake — `probe_test --channel-server`
 * running probe.cpp + native_intake.cpp against FakeHost (no After
 * Effects). Point AE_DEVTOOLS_PROBE_TEST at the built test binary;
 * the suite skips when unset so CI stays hermetic. Evidence level:
 * fake/mock only — nothing here is real-host proof.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  prepareNativeChannel,
  publishNativeRequest,
  awaitNativeResult,
  readNativeChannelState,
  type NativeRequestInput,
} from "../src/driver/native-channel.js";

const BIN = process.env.AE_DEVTOOLS_PROBE_TEST ?? "";

describe.skipIf(BIN === "")("native-channel interop with ae-devtools probe_test (fake host)", () => {
  it("publishes a request the real intake processes and collects the typed result", async () => {
    const root = mkdtempSync(join(tmpdir(), "a8n-native-interop-"));
    try {
      const channel = prepareNativeChannel(root);
      const input: NativeRequestInput = {
        requestId: "interop-1",
        timeoutMs: 30_000,
        session: { sessionId: "interop", aeVersion: "26.5" },
        operationId: "AEGP_ProjSuite6.AEGP_GetNumProjects",
      };
      publishNativeRequest(channel, input);

      const child = spawn(BIN, ["--channel-server", root, "interop-1", "20000"], {
        stdio: "ignore",
      });
      const delivery = await awaitNativeResult(channel, "interop-1", 30_000, {
        graceMs: 25_000,
        pollMs: 50,
      });
      child.kill();

      expect(delivery.result.outcome).toBe("completed");
      expect(delivery.result.requestId).toBe("interop-1");
      expect(delivery.result.schema).toBe("ae-devtools/native-dispatch/v1");
      expect((delivery.result.result as { numProjects?: number }).numProjects).toBeTypeOf("number");
      expect(delivery.result.opCalls?.length).toBeGreaterThan(0);
      expect(delivery.host.plugin).toBe("ae-a8n NativeProbe");

      const state = readNativeChannelState(root);
      expect(state?.instance).toBe(delivery.instance);
      expect(state?.allowlist).toContain("AEGP_ProjSuite6.AEGP_GetNumProjects");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
