/**
 * `GuiEvidenceIndex` core — read/write/merge of the
 * `ae-a8n.gui-evidence/v1` document (#377, spec §5.5).
 *
 * The index is one JSON file per session at
 * `<sessionRoot>/artifacts/evidence-index.json`, written incrementally
 * with the same atomic temp+rename pattern as the #342 recovery
 * manifest (`src/driver/recovery-evidence.ts`). It is append-tolerant:
 * a second writer in the same session merges by artifact/segment id,
 * unions operation `evidenceRefs` and gap lists, and lets scalars go
 * last-writer-wins. Concurrent writers are excluded by the session's
 * single-driver model — merge exists for sequential writers and for
 * recovery, not for parallelism.
 *
 * Honesty rules carried over from the recovery manifest:
 *
 *   - Gaps are first-class: `uncapturable` / `unrecorded` / `orphaned`
 *     and per-operation `coverage: "none"` are recorded, never omitted.
 *   - `consumerRefs` echoes caller-supplied identities only; nothing is
 *     invented (spec §5.3 rule 5).
 *   - A malformed index file throws on read — half-written or foreign
 *     content must never be silently treated as "no evidence".
 *
 * Level: pure contract — file I/O and JSON only, no OS calls.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { errorMessage } from "../errors.js";
import {
  GUI_EVIDENCE_INDEX_KIND,
  type EvidenceArtifact,
  type EvidenceConsumerRefs,
  type EvidenceCoverage,
  type EvidenceHostRef,
  type EvidenceOperation,
  type EvidenceSegment,
  type GuiEvidenceIndexDocument,
} from "./types.js";

export {
  artifactCoverage,
  clockSkewMs,
  coveredOperationIds,
  indexClockSkew,
  operationCoverage,
  segmentTraceCoverage,
  segmentOperationCoverage,
} from "./correlate.js";
export type {
  DualClockPoint,
  EvidenceTraceRow,
  SegmentOperationCoverage,
  SegmentTraceCoverage,
} from "./correlate.js";
export { guiEvidenceCapabilities } from "./capabilities.js";
export type {
  GuiEvidenceCapabilities,
  GuiEvidenceCapability,
} from "./capabilities.js";

export { GUI_EVIDENCE_INDEX_KIND } from "./types.js";
export type {
  CaptureLeakage,
  CaptureScope,
  EvidenceArtifact,
  EvidenceCaptureStats,
  EvidenceClock,
  EvidenceConsumerRefs,
  EvidenceCoverage,
  EvidenceExclusion,
  EvidenceHostRef,
  EvidenceIndexSession,
  EvidenceKind,
  EvidenceOperation,
  EvidenceSegment,
  EvidenceSessionKind,
  GuiEvidenceIndexDocument,
} from "./types.js";

/** The index file name inside the session artifacts directory. */
export const EVIDENCE_INDEX_FILENAME = "evidence-index.json";

/** `<sessionRoot>/artifacts/evidence-index.json` (spec §5.5). */
export function evidenceIndexPath(artifactsDir: string): string {
  return join(artifactsDir, EVIDENCE_INDEX_FILENAME);
}

/**
 * The `kind: "index"` self-reference artifact (spec §5.5: "artifact
 * enumerations are self-describing"). The index cannot hash itself — the
 * hash would change on every write — so `sha256` is `null` with the
 * reason recorded, per the honesty rule.
 */
export function selfIndexArtifact(
  session: EvidenceHostRef,
  capturedAt: string,
): EvidenceArtifact {
  return {
    id: "evidence-index",
    kind: "index",
    role: "original",
    path: EVIDENCE_INDEX_FILENAME,
    sha256: null,
    sha256Error: "self-referential: the index cannot hash itself",
    bytes: null,
    session,
    time: {
      capturedAt,
      t0EpochMs: null,
      t0MonoMs: null,
      durationMs: null,
      endEpochMs: null,
    },
    provenance: { producer: "ae-a8n", tool: "ae-a8n" },
    operationIds: [],
  };
}

/* ------------------------------------------------------------------ */
/* Merge helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * The dedup key for an artifact: `sha256` when the content was hashed
 * (spec §5.5 "deduplicated by sha256"), the caller-assigned `id`
 * otherwise. Two artifacts with the same hash are the same evidence.
 */
export function artifactDedupKey(artifact: EvidenceArtifact): string {
  return artifact.sha256 !== null ? `sha256:${artifact.sha256}` : `id:${artifact.id}`;
}

function unionStrings(existing: readonly string[], incoming: readonly string[]): string[] {
  const out = [...existing];
  for (const value of incoming) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * Coverage merge: the union of what evidence exists. `"both"` wins;
 * screen+render combine to `"both"`; `"none"` never erases a channel.
 */
export function mergeCoverage(a: EvidenceCoverage, b: EvidenceCoverage): EvidenceCoverage {
  if (a === "both" || b === "both") {
    return "both";
  }
  if (a === "none") {
    return b;
  }
  if (b === "none" || a === b) {
    return a;
  }
  return "both";
}

function mergeOperation(a: EvidenceOperation, b: EvidenceOperation): EvidenceOperation {
  const coverage = mergeCoverage(a.coverage, b.coverage);
  const merged: {
    requestId: string;
    traceSeq?: number;
    op: string;
    auditOpId?: string;
    evidenceRefs: string[];
    coverage: EvidenceCoverage;
    uncovered?: string;
  } = {
    requestId: a.requestId,
    op: b.op || a.op,
    evidenceRefs: unionStrings(a.evidenceRefs, b.evidenceRefs),
    coverage,
  };
  const traceSeq = b.traceSeq ?? a.traceSeq;
  if (traceSeq !== undefined) {
    merged.traceSeq = traceSeq;
  }
  const auditOpId = b.auditOpId ?? a.auditOpId;
  if (auditOpId !== undefined) {
    merged.auditOpId = auditOpId;
  }
  // `uncovered` explains a "none"; it is meaningless once evidence exists.
  if (coverage === "none") {
    const uncovered = b.uncovered ?? a.uncovered;
    if (uncovered !== undefined) {
      merged.uncovered = uncovered;
    }
  }
  return merged;
}

function mergeConsumerRefs(
  a: EvidenceConsumerRefs | undefined,
  b: EvidenceConsumerRefs | undefined,
): EvidenceConsumerRefs | undefined {
  if (a === undefined) {
    return b === undefined ? undefined : { ...b };
  }
  if (b === undefined) {
    return { ...a };
  }
  // Scalar last-writer-wins per defined field; undefined never erases.
  const merged: { -readonly [K in keyof EvidenceConsumerRefs]?: string } = { ...a };
  for (const key of ["testId", "runId", "suite"] as const) {
    const value = b[key];
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Document merge — append-tolerant                                    */
/* ------------------------------------------------------------------ */

/**
 * Merges `incoming` into `base` per spec §5.5: artifacts deduplicated by
 * `artifactDedupKey`, segments and operations merged by id/requestId,
 * gap lists unioned, scalars (session fields, `clock`, `consumerRefs`,
 * `captureStats`) last-writer-wins — with `undefined` never erasing a
 * defined value.
 */
export function mergeEvidenceIndexDocuments(
  base: GuiEvidenceIndexDocument,
  incoming: GuiEvidenceIndexDocument,
): GuiEvidenceIndexDocument {
  const artifacts = new Map<string, EvidenceArtifact>();
  for (const artifact of [...base.artifacts, ...incoming.artifacts]) {
    artifacts.set(artifactDedupKey(artifact), artifact);
  }
  const segments = new Map<string, EvidenceSegment>();
  for (const segment of [...base.segments, ...incoming.segments]) {
    segments.set(segment.id, segment);
  }
  const operations = new Map<string, EvidenceOperation>();
  for (const operation of [...base.operations, ...incoming.operations]) {
    const existing = operations.get(operation.requestId);
    operations.set(
      operation.requestId,
      existing === undefined ? operation : mergeOperation(existing, operation),
    );
  }
  const consumerRefs = mergeConsumerRefs(base.consumerRefs, incoming.consumerRefs);
  return {
    kind: GUI_EVIDENCE_INDEX_KIND,
    // Session identity is the session's, not the writer's claim: incoming
    // (the later writer) wins on defined scalars; null never erases.
    session: { ...base.session, ...definedOnly(incoming.session, base.session) },
    ...(consumerRefs === undefined ? {} : { consumerRefs }),
    segments: [...segments.values()],
    artifacts: [...artifacts.values()],
    operations: [...operations.values()],
    gaps: {
      uncapturable: unionStrings(base.gaps.uncapturable, incoming.gaps.uncapturable),
      unrecorded: unionStrings(base.gaps.unrecorded, incoming.gaps.unrecorded),
      orphaned: unionStrings(base.gaps.orphaned, incoming.gaps.orphaned),
    },
    ...(incoming.captureStats === undefined
      ? base.captureStats === undefined
        ? {}
        : { captureStats: base.captureStats }
      : { captureStats: incoming.captureStats }),
    clock: {
      basis: "epoch+mono",
      skewEstimateMs:
        incoming.clock.skewEstimateMs ?? base.clock.skewEstimateMs ?? null,
    },
    capturedAt: base.capturedAt,
    updatedAt: incoming.updatedAt,
  };
}

function definedOnly<T extends object>(source: T, fallback: T): T {
  const out: Record<string, unknown> = {
    ...(fallback as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out as unknown as T;
}

/* ------------------------------------------------------------------ */
/* Validation — fail closed                                            */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Structural validation of a parsed index document. Checks the schema
 * discriminator and the fields every consumer dereferences; it is not a
 * full JSON-Schema pass. Throws on anything malformed — a corrupt index
 * must surface, not read as empty.
 */
export function parseGuiEvidenceIndexDocument(value: unknown): GuiEvidenceIndexDocument {
  if (!isRecord(value)) {
    throw new Error("gui evidence index is not a JSON object");
  }
  if (value.kind !== GUI_EVIDENCE_INDEX_KIND) {
    throw new Error(
      `gui evidence index has kind ${JSON.stringify(value.kind)}, expected ${GUI_EVIDENCE_INDEX_KIND}`,
    );
  }
  const session = value.session;
  if (
    !isRecord(session) ||
    typeof session.sessionRoot !== "string" ||
    typeof session.adapter !== "string" ||
    !isStringOrNull(session.sessionId) ||
    !isFiniteNumberOrNull(session.pid) ||
    !isStringOrNull(session.processStartIdentity) ||
    typeof session.sessionKind !== "string"
  ) {
    throw new Error("gui evidence index session block is malformed");
  }
  if (
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.segments) ||
    !Array.isArray(value.operations) ||
    !isRecord(value.gaps) ||
    !Array.isArray(value.gaps.uncapturable) ||
    !Array.isArray(value.gaps.unrecorded) ||
    !Array.isArray(value.gaps.orphaned) ||
    !isRecord(value.clock) ||
    value.clock.basis !== "epoch+mono" ||
    typeof value.capturedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("gui evidence index body is malformed");
  }
  for (const artifact of value.artifacts) {
    if (
      !isRecord(artifact) ||
      typeof artifact.id !== "string" ||
      typeof artifact.kind !== "string" ||
      (artifact.sha256 !== null && typeof artifact.sha256 !== "string")
    ) {
      throw new Error("gui evidence index contains a malformed artifact record");
    }
    // The honesty rule: a null hash must carry its reason.
    if (artifact.sha256 === null && typeof artifact.sha256Error !== "string") {
      throw new Error(
        `gui evidence index artifact ${JSON.stringify(artifact.id)} has sha256: null without sha256Error`,
      );
    }
  }
  return value as unknown as GuiEvidenceIndexDocument;
}

/* ------------------------------------------------------------------ */
/* The index core                                                      */
/* ------------------------------------------------------------------ */

type MutableGaps = {
  uncapturable: string[];
  unrecorded: string[];
  orphaned: string[];
};

type MutableIndexDoc = {
  -readonly [K in keyof GuiEvidenceIndexDocument]: K extends "segments"
    ? EvidenceSegment[]
    : K extends "artifacts"
      ? EvidenceArtifact[]
      : K extends "operations"
        ? EvidenceOperation[]
        : K extends "gaps"
          ? MutableGaps
          : GuiEvidenceIndexDocument[K];
};

/**
 * A live handle on one session's index: load or create, mutate, save.
 * Mutations update the in-memory document; `save()` persists it
 * atomically. `document` returns a deep copy so callers cannot corrupt
 * the writer's state.
 */
export class GuiEvidenceIndex {
  readonly #doc: MutableIndexDoc;

  private constructor(doc: MutableIndexDoc) {
    this.#doc = doc;
  }

  /** A fresh index for a session. */
  static create(
    session: GuiEvidenceIndexDocument["session"],
    options: { readonly now?: string } = {},
  ): GuiEvidenceIndex {
    const now = options.now ?? new Date().toISOString();
    return new GuiEvidenceIndex({
      kind: GUI_EVIDENCE_INDEX_KIND,
      session,
      segments: [],
      artifacts: [],
      operations: [],
      gaps: { uncapturable: [], unrecorded: [], orphaned: [] },
      clock: { basis: "epoch+mono" },
      capturedAt: now,
      updatedAt: now,
    });
  }

  /**
   * Loads the index from a session artifacts directory. Returns `null`
   * when no index exists yet (a normal first-write state); throws when
   * the file exists but is not a valid `ae-a8n.gui-evidence/v1` document.
   */
  static load(artifactsDir: string): GuiEvidenceIndex | null {
    const path = evidenceIndexPath(artifactsDir);
    if (!existsSync(path)) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      throw new Error(
        `gui evidence index at ${path} is not readable JSON: ${errorMessage(error)}`,
      );
    }
    const doc = parseGuiEvidenceIndexDocument(parsed);
    return GuiEvidenceIndex.fromDocument(doc);
  }

  /** Wraps an already-validated document. */
  static fromDocument(doc: GuiEvidenceIndexDocument): GuiEvidenceIndex {
    return new GuiEvidenceIndex({
      ...doc,
      segments: [...doc.segments],
      artifacts: [...doc.artifacts],
      operations: [...doc.operations],
      gaps: {
        uncapturable: [...doc.gaps.uncapturable],
        unrecorded: [...doc.gaps.unrecorded],
        orphaned: [...doc.gaps.orphaned],
      },
    });
  }

  /**
   * Merges another index into this one (append-tolerant; see
   * `mergeEvidenceIndexDocuments`). Returns `this` for chaining.
   */
  mergeFrom(other: GuiEvidenceIndex): this {
    const merged = mergeEvidenceIndexDocuments(this.document, other.document);
    this.#doc.session = merged.session;
    if (merged.consumerRefs === undefined) {
      delete this.#doc.consumerRefs;
    } else {
      this.#doc.consumerRefs = merged.consumerRefs;
    }
    this.#doc.segments = [...merged.segments];
    this.#doc.artifacts = [...merged.artifacts];
    this.#doc.operations = [...merged.operations];
    this.#doc.gaps = {
      uncapturable: [...merged.gaps.uncapturable],
      unrecorded: [...merged.gaps.unrecorded],
      orphaned: [...merged.gaps.orphaned],
    };
    if (merged.captureStats === undefined) {
      delete this.#doc.captureStats;
    } else {
      this.#doc.captureStats = merged.captureStats;
    }
    this.#doc.clock = merged.clock;
    this.#doc.updatedAt = merged.updatedAt;
    return this;
  }

  /** A deep copy of the current document. */
  get document(): GuiEvidenceIndexDocument {
    return structuredClone(this.#doc);
  }

  get updatedAt(): string {
    return this.#doc.updatedAt;
  }

  /**
   * Echoes caller-supplied consumer identities. Only defined fields are
   * written — ae-a8n never invents a testId/runId (spec §5.3 rule 5).
   */
  setConsumerRefs(refs: EvidenceConsumerRefs): void {
    const merged = mergeConsumerRefs(this.#doc.consumerRefs, refs);
    if (merged === undefined) {
      delete this.#doc.consumerRefs;
    } else {
      this.#doc.consumerRefs = merged;
    }
    this.#touch();
  }

  /**
   * Adds or replaces an artifact, deduplicated by
   * `artifactDedupKey` (sha256 when hashed, else id). Returns the key the
   * artifact was stored under so callers can build `evidenceRefs`.
   */
  addArtifact(artifact: EvidenceArtifact): string {
    const key = artifactDedupKey(artifact);
    this.#doc.artifacts = this.#doc.artifacts.filter(
      (existing) => artifactDedupKey(existing) !== key,
    );
    this.#doc.artifacts.push(artifact);
    this.#touch();
    return key;
  }

  /** Adds or replaces a recording segment summary, keyed by `id`. */
  addSegment(segment: EvidenceSegment): void {
    this.#doc.segments = this.#doc.segments.filter((s) => s.id !== segment.id);
    this.#doc.segments.push(segment);
    this.#touch();
  }

  /**
   * Records an operation's evidence accounting. Merges by `requestId`:
   * `evidenceRefs` union, coverage takes the union of channels. When the
   * merged coverage is `"none"` the `uncovered` reason is kept — a gap is
   * data.
   */
  recordOperation(operation: EvidenceOperation): void {
    const existing = this.#doc.operations.find((o) => o.requestId === operation.requestId);
    if (existing === undefined) {
      this.#doc.operations.push({ ...operation, evidenceRefs: [...operation.evidenceRefs] });
    } else {
      const merged = mergeOperation(existing, operation);
      this.#doc.operations = this.#doc.operations.map((o) =>
        o.requestId === operation.requestId ? merged : o,
      );
    }
    this.#touch();
  }

  /** An operation ran and evidence could not be produced — record why. */
  noteUncapturable(reason: string): void {
    if (!this.#doc.gaps.uncapturable.includes(reason)) {
      this.#doc.gaps.uncapturable.push(reason);
      this.#touch();
    }
  }

  /** An operation ran while recording/capture was off — record why. */
  noteUnrecorded(reason: string): void {
    if (!this.#doc.gaps.unrecorded.includes(reason)) {
      this.#doc.gaps.unrecorded.push(reason);
      this.#touch();
    }
  }

  /** An artifact id or segment id found without its producer — record it. */
  noteOrphaned(id: string): void {
    if (!this.#doc.gaps.orphaned.includes(id)) {
      this.#doc.gaps.orphaned.push(id);
      this.#touch();
    }
  }

  /** Records measured capture/record overhead numbers (spec §11). */
  setCaptureStats(stats: NonNullable<GuiEvidenceIndexDocument["captureStats"]>): void {
    this.#doc.captureStats = { ...stats };
    this.#touch();
  }

  /** Records the latest dual-clock skew estimate (ms), or clears it. */
  setClockSkew(skewEstimateMs: number | null): void {
    this.#doc.clock = { basis: "epoch+mono", skewEstimateMs };
    this.#touch();
  }

  /**
   * Persists the index atomically (temp file + rename, same pattern as
   * `writeRecoveryEvidence`) into `artifactsDir`. Returns the written
   * path, or `null` with the reason — a failed index write must never
   * break the run it describes, so nothing here throws.
   */
  save(artifactsDir: string): { readonly path: string | null; readonly error?: string } {
    this.#doc.updatedAt = new Date().toISOString();
    const path = evidenceIndexPath(artifactsDir);
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(this.#doc, null, 2)}\n`, "utf-8");
      renameSync(tmp, path);
      return { path };
    } catch (error) {
      return { path: null, error: errorMessage(error) };
    }
  }

  #touch(): void {
    this.#doc.updatedAt = new Date().toISOString();
  }
}
