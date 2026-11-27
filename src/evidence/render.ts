/**
 * Render-channel evidence binding — `render-frame` / `render-sequence`
 * `EvidenceArtifact` records for AE-produced output (#385, parent
 * program #337 US-B4 / tracking #346, spec `specs/gui-evidence/spec.md`
 * §3.2, §5.1, §5.3, §5.5; slice E4).
 *
 * This module does NOT render anything: `comp.renderFrame` in
 * `src/api/entities.ts` remains the single render vehicle (the host's
 * `saveFrameToPng` path). What happens here is the Channel-R half of
 * the evidence contract — a successful render becomes an index artifact
 * (`producer: "ae-render"`, a reference with path + sha256 + bytes,
 * never a copy), the render operation gets an `operations[]` row whose
 * `evidenceRefs` link the artifact — and any recording segment whose
 * time window covers the render, so `coverage: "both"` is computable —
 * and the artifact's `operationIds` bind the protocol `requestId` the
 * driver's trace row carries.
 *
 * Channel separation (spec §3): a `render-*` artifact proves what AE
 * produced; it carries no `scope`/`leakage` (those are screen-capture
 * concepts) and never claims a GUI operation succeeded. The coexistence
 * rule (§3.3) is honored by linking, not blending: one operation row can
 * reference a screen segment and a render artifact, and the consumer
 * cites both refs.
 *
 * Honesty rules (same posture as `stills.ts`/`recording.ts`):
 *
 *   - A failed render is a first-class gap: `gaps.uncapturable` plus an
 *     operation row with `coverage: "none"` and an `uncovered` reason.
 *   - An index that cannot be loaded or written does not break the
 *     render: the error is returned to the caller, never thrown.
 *   - `operationIds` binds the requestId found on the driver's trace
 *     row — never an invented id. When no trace row correlates, the
 *     artifact is still recorded (the file exists) with empty
 *     `operationIds` and a `gaps.unrecorded` note.
 *   - Discovery (`discoverRenderArtifacts`) only registers files that
 *     match the `comp.renderFrame` output naming contract
 *     (`<prefix>.<digits>.png`); arbitrary render-queue outputs are NOT
 *     guessed — they need the same naming or an explicit record call.
 *
 * Level: `automated test` — file I/O in the session artifacts dir and
 * pure mapping; no OS calls, no After Effects.
 */

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync, type Dirent } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { errorMessage } from "../errors.js";
import type { TraceRecorder } from "../trace/trace.js";
import { artifactDedupKey, GuiEvidenceIndex, type EvidenceTraceRow } from "./index.js";
import { artifactRelativePath } from "./stills.js";
import { operationCoverage } from "./correlate.js";
import type {
  EvidenceArtifact,
  EvidenceCoverage,
  EvidenceIndexSession,
  EvidenceKind,
  EvidenceOperation,
} from "./types.js";

/** The protocol op name `comp.renderFrame` records under. */
export const RENDER_FRAME_OP = "comp.renderFrame";
/**
 * The supplementary trace op that carries `result.evidenceId` back to
 * the render's own trace row (the driver already wrote the
 * `comp.renderFrame` row, so the binding lands as a follow-up record —
 * same pattern as `menu.execute.scene`).
 */
export const RENDER_EVIDENCE_OP = "comp.renderFrame.evidence";

/** Everything the render binder needs; assembled once per call site. */
export type RenderEvidenceContext = {
  /**
   * The session artifacts directory — the index lives at
   * `<artifactsDir>/evidence-index.json` and render outputs are expected
   * under it (the default `renderFrame` outputDir IS this directory).
   */
  readonly artifactsDir: string;
  /** The session identity block written onto the index on creation. */
  readonly session: EvidenceIndexSession;
  /** Session trace recorder; the evidence-binding row lands here. */
  readonly trace?: Pick<TraceRecorder, "record">;
  /**
   * Trace rows for requestId correlation and segment coverage checks.
   * When absent, correlation relies on the in-memory event scan the API
   * layer performs before calling in.
   */
  readonly listTraceRows?: () => readonly EvidenceTraceRow[];
  /** Clock seams for deterministic tests. */
  readonly now?: () => Date;
  /** Monotonic clock in ms (`performance.now()`-shaped); null-able seam. */
  readonly monoNow?: () => number;
  /** sha256+bytes of the rendered file; defaults to a streaming hash. */
  readonly hashFile?: (
    path: string,
  ) => Promise<{ readonly sha256: string; readonly bytes: number | null }>;
};

/** The render output shape `comp.renderFrame` resolves to (structural). */
export type RenderedFrameRef = {
  readonly path: string;
  readonly frame: number;
  readonly width: number;
  readonly height: number;
};

function isoNow(ctx: RenderEvidenceContext): { epoch: string; epochMs: number } {
  const date = (ctx.now ?? (() => new Date()))();
  return { epoch: date.toISOString(), epochMs: date.getTime() };
}

function monoNow(ctx: RenderEvidenceContext): number | null {
  if (ctx.monoNow !== undefined) {
    return ctx.monoNow();
  }
  try {
    return performance.now();
  } catch {
    return null;
  }
}

async function hashFileStreaming(
  path: string,
): Promise<{ sha256: string; bytes: number | null }> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * The minimal trace-event shape the render correlator needs. `TraceEvent`
 * from `src/trace/trace.ts` is structurally assignable.
 */
export type RenderTraceEventLike = {
  readonly seq?: number;
  readonly op: string;
  readonly status: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly result?: Readonly<Record<string, unknown>>;
};

/**
 * Whether a trace event is the `comp.renderFrame` call that produced
 * `rendered`: same op, a string `requestId` in args, and — when the
 * result summary carries `path`/`frame` — matching values. The path
 * match is the strong join: each render writes a distinct file.
 */
export function isRenderFrameTraceEvent(
  event: RenderTraceEventLike,
  rendered: RenderedFrameRef,
): boolean {
  if (event.op !== RENDER_FRAME_OP || event.status !== "ok") {
    return false;
  }
  if (typeof event.args?.requestId !== "string") {
    return false;
  }
  if (typeof event.result?.path === "string" && event.result.path !== rendered.path) {
    return false;
  }
  if (typeof event.args?.frame === "number" && event.args.frame !== rendered.frame) {
    return false;
  }
  return true;
}

/**
 * Finds the trace event for a successful `comp.renderFrame`, scanning
 * newest-first so a re-render of the same comp/frame (same output path)
 * binds the LATEST call — the one that just resolved.
 */
export function findRenderFrameTraceEvent(
  events: readonly RenderTraceEventLike[],
  rendered: RenderedFrameRef,
): { readonly requestId: string; readonly seq?: number } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (isRenderFrameTraceEvent(event, rendered)) {
      return {
        requestId: event.args!.requestId as string,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      };
    }
  }
  return null;
}

/** What a failed render's trace match needs: the call's identity args. */
export type RenderFrameCallRef = {
  readonly comp: string;
  readonly frame: number;
  readonly outputDir?: string;
};

/**
 * Finds the failed `comp.renderFrame` trace event for `call`, scanning
 * newest-first. Matches on the call args (`comp`, `frame`, and
 * `outputDir` when the caller knows it) since an error row carries no
 * result path.
 */
export function findRenderFrameErrorTraceEvent(
  events: readonly RenderTraceEventLike[],
  call: RenderFrameCallRef,
): { readonly requestId: string; readonly seq?: number } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.op !== RENDER_FRAME_OP || event.status === "ok") {
      continue;
    }
    const args = event.args;
    if (typeof args?.requestId !== "string") {
      continue;
    }
    if (args.comp !== call.comp || args.frame !== call.frame) {
      continue;
    }
    if (
      call.outputDir !== undefined &&
      typeof args.outputDir === "string" &&
      args.outputDir !== call.outputDir
    ) {
      continue;
    }
    return {
      requestId: args.requestId,
      ...(event.seq === undefined ? {} : { seq: event.seq }),
    };
  }
  return null;
}

/**
 * Recording segments whose `[t0EpochMs, endEpochMs]` window covers
 * `epochMs` — open segments (`endEpochMs === null`) count as covering:
 * the segment exists in the index and its artifact lands at finalize.
 * This is the Channel-S half of the coexistence join (spec §3.3): the
 * segment id joins the render operation's `evidenceRefs` so
 * `coverage: "both"` is computable.
 */
export function coveringSegments(
  segments: readonly {
    readonly id: string;
    readonly t0EpochMs: number;
    readonly endEpochMs: number | null;
  }[],
  epochMs: number,
): readonly string[] {
  return segments
    .filter(
      (segment) =>
        segment.t0EpochMs <= epochMs &&
        (segment.endEpochMs === null || segment.endEpochMs >= epochMs),
    )
    .map((segment) => segment.id);
}

/**
 * Builds the `render-frame` `EvidenceArtifact` for a successful
 * `comp.renderFrame`. Pure mapping except the file hash — no I/O beyond
 * the optional `hashFile` seam.
 */
export async function buildRenderArtifact(
  rendered: RenderedFrameRef,
  ctx: RenderEvidenceContext,
  requestId: string | null,
): Promise<EvidenceArtifact> {
  const { epoch, epochMs } = isoNow(ctx);
  const host = {
    pid: ctx.session.pid,
    processStartIdentity: ctx.session.processStartIdentity,
    sessionId: ctx.session.sessionId,
    sessionKind: ctx.session.sessionKind,
  };
  let sha256: string | null = null;
  let sha256Error: string | undefined;
  let bytes: number | null = null;
  let unavailable: { reason: string } | undefined;
  try {
    const hashed = await (ctx.hashFile ?? hashFileStreaming)(rendered.path);
    sha256 = hashed.sha256;
    bytes = hashed.bytes;
  } catch (error) {
    sha256Error = `sha256 failed: ${errorMessage(error)}`;
    unavailable = {
      reason: `render output could not be hashed at bind time: ${errorMessage(error)}`,
    };
  }
  return {
    id: `render-${requestId ?? "unbound"}-${rendered.frame}`,
    kind: "render-frame",
    role: "original",
    // Reference, never a copy: the path is the producer's own output.
    path: artifactRelativePath(ctx.artifactsDir, rendered.path),
    sha256,
    ...(sha256Error === undefined ? {} : { sha256Error }),
    bytes,
    session: host,
    // Channel R carries no CaptureScope/leakage — those are screen
    // concepts (spec §3.2). The artifact proves render output only.
    time: {
      capturedAt: epoch,
      t0EpochMs: epochMs,
      t0MonoMs: monoNow(ctx),
      durationMs: null,
      endEpochMs: null,
    },
    geometry: {
      widthPx: rendered.width,
      heightPx: rendered.height,
      coordinateSpace: "pixels-top-left",
    },
    provenance: { producer: "ae-render", tool: "a8n-host comp.renderFrame" },
    operationIds: requestId === null ? [] : [requestId],
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

/**
 * Resolves the artifact record to store when content deduplication
 * applies — same rule as stills: two renders of identical pixels share
 * a sha256, the index keeps ONE record, and the surviving artifact's id
 * (the one earlier trace rows already point at) is preserved while
 * operation ids union.
 */
function dedupedRenderArtifact(
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

export type RenderBindingResult = {
  /** The artifact id the operation row's `evidenceRefs` points at. */
  readonly evidenceId: string;
  /** The dedup key the artifact was stored under (sha256 or id). */
  readonly artifactKey: string;
  /** Recording segment ids joined into `evidenceRefs` (Channel S). */
  readonly coveringSegmentIds: readonly string[];
  /** The coverage verdict stored on the operation row. */
  readonly coverage: EvidenceCoverage;
  /** Index write failure, when the index could not be persisted. */
  readonly indexError?: string;
};

function loadOrCreateIndex(ctx: RenderEvidenceContext): GuiEvidenceIndex {
  return (
    GuiEvidenceIndex.load(ctx.artifactsDir) ??
    GuiEvidenceIndex.create(ctx.session, { now: isoNow(ctx).epoch })
  );
}

/**
 * Records a successful `comp.renderFrame` into the session evidence
 * index: `render-frame` artifact append (sha256-deduplicated, covering
 * segments joined for `coverage: "both"`), the render operation's
 * `operations[]` row, and an atomic save. `requestId`/`traceSeq` are
 * the driver's own ids found on the trace row — pass `null` requestId
 * when no trace row correlated (the artifact is still recorded, with a
 * `gaps.unrecorded` note, never an invented id).
 *
 * Never throws — an index failure is reported in `indexError`.
 */
export async function recordRenderFrame(
  rendered: RenderedFrameRef,
  ctx: RenderEvidenceContext,
  binding: {
    readonly requestId: string | null;
    readonly traceSeq?: number;
    readonly comp?: string;
  },
): Promise<RenderBindingResult> {
  const artifact = await buildRenderArtifact(rendered, ctx, binding.requestId);
  const { epochMs } = isoNow(ctx);
  try {
    const index = loadOrCreateIndex(ctx);
    const merged = dedupedRenderArtifact(artifact, index.document.artifacts);
    const key = index.addArtifact(merged);

    const segmentIds = coveringSegments(index.document.segments, epochMs);
    const refs = [merged.id, ...segmentIds];
    // Coverage is computed from the kinds the refs resolve to: the
    // render artifact is Channel R; every covering segment is Channel S.
    const kinds: EvidenceKind[] = ["render-frame"];
    for (let i = 0; i < segmentIds.length; i += 1) {
      kinds.push("screen-recording");
    }
    const coverage = operationCoverage(kinds);

    if (binding.requestId === null) {
      index.noteUnrecorded(
        `render-frame ${artifact.path}: no trace row carried a requestId ` +
          "for this render; the artifact is recorded unbound",
      );
    } else {
      const operation: EvidenceOperation = {
        requestId: binding.requestId,
        ...(binding.traceSeq === undefined ? {} : { traceSeq: binding.traceSeq }),
        op: RENDER_FRAME_OP,
        evidenceRefs: refs,
        coverage,
      };
      index.recordOperation(operation);
    }
    const saved = index.save(ctx.artifactsDir);
    return {
      evidenceId: merged.id,
      artifactKey: key,
      coveringSegmentIds: segmentIds,
      coverage,
      ...(saved.error === undefined ? {} : { indexError: saved.error }),
    };
  } catch (error) {
    return {
      evidenceId: artifact.id,
      artifactKey: artifactDedupKey(artifact),
      coveringSegmentIds: [],
      coverage: "render",
      indexError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Records a failed `comp.renderFrame` as a gap: `gaps.uncapturable` plus
 * an operation row with `coverage: "none"` and the reason — a render
 * that produced no output is explicit absence, never silence.
 * Best-effort like the success path.
 */
export function noteRenderFrameFailure(
  ctx: RenderEvidenceContext,
  binding: {
    readonly requestId: string | null;
    readonly traceSeq?: number;
  },
  error: unknown,
): { readonly indexError?: string } {
  const reason = `comp.renderFrame failed: ${error instanceof Error ? error.message : String(error)}`;
  try {
    const index = loadOrCreateIndex(ctx);
    index.noteUncapturable(reason);
    index.recordOperation({
      ...(binding.requestId === null
        ? { requestId: `render-failed-${isoNow(ctx).epochMs}` }
        : { requestId: binding.requestId }),
      ...(binding.traceSeq === undefined ? {} : { traceSeq: binding.traceSeq }),
      op: RENDER_FRAME_OP,
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

/** Writes the supplementary trace row carrying `result.evidenceId`. */
export function traceRenderEvidence(
  ctx: RenderEvidenceContext,
  binding: {
    readonly requestId: string | null;
    readonly evidenceId: string;
    readonly path: string;
    readonly coverage?: EvidenceCoverage;
    readonly indexError?: string;
  },
): void {
  try {
    ctx.trace?.record(RENDER_EVIDENCE_OP, "ok", 0, {
      args: {
        ...(binding.requestId === null ? {} : { requestId: binding.requestId }),
      },
      result: {
        evidenceId: binding.evidenceId,
        path: binding.path,
        ...(binding.coverage === undefined ? {} : { coverage: binding.coverage }),
        ...(binding.indexError === undefined ? {} : { indexError: binding.indexError }),
      },
    });
  } catch {
    // A trace failure must never break the render it describes.
  }
}

/* ------------------------------------------------------------------ */
/* Discovery — render outputs that landed without a bound call          */
/* ------------------------------------------------------------------ */

/**
 * The `comp.renderFrame` output naming contract: `<prefix>.<digits>.png`
 * where digits is the zero-padded frame (`zeroPad(frame, 5)` in the
 * host). Only this pattern is discovered — arbitrary render-queue
 * outputs are NOT guessed into the index.
 */
const RENDER_FRAME_NAME = /\.(\d{5,})\.png$/i;

const DISCOVERY_MAX_DEPTH = 4;
const SKIP_DIRS = new Set(["recordings", "panels", "diagnostics"]);

function* walkRenderCandidates(
  dir: string,
  depth: number,
): Generator<string> {
  if (depth > DISCOVERY_MAX_DEPTH) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walkRenderCandidates(full, depth + 1);
      }
    } else if (entry.isFile() && RENDER_FRAME_NAME.test(entry.name)) {
      yield full;
    }
  }
}

function isAbsoluteish(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Absolute path an artifact `path` resolves to under `artifactsDir`.
 * Artifact paths are recorded relative (POSIX separators) but the
 * relative-path fallback in `artifactRelativePath` can store an
 * absolute path — both forms resolve correctly here.
 */
export function resolveArtifactPath(artifactsDir: string, artifactPath: string): string {
  if (isAbsoluteish(artifactPath)) {
    return artifactPath;
  }
  return join(artifactsDir, ...artifactPath.split("/"));
}

export type RenderDiscoveryResult = {
  /** Artifact ids newly added to the index (frames + sequences). */
  readonly added: readonly string[];
  /** Files skipped because the index already references them. */
  readonly alreadyIndexed: number;
  /** Non-fatal problem, when discovery itself failed. */
  readonly error?: string;
};

/**
 * Discovers render outputs under `artifactsDir` that no index artifact
 * references yet and registers them: each `<prefix>.<NNNNN>.png` file
 * becomes a `render-frame` artifact, and a group of ≥2 files sharing a
 * directory + prefix additionally becomes one `render-sequence`
 * artifact (path = the containing directory, per-frame hashes stay on
 * the member artifacts — the sequence record itself honestly carries
 * `sha256: null`). Discovered files have empty `operationIds` unless a
 * trace row correlates — and each is noted `orphaned`, because a render
 * output without its producing operation is exactly the gap the index
 * exists to surface.
 *
 * This is the `session.artifactsDir` discoverability path ae-test's
 * `collectRenders` relies on (spec §4.3/§5.5): outputs directed there
 * appear in the index without the consumer knowing the layout.
 * Best-effort: never throws.
 */
export async function discoverRenderArtifacts(
  artifactsDir: string,
  ctx: RenderEvidenceContext,
): Promise<RenderDiscoveryResult> {
  try {
    const index = loadOrCreateIndex(ctx);
    const indexedPaths = new Set(
      index.document.artifacts
        .filter((a) => a.kind === "render-frame" || a.kind === "render-sequence")
        .map((a) => resolveArtifactPath(artifactsDir, a.path)),
    );
    const { epoch, epochMs } = isoNow(ctx);
    const host = {
      pid: ctx.session.pid,
      processStartIdentity: ctx.session.processStartIdentity,
      sessionId: ctx.session.sessionId,
      sessionKind: ctx.session.sessionKind,
    };
    const added: string[] = [];
    let alreadyIndexed = 0;
    // Group key → member absolute paths, for sequence detection.
    const groups = new Map<string, string[]>();

    for (const file of walkRenderCandidates(artifactsDir, 0)) {
      if (indexedPaths.has(file)) {
        alreadyIndexed += 1;
        continue;
      }
      indexedPaths.add(file);
      const info = statSync(file, { throwIfNoEntry: false });
      if (info === undefined || !info.isFile()) {
        continue;
      }
      let sha256: string | null = null;
      let sha256Error: string | undefined;
      let bytes: number | null = null;
      try {
        const hashed = await (ctx.hashFile ?? hashFileStreaming)(file);
        sha256 = hashed.sha256;
        bytes = hashed.bytes;
      } catch (error) {
        sha256Error = `sha256 failed: ${errorMessage(error)}`;
      }
      const base = basename(file);
      const stem = base.replace(RENDER_FRAME_NAME, "");
      const dir = dirname(file);
      const groupKey = `${dir}\u0000${stem}`;
      const members = groups.get(groupKey) ?? [];
      members.push(file);
      groups.set(groupKey, members);

      const artifact: EvidenceArtifact = {
        // Path-derived id: deterministic across re-discovery so the
        // index dedupes by id even when hashing fails (sha256 null →
        // id dedup key).
        id: `render-${artifactRelativePath(artifactsDir, file)}`
          .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
          .slice(0, 120),
        kind: "render-frame",
        role: "original",
        path: artifactRelativePath(artifactsDir, file),
        sha256,
        ...(sha256Error === undefined ? {} : { sha256Error }),
        bytes,
        session: host,
        time: {
          capturedAt: epoch,
          t0EpochMs: epochMs,
          t0MonoMs: monoNow(ctx),
          durationMs: null,
          endEpochMs: null,
        },
        provenance: { producer: "ae-render", tool: "a8n render discovery" },
        operationIds: [],
      };
      index.addArtifact(artifact);
      index.noteOrphaned(artifact.id);
      added.push(artifact.id);
    }

    // Sequence rollup: ≥2 discovered frames sharing dir+prefix are one
    // render job's numbered output.
    for (const [groupKey, members] of groups) {
      if (members.length < 2) {
        continue;
      }
      const [dir, stem] = groupKey.split("\u0000") as [string, string];
      // `relative` yields "" for the artifacts dir itself; "." is the
      // honest relative path for "the whole artifacts root". Separators
      // normalize to `/` like every artifact path in the index.
      const relDirRaw = relative(artifactsDir, dir).split(sep).join("/");
      const relDir = relDirRaw === "" ? "." : relDirRaw;
      const sequenceId = `render-seq-${relDir}-${stem}`
        .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
        .slice(0, 120);
      const memberArtifacts = members.map((member) =>
        index.document.artifacts.find(
          (a) => a.kind === "render-frame" && resolveArtifactPath(artifactsDir, a.path) === member,
        ),
      );
      const totalBytes = memberArtifacts.reduce(
        (sum, a) => sum + (a?.bytes ?? 0),
        0,
      );
      const sequence: EvidenceArtifact = {
        id: sequenceId,
        kind: "render-sequence",
        role: "original",
        path: relDir,
        sha256: null,
        sha256Error:
          "sequence container: member frames carry individual sha256 " +
          "on their render-frame artifacts",
        bytes: totalBytes === 0 ? null : totalBytes,
        session: host,
        time: {
          capturedAt: epoch,
          t0EpochMs: epochMs,
          t0MonoMs: monoNow(ctx),
          durationMs: null,
          endEpochMs: null,
        },
        provenance: { producer: "ae-render", tool: "a8n render discovery" },
        operationIds: [
          ...new Set(
            memberArtifacts.flatMap((a) => a?.operationIds ?? []),
          ),
        ],
      };
      index.addArtifact(sequence);
      added.push(sequenceId);
    }

    const saved = index.save(ctx.artifactsDir);
    if (saved.error !== undefined) {
      return { added, alreadyIndexed, error: saved.error };
    }
    return { added, alreadyIndexed };
  } catch (error) {
    return {
      added: [],
      alreadyIndexed: 0,
      error: errorMessage(error),
    };
  }
}
