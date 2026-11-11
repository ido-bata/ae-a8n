import { describe, expect, it } from "vitest";

import {
  FakeAdapter,
  FAKE_CAPABILITIES,
  FAKE_IDENTITY,
} from "../src/platform/fake-adapter.js";
import {
  UnprovenTargetError,
  assertProvenIdentity,
  capabilityChecks,
  type SessionIdentity,
  type TargetSpec,
} from "../src/platform/contract.js";

const TARGET: TargetSpec = {
  name: "local-test-user",
  isolation: "session",
  user: "fake-test",
  host: null,
};

const UNPROVEN: SessionIdentity = {
  ...FAKE_IDENTITY,
  proven: false,
  detail: { uid: null, asid: null },
};

describe("the adapter contract", () => {
  it("probes without side effects and reports capabilities", async () => {
    const adapter = new FakeAdapter("darwin");
    const probe = await adapter.probe(TARGET);
    expect(probe.capabilities).toEqual(FAKE_CAPABILITIES);
    expect(probe.checks).toEqual([]);
    expect(adapter.calls).toEqual(["probe:local-test-user"]);
  });

  it("records the session lifecycle in order", async () => {
    const adapter = new FakeAdapter("darwin");
    const session = await adapter.open(TARGET);
    await session.open();
    const outcome = await session.run(["./tests/example.ts"], {
      timeoutMs: 1000,
      env: { A8N_RUN_ID: "run-1" },
    });
    const closed = await session.close();

    expect(outcome.exitCode).toBe(0);
    expect(closed).toEqual({ closed: true, reason: null });
    expect(adapter.calls).toEqual([
      "open:local-test-user",
      "session.open",
      "run:./tests/example.ts",
      "session.close",
    ]);
  });

  it("refuses to run a command before the session is open", async () => {
    const adapter = new FakeAdapter("darwin");
    const session = await adapter.open(TARGET);
    await expect(session.run(["./tests/example.ts"], { timeoutMs: 1, env: {} })).rejects.toThrow(
      "not open",
    );
    expect(adapter.calls).not.toContain("run:./tests/example.ts");
  });

  it("refuses an unproven identity before sending anything", async () => {
    const adapter = new FakeAdapter("win32", { identity: UNPROVEN });
    const session = await adapter.open({
      name: "remote",
      isolation: "remote-host",
      user: "test",
      host: "win-test",
    });
    await session.open();

    await expect(session.run(["./tests/example.ts"], { timeoutMs: 1, env: {} })).rejects.toBeInstanceOf(
      UnprovenTargetError,
    );
    expect(adapter.calls).toEqual(["open:remote", "session.open"]);
  });

  it("turns an unproven identity into a diagnostic code", () => {
    try {
      assertProvenIdentity(UNPROVEN);
      expect.unreachable("assertProvenIdentity should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnprovenTargetError);
      expect((error as UnprovenTargetError).code).toBe("A8N-AE-003");
    }
    expect(() => assertProvenIdentity(FAKE_IDENTITY)).not.toThrow();
  });

  it("reports non-interference it cannot prove as a blocker", () => {
    const checks = capabilityChecks({ ...FAKE_CAPABILITIES, nonInterference: "unproven" }, "win32");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.code).toBe("A8N-AE-003");
    expect(checks[0]?.severity).toBe("blocker");
    expect(capabilityChecks(FAKE_CAPABILITIES, "darwin")).toEqual([]);
  });

  it("reports a dry run without claiming a step was applied", async () => {
    const adapter = new FakeAdapter("darwin");
    const steps = await adapter.plan(TARGET);
    const result = await adapter.apply(steps, { yes: false, dryRun: true });
    expect(result.outcomes.map((outcome) => outcome.state)).toEqual(["planned"]);
    expect(adapter.calls).toEqual(["plan:local-test-user", "apply:dry-run"]);
  });
});
