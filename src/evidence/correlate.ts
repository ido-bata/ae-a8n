/**
 * Dual-clock correlation helpers for the evidence index (#377,
 * `specs/gui-evidence/spec.md` §5.3).
 *
 * Everything here is pure: the functions take already-collected values
 * (trace rows, segment bounds, dual-clock stamps) and return computed
 * answers. The index stores the computed answer — `coversOperations` on a
 * segment, `coverage` on an operation row — so consumers never re-derive
 * the join and never have to guess which clock a timestamp used.
 *
 * The join key is the wall clock: trace rows carry epoch `ts` only, so a
 * trace timestamp inside a segment's `[t0EpochMs, endEpochMs]` window is
 * covered. The monotonic stamp (`t0MonoMs`) exists for the drift check —
 * `clockSkewMs` estimates how far the two clocks disagree over a span.
 */

import type {
  EvidenceArtifact,
  EvidenceCoverage,
  EvidenceKind,
  EvidenceSegment,
} from "./types.js";

/**
 * The minimal trace-row shape correlation needs. `TraceEvent` from
 * `src/trace/trace.ts` is structurally assignable when the caller maps
 * `requestId` in; the requestId is not a first-class trace field today.
 */
export type EvidenceTraceRow = {
  readonly seq?: number;
  /** ISO epoch timestamp — the wall-clock join key. */
  readonly ts: string;
  readonly op: string;
  /** The protocol envelope id, when the caller can correlate one. */
  readonly requestId?: string;
};

const SCREEN_KINDS: ReadonlySet<EvidenceKind> = new Set(["screen-still", "screen-recording"]);
const RENDER_KINDS: ReadonlySet<EvidenceKind> = new Set(["render-frame", "render-sequence"]);

/**
 * Which channel(s) a set of evidence kinds covers (spec §3). `"index"`
 * and `"trace"` are channel-neutral bookkeeping, not coverage — they
 * never upgrade an operation to `"screen"` or `"render"`.
 */
export function operationCoverage(kinds: Iterable<EvidenceKind>): EvidenceCoverage {
  let screen = false;
  let render = false;
  for (const kind of kinds) {
    if (SCREEN_KINDS.has(kind)) {
      screen = true;
    } else if (RENDER_KINDS.has(kind)) {
      render = true;
    }
  }
  if (screen && render) {
    return "both";
  }
  if (screen) {
    return "screen";
  }
  if (render) {
    return "render";
  }
  return "none";
}

/** Coverage of one artifact — convenience over `operationCoverage([kind])`. */
export function artifactCoverage(artifact: EvidenceArtifact): EvidenceCoverage {
  return operationCoverage([artifact.kind]);
}

export type SegmentTraceCoverage = {
  /** Rows whose `ts` falls inside the segment window. */
  readonly covered: readonly EvidenceTraceRow[];
  /** Rows outside the window — not evidenced by THIS segment. */
  readonly uncovered: readonly EvidenceTraceRow[];
  /**
   * `true` when the segment has no `endEpochMs` (still recording, or the
   * recorder vanished): coverage is then provisional and must be reported
   * as open, never as complete (spec §5.3 rule 3).
   */
  readonly open: boolean;
};

/**
 * Splits trace rows into covered/uncovered for one segment. Rows with an
 * unparseable `ts` are neither — they cannot be joined and must not be
 * silently counted as covered.
 */
export function segmentTraceCoverage(
  segment: Pick<EvidenceSegment, "t0EpochMs" | "endEpochMs">,
  rows: readonly EvidenceTraceRow[],
): SegmentTraceCoverage {
  const open = segment.endEpochMs === null;
  const end = segment.endEpochMs ?? Number.POSITIVE_INFINITY;
  const covered: EvidenceTraceRow[] = [];
  const uncovered: EvidenceTraceRow[] = [];
  for (const row of rows) {
    const epoch = Date.parse(row.ts);
    if (Number.isNaN(epoch)) {
      continue;
    }
    if (epoch >= segment.t0EpochMs && epoch <= end) {
      covered.push(row);
    } else {
      uncovered.push(row);
    }
  }
  return { covered, uncovered, open };
}

/**
 * The operation ids a segment covers: every covered row's `requestId`,
 * plus every id already claimed in `operationIds` (audit-side ids the
 * trace does not carry). Rows without a `requestId` contribute nothing —
 * an unidentifiable row cannot evidence an operation.
 */
export function coveredOperationIds(
  segment: Pick<EvidenceSegment, "t0EpochMs" | "endEpochMs" | "operationIds">,
  rows: readonly EvidenceTraceRow[],
): { readonly covered: readonly string[]; readonly open: boolean } {
  const { covered, open } = segmentTraceCoverage(segment, rows);
  const ids = new Set<string>(segment.operationIds);
  for (const row of covered) {
    if (row.requestId !== undefined) {
      ids.add(row.requestId);
    }
  }
  return { covered: [...ids], open };
}

/**
 * Trace ops that are the recording lifecycle's own bookkeeping rows
 * (`record.start`/`record.stop`, written by `RecordingController` — #381).
 * They carry no protocol `requestId` by design; they must not count as
 * unbound operations when `coversOperations` is computed.
 */
const RECORD_LIFECYCLE_OPS: ReadonlySet<string> = new Set([
  "record.start",
  "record.stop",
]);

export type SegmentOperationCoverage = {
  /** Every operation id the segment window covers (requestIds + claimed ids). */
  readonly operationIds: readonly string[];
  /**
   * The stored `coversOperations` answer (spec §5.3 rule 2): `null` while
   * the segment is open; `false` when the segment cannot prove it covered
   * what ran inside its window — an incomplete segment, a file that did
   * not probe playable, or a covered trace row that carries no
   * `requestId` (an operation that ran but cannot be bound to an id);
   * `true` only when the window is closed, finalized playable, and every
   * covered operation is identifiable.
   */
  readonly coversOperations: boolean | null;
  /** `true` when `endEpochMs` is `null` — coverage is provisional/open. */
  readonly open: boolean;
};

/**
 * The `record.stop`-time computation for one segment (spec §5.3 rules
 * 2–3, issue #381): intersects the trace `[ts]` rows with the segment's
 * `[t0EpochMs, endEpochMs]` window and answers both the covered operation
 * ids and the stored `coversOperations` verdict. `endEpochMs === null`
 * reports `open` — never a completed answer.
 */
export function segmentOperationCoverage(
  segment: Pick<EvidenceSegment, "t0EpochMs" | "endEpochMs" | "operationIds">,
  rows: readonly EvidenceTraceRow[],
  finalize: {
    /** Container probe result; `null`/`false` means coverage is unproven. */
    readonly playable: boolean | null;
    /** Set when the segment ended early (`"deadline-exceeded"`, …). */
    readonly incomplete?: string;
  },
): SegmentOperationCoverage {
  const { covered, open } = segmentTraceCoverage(segment, rows);
  const ids = new Set<string>(segment.operationIds);
  let unbound = 0;
  for (const row of covered) {
    if (row.requestId !== undefined) {
      ids.add(row.requestId);
    } else if (!RECORD_LIFECYCLE_OPS.has(row.op)) {
      unbound += 1;
    }
  }
  let coversOperations: boolean | null;
  if (open) {
    coversOperations = null;
  } else if (
    finalize.playable !== true ||
    finalize.incomplete !== undefined ||
    unbound > 0
  ) {
    coversOperations = false;
  } else {
    coversOperations = true;
  }
  return { operationIds: [...ids], coversOperations, open };
}

/** A dual-clock instant: wall epoch and monotonic, both required. */
export type DualClockPoint = {
  readonly epochMs: number;
  readonly monoMs: number;
};

/**
 * Estimates wall-vs-monotonic skew over the span from `origin` to `point`:
 * how much the elapsed wall time diverges from the elapsed monotonic
 * time. `0` means the clocks agree; a nonzero value is the drift a
 * wall-clock-only join would have missed. Returns `null` inputs are not
 * accepted — callers with a missing mono stamp have no skew to estimate.
 */
export function clockSkewMs(origin: DualClockPoint, point: DualClockPoint): number {
  return point.epochMs - origin.epochMs - (point.monoMs - origin.monoMs);
}

/**
 * The skew to record on the index's `clock` block: the latest computable
 * estimate, or `null` when either endpoint lacks a monotonic stamp.
 */
export function indexClockSkew(
  origin: { readonly epochMs: number | null; readonly monoMs: number | null },
  point: { readonly epochMs: number | null; readonly monoMs: number | null },
): number | null {
  if (
    origin.epochMs === null ||
    origin.monoMs === null ||
    point.epochMs === null ||
    point.monoMs === null
  ) {
    return null;
  }
  return clockSkewMs(
    { epochMs: origin.epochMs, monoMs: origin.monoMs },
    { epochMs: point.epochMs, monoMs: point.monoMs },
  );
}
