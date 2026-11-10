/**
 * Windows destination proof (T090): the agent writes a per-run session marker,
 * the controller verifies it, and a close path acts only on a marker that names
 * this run.
 *
 * The marker's secret comes from the agent's random source, never from the run
 * id, the job id or a timestamp, so it cannot be predicted from public facts.
 * A wrong or missing marker means nothing is quit (`A8N-AE-002`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SessionIdentity, TargetSpec } from "../src/platform/contract.js";
import { DirectoryChannel } from "../src/platform/windows/channel.js";
import type { AgentIdentity } from "../src/platform/windows/job.js";
import type { WindowsFacts } from "../src/platform/windows/probe.js";
import {
  WindowsSession,
  type RunBinding,
  type WindowsSessionBackend,
} from "../src/platform/windows/runner.js";
import {
  SESSION_MARKER_SCHEMA_VERSION,
  SESSION_SECRET_BYTES,
  createSessionMarker,
  decodeSessionMarker,
  encodeSessionMarker,
  proveRunDestination,
  readSessionMarker,
  sessionMarkerPath,
  verifySessionMarker,
  writeSessionMarker,
  type SessionMarker,
} from "../src/platform/windows/session-marker.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const RUN_ID = "20261110T120000Z-abcdef01";
const OTHER_RUN = "20261110T120000Z-11111111";
const JOB_ID = "20261110T120000Z-12345678";
const OTHER_JOB = "20261110T120000Z-87654321";

const AGENT: AgentIdentity = {
  id: "agent-1",
  host: "WIN-AE-01",
  user: "a8n",
  sessionId: 1,
  version: "0.1.0-alpha.1",
};

const IDENTITY: SessionIdentity = {
  kind: "host-and-user",
  user: "a8n",
  detail: { host: "WIN-AE-01", sessionId: 1 },
  proven: true,
};

const TARGET: TargetSpec = {
  name: "win-ae",
  isolation: "remote-host",
  user: "a8n",
  host: "WIN-AE-01",
};

const FACTS: WindowsFacts = {
  osCaption: "Microsoft Windows 11 Pro",
  osVersion: "10.0.26100",
  sessionId: 1,
  currentUser: "WIN-AE-01\\a8n",
  consoleUser: "WIN-AE-01\\a8n",
  aeInstalls: [],
  aeProcesses: [],
  targetUserExists: true,
  evidence: {},
};

function marker(overrides: Partial<SessionMarker> = {}): SessionMarker {
  return {
    ...createSessionMarker({
      runId: RUN_ID,
      jobId: JOB_ID,
      agent: AGENT,
      now: () => NOW,
      random: () => new Uint8Array(SESSION_SECRET_BYTES).fill(0xab),
    }),
    ...overrides,
  };
}

const roots: string[] = [];

async function channel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-destination-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the session marker", () => {
  it("is named after the job and carries a random 64-hex secret", () => {
    expect(sessionMarkerPath(JOB_ID)).toBe(`results/${JOB_ID}/session-marker.json`);
    const created = marker();
    expect(created).toMatchObject({
      schemaVersion: SESSION_MARKER_SCHEMA_VERSION,
      runId: RUN_ID,
      jobId: JOB_ID,
      secret: "ab".repeat(32),
      agent: AGENT,
    });
    const different = createSessionMarker({
      runId: RUN_ID,
      jobId: JOB_ID,
      agent: AGENT,
      now: () => NOW,
      random: () => new Uint8Array(SESSION_SECRET_BYTES).fill(0xcd),
    });
    expect(different.secret).not.toBe(created.secret);
    expect(created.secret).not.toContain(RUN_ID);
  });

  it("refuses a random source that cannot supply the whole secret", () => {
    expect(() =>
      createSessionMarker({
        runId: RUN_ID,
        jobId: JOB_ID,
        agent: AGENT,
        now: () => NOW,
        random: () => new Uint8Array(4),
      }),
    ).toThrow("32 are required");
  });

  it("refuses a run or job id that cannot be a path component", () => {
    expect(() => sessionMarkerPath("../../escape")).toThrow("path component");
    expect(() =>
      createSessionMarker({
        runId: "../escape",
        jobId: JOB_ID,
        agent: AGENT,
        now: () => NOW,
        random: () => new Uint8Array(SESSION_SECRET_BYTES),
      }),
    ).toThrow("path component");
  });

  it("round-trips through results/<jobId>/session-marker.json", async () => {
    const files = await channel();
    await writeSessionMarker(files, marker());
    expect(await readSessionMarker(files, JOB_ID)).toEqual({
      state: "ok",
      marker: marker(),
    });
    expect(await readSessionMarker(files, OTHER_JOB)).toEqual({ state: "missing" });
  });

  it("rejects a malformed marker instead of trusting it", () => {
    const cases: readonly unknown[] = [
      { ...marker(), schemaVersion: "2.0" },
      { ...marker(), runId: "../escape" },
      { ...marker(), jobId: "abc" },
      { ...marker(), secret: "ab" },
      { ...marker(), secret: "z".repeat(64) },
      { ...marker(), createdAt: "yesterday" },
      { ...marker(), agent: { ...AGENT, sessionId: "1" } },
      { ...marker(), agent: { ...AGENT, id: "" } },
    ];
    for (const value of cases) {
      const decoded = decodeSessionMarker(
        new TextEncoder().encode(JSON.stringify(value)),
      );
      expect(decoded.ok).toBe(false);
    }
    expect(decodeSessionMarker(new TextEncoder().encode("{"))).toMatchObject({
      ok: false,
      detail: "session-marker.json is not valid JSON",
    });
  });

  it("accepts only a marker that names this run, job and agent", () => {
    expect(
      verifySessionMarker(marker(), { runId: RUN_ID, jobId: JOB_ID, agent: AGENT }),
    ).toMatchObject({
      proven: true,
      proof: "marker",
    });
    expect(
      verifySessionMarker(marker({ runId: OTHER_RUN }), {
        runId: RUN_ID,
        jobId: JOB_ID,
        agent: AGENT,
      }),
    ).toMatchObject({ proven: false, code: "A8N-AE-002" });
    expect(
      verifySessionMarker(marker({ jobId: OTHER_JOB }), {
        runId: RUN_ID,
        jobId: JOB_ID,
        agent: AGENT,
      }),
    ).toMatchObject({ proven: false, code: "A8N-AE-002" });
    expect(
      verifySessionMarker(marker(), { runId: RUN_ID, jobId: JOB_ID, agent: { ...AGENT, id: "agent-2" } }),
    ).toMatchObject({ proven: false, code: "A8N-AE-002" });
    expect(
      verifySessionMarker(marker(), {
        runId: RUN_ID,
        jobId: JOB_ID,
        agent: { ...AGENT, sessionId: 2 },
      }),
    ).toMatchObject({ proven: false, code: "A8N-AE-002" });
    expect(
      verifySessionMarker(marker(), {
        runId: RUN_ID,
        jobId: JOB_ID,
        agent: { ...AGENT, host: "WIN-AE-02" },
      }),
    ).toMatchObject({ proven: false, code: "A8N-AE-002" });
  });

  it("treats a missing or unreadable marker as unproven, never as these bytes", async () => {
    const files = await channel();
    expect(
      await proveRunDestination(files, { runId: RUN_ID, jobId: JOB_ID, agent: AGENT }),
    ).toMatchObject({ proven: false, code: "A8N-AE-002" });

    await files.writeAtomic(
      sessionMarkerPath(JOB_ID),
      new TextEncoder().encode("{not json"),
    );
    expect(
      await proveRunDestination(files, { runId: RUN_ID, jobId: JOB_ID, agent: AGENT }),
    ).toMatchObject({ proven: false, code: "A8N-AE-002" });
  });

  it("encodes the same bytes it decodes", () => {
    expect(decodeSessionMarker(encodeSessionMarker(marker()))).toEqual({
      ok: true,
      value: marker(),
    });
  });
});

type Backend = {
  readonly backend: WindowsSessionBackend;
  readonly calls: string[];
};

/** A backend whose destination verdict is fixed; only close() is exercised. */
function backendWith(destination: WindowsSessionBackend["destination"]): Backend {
  const calls: string[] = [];
  return {
    calls,
    backend: {
      prepare: () =>
        Promise.resolve({ identity: IDENTITY, facts: FACTS, checks: [] }),
      run: (_identity, _argv, _options, onRun: (run: RunBinding) => void) => {
        onRun({ runId: RUN_ID, jobId: JOB_ID });
        return Promise.resolve({ exitCode: 0, stdoutPath: "out", stderrPath: "err" });
      },
      destination: (run) => {
        calls.push("destination");
        return destination(run);
      },
      release: () => {
        calls.push("release");
        return Promise.resolve();
      },
      quit: () => {
        calls.push("quit");
        return Promise.resolve();
      },
    },
  };
}

async function opened(backend: WindowsSessionBackend): Promise<WindowsSession> {
  const session = new WindowsSession(TARGET, IDENTITY, backend);
  await session.open();
  await session.run(["/bin/echo"], { timeoutMs: 1000, env: {} });
  return session;
}

describe("the close path", () => {
  it("does nothing when the marker names another run", async () => {
    const { backend, calls } = backendWith(() =>
      Promise.resolve({
        proven: false,
        code: "A8N-AE-002",
        detail: 'the marker names run "other", not this run',
      }),
    );
    const session = await opened(backend);
    const closed = await session.close();
    expect(closed.closed).toBe(false);
    expect(closed.reason).toContain("A8N-AE-002");
    expect(closed.reason).toContain("nothing was quit");
    expect(calls).toEqual(["destination", "release"]);
    expect(calls).not.toContain("quit");
    // A second close must not report a clean close over the refusal.
    expect(await session.close()).toEqual(closed);
    expect(calls).toEqual(["destination", "release"]);
  });

  it("proceeds, quitting only after the proof, when the marker matches", async () => {
    const { backend, calls } = backendWith(() =>
      Promise.resolve({
        proven: true,
        proof: "marker",
        marker: marker(),
      }),
    );
    const session = await opened(backend);
    expect(await session.close()).toEqual({ closed: true, reason: null });
    expect(calls).toEqual(["destination", "quit", "release"]);
  });

  it("never quits a job mis-delivered with another run's marker", async () => {
    const files = await channel();
    await writeSessionMarker(files, marker({ runId: OTHER_RUN }));
    const { backend, calls } = backendWith((run) =>
      proveRunDestination(files, {
        runId: run.runId,
        jobId: run.jobId ?? JOB_ID,
        agent: AGENT,
      }),
    );
    const session = await opened(backend);
    const closed = await session.close();
    expect(closed.closed).toBe(false);
    expect(closed.reason).toContain("A8N-AE-002");
    expect(calls).not.toContain("quit");
  });
});
