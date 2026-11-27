/**
 * `record.start`/`record.stop` lifecycle — bounded segments, finalize,
 * residue and gates (#381, spec `specs/gui-evidence/spec.md` §5.4/§5.6,
 * E2a). The OS recorder backends are later tickets (#382/#384); this
 * suite drives `RecordingController` with a fake `ScreenRecorder`.
 *
 * Level: automated test / fake only — temp-dir file I/O and injected
 * seams; no OS calls, no After Effects, nothing here has run against a
 * real host.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GuiEvidenceIndex } from "../src/evidence/index.js";
import {
  RECORDING_DEFAULT_MAX_DURATION_MS,
  RECORDING_MAX_DURATION_MS_CAP,
  RecordingController,
  type RecorderFileProbe,
  type RecorderHandle,
  type RecorderStartRequest,
  type ScreenRecorder,
} from "../src/evidence/recording.js";
import type {
  CaptureScope,
  EvidenceIndexSession,
  EvidenceSegment,
  EvidenceTraceRow,
} from "../src/evidence/index.js";
import type { PanelTarget } from "../src/panels/types.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;
let artifactsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-recording-"));
  artifactsDir = join(root, "artifacts");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function session(overrides: Partial<EvidenceIndexSession> = {}): EvidenceIndexSession {
  return {
    pid: 4242,
    processStartIdentity: "pid-start:1700000000000",
    sessionId: "42",
    sessionKind: "isolated",
    sessionRoot: root,
    adapter: "fake",
    ...overrides,
  };
}

const SESSION_SCOPE: CaptureScope = { kind: "session", sessionKind: "isolated" };
const DISPLAY_SCOPE: CaptureScope = { kind: "display", displayId: "1" };

const PANEL: PanelTarget = {
  pid: 4242,
  resolvedAt: "2026-01-01T00:00:00.000Z",
  surface: {
    kind: "window",
    windowIndex: 1,
    windowNumber: 77,
    locator: { windowNumber: 77 },
    frame: { x: 10, y: 20, width: 300, height: 200 },
    state: { onScreen: true, occluded: "unknown" },
    attribution: "owned",
  },
};
const WINDOW_SCOPE: CaptureScope = { kind: "window", window: PANEL };
const FOREIGN_PANEL: PanelTarget = {
  ...PANEL,
  surface: { ...PANEL.surface, attribution: "foreign" },
};
const FOREIGN_WINDOW_SCOPE: CaptureScope = { kind: "window", window: FOREIGN_PANEL };

/**
 * A fake recorder backend: writes a small file at start (so the
 * container probe and sha256 have something real), tracks pids for
 * residue accounting, and allows per-test overrides.
 */
class FakeRecorder implements ScreenRecorder {
  readonly tool = "fake-recorder";
  readonly toolVersion = "0.0.1";
  readonly fileExtension = ".mov";
  readonly requests: RecorderStartRequest[] = [];
  readonly handles: RecorderHandle[] = [];
  readonly stops: RecorderHandle[] = [];
  readonly terminated: number[] = [];
  alivePids = new Set<number>();
  nextPid = 9000;
  /** When true, stop leaves the pid alive (residue scenario). */
  surviveStop = false;
  /** When set, probe returns this regardless of the file. */
  probeOverride: RecorderFileProbe | null = null;
  /** When set, start throws. */
  startError: Error | null = null;
  /** When set, stop reports not-exited. */
  stopExited = true;
  writeFile = true;

  start(request: RecorderStartRequest) {
    this.requests.push(request);
    if (this.startError !== null) {
      return Promise.reject(this.startError);
    }
    if (this.writeFile) {
      writeFileSync(request.filePath, `fake-video:${request.segmentId}`);
    }
    const pid = this.nextPid++;
    const handle: RecorderHandle = { pid, filePath: request.filePath };
    this.handles.push(handle);
    this.alivePids.add(pid);
    return Promise.resolve({ handle });
  }

  stop(handle: RecorderHandle) {
    this.stops.push(handle);
    if (!this.surviveStop && handle.pid !== null) {
      this.alivePids.delete(handle.pid);
    }
    return Promise.resolve({
      exited: this.stopExited,
      exitCode: this.stopExited ? 0 : null,
    });
  }

  probe(filePath: string): Promise<RecorderFileProbe> {
    if (this.probeOverride !== null) {
      return Promise.resolve(this.probeOverride);
    }
    const exists = existsSync(filePath);
    return Promise.resolve(
      exists
        ? { exists: true, bytes: 23, playable: true }
        : { exists: false, bytes: null, playable: false, detail: "file missing" },
    );
  }

  listPids(): Promise<readonly number[] | null> {
    return Promise.resolve([...this.alivePids]);
  }

  terminate(pid: number): Promise<boolean> {
    this.terminated.push(pid);
    this.alivePids.delete(pid);
    return Promise.resolve(true);
  }
}

function controller(
  recorder: ScreenRecorder | null,
  overrides: Partial<ConstructorParameters<typeof RecordingController>[0]> = {},
): RecordingController {
  return new RecordingController({
    artifactsDir,
    session: session(),
    recorder: recorder ?? (() => null),
    ...overrides,
  });
}

function loadIndex(): GuiEvidenceIndex {
  const loaded = GuiEvidenceIndex.load(artifactsDir);
  expect(loaded).not.toBeNull();
  return loaded!;
}

describe("record.start/stop round-trip", () => {
  it("starts, stops and finalizes a segment into the index", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      authorizeRecording: () => null,
    });

    const session = await ctl.start(SESSION_SCOPE, { fps: 30 });
    expect(session.id).toBe("seg-001");
    expect(recorder.requests).toHaveLength(1);
    expect(recorder.requests[0]?.maxDurationMs).toBe(
      RECORDING_DEFAULT_MAX_DURATION_MS,
    );
    expect(recorder.requests[0]?.filePath).toContain("seg-001.mov");

    // The open segment is persisted immediately (crash honesty).
    const open = loadIndex().document.segments[0];
    expect(open?.endEpochMs).toBeNull();
    expect(open?.coversOperations).toBeNull();

    const result = await ctl.stop(session.id);
    expect(result.evidenceId).toBe("seg-001");
    const segment = result.segment;
    expect(segment.endEpochMs).not.toBeNull();
    expect(segment.playable).toBe(true);
    expect(segment.file).toBe(join("recordings", "seg-001.mov"));
    expect(segment.recorderResidue).toBe("none");

    const doc = loadIndex().document;
    const artifact = doc.artifacts.find((a) => a.id === "seg-001");
    expect(artifact?.kind).toBe("screen-recording");
    expect(artifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact?.provenance.tool).toBe("fake-recorder");
    expect(artifact?.leakage).toBe("full-session");
  });

  it("assigns sequential segment ids and honors maxDurationMs clamp", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, { authorizeRecording: () => null });
    const first = await ctl.start(SESSION_SCOPE);
    await ctl.stop(first.id);
    const second = await ctl.start(SESSION_SCOPE, {
      maxDurationMs: RECORDING_MAX_DURATION_MS_CAP * 2,
    });
    expect(second.id).toBe("seg-002");
    expect(recorder.requests[1]?.maxDurationMs).toBe(
      RECORDING_MAX_DURATION_MS_CAP,
    );
    await ctl.stop(second.id);
  });

  it("emits record.start/record.stop trace rows with result.evidenceId", async () => {
    const tracePath = join(root, "trace.jsonl");
    const trace = new TraceRecorder({ file: tracePath });
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      authorizeRecording: () => null,
      trace,
    });
    const session = await ctl.start(SESSION_SCOPE);
    await ctl.stop(session.id);

    const rows = readFileSync(tracePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { op: string; result?: { evidenceId?: string } });
    const start = rows.find((r) => r.op === "record.start");
    const stop = rows.find((r) => r.op === "record.stop");
    expect(start?.result?.evidenceId).toBe("seg-001");
    expect(stop?.result?.evidenceId).toBe("seg-001");
  });
});

describe("bounded duration", () => {
  it("marks a deadline-exceeded segment incomplete and never retries", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, { authorizeRecording: () => null });
    const session = await ctl.start(SESSION_SCOPE, { maxDurationMs: 40 });

    // Wait for the deadline finalize to land in the index — under load
    // the timer and the async finalize can both lag wall-clock sleeps.
    let segment: EvidenceSegment | undefined;
    for (let i = 0; i < 100 && segment?.endEpochMs == null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      segment = loadIndex().document.segments.find((s) => s.id === session.id);
    }

    const doc = loadIndex().document;
    segment = doc.segments.find((s) => s.id === session.id);
    expect(segment?.incomplete).toBe("deadline-exceeded");
    expect(segment?.endEpochMs).not.toBeNull();
    // Exactly one stop attempt — no blind retry.
    expect(recorder.stops).toHaveLength(1);
    // An incomplete segment cannot claim coverage.
    expect(segment?.coversOperations).toBe(false);
  });
});

describe("finalize / residue", () => {
  it("finalizeAll stops open segments and records recorderResidue", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, { authorizeRecording: () => null });
    const session = await ctl.start(SESSION_SCOPE);
    await ctl.finalizeAll();

    expect(recorder.stops).toHaveLength(1);
    const segment = loadIndex().document.segments.find((s) => s.id === session.id);
    expect(segment?.endEpochMs).not.toBeNull();
    expect(segment?.recorderResidue).toBe("none");
    // A finalized controller refuses new starts.
    await expect(ctl.start(SESSION_SCOPE)).rejects.toMatchObject({
      code: "closed",
    });
  });

  it("terminates surviving recorder pids and reports \"terminated\"", async () => {
    const recorder = new FakeRecorder();
    recorder.surviveStop = true; // encoder outlives the stop request
    const ctl = controller(recorder, { authorizeRecording: () => null });
    const session = await ctl.start(SESSION_SCOPE);
    await ctl.stop(session.id);

    expect(recorder.terminated.length).toBeGreaterThan(0);
    const segment = loadIndex().document.segments.find((s) => s.id === session.id);
    expect(segment?.recorderResidue).toBe("terminated");
    expect(recorder.alivePids.size).toBe(0);
  });

  it("reports \"unknown\" residue when the backend cannot enumerate", async () => {
    const recorder = new FakeRecorder();
    recorder.listPids = () => Promise.resolve(null); // cannot enumerate → "unknown"
    const ctl = controller(recorder, { authorizeRecording: () => null });
    const session = await ctl.start(SESSION_SCOPE);
    await ctl.stop(session.id);
    const segment = loadIndex().document.segments.find((s) => s.id === session.id);
    expect(segment?.recorderResidue).toBe("unknown");
  });
});

describe("unplayable finalize", () => {
  it("records playable:false with a reason and keeps the file", async () => {
    const recorder = new FakeRecorder();
    recorder.probeOverride = {
      exists: true,
      bytes: 512,
      playable: false,
      detail: "moov atom missing — encoder was killed",
    };
    const ctl = controller(recorder, { authorizeRecording: () => null });
    const session = await ctl.start(SESSION_SCOPE);
    await ctl.stop(session.id);

    const doc = loadIndex().document;
    const segment = doc.segments.find((s) => s.id === session.id);
    expect(segment?.playable).toBe(false);
    expect(segment?.file).toBe(join("recordings", "seg-001.mov"));
    const artifact = doc.artifacts.find((a) => a.id === "seg-001");
    expect(artifact?.unavailable?.reason).toContain("moov atom missing");
    // The file is evidence of what happened — never deleted.
    expect(existsSync(join(artifactsDir, "recordings", "seg-001.mov"))).toBe(true);
    expect(segment?.coversOperations).toBe(false);
  });
});

describe("coversOperations", () => {
  function rowsFor(t0: number, extra: EvidenceTraceRow[] = []): EvidenceTraceRow[] {
    return [
      { seq: 0, ts: new Date(t0 - 60_000).toISOString(), op: "session.launch", requestId: "req-before" },
      { seq: 1, ts: new Date(t0 + 10).toISOString(), op: "mutate-gui", requestId: "req-in" },
      { seq: 2, ts: new Date(t0 + 20).toISOString(), op: "comp.renderFrame", requestId: "req-render" },
      ...extra,
    ];
  }

  it("computes covered operation ids from the trace window", async () => {
    const recorder = new FakeRecorder();
    let rows: EvidenceTraceRow[] = [];
    const ctl = controller(recorder, {
      authorizeRecording: () => null,
      listTraceRows: () => rows,
    });
    const session = await ctl.start(SESSION_SCOPE);
    rows = rowsFor(session.t0EpochMs);
    // Let real time pass so the segment window actually contains the
    // in-window rows (finalize is otherwise near-instant).
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctl.stop(session.id);

    const segment = loadIndex().document.segments.find((s) => s.id === session.id);
    expect(segment?.coversOperations).toBe(true);
    expect([...(segment?.operationIds ?? [])].sort()).toEqual(["req-in", "req-render"]);
  });

  it("reports coversOperations false when a covered op has no requestId", async () => {
    const recorder = new FakeRecorder();
    let rows: EvidenceTraceRow[] = [];
    const ctl = controller(recorder, {
      authorizeRecording: () => null,
      listTraceRows: () => rows,
    });
    const session = await ctl.start(SESSION_SCOPE);
    rows = rowsFor(session.t0EpochMs, [
      { seq: 3, ts: new Date(session.t0EpochMs + 30).toISOString(), op: "session.recover" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ctl.stop(session.id);

    const segment = loadIndex().document.segments.find((s) => s.id === session.id);
    expect(segment?.coversOperations).toBe(false);
  });
});

describe("orphan marking", () => {
  it("marks segments found open in the index as orphaned", async () => {
    const recorder = new FakeRecorder();
    const first = controller(recorder, { authorizeRecording: () => null });
    await first.start(SESSION_SCOPE);
    // Simulate a dead session: the open segment was persisted at start,
    // then the "driver" vanished without finalize.
    const second = controller(recorder, { authorizeRecording: () => null });

    const doc = second.index.document;
    const segment = doc.segments.find((s) => s.id === "seg-001");
    expect(segment?.incomplete).toBe("orphaned");
    expect(doc.gaps.orphaned).toContain("seg-001");
  });
});

describe("gates (spec §5.6)", () => {
  it("refuses display scope without authorization and records the gap", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder); // no authorizeRecording seam
    await expect(ctl.start(DISPLAY_SCOPE)).rejects.toMatchObject({
      code: "unauthorized",
    });
    const doc = loadIndex().document;
    expect(doc.gaps.unrecorded.some((g) => g.includes("authorization"))).toBe(true);
    expect(recorder.requests).toHaveLength(0);
  });

  it("refuses every scope on a non-isolated session without authorization", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      session: session({ sessionKind: "console" }),
    });
    await expect(ctl.start(WINDOW_SCOPE)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("honors an authorizer that returns null", async () => {
    const recorder = new FakeRecorder();
    const seen: string[] = [];
    const ctl = controller(recorder, {
      authorizeRecording: ({ scope }) => {
        seen.push(scope.kind);
        return null;
      },
    });
    const session = await ctl.start(DISPLAY_SCOPE);
    expect(seen).toEqual(["display"]);
    await ctl.stop(session.id);
  });

  it("refuses a foreign/unproven window attribution before any recorder call", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder);
    await expect(ctl.start(FOREIGN_WINDOW_SCOPE)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(recorder.requests).toHaveLength(0);
    expect(loadIndex().document.gaps.unrecorded.length).toBeGreaterThan(0);
  });

  it("refuses window scope without a lease seam", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder);
    await expect(ctl.start(WINDOW_SCOPE)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(recorder.requests).toHaveLength(0);
  });

  it("holds the GUI lease for the segment duration on window scope", async () => {
    const recorder = new FakeRecorder();
    const events: string[] = [];
    const ctl = controller(recorder, {
      acquireLease: (segmentId) => {
        events.push(`acquire:${segmentId}`);
        return {
          release: () => {
            events.push("release");
          },
        };
      },
    });
    const session = await ctl.start(WINDOW_SCOPE);
    expect(events).toEqual(["acquire:seg-001"]);
    await ctl.stop(session.id);
    expect(events).toEqual(["acquire:seg-001", "release"]);
  });

  it("refuses region scope without an owned parent", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder);
    await expect(
      ctl.start({ kind: "region", frame: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses when no recorder backend is registered", async () => {
    const ctl = controller(null, { authorizeRecording: () => null });
    await expect(ctl.start(SESSION_SCOPE)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(loadIndex().document.gaps.unrecorded.length).toBeGreaterThan(0);
  });

  it("refuses audio:true — v1 records no audio", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, { authorizeRecording: () => null });
    // @ts-expect-error — audio:true is refused at runtime for JS callers
    await expect(ctl.start(SESSION_SCOPE, { audio: true })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
