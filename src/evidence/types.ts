/**
 * GUI evidence index contract — `ae-a8n.gui-evidence/v1` (#377, parent
 * program #337 US-B4 / tracking #346, spec `specs/gui-evidence/spec.md`
 * §5.1, §5.2, §5.5).
 *
 * One JSON document per session at `<sessionRoot>/artifacts/
 * evidence-index.json` binds every evidence artifact a run produced —
 * screen stills, screen recordings, render frames/sequences, the trace
 * itself, and the index — to the operations that asked for them. The two
 * evidence channels of spec §3 stay distinct here: a `screen-*` artifact
 * proves what the GUI displayed, a `render-*` artifact proves what AE
 * produced, and `coverage` on an operation row records which channel (or
 * both, or neither) actually has evidence. Gaps are data: an operation
 * that ran unrecorded, a capture that could not happen, and a segment
 * whose recorder vanished are all listed, never omitted.
 *
 * This module is pure contract: no OS calls, no capture, no recording.
 * Producer identity, artifact ids and consumer references are supplied by
 * the caller — ae-a8n echoes `consumerRefs`, it never invents a test or
 * run identity.
 */

import type { PanelFrame, PanelTarget } from "../panels/types.js";

/** The index schema id; bump on breaking shape changes. */
export const GUI_EVIDENCE_INDEX_KIND = "ae-a8n.gui-evidence/v1";

/** What an evidence artifact is (spec §5.1). */
export type EvidenceKind =
  /** One OS capture of a scope (display/region/window). */
  | "screen-still"
  /** One bounded video segment of a scope. */
  | "screen-recording"
  /** One AE-produced frame (renderFrame PNG, RQ output frame). */
  | "render-frame"
  /** A numbered frame sequence from one render job. */
  | "render-sequence"
  /** The session trace.jsonl — referenced, not copied. */
  | "trace"
  /** The run evidence index itself. */
  | "index";

/**
 * The session kind vocabulary of spec §5.2/§5.6. `"unknown"` is the honest
 * answer when the driver cannot prove which session class it runs in —
 * it is never silently upgraded to `"isolated"`.
 */
export type EvidenceSessionKind = "isolated" | "attached" | "console" | "unknown";

/**
 * The proven host identity an artifact belongs to. Every field is
 * nullable because "not proven" is a reportable state: a pid without a
 * start identity is a pid that could have been reused.
 */
export type EvidenceHostRef = {
  readonly pid: number | null;
  /** Process start identity (launch-provenance `startedAt`/`identity`). */
  readonly processStartIdentity: string | null;
  readonly sessionId: string | null;
  readonly sessionKind: EvidenceSessionKind;
};

/** Session-level identity block on the index itself. */
export type EvidenceIndexSession = EvidenceHostRef & {
  /** Absolute path of the session root this index lives under. */
  readonly sessionRoot: string;
  /** The adapter/transport that produced the evidence, caller-supplied. */
  readonly adapter: string;
};

/**
 * What a capture or recording was asked to cover (spec §5.2). `window`
 * and `region` reuse the B-PANEL identity types: a scope is only valid
 * against a `PanelTarget` whose attribution is `"owned"` — enforcement of
 * that gate lives in the capture path, the schema only carries the claim.
 */
export type CaptureScope =
  | {
      readonly kind: "window";
      /** The resolved panel surface the capture addresses. */
      readonly window: PanelTarget;
    }
  | {
      readonly kind: "region";
      /** The rectangle in points, top-left origin (census/AX space). */
      readonly frame: PanelFrame;
      /** The panel the region belongs to, when it is panel-derived. */
      readonly parent?: PanelTarget;
    }
  | {
      readonly kind: "display";
      /** OS display identifier when the platform names one. */
      readonly displayId?: string;
    }
  | {
      readonly kind: "session";
      readonly sessionKind: "isolated" | "attached" | "console";
    };

/**
 * What an artifact may contain beyond its declared scope (spec §5.2,
 * §7). Wide scopes are a privacy declaration: `full-display` and
 * `full-session` artifacts can contain arbitrary other-app content and
 * must never be treated as window-scoped evidence.
 */
export type CaptureLeakage =
  | "window"
  | "region"
  | "full-display"
  | "full-session"
  | "unknown";

/** One evidence artifact record (spec §5.1). */
export type EvidenceArtifact = {
  /**
   * The artifact's index id — what `operations[].evidenceRefs` and trace
   * `result.evidenceId` point at. Caller-assigned; the index deduplicates
   * on it (and on `sha256` when present — see the index merge rules).
   */
  readonly id: string;
  readonly kind: EvidenceKind;
  /** `"original"` is the untouched producer output; `"derived"` a transform. */
  readonly role: "original" | "derived";
  /** Path relative to the session artifacts directory. */
  readonly path: string;
  /**
   * Content hash, or `null` when hashing was impossible — and then
   * `sha256Error` MUST say why. A missing hash is recorded, never omitted:
   * an absent field must not read as "hash matched".
   */
  readonly sha256: string | null;
  readonly sha256Error?: string;
  readonly bytes: number | null;
  /** The proven host identity the artifact was produced on/for. */
  readonly session: EvidenceHostRef;
  /** The scope that was asked for. Screen kinds only. */
  readonly scope?: CaptureScope;
  /**
   * The scope actually delivered, when it differs from `scope` — e.g. a
   * `window` request a whole-display fallback honored (spec §5.2:
   * requested ≠ delivered is always explicit).
   */
  readonly actualScope?: CaptureScope;
  /** Leakage declaration for wide scopes; `"unknown"` when unproven. */
  readonly leakage?: CaptureLeakage;
  readonly time: {
    /** ISO epoch wall clock at capture/production. */
    readonly capturedAt: string;
    /** Recording/capture start on the wall clock; `null` when unprovable. */
    readonly t0EpochMs: number | null;
    /** Same instant on the monotonic clock — the drift check axis. */
    readonly t0MonoMs: number | null;
    /** Elapsed milliseconds; `null` for stills. */
    readonly durationMs: number | null;
    /** Wall-clock end; `null` while open or for stills. */
    readonly endEpochMs: number | null;
  };
  readonly geometry?: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly fps?: number;
    readonly coordinateSpace: string;
    readonly backingScale?: number;
  };
  readonly provenance: {
    readonly producer: "os-capture" | "ae-render" | "ae-a8n" | "derived-tool";
    readonly tool: string;
    readonly toolVersion?: string;
  };
  /** requestIds / audit op ids this artifact evidences (spec §5.3). */
  readonly operationIds: readonly string[];
  /** Present on `role: "derived"` artifacts — what transform was applied. */
  readonly transform?: {
    readonly kind: "crop" | "scale" | "trim" | "frame-extract" | "re-encode";
    readonly params: Readonly<Record<string, unknown>>;
  };
  /** Honest absence — a gap is data, not silence. */
  readonly unavailable?: { readonly reason: string };
};

/**
 * A declarative exclusion request recorded on a recording segment
 * (spec §7.2): what the caller asked the recorder to leave out. The
 * request is recorded verbatim; whether the backend honored it is
 * backend-reported — an exclusion that cannot be honored surfaces as an
 * `unavailable`/`uncapturable` reason, never silently.
 */
export type EvidenceExclusion = {
  readonly kind: "window" | "region" | "display" | "application" | "process";
  /** Opaque backend predicate, recorded verbatim for audit. */
  readonly predicate?: string;
};

/**
 * One bounded recording segment, summarized on the index (spec §5.4).
 * The lifecycle that writes it is `RecordingController` (#381,
 * `recording.ts`); this is the record shape.
 */
export type EvidenceSegment = {
  readonly id: string;
  readonly scope: CaptureScope;
  readonly actualScope?: CaptureScope;
  readonly t0EpochMs: number;
  readonly t0MonoMs: number | null;
  /** `null` while the segment is open or was never closed cleanly. */
  readonly endEpochMs: number | null;
  readonly durationMs: number | null;
  /** Media file path relative to the artifacts dir; `null` if none. */
  readonly file: string | null;
  /** Container probe result; `null` = never probed, `false` = unplayable. */
  readonly playable: boolean | null;
  /** Why the segment is `incomplete`, e.g. `"deadline-exceeded"`. */
  readonly incomplete?: string;
  /**
   * Whether the segment's `[t0,end]` window covers every operation the
   * caller computed it should — computed at `record.stop` from the trace
   * (spec §5.3 rule 2); consumers do not re-derive it. `null` = open.
   */
  readonly coversOperations: boolean | null;
  readonly operationIds: readonly string[];
  /** Recorder process residue after teardown (spec §5.4). */
  readonly recorderResidue?: "none" | "terminated" | "unknown";
  /** Exclusion requests the caller made, recorded verbatim (spec §7.2). */
  readonly exclude?: readonly EvidenceExclusion[];
};

/**
 * Which evidence channel(s) an operation has (spec §3/§5.5). `"none"`
 * is the uncovered case — the operation ran and nothing evidences it.
 */
export type EvidenceCoverage = "screen" | "render" | "both" | "none";

/** One operation's evidence accounting row on the index. */
export type EvidenceOperation = {
  /** The protocol envelope id (`nextRequestId()`). */
  readonly requestId: string;
  /** The trace row's `seq`, when the caller could correlate one. */
  readonly traceSeq?: number;
  /** The trace row's `op` name, for readability. */
  readonly op: string;
  /** The GUI audit op id, when the operation mutated through the lease. */
  readonly auditOpId?: string;
  /** Artifact and segment ids that evidence this operation. */
  readonly evidenceRefs: readonly string[];
  readonly coverage: EvidenceCoverage;
  /** Why the operation has `coverage: "none"` — required then. */
  readonly uncovered?: string;
};

/** Caller-supplied identities the index echoes — never invented (§5.3.5). */
export type EvidenceConsumerRefs = {
  readonly testId?: string;
  readonly runId?: string;
  readonly suite?: string;
};

/** Performance numbers a recording run measured (spec §11). */
export type EvidenceCaptureStats = {
  readonly requestedFps?: number;
  readonly achievedFps?: number | null;
  readonly droppedFrames?: number | null;
  readonly encodeCpu?: number | null;
  readonly measuredOverheadMs?: number | null;
};

/**
 * The dual-clock bookkeeping block. `basis` names the clock pair the
 * correlation functions assume; `skewEstimateMs` is the last computed
 * wall-vs-monotonic divergence, `null`/absent when never computed.
 */
export type EvidenceClock = {
  readonly basis: "epoch+mono";
  readonly skewEstimateMs?: number | null;
};

/** The `ae-a8n.gui-evidence/v1` document — one per session. */
export type GuiEvidenceIndexDocument = {
  readonly kind: typeof GUI_EVIDENCE_INDEX_KIND;
  readonly session: EvidenceIndexSession;
  /** Present only with caller-supplied values; absent means "not given". */
  readonly consumerRefs?: EvidenceConsumerRefs;
  readonly segments: readonly EvidenceSegment[];
  /** Stills, render refs, derived artifacts and the self `"index"` entry. */
  readonly artifacts: readonly EvidenceArtifact[];
  readonly operations: readonly EvidenceOperation[];
  /**
   * First-class gaps (spec §5.5): what could not be captured, what ran
   * unrecorded, and which artifacts/segments were found orphaned. Lists
   * are strings so a reason can carry detail (`"screen-image:before
   * (screencapture exited 1)"`); they are never omitted when non-empty.
   */
  readonly gaps: {
    readonly uncapturable: readonly string[];
    readonly unrecorded: readonly string[];
    readonly orphaned: readonly string[];
  };
  readonly captureStats?: EvidenceCaptureStats;
  readonly clock: EvidenceClock;
  readonly capturedAt: string;
  readonly updatedAt: string;
};
