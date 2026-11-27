/**
 * Stills binding — `EvidenceArtifact` (`kind: "screen-still"`) records for
 * the existing B-PANEL capture path (#380, parent program #337 US-B4 /
 * tracking #346, spec `specs/gui-evidence/spec.md` §5.1, §5.3, §6.3 T1).
 *
 * This module does NOT capture anything: `PanelController.capture()` in
 * `src/panels/controller.ts` remains the single capture vehicle
 * (`screencapture -l`/`-R` on macOS). What happens here is the evidence
 * half of spec §5.3 rule 1 — a successful capture becomes an index
 * artifact, the capture operation gets an index `operations[]` row whose
 * `evidenceRefs` point at it, and the operation's trace row carries
 * `result.evidenceId` so a consumer can walk trace → artifact without
 * guessing.
 *
 * Honesty rules (same posture as `GuiEvidenceIndex` and the #342
 * manifest):
 *
 *   - A refused or failed capture is a first-class gap: the index gets
 *     `gaps.uncapturable` plus an operation row with `coverage: "none"`
 *     and an `uncovered` reason. Success is never fabricated.
 *   - An index that cannot be loaded or written does not break the
 *     capture: the error is returned to the caller and lands on the
 *     trace row, because evidence must not break the run it describes.
 *   - `operationIds` binds the requestId minted for this capture op and
 *     the panel-level `operationId`; recording segments are not yet
 *     implemented (E2), so time-window intersection binding arrives with
 *     them — the artifact shape already carries `operationIds` for it.
 *
 * Level: automated test / fake only — file I/O in the session artifacts
 * dir and pure mapping; no OS calls, no After Effects.
 */

import { relative } from "node:path";

import { nextRequestId } from "../protocol/workspace.js";
import type { TraceRecorder } from "../trace/trace.js";
import type { PanelCapture } from "../panels/types.js";
import { PanelError } from "../panels/types.js";
import { artifactDedupKey, GuiEvidenceIndex } from "./index.js";
import type {
  CaptureLeakage,
  CaptureScope,
  EvidenceArtifact,
  EvidenceIndexSession,
  EvidenceOperation,
} from "./types.js";

/** Everything the binder needs; assembled once per `ae.panel()` handle. */
export type StillEvidenceContext = {
  /**
   * The session artifacts directory — the index lives at
   * `<artifactsDir>/evidence-index.json` and capture files are expected
   * under it (panel captures land in `panels/`).
   */
  readonly artifactsDir: string;
  /** The session identity block written onto the index on creation. */
  readonly session: EvidenceIndexSession;
  /** Session trace recorder; the capture op's row lands here. */
  readonly trace?: TraceRecorder;
  /** Clock seams for deterministic tests. */
  readonly now?: () => Date;
  /** Monotonic clock in ms (`performance.now()`-shaped); null-able seam. */
  readonly monoNow?: () => number;
  /** Operation-id seam; defaults to `nextRequestId()` (UUID). */
  readonly newRequestId?: () => string;
};

/** The trace op name every stills capture records under. */
export const STILL_CAPTURE_OP = "panel.capture";

function isoNow(ctx: StillEvidenceContext): { epoch: string; epochMs: number } {
  const date = (ctx.now ?? (() => new Date()))();
  return { epoch: date.toISOString(), epochMs: date.getTime() };
}

function monoNow(ctx: StillEvidenceContext): number | null {
  if (ctx.monoNow !== undefined) {
    return ctx.monoNow();
  }
  try {
    // `performance.now()` is the monotonic millisecond clock Node exposes;
    // importing `node:perf_hooks` for one call is unnecessary.
    return performance.now();
  } catch {
    return null;
  }
}

/**
 * The scope the capture actually delivered, taken from the vehicle the
 * controller reports (`PanelCapture.vehicle`, #380). A `window` vehicle
 * is `screencapture -l <CGWindowID>` — the narrowest still scope; a
 * `region` vehicle is `screencapture -R` over the surface frame. The
 * `window`/`region` kinds both require `attribution === "owned"`, which
 * `PanelController.capture()` already enforced before producing the
 * artifact — the scope here only records what was delivered.
 */
export function stillCaptureScope(capture: PanelCapture): CaptureScope {
  if (capture.vehicle === "window") {
    return { kind: "window", window: capture.target };
  }
  return {
    kind: "region",
    frame: capture.target.surface.frame,
    parent: capture.target,
  };
}

function stillLeakage(capture: PanelCapture): CaptureLeakage {
  switch (capture.geometry.leakage) {
    case "region":
      return "region";
    case "full-screen":
      // The whole session screen was photographed — the wide-scope
      // declaration consumers must see (spec §5.2/§7).
      return "full-display";
    default:
      return "unknown";
  }
}

/** Artifact path relative to the artifacts dir; absolute fallback, never a lie. */
function artifactRelativePath(artifactsDir: string, absolutePath: string): string {
  const rel = relative(artifactsDir, absolutePath);
  return rel.startsWith("..") || rel === "" ? absolutePath : rel;
}

/**
 * Builds the `screen-still` `EvidenceArtifact` for a successful
 * `PanelCapture`. Pure mapping — no I/O, no clock beyond the caller's.
 */
export function buildStillArtifact(
  capture: PanelCapture,
  ctx: StillEvidenceContext,
  requestId: string,
): EvidenceArtifact {
  const { epochMs } = isoNow(ctx);
  const pixelSize = capture.original.pixelSize;
  const operationIds = [...new Set([requestId, capture.operationId])];
  return {
    id: `still-${capture.operationId}`,
    kind: "screen-still",
    role: "original",
    path: artifactRelativePath(ctx.artifactsDir, capture.original.path),
    sha256: capture.original.sha256,
    bytes: capture.original.bytes,
    session: {
      pid: ctx.session.pid,
      processStartIdentity: ctx.session.processStartIdentity,
      sessionId: ctx.session.sessionId,
      sessionKind: ctx.session.sessionKind,
    },
    scope: stillCaptureScope(capture),
    leakage: stillLeakage(capture),
    time: {
      capturedAt: capture.capturedAt,
      t0EpochMs: epochMs,
      t0MonoMs: monoNow(ctx),
      durationMs: null,
      endEpochMs: null,
    },
    ...(pixelSize === null
      ? {}
      : {
          geometry: {
            widthPx: pixelSize.width,
            heightPx: pixelSize.height,
            coordinateSpace: "pixels-top-left",
            ...(capture.geometry.backingScale === null
              ? {}
              : { backingScale: capture.geometry.backingScale }),
          },
        }),
    provenance: { producer: "os-capture", tool: "screencapture" },
    operationIds,
  };
}

/**
 * Loads the session index or creates it. A malformed existing index
 * throws from `GuiEvidenceIndex.load` — the caller decides whether that
 * fails the capture (it must not; see `recordStillCapture`).
 */
function loadOrCreateIndex(ctx: StillEvidenceContext): GuiEvidenceIndex {
  return (
    GuiEvidenceIndex.load(ctx.artifactsDir) ??
    GuiEvidenceIndex.create(ctx.session, { now: isoNow(ctx).epoch })
  );
}

/**
 * Resolves the artifact record to store when content deduplication
 * applies. Two captures of an unchanged screen share a sha256; the index
 * keeps ONE record, so the second capture must union its operation ids
 * into the existing artifact and keep the FIRST artifact's id — the id
 * an earlier trace row's `result.evidenceId` already points at must
 * never dangle.
 */
function dedupedStillArtifact(
  artifact: EvidenceArtifact,
  existing: readonly EvidenceArtifact[],
): EvidenceArtifact {
  const key = artifactDedupKey(artifact);
  const prior = existing.find((a) => artifactDedupKey(a) === key);
  if (prior === undefined) {
    return artifact;
  }
  const ids = new Set<string>([...prior.operationIds, ...artifact.operationIds]);
  return { ...prior, operationIds: [...ids] };
}

export type StillBindingResult = {
  /** The artifact id the trace row's `result.evidenceId` points at. */
  readonly evidenceId: string;
  /** The dedup key the artifact was stored under (sha256 or id). */
  readonly artifactKey: string;
  /** Index write failure, when the index could not be persisted. */
  readonly indexError?: string;
};

/**
 * Records a successful still capture into the session evidence index:
 * artifact append (sha256-deduplicated), the capture operation's
 * `operations[]` row with `coverage: "screen"`, and an atomic save.
 * Returns the binding; never throws — an index failure is reported in
 * `indexError`, not by breaking the capture it describes.
 */
export function recordStillCapture(
  capture: PanelCapture,
  ctx: StillEvidenceContext,
  requestId: string,
): StillBindingResult {
  const artifact = buildStillArtifact(capture, ctx, requestId);
  try {
    const index = loadOrCreateIndex(ctx);
    const merged = dedupedStillArtifact(artifact, index.document.artifacts);
    const key = index.addArtifact(merged);
    const operation: EvidenceOperation = {
      requestId,
      op: STILL_CAPTURE_OP,
      evidenceRefs: [merged.id],
      coverage: "screen",
    };
    index.recordOperation(operation);
    const saved = index.save(ctx.artifactsDir);
    return {
      evidenceId: merged.id,
      artifactKey: key,
      ...(saved.error === undefined ? {} : { indexError: saved.error }),
    };
  } catch (error) {
    return {
      evidenceId: artifact.id,
      artifactKey: artifactDedupKey(artifact),
      indexError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Records a refused/failed capture as a gap: `gaps.uncapturable` plus an
 * operation row with `coverage: "none"` and the reason. Best-effort like
 * the success path — index problems are swallowed into the return value
 * because the capture error the caller is about to throw is the primary
 * fact.
 */
export function noteStillCaptureFailure(
  ctx: StillEvidenceContext,
  requestId: string,
  error: unknown,
): { readonly indexError?: string } {
  const reason =
    error instanceof PanelError
      ? `panel.capture refused (${error.code}): ${error.message}`
      : `panel.capture failed: ${error instanceof Error ? error.message : String(error)}`;
  try {
    const index = loadOrCreateIndex(ctx);
    index.noteUncapturable(reason);
    index.recordOperation({
      requestId,
      op: STILL_CAPTURE_OP,
      evidenceRefs: [],
      coverage: "none",
      uncovered: reason,
    });
    const saved = index.save(ctx.artifactsDir);
    return saved.error === undefined ? {} : { indexError: saved.error };
  } catch (indexError) {
    return {
      indexError: indexError instanceof Error ? indexError.message : String(indexError),
    };
  }
}

function traceDetailError(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The `Panel.capture()` wrapper the API layer installs when an evidence
 * context is present: mint the operation's requestId, run the capture,
 * bind the result into the index, and write the trace row carrying
 * `result.evidenceId` (spec §5.3 rule 1). On failure the gap is recorded
 * and the original error rethrown unchanged — evidence never masks the
 * refusal it observed.
 */
export function captureWithStillEvidence(
  capture: () => PanelCapture,
  ctx: StillEvidenceContext,
): PanelCapture {
  const requestId = (ctx.newRequestId ?? nextRequestId)();
  const began = Date.now();
  let result: PanelCapture;
  try {
    result = capture();
  } catch (error) {
    const gap = noteStillCaptureFailure(ctx, requestId, error);
    ctx.trace?.record(STILL_CAPTURE_OP, "error", Date.now() - began, {
      error: traceDetailError(error),
      ...(gap.indexError === undefined
        ? {}
        : { result: { indexError: gap.indexError } }),
    });
    throw error;
  }
  const binding = recordStillCapture(result, ctx, requestId);
  ctx.trace?.record(STILL_CAPTURE_OP, "ok", Date.now() - began, {
    result: {
      evidenceId: binding.evidenceId,
      ...(binding.indexError === undefined ? {} : { indexError: binding.indexError }),
    },
  });
  return result;
}

