/**
 * Render-evidence join + consumer handoff tests (#385,
 * `specs/gui-evidence/spec.md` §3.2/§3.3, §5.3, §5.5; E4).
 *
 * Two layers are proven here:
 *
 *   - `src/evidence/render.ts` + `src/evidence/consumer.ts` against a
 *     real `GuiEvidenceIndex` in a temp artifacts dir and real PNG
 *     files — the `render-frame`/`render-sequence` artifact records,
 *     sha256 reference (never a copy), `operationIds`/`coverage`
 *     accounting, gap honesty, artifactsDir discovery, the same-run
 *     join, and the ae-test `Artifact` mapping.
 *   - The `Comp.renderFrame` → index wiring end-to-end against the
 *     in-repo fake After Effects (`FakeAfterEffectsTransport` +
 *     `AeDriver` + `Session`): the driver's own trace row supplies the
 *     requestId, the index binds it, and `ae.evidence` reads it back.
 *
 * Level: `automated test` / fake host only — nothing here has run
 * against a real After Effects; render correctness on a real host
 * stays unverified (spec §10).
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver } from "../src/driver/driver.js";
import { FakeAfterEffectsTransport } from "../src/testing/fake-transport.js";
import { encodePng } from "../src/testing/index.js";
import { GuiEvidenceIndex } from "../src/evidence/index.js";
import {
  consumerArtifactKind,
  consumerArtifacts,
  consumerRefs,
  joinOperationEvidence,
} from "../src/evidence/consumer.js";
import {
  coveringSegments,
  discoverRenderArtifacts,
  findRenderFrameErrorTraceEvent,
  findRenderFrameTraceEvent,
  noteRenderFrameFailure,
  recordRenderFrame,
  resolveArtifactPath,
  RENDER_FRAME_OP,
  type RenderEvidenceContext,
  type RenderedFrameRef,
} from "../src/evidence/render.js";
import type {
  EvidenceIndexSession,
  EvidenceSegment,
  GuiEvidenceIndexDocument,
} from "../src/evidence/types.js";
import { Session } from "../src/api/session.js";
import { Comp } from "../src/api/entities.js";
import { evidenceApiFor } from "../src/api/render-evidence.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;
let artifactsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-render-evidence-"));
  artifactsDir = join(root, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function session(over: Partial<EvidenceIndexSession> = {}): EvidenceIndexSession {
  return {
    pid: 4242,
    processStartIdentity: "pid-start:1700000000000:boot-1",
    sessionId: "42",
    sessionKind: "isolated",
    sessionRoot: root,
    adapter: "fake",
    ...over,
  };
}

function ctx(over: Partial<RenderEvidenceContext> = {}): RenderEvidenceContext {
  return {
    artifactsDir,
    session: session(),
    now: () => new Date("2026-02-01T12:00:00.000Z"),
    monoNow: () => 1234.5,
    ...over,
  };
}

function writePng(path: string, rgb: [number, number, number] = [10, 20, 30]): void {
  writeFileSync(path, encodePng(64, 64, () => rgb));
}

function loadIndex(): GuiEvidenceIndex {
  const index = GuiEvidenceIndex.load(artifactsDir);
  expect(index).not.toBeNull();
  return index!;
}

function segment(over: Partial<EvidenceSegment> = {}): EvidenceSegment {
  return {
    id: "seg-001",
    scope: { kind: "display", displayId: "1" },
    t0EpochMs: Date.parse("2026-02-01T11:59:00.000Z"),
    t0MonoMs: 1000,
    endEpochMs: Date.parse("2026-02-01T12:01:00.000Z"),
    durationMs: 120_000,
    file: "recordings/seg-001.mov",
    playable: true,
    coversOperations: true,
    operationIds: [],
    ...over,
  };
}

describe("render-frame binding (#385)", () => {
  it("records a render-frame artifact by reference and links the operation", async () => {
    const png = join(artifactsDir, "Main.00007.png");
    writePng(png);
    const rendered: RenderedFrameRef = { path: png, frame: 7, width: 64, height: 64 };

    const result = await recordRenderFrame(rendered, ctx(), {
      requestId: "req-render-1",
      traceSeq: 11,
      comp: "Main",
    });

    const doc = loadIndex().document;
    const artifact = doc.artifacts.find((a) => a.kind === "render-frame");
    expect(artifact).toBeDefined();
    expect(result.evidenceId).toBe(artifact!.id);
    // Reference, never a copy: the recorded path resolves to the
    // producer's own file and no second copy exists.
    expect(artifact!.path).toBe("Main.00007.png");
    expect(resolveArtifactPath(artifactsDir, artifact!.path)).toBe(png);
    expect(artifact!.role).toBe("original");
    expect(artifact!.sha256).toBe(
      createHash("sha256").update(readFileSync(png)).digest("hex"),
    );
    expect(artifact!.bytes).toBe(readFileSync(png).length);
    expect(artifact!.provenance.producer).toBe("ae-render");
    // Channel R carries no screen scope/leakage — those are Channel-S
    // concepts (spec §3.2).
    expect(artifact!.scope).toBeUndefined();
    expect(artifact!.leakage).toBeUndefined();
    expect(artifact!.operationIds).toEqual(["req-render-1"]);
    expect(artifact!.geometry).toMatchObject({ widthPx: 64, heightPx: 64 });

    const operation = doc.operations.find((o) => o.requestId === "req-render-1");
    expect(operation).toBeDefined();
    expect(operation!.op).toBe(RENDER_FRAME_OP);
    expect(operation!.traceSeq).toBe(11);
    expect(operation!.evidenceRefs).toContain(artifact!.id);
    expect(operation!.coverage).toBe("render");
  });

  it("joins a covering recording segment so coverage becomes 'both'", async () => {
    const index = GuiEvidenceIndex.create(session());
    index.addSegment(segment());
    index.save(artifactsDir);

    const png = join(artifactsDir, "Main.00000.png");
    writePng(png);
    const result = await recordRenderFrame(
      { path: png, frame: 0, width: 64, height: 64 },
      ctx(),
      { requestId: "req-both" },
    );

    expect(result.coverage).toBe("both");
    expect(result.coveringSegmentIds).toEqual(["seg-001"]);

    const operation = loadIndex().document.operations.find(
      (o) => o.requestId === "req-both",
    )!;
    expect(operation.coverage).toBe("both");
    expect(operation.evidenceRefs).toEqual(
      expect.arrayContaining([result.evidenceId, "seg-001"]),
    );
  });

  it("does not join a segment whose window misses the render", async () => {
    const index = GuiEvidenceIndex.create(session());
    index.addSegment(
      segment({
        t0EpochMs: Date.parse("2026-02-01T13:00:00.000Z"),
        endEpochMs: Date.parse("2026-02-01T13:01:00.000Z"),
      }),
    );
    index.save(artifactsDir);

    const png = join(artifactsDir, "Main.00001.png");
    writePng(png);
    const result = await recordRenderFrame(
      { path: png, frame: 1, width: 64, height: 64 },
      ctx(),
      { requestId: "req-render-only" },
    );
    expect(result.coverage).toBe("render");
    expect(result.coveringSegmentIds).toHaveLength(0);
  });

  it("deduplicates identical renders by sha256 and unions operation ids", async () => {
    const png = join(artifactsDir, "Main.00002.png");
    writePng(png);
    const rendered: RenderedFrameRef = { path: png, frame: 2, width: 64, height: 64 };

    const first = await recordRenderFrame(rendered, ctx(), { requestId: "req-a" });
    const second = await recordRenderFrame(rendered, ctx(), { requestId: "req-b" });

    const doc = loadIndex().document;
    const renderArtifacts = doc.artifacts.filter((a) => a.kind === "render-frame");
    expect(renderArtifacts).toHaveLength(1);
    // The first artifact id wins so earlier evidenceRefs still resolve.
    expect(second.evidenceId).toBe(first.evidenceId);
    expect(renderArtifacts[0]!.operationIds).toEqual(
      expect.arrayContaining(["req-a", "req-b"]),
    );
    for (const requestId of ["req-a", "req-b"]) {
      const operation = doc.operations.find((o) => o.requestId === requestId);
      expect(operation!.evidenceRefs).toContain(first.evidenceId);
    }
  });

  it("records an unbound render honestly when no trace row correlates", async () => {
    const png = join(artifactsDir, "Main.00003.png");
    writePng(png);

    const result = await recordRenderFrame(
      { path: png, frame: 3, width: 64, height: 64 },
      ctx(),
      { requestId: null },
    );

    const doc = loadIndex().document;
    expect(doc.artifacts.filter((a) => a.kind === "render-frame")).toHaveLength(1);
    // No invented requestId: the artifact exists but no operation row
    // claims it, and the gap is recorded.
    expect(doc.operations).toHaveLength(0);
    expect(doc.gaps.unrecorded.some((g) => g.includes("unbound"))).toBe(true);
    expect(result.coverage).toBe("render");
  });

  it("records a missing output file as unavailable, not as success", async () => {
    const missing = join(artifactsDir, "Main.00009.png");
    const result = await recordRenderFrame(
      { path: missing, frame: 9, width: 64, height: 64 },
      ctx(),
      { requestId: "req-missing" },
    );

    const artifact = loadIndex().document.artifacts.find(
      (a) => a.kind === "render-frame",
    )!;
    expect(artifact.sha256).toBeNull();
    expect(artifact.sha256Error).toBeDefined();
    expect(artifact.unavailable?.reason).toContain("could not be hashed");
    expect(result.indexError).toBeUndefined();
  });

  it("records a failed render as uncapturable + coverage none", () => {
    const gap = noteRenderFrameFailure(
      ctx(),
      { requestId: "req-fail", traceSeq: 5 },
      new Error("frame 0 was not rendered: Operation failed"),
    );
    expect(gap.indexError).toBeUndefined();

    const doc = loadIndex().document;
    expect(doc.artifacts.filter((a) => a.kind === "render-frame")).toHaveLength(0);
    expect(doc.gaps.uncapturable.some((g) => g.includes("was not rendered"))).toBe(
      true,
    );
    const operation = doc.operations.find((o) => o.requestId === "req-fail");
    expect(operation!.coverage).toBe("none");
    expect(operation!.uncovered).toContain("was not rendered");
  });
});

describe("trace correlation", () => {
  const rendered: RenderedFrameRef = {
    path: "/x/Main.00001.png",
    frame: 1,
    width: 64,
    height: 64,
  };

  it("finds the matching ok trace event by path and requestId", () => {
    const events = [
      {
        seq: 1,
        op: RENDER_FRAME_OP,
        status: "ok",
        args: { method: RENDER_FRAME_OP, comp: "Main", frame: 1, requestId: "req-old" },
        result: { path: "/x/Main.00000.png" },
      },
      {
        seq: 2,
        op: RENDER_FRAME_OP,
        status: "ok",
        args: { method: RENDER_FRAME_OP, comp: "Main", frame: 1, requestId: "req-new" },
        result: { path: "/x/Main.00001.png", frame: 1, width: 64, height: 64 },
      },
    ];
    expect(findRenderFrameTraceEvent(events, rendered)).toEqual({
      requestId: "req-new",
      seq: 2,
    });
  });

  it("finds a failed render's trace event by call args", () => {
    const events = [
      {
        seq: 3,
        op: RENDER_FRAME_OP,
        status: "error",
        args: {
          method: RENDER_FRAME_OP,
          comp: "Main",
          frame: 4,
          outputDir: "/x",
          requestId: "req-err",
        },
      },
    ];
    expect(
      findRenderFrameErrorTraceEvent(events, {
        comp: "Main",
        frame: 4,
        outputDir: "/x",
      }),
    ).toEqual({ requestId: "req-err", seq: 3 });
    expect(
      findRenderFrameErrorTraceEvent(events, { comp: "Main", frame: 5 }),
    ).toBeNull();
  });

  it("coveringSegments respects open and closed windows", () => {
    const open = segment({ id: "seg-open", endEpochMs: null });
    const closed = segment({ id: "seg-closed" });
    const t = Date.parse("2026-02-01T12:00:00.000Z");
    expect(coveringSegments([open, closed], t)).toEqual(["seg-open", "seg-closed"]);
    expect(
      coveringSegments(
        [segment({ id: "seg-later", t0EpochMs: t + 60_000, endEpochMs: t + 120_000 })],
        t,
      ),
    ).toEqual([]);
  });
});

describe("artifactsDir discovery", () => {
  it("registers numbered PNGs as render-frame + render-sequence, skipping indexed", async () => {
    writePng(join(artifactsDir, "Shot.00001.png"), [1, 2, 3]);
    writePng(join(artifactsDir, "Shot.00002.png"), [4, 5, 6]);
    writePng(join(artifactsDir, "Solo.00001.png"), [7, 8, 9]);
    // Not a renderFrame name — must not be discovered.
    writeFileSync(join(artifactsDir, "notes.0001.png"), "not-a-frame");
    writeFileSync(join(artifactsDir, "plain.png"), "not-a-frame");

    const result = await discoverRenderArtifacts(artifactsDir, ctx());
    expect(result.error).toBeUndefined();
    expect(result.added).toHaveLength(4); // 3 frames + 1 sequence

    const doc = loadIndex().document;
    const frames = doc.artifacts.filter((a) => a.kind === "render-frame");
    const sequences = doc.artifacts.filter((a) => a.kind === "render-sequence");
    expect(frames).toHaveLength(3);
    expect(sequences).toHaveLength(1);
    expect(sequences[0]!.path).toBe(".");
    expect(sequences[0]!.sha256).toBeNull();
    expect(sequences[0]!.sha256Error).toContain("member frames");
    // Discovered files are orphans: no producing operation is known.
    for (const artifact of [...frames, ...sequences]) {
      expect(artifact.operationIds).toEqual([]);
    }
    expect(doc.gaps.orphaned.length).toBeGreaterThanOrEqual(3);

    // Second sweep is a no-op for already-indexed files.
    const again = await discoverRenderArtifacts(artifactsDir, ctx());
    expect(again.added).toHaveLength(0);
    expect(again.alreadyIndexed).toBe(3);
  });

  it("does not mistake stills or recordings for render outputs", async () => {
    mkdirSync(join(artifactsDir, "panels"), { recursive: true });
    mkdirSync(join(artifactsDir, "recordings"), { recursive: true });
    writePng(join(artifactsDir, "panels", "op-1.png"));
    writeFileSync(join(artifactsDir, "recordings", "seg-001.mov"), "video");

    const result = await discoverRenderArtifacts(artifactsDir, ctx());
    expect(result.added).toHaveLength(0);
    expect(loadIndex().document.artifacts).toHaveLength(0);
  });
});

describe("same-run join + consumer mapping", () => {
  function docWithRenderAndSegment(
    over: {
      segmentEnd?: number | null;
      segmentOperationIds?: readonly string[];
      artifactSession?: Partial<EvidenceIndexSession>;
    } = {},
  ): GuiEvidenceIndexDocument {
    const index = GuiEvidenceIndex.create(session());
    const t0 = Date.parse("2026-02-01T11:59:00.000Z");
    const end = over.segmentEnd === undefined ? Date.parse("2026-02-01T12:01:00.000Z") : over.segmentEnd;
    index.addSegment(
      segment({
        t0EpochMs: t0,
        endEpochMs: end,
        operationIds: [...(over.segmentOperationIds ?? [])],
      }),
    );
    const artifact = {
      id: "render-req-1-0",
      kind: "render-frame" as const,
      role: "original" as const,
      path: "Main.00000.png",
      sha256: "abc",
      bytes: 100,
      session: {
        pid: 4242,
        processStartIdentity: "pid-start:1700000000000:boot-1",
        sessionId: "42",
        sessionKind: "isolated" as const,
        ...over.artifactSession,
      },
      time: {
        capturedAt: "2026-02-01T12:00:00.000Z",
        t0EpochMs: Date.parse("2026-02-01T12:00:00.000Z"),
        t0MonoMs: null,
        durationMs: null,
        endEpochMs: null,
      },
      provenance: { producer: "ae-render" as const, tool: "test" },
      operationIds: ["req-1"],
    };
    index.addArtifact(artifact);
    index.recordOperation({
      requestId: "req-1",
      op: RENDER_FRAME_OP,
      evidenceRefs: ["render-req-1-0", "seg-001"],
      coverage: "both",
    });
    return index.document;
  }

  it("verifies a same-run join: render artifact + closed covering segment", () => {
    const join = joinOperationEvidence(docWithRenderAndSegment(), "req-1");
    expect(join.sameRun.verified).toBe(true);
    expect(join.renderArtifacts.map((a) => a.id)).toEqual(["render-req-1-0"]);
    expect(join.segments.map((s) => s.id)).toEqual(["seg-001"]);
    expect(join.coverage).toBe("both");
    expect(join.sameRun.checks.every((c) => c.ok)).toBe(true);
  });

  it("reports unverified when no screen segment covers the render", () => {
    const join = joinOperationEvidence(
      docWithRenderAndSegment({ segmentEnd: null, segmentOperationIds: [] }),
      "req-1",
    );
    // The segment still time-covers the render but is OPEN — provisional.
    expect(join.sameRun.verified).toBe(false);
    const screen = join.sameRun.checks.find((c) => c.name === "screen-channel")!;
    expect(screen.ok).toBe(false);
    expect(screen.detail).toContain("open");
  });

  it("reports unverified when the segment window misses the render", () => {
    const index = GuiEvidenceIndex.create(session());
    index.addSegment(
      segment({
        t0EpochMs: Date.parse("2026-02-01T13:00:00.000Z"),
        endEpochMs: Date.parse("2026-02-01T13:01:00.000Z"),
      }),
    );
    index.addArtifact({
      id: "render-late",
      kind: "render-frame",
      role: "original",
      path: "Main.00000.png",
      sha256: "abc",
      bytes: 1,
      session: session(),
      time: {
        capturedAt: "2026-02-01T12:00:00.000Z",
        t0EpochMs: Date.parse("2026-02-01T12:00:00.000Z"),
        t0MonoMs: null,
        durationMs: null,
        endEpochMs: null,
      },
      provenance: { producer: "ae-render", tool: "test" },
      operationIds: ["req-x"],
    });
    index.recordOperation({
      requestId: "req-x",
      op: RENDER_FRAME_OP,
      evidenceRefs: ["render-late"],
      coverage: "render",
    });
    const join = joinOperationEvidence(index.document, "req-x");
    expect(join.sameRun.verified).toBe(false);
    expect(join.segments).toHaveLength(0);
  });

  it("reports unverified on session-identity mismatch", () => {
    const join = joinOperationEvidence(
      docWithRenderAndSegment({ artifactSession: { pid: 9999 } }),
      "req-1",
    );
    expect(join.sameRun.verified).toBe(false);
    const identity = join.sameRun.checks.find((c) => c.name === "session-identity")!;
    expect(identity.ok).toBe(false);
    expect(identity.detail).toContain("pid");
  });

  it("reports unverified when the operation row is absent", () => {
    const join = joinOperationEvidence(docWithRenderAndSegment(), "req-unknown");
    expect(join.operation).toBeNull();
    expect(join.sameRun.verified).toBe(false);
    expect(
      join.sameRun.checks.find((c) => c.name === "operation-row")!.ok,
    ).toBe(false);
  });

  it("maps artifacts to the ae-test Artifact shape with channel kinds", () => {
    const index = GuiEvidenceIndex.create(session());
    index.setConsumerRefs({ testId: "t-1", runId: "r-1" });
    const base = {
      role: "original" as const,
      bytes: 10,
      session: session(),
      time: {
        capturedAt: "2026-02-01T12:00:00.000Z",
        t0EpochMs: null,
        t0MonoMs: null,
        durationMs: null,
        endEpochMs: null,
      },
      provenance: { producer: "ae-render" as const, tool: "test" },
      operationIds: [],
    };
    index.addArtifact({ ...base, id: "r1", kind: "render-frame", path: "a.png", sha256: "x" });
    index.addArtifact({ ...base, id: "r2", kind: "render-sequence", path: "seq", sha256: null, sha256Error: "seq" });
    index.addArtifact({ ...base, id: "s1", kind: "screen-still", path: "panels/x.png", sha256: "y" });
    index.addArtifact({ ...base, id: "t1", kind: "trace", path: "trace.jsonl", sha256: null, sha256Error: "ref" });

    const doc = index.document;
    const mapped = consumerArtifacts(doc);
    expect(mapped.map((a) => [a.name, a.kind])).toEqual([
      ["r1", "render"],
      ["r2", "render"],
      ["s1", "attachment"],
      ["t1", "trace"],
    ]);
    // absolutePath resolves under <sessionRoot>/artifacts.
    expect(mapped[0]!.absolutePath).toBe(join(root, "artifacts", "a.png"));
    // Channel separation survives the mapping: a screen still is an
    // attachment, never "render".
    expect(consumerArtifactKind("screen-recording")).toBe("attachment");
    expect(consumerRefs(doc)).toEqual({ testId: "t-1", runId: "r-1" });
  });
});

describe("Comp.renderFrame → index wiring (fake host)", () => {
  let transport: FakeAfterEffectsTransport;
  let driver: AeDriver;
  let trace: TraceRecorder;
  let sessionRoot: string;

  beforeEach(async () => {
    sessionRoot = join(root, "session");
    transport = new FakeAfterEffectsTransport();
    trace = new TraceRecorder();
    driver = new AeDriver({
      transport,
      sessionRoot,
      trace,
      defaultTimeoutMs: 2_000,
      readinessTimeoutMs: 2_000,
    });
    await driver.start();
  });

  afterEach(async () => {
    await driver.stop({ unsavedChanges: "discard" });
  });

  it("binds the rendered PNG into evidence-index.json with the driver's requestId", async () => {
    const session = new Session(driver, trace);
    const comp = new Comp(session, "Main");

    const rendered = await comp.renderFrame(0);

    const index = GuiEvidenceIndex.load(driver.artifactsDir);
    expect(index).not.toBeNull();
    const doc = index!.document;
    const artifact = doc.artifacts.find((a) => a.kind === "render-frame");
    expect(artifact).toBeDefined();
    expect(artifact!.path).toBe(rendered.path.split("/").pop());
    expect(artifact!.sha256).toBe(
      createHash("sha256").update(readFileSync(rendered.path)).digest("hex"),
    );

    // The requestId is the driver's own envelope id — recovered from
    // the trace row, never invented.
    const renderRow = session.events.find(
      (e) => e.op === RENDER_FRAME_OP && e.status === "ok",
    )!;
    const requestId = renderRow.args?.requestId as string;
    expect(typeof requestId).toBe("string");
    expect(artifact!.operationIds).toContain(requestId);

    const operation = doc.operations.find((o) => o.requestId === requestId);
    expect(operation).toBeDefined();
    expect(operation!.evidenceRefs).toContain(artifact!.id);
    expect(operation!.coverage).toBe("render");

    // The supplementary trace row carries result.evidenceId — the
    // trace → artifact walk the spec requires.
    const evidenceRow = session.events.find((e) => e.op === "comp.renderFrame.evidence");
    expect(evidenceRow).toBeDefined();
    expect(evidenceRow!.result?.evidenceId).toBe(artifact!.id);

    // `ae.evidence` reads the same document back and the join resolves.
    const api = evidenceApiFor(session);
    const join = api.joinOperation(requestId);
    expect(join).not.toBeNull();
    expect(join!.renderArtifacts.map((a) => a.id)).toContain(artifact!.id);
    // No recording ran, so same-run screen coverage is honestly absent.
    expect(join!.sameRun.verified).toBe(false);
    expect(
      join!.sameRun.checks.find((c) => c.name === "screen-channel")!.ok,
    ).toBe(false);
  });

  it("records a failed renderFrame as a coverage-none gap and rethrows", async () => {
    const session = new Session(driver, trace);
    const comp = new Comp(session, "Main");
    transport.app.project.item(1)?.failNextSaveFrame();

    await expect(comp.renderFrame(0)).rejects.toThrow(/was not rendered/);

    const doc = GuiEvidenceIndex.load(driver.artifactsDir)!.document;
    expect(doc.artifacts.filter((a) => a.kind === "render-frame")).toHaveLength(0);
    expect(doc.gaps.uncapturable.some((g) => g.includes("was not rendered"))).toBe(
      true,
    );
    const failed = doc.operations.find((o) => o.coverage === "none");
    expect(failed).toBeDefined();
    expect(failed!.uncovered).toContain("was not rendered");
  });

  it("echoes consumerRefs through ae.evidence without inventing them", () => {
    const session = new Session(driver, trace);
    const api = evidenceApiFor(session);
    expect(api.document()).toBeNull();
    expect(api.consumerRefs()).toBeNull();

    const saved = api.setConsumerRefs({ testId: "ae-test-1", runId: "run-9" });
    expect(saved.error).toBeUndefined();
    expect(api.consumerRefs()).toEqual({ testId: "ae-test-1", runId: "run-9" });

    const mapped = api.consumerArtifacts();
    expect(mapped.every((a) => typeof a.name === "string")).toBe(true);
  });
});
