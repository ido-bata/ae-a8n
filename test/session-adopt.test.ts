/**
 * Evidence-backed session resume (#108).
 *
 * A launch writes a provenance record naming the process it proved it owns.
 * `resume` may rebind only when the live process list still proves that exact
 * process — pid, start time, Windows creation identity, executable — is the
 * only instance of the install in scope, and the readiness probe then
 * answers. Everything less refuses: no replacement host is started, and
 * nothing that cannot be proven is ever quit.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AfterEffects } from "../src/index.js";
import { AeDriver } from "../src/driver/driver.js";
import {
  launchProvenancePath,
  readLaunchProvenance,
  recordLaunchProvenance,
} from "../src/driver/launch-provenance.js";
import {
  ScriptInvocationTransport,
  type HostProcess,
} from "../src/driver/script-invocation.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-adopt-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-15T00:00:00Z");
const DARWIN_EXECUTABLE =
  "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects";
const WINDOWS_EXECUTABLE = "C:\\Adobe\\After Effects 2026\\Support Files\\AfterFX.exe";
const darwinInstall = {
  executable: DARWIN_EXECUTABLE,
  versionName: "Adobe After Effects 2026.app",
  renderExecutable: null,
};
const windowsInstall = {
  executable: WINDOWS_EXECUTABLE,
  versionName: "Adobe After Effects 2026",
  renderExecutable: null,
};
const ae = (pid: number, startedAt = T0 + 1_000, executable = DARWIN_EXECUTABLE): HostProcess => ({
  pid,
  startedAt,
  executable,
});

describe("launch provenance record", () => {
  it("round-trips what a session recorded", () => {
    recordLaunchProvenance(root, {
      transport: "script-invocation",
      host: { pid: 4242, startedAt: T0 + 1_000, executable: DARWIN_EXECUTABLE },
    });
    const provenance = readLaunchProvenance(root);
    expect(provenance).not.toBeNull();
    expect(provenance?.schema).toBe("a8n.launch-provenance/v1");
    expect(provenance?.transport).toBe("script-invocation");
    expect(provenance?.host).toMatchObject({
      pid: 4242,
      startedAt: T0 + 1_000,
      executable: DARWIN_EXECUTABLE,
      platform: process.platform,
    });
    expect(provenance?.a8nVersion).toBeTruthy();
  });

  it("is null when nothing was recorded", () => {
    expect(readLaunchProvenance(root)).toBeNull();
  });

  it("throws on unreadable content rather than reporting 'no provenance'", () => {
    writeFileSync(launchProvenancePath(root), "not json{", "utf-8");
    expect(() => readLaunchProvenance(root)).toThrow(/not readable JSON/);
  });

  it("throws on a document of the wrong shape", () => {
    writeFileSync(launchProvenancePath(root), JSON.stringify({ schema: "other/v9" }), "utf-8");
    expect(() => readLaunchProvenance(root)).toThrow(/does not match/);
  });
});

describe("driver provenance", () => {
  function driverFor(transport: FakeAfterEffectsTransport): AeDriver {
    return new AeDriver({
      transport,
      sessionRoot: root,
      trace: new TraceRecorder({ file: join(root, "trace.jsonl") }),
    });
  }

  it("records the owned process on start and clears it on a clean quit", async () => {
    const transport = new FakeAfterEffectsTransport();
    transport.ownedProcessValue = {
      pid: 4242,
      startedAt: T0,
      executable: DARWIN_EXECUTABLE,
    };
    const driver = driverFor(transport);
    await driver.start();
    const provenance = readLaunchProvenance(root);
    expect(provenance?.host.pid).toBe(4242);
    expect(provenance?.transport).toBe("fake-in-process");

    const result = await driver.stop();
    expect(result.quit).toBe(true);
    expect(readLaunchProvenance(root)).toBeNull();
  });

  it("records nothing for a host the session does not own", async () => {
    const transport = new FakeAfterEffectsTransport();
    transport.ownershipKind = "attached";
    transport.ownedProcessValue = {
      pid: 4242,
      startedAt: T0,
      executable: DARWIN_EXECUTABLE,
    };
    const driver = driverFor(transport);
    await driver.start();
    expect(readLaunchProvenance(root)).toBeNull();
    await driver.stop();
  });
});

describe("transport adoption", () => {
  type Adopt = {
    pid: number;
    startedAt: number | null;
    identity?: string | null;
    executable: string;
    recordedAt?: string;
  };

  function darwinTransport(
    processes: () => readonly HostProcess[],
    adopt: Adopt,
  ): ScriptInvocationTransport {
    return new ScriptInvocationTransport({
      platform: "darwin",
      install: darwinInstall,
      now: () => T0,
      processes,
      adopt,
    });
  }

  const recorded = { pid: 42, startedAt: T0 + 1_000, executable: DARWIN_EXECUTABLE };

  it("adopts the recorded process when it is still the only instance", async () => {
    const transport = darwinTransport(() => [ae(42)], { ...recorded, recordedAt: "2026-10-15T00:00:01Z" });
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("owned");
    expect(transport.ownership().evidence).toContain("pid 42");
    expect(transport.hostPid()).toBe(42);
    expect(transport.ownedProcess()).toMatchObject({ pid: 42, executable: DARWIN_EXECUTABLE });
  });

  it("refuses when the recorded process is gone", async () => {
    const transport = darwinTransport(() => [], recorded);
    await expect(transport.launch()).rejects.toThrow(/cannot adopt/);
  });

  it("refuses when the pid was reused by a different process", async () => {
    // Same pid, a start time far outside ps's one-second resolution.
    const transport = darwinTransport(() => [ae(42, T0 + 60_000)], recorded);
    await expect(transport.launch()).rejects.toThrow(/cannot adopt/);
  });

  it("refuses when another instance of the install is also running", async () => {
    const transport = darwinTransport(() => [ae(42), ae(43, T0 + 2_000)], recorded);
    await expect(transport.launch()).rejects.toThrow(/cannot adopt.*instances/);
  });

  it("refuses a record naming a different executable", async () => {
    const transport = darwinTransport(() => [ae(42)], {
      ...recorded,
      executable: "/Applications/Other/After Effects.app/Contents/MacOS/After Effects",
    });
    await expect(transport.launch()).rejects.toThrow(/cannot adopt/);
  });

  it("refuses a record without a start time", async () => {
    const transport = darwinTransport(() => [ae(42)], { ...recorded, startedAt: null });
    await expect(transport.launch()).rejects.toThrow(/start time/);
  });

  it("downgrades to unknown when the process vanishes before the probe answers", async () => {
    const lists: HostProcess[][] = [[ae(42)], []];
    let polls = 0;
    const transport = darwinTransport(
      () => lists[Math.min(polls++, lists.length - 1)] as HostProcess[],
      recorded,
    );
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("unknown");
  });

  it("adopts on Windows only when the creation identity matches", async () => {
    const identity = "2026-10-15T00:00:01.0000000Z";
    const winProcess = (pid: number): HostProcess => ({
      pid,
      startedAt: T0 + 1_000,
      executable: WINDOWS_EXECUTABLE,
      identity,
    });
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: windowsInstall,
      now: () => T0,
      processes: () => [winProcess(42)],
      adopt: {
        pid: 42,
        startedAt: T0 + 1_000,
        identity,
        executable: WINDOWS_EXECUTABLE,
      },
    });
    await transport.launch();
    transport.confirmLaunched();
    expect(transport.ownership().kind).toBe("owned");
    expect(transport.ownedProcess()?.identity).toBe(identity);
  });

  it("refuses on Windows when the creation identity differs", async () => {
    const winProcess = (pid: number): HostProcess => ({
      pid,
      startedAt: T0 + 1_000,
      executable: WINDOWS_EXECUTABLE,
      identity: "2026-10-15T00:00:09.0000000Z",
    });
    const transport = new ScriptInvocationTransport({
      platform: "win32",
      install: windowsInstall,
      now: () => T0,
      processes: () => [winProcess(42)],
      adopt: {
        pid: 42,
        startedAt: T0 + 1_000,
        identity: "2026-10-15T00:00:01.0000000Z",
        executable: WINDOWS_EXECUTABLE,
      },
    });
    await expect(transport.launch()).rejects.toThrow(/cannot adopt/);
  });
});

describe("AfterEffects.resume", () => {
  it("refuses when the sessionRoot holds no provenance", async () => {
    await expect(AfterEffects.resume({ sessionRoot: root })).rejects.toThrow(
      /no launch provenance/,
    );
  });

  it("refuses when the provenance file is malformed", async () => {
    writeFileSync(launchProvenancePath(root), "{broken", "utf-8");
    await expect(AfterEffects.resume({ sessionRoot: root })).rejects.toThrow(
      /not readable JSON/,
    );
  });

  it("resumes through a caller-supplied transport once provenance exists", async () => {
    recordLaunchProvenance(root, {
      transport: "script-invocation",
      host: { pid: 42, startedAt: T0 + 1_000, executable: DARWIN_EXECUTABLE },
    });
    const ae = await AfterEffects.resume({
      sessionRoot: root,
      transport: new FakeAfterEffectsTransport(),
    });
    expect(ae.info().version).toBeTruthy();
    const result = await ae.close();
    expect(result.quit).toBe(true);
  });
});
