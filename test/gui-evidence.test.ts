/**
 * `ae-a8n.gui-evidence/v1` index schema and `GuiEvidenceIndex` core
 * (#377, spec `specs/gui-evidence/spec.md` §5, §12 E1a).
 *
 * The contract under test: the index round-trips through
 * `<artifactsDir>/evidence-index.json` atomically, merges append-tolerant
 * (artifact dedup, scalar last-writer-wins), keeps gaps as first-class
 * data, echoes only caller-supplied `consumerRefs`, records a `null`
 * sha256 with its reason, and answers the dual-clock correlation
 * questions as pure functions. The capability matrix reports honest
 * per-OS verification levels.
 *
 * Level: automated test / fake only — file I/O in a temp dir and pure
 * functions; no OS calls, no After Effects, nothing here has run
 * against a real host.
 */

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

import {
  artifactDedupKey,
  coveredOperationIds,
  clockSkewMs,
  GuiEvidenceIndex,
  GUI_EVIDENCE_INDEX_KIND,
  mergeCoverage,
  operationCoverage,
  selfIndexArtifact,
  segmentTraceCoverage,
  type EvidenceArtifact,
  type EvidenceHostRef,
  type EvidenceIndexSession,
  type EvidenceOperation,
  type EvidenceSegment,
  type EvidenceTraceRow,
  type GuiEvidenceIndexDocument,
} from "../src/evidence/index.js";
import { guiEvidenceCapabilities } from "../src/evidence/capabilities.js";
import type { PanelTarget } from "../src/panels/types.js";

let root: string;
let artifactsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-gui-evidence-"));
  artifactsDir = join(root, "artifacts");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const HOST: EvidenceHostRef = {
  pid: 4242,
  processStartIdentity: "startedAt=1700000000000",
  sessionId: "session-1",
  sessionKind: "isolated",
};

function session(): EvidenceIndexSession {
  return { ...HOST, sessionRoot: root, adapter: "fake" };
}

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

function stillArtifact(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return {
    id: "art-still-1",
    kind: "screen-still",
    role: "original",
    path: "stills/panel-1.png",
    sha256: "a".repeat(64),
    bytes: 1234,
    session: HOST,
    scope: { kind: "window", window: PANEL },
    time: {
      capturedAt: "2026-01-01T00:00:01.000Z",
      t0EpochMs: Date.parse("2026-01-01T00:00:01.000Z"),
      t0MonoMs: 1000,
      durationMs: null,
      endEpochMs: null,
    },
    geometry: { widthPx: 600, heightPx: 400, coordinateSpace: "pixels" },
    provenance: { producer: "os-capture", tool: "screencapture" },
    operationIds: ["req-1"],
    ...overrides,
  };
}

function segment(overrides: Partial<EvidenceSegment> = {}): EvidenceSegment {
  return {
    id: "seg-001",
    scope: { kind: "session", sessionKind: "isolated" },
    t0EpochMs: Date.parse("2026-01-01T00:00:00.000Z"),
    t0MonoMs: 0,
    endEpochMs: Date.parse("2026-01-01T00:00:10.000Z"),
    durationMs: 10_000,
    file: "recordings/seg-001.mov",
    playable: true,
    coversOperations: true,
    operationIds: [],
    ...overrides,
  };
}

function operation(overrides: Partial<EvidenceOperation> = {}): EvidenceOperation {
  const base: EvidenceOperation = {
    requestId: "req-1",
    op: "mutate-gui",
    evidenceRefs: [],
    coverage: "none",
    uncovered: "recording was not running",
  };
  const merged = { ...base, ...overrides };
  // `uncovered` explains a "none"; a covered operation must not carry it
  // unless the caller explicitly supplied a reason.
  if (merged.coverage !== "none" && overrides.uncovered === undefined) {
    const { uncovered: _dropped, ...rest } = merged;
    return rest;
  }
  return merged;
}

describe("GuiEvidenceIndex write/read round-trip", () => {
  it("creates, saves and reloads a valid ae-a8n.gui-evidence/v1 document", () => {
    const index = GuiEvidenceIndex.create(session(), { now: "2026-01-01T00:00:00.000Z" });
    index.addArtifact(stillArtifact());
    index.addArtifact(selfIndexArtifact(HOST, "2026-01-01T00:00:02.000Z"));
    index.addSegment(segment());
    index.recordOperation(
      operation({ evidenceRefs: ["art-still-1", "seg-001"], coverage: "screen" }),
    );

    const saved = index.save(artifactsDir);
    expect(saved.path).toBe(join(artifactsDir, "evidence-index.json"));
    expect(saved.error).toBeUndefined();

    const loaded = GuiEvidenceIndex.load(artifactsDir);
    expect(loaded).not.toBeNull();
    const doc = loaded!.document;
    expect(doc.kind).toBe(GUI_EVIDENCE_INDEX_KIND);
    expect(doc.session.sessionRoot).toBe(root);
    expect(doc.artifacts.map((a) => a.id).sort()).toEqual([
      "art-still-1",
      "evidence-index",
    ]);
    expect(doc.segments[0]?.id).toBe("seg-001");
    expect(doc.operations[0]?.coverage).toBe("screen");
  });

  it("returns null for a missing index and throws on a malformed one", () => {
    expect(GuiEvidenceIndex.load(artifactsDir)).toBeNull();

    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "evidence-index.json"), "{not json", "utf-8");
    expect(() => GuiEvidenceIndex.load(artifactsDir)).toThrow(/not readable JSON/);

    writeFileSync(
      join(artifactsDir, "evidence-index.json"),
      JSON.stringify({ kind: "something-else/v9" }),
      "utf-8",
    );
    expect(() => GuiEvidenceIndex.load(artifactsDir)).toThrow(/kind/);
  });

  it("rejects an artifact whose null sha256 carries no reason", () => {
    const index = GuiEvidenceIndex.create(session());
    index.addArtifact(stillArtifact({ sha256: null }));
    const saved = index.save(artifactsDir);
    expect(saved.path).not.toBeNull();
    // Strip the reason the fixture never set, then prove the reader refuses it.
    const doc = JSON.parse(readFileSync(saved.path!, "utf-8")) as GuiEvidenceIndexDocument;
    delete (doc.artifacts[0] as { sha256Error?: string }).sha256Error;
    writeFileSync(saved.path!, JSON.stringify(doc), "utf-8");
    expect(() => GuiEvidenceIndex.load(artifactsDir)).toThrow(/sha256Error/);
  });
});

describe("GuiEvidenceIndex merge", () => {
  function writerWith(artifact: EvidenceArtifact, requestId: string): GuiEvidenceIndex {
    const index = GuiEvidenceIndex.create(session());
    index.addArtifact(artifact);
    index.recordOperation(
      operation({ requestId, coverage: "screen", evidenceRefs: [artifact.id] }),
    );
    index.noteUnrecorded("recorder not started");
    index.noteOrphaned("seg-999");
    return index;
  }

  it("deduplicates artifacts by sha256 across writers and unions gaps", () => {
    const first = writerWith(stillArtifact(), "req-1");
    // Second writer produced the same bytes under a different id.
    const second = writerWith(
      stillArtifact({ id: "art-still-1-copy", path: "stills/other-name.png" }),
      "req-2",
    );
    second.noteUncapturable("screencapture exited 1");

    const merged = GuiEvidenceIndex.create(session()).mergeFrom(first).mergeFrom(second);
    const doc = merged.document;

    // Same sha256 → one artifact survives (the later writer's record).
    expect(doc.artifacts.filter((a) => a.kind === "screen-still")).toHaveLength(1);
    expect(doc.artifacts.find((a) => a.kind === "screen-still")?.id).toBe(
      "art-still-1-copy",
    );
    // Operations union; refs merge on the shared requestId only.
    expect(doc.operations.map((o) => o.requestId).sort()).toEqual(["req-1", "req-2"]);
    // Gap lists are unions, never dropped.
    expect(doc.gaps.unrecorded).toContain("recorder not started");
    expect(doc.gaps.uncapturable).toContain("screencapture exited 1");
    expect(doc.gaps.orphaned).toContain("seg-999");
  });

  it("merges operation evidenceRefs and coverage by channel union", () => {
    const a = GuiEvidenceIndex.create(session());
    a.recordOperation(operation({ requestId: "req-x", coverage: "screen" }));
    const b = GuiEvidenceIndex.create(session());
    b.recordOperation(
      operation({
        requestId: "req-x",
        coverage: "render",
        evidenceRefs: ["render-1"],
      }),
    );
    const merged = a.mergeFrom(b).document;
    expect(merged.operations).toHaveLength(1);
    expect(merged.operations[0]?.coverage).toBe("both");
    expect(merged.operations[0]?.evidenceRefs).toContain("render-1");
  });

  it("round-trips a merged index through disk", () => {
    const first = writerWith(stillArtifact(), "req-1");
    first.save(artifactsDir);
    const loaded = GuiEvidenceIndex.load(artifactsDir)!;
    loaded.mergeFrom(writerWith(stillArtifact({ id: "art-2", sha256: "b".repeat(64) }), "req-2"));
    loaded.save(artifactsDir);
    const reloaded = GuiEvidenceIndex.load(artifactsDir)!.document;
    expect(reloaded.artifacts.filter((a) => a.kind === "screen-still")).toHaveLength(2);
    expect(reloaded.operations).toHaveLength(2);
  });
});

describe("gap accounting", () => {
  it("keeps uncovered operations and gap lists as explicit data", () => {
    const index = GuiEvidenceIndex.create(session());
    index.recordOperation(operation({ requestId: "req-uncovered" }));
    index.recordOperation(
      operation({ requestId: "req-covered", coverage: "screen" }),
    );
    index.noteUncapturable("region capture: screencapture timed out");
    index.noteUnrecorded("record.start refused: scope unauthorized");
    index.noteOrphaned("seg-007");

    const doc = index.document;
    const uncovered = doc.operations.find((o) => o.requestId === "req-uncovered");
    expect(uncovered?.coverage).toBe("none");
    expect(uncovered?.uncovered).toBe("recording was not running");
    expect(doc.gaps.uncapturable).toEqual(["region capture: screencapture timed out"]);
    expect(doc.gaps.unrecorded).toEqual(["record.start refused: scope unauthorized"]);
    expect(doc.gaps.orphaned).toEqual(["seg-007"]);
  });

  it("drops the uncovered reason once evidence merges in", () => {
    const index = GuiEvidenceIndex.create(session());
    index.recordOperation(operation({ requestId: "req-1" }));
    index.recordOperation(
      operation({ requestId: "req-1", coverage: "screen", evidenceRefs: ["a1"] }),
    );
    const op = index.document.operations[0];
    expect(op?.coverage).toBe("screen");
    expect(op?.uncovered).toBeUndefined();
    expect(op?.evidenceRefs).toContain("a1");
  });
});

describe("consumerRefs", () => {
  it("echoes only caller-supplied identities and never invents them", () => {
    const index = GuiEvidenceIndex.create(session());
    expect(index.document.consumerRefs).toBeUndefined();

    index.setConsumerRefs({ testId: "plugin-smoke" });
    expect(index.document.consumerRefs).toEqual({ testId: "plugin-smoke" });

    index.setConsumerRefs({ runId: "run-42" });
    expect(index.document.consumerRefs).toEqual({
      testId: "plugin-smoke",
      runId: "run-42",
    });

    // Round-trip preserves exactly what was supplied.
    index.save(artifactsDir);
    expect(GuiEvidenceIndex.load(artifactsDir)!.document.consumerRefs).toEqual({
      testId: "plugin-smoke",
      runId: "run-42",
    });
  });
});

describe("sha256 honesty", () => {
  it("records null sha256 with a reason instead of omitting the field", () => {
    const index = GuiEvidenceIndex.create(session());
    index.addArtifact(
      stillArtifact({
        id: "art-unhashed",
        sha256: null,
        sha256Error: "readFile failed: EACCES",
      }),
    );
    const artifact = index.document.artifacts.find((a) => a.id === "art-unhashed");
    expect(artifact?.sha256).toBeNull();
    expect(artifact?.sha256Error).toBe("readFile failed: EACCES");
    // Dedup falls back to id when there is no hash.
    expect(artifactDedupKey(artifact!)).toBe("id:art-unhashed");
  });
});

describe("correlation pure functions", () => {
  const rows: EvidenceTraceRow[] = [
    { seq: 0, ts: "2025-12-31T23:59:59.000Z", op: "session.launch", requestId: "req-0" },
    { seq: 1, ts: "2026-01-01T00:00:05.000Z", op: "mutate-gui", requestId: "req-1" },
    { seq: 2, ts: "2026-01-01T00:00:15.000Z", op: "comp.renderFrame", requestId: "req-2" },
  ];

  it("computes operation coverage from artifact kinds", () => {
    expect(operationCoverage(["screen-still"])).toBe("screen");
    expect(operationCoverage(["render-frame"])).toBe("render");
    expect(operationCoverage(["screen-recording", "render-sequence"])).toBe("both");
    expect(operationCoverage(["index", "trace"])).toBe("none");
    expect(operationCoverage([])).toBe("none");
    expect(mergeCoverage("screen", "render")).toBe("both");
    expect(mergeCoverage("none", "screen")).toBe("screen");
  });

  it("splits trace rows into covered/uncovered by the wall-clock window", () => {
    const closed = segmentTraceCoverage(segment(), rows);
    expect(closed.open).toBe(false);
    expect(closed.covered.map((r) => r.requestId)).toEqual(["req-1"]);
    expect(closed.uncovered.map((r) => r.requestId)).toEqual(["req-0", "req-2"]);

    // An open segment (endEpochMs null) reports coverage as open.
    const open = segmentTraceCoverage(segment({ endEpochMs: null }), rows);
    expect(open.open).toBe(true);
    expect(open.covered.map((r) => r.requestId)).toEqual(["req-1", "req-2"]);
  });

  it("collects covered operation ids including audit-side claims", () => {
    const { covered, open } = coveredOperationIds(
      segment({ operationIds: ["audit-op-7"] }),
      rows,
    );
    expect(open).toBe(false);
    expect([...covered].sort()).toEqual(["audit-op-7", "req-1"]);
  });

  it("estimates wall-vs-monotonic skew over a span", () => {
    // Wall advanced 10_005 ms while mono advanced 10_000 ms → 5 ms skew.
    expect(
      clockSkewMs(
        { epochMs: 1_000, monoMs: 500 },
        { epochMs: 11_005, monoMs: 10_500 },
      ),
    ).toBe(5);
  });
});

describe("capability matrix", () => {
  it("reports the index as contract-tested on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const caps = guiEvidenceCapabilities(platform);
      expect(caps.index.support).toBe("implemented");
      expect(caps.index.verification).toBe("automated test");
    }
  });

  it("is honest about unimplemented screen channels", () => {
    const darwin = guiEvidenceCapabilities("darwin");
    expect(darwin.screenStill.support).toBe("partial");
    // #381: the record lifecycle is contract-tested, but no OS backend
    // exists yet — "partial", never "implemented"/"verified".
    expect(darwin.screenRecording.support).toBe("partial");
    expect(darwin.screenRecording.verification).toBe("automated test");
    expect(darwin.screenRecording.reason).toContain("no macOS backend");

    const win32 = guiEvidenceCapabilities("win32");
    expect(win32.screenStill.support).toBe("unsupported");
    expect(win32.screenRecording.support).toBe("partial");
    // Render evidence is contract-level everywhere until E4.
    expect(win32.renderEvidence.support).toBe("partial");
  });
});
