/**
 * Render-evidence API glue (#385, `specs/gui-evidence/spec.md` §3.2,
 * §5.3, §5.5; E4 of program #337 / tracking #346).
 *
 * Two surfaces live here:
 *
 *   - `recordRenderedFrameEvidence` / `noteRenderFrameFailureEvidence` —
 *     the binding `Comp.renderFrame` calls around its `session.call`.
 *     The protocol `requestId` is minted inside the driver, so the
 *     binding correlates it back through the session's trace events
 *     (`args.requestId` + `result.path`), exactly like
 *     `traceRowRequestId` does for recording coverage. Everything is
 *     best-effort: evidence never breaks the render it describes.
 *
 *   - `evidenceApiFor` — the `ae.evidence` consumer handoff: read the
 *     `ae-a8n.gui-evidence/v1` document, echo `consumerRefs`
 *     (testId/runId/suite — supplied, never invented), project
 *     artifacts into the ae-test `Artifact` shape, run the same-run
 *     join, and trigger render-output discovery under
 *     `session.artifactsDir`.
 *
 * Session identity mirrors `sessionIdentity` in `./record.ts` — the
 * same proven-or-null fields the recording lifecycle writes, so render
 * artifacts and screen segments land on ONE session block and the
 * same-run join's identity check can compare them.
 */

import type { Session } from "./session.js";
import { evidenceSessionKindFor } from "./record.js";
import type { RenderedFrame } from "./types.js";
import { GuiEvidenceIndex } from "../evidence/index.js";
import {
  consumerArtifacts,
  consumerRefs,
  joinOperationEvidence,
  type ConsumerArtifact,
  type OperationEvidenceJoin,
} from "../evidence/consumer.js";
import {
  discoverRenderArtifacts,
  findRenderFrameErrorTraceEvent,
  findRenderFrameTraceEvent,
  noteRenderFrameFailure,
  recordRenderFrame,
  traceRenderEvidence,
  type RenderEvidenceContext,
  type RenderFrameCallRef,
} from "../evidence/render.js";
import type {
  EvidenceConsumerRefs,
  EvidenceIndexSession,
  GuiEvidenceIndexDocument,
} from "../evidence/types.js";

/**
 * The session identity block for evidence records — mirrors
 * `sessionIdentity` in `./record.ts` (kept local so the two writers
 * stay independently mergeable): proven pid/start identity when the
 * transport attests them, `"unknown"` session kind when nothing proves
 * otherwise — never upgraded.
 */
export function renderEvidenceSession(session: Session): EvidenceIndexSession {
  const driver = session.driver;
  const attestation = driver.hostAttestation();
  const target = driver.recoveryTarget();
  const pid = attestation.pid ?? target?.pid ?? null;
  const owned = attestation.ownedProcess;
  return {
    pid,
    processStartIdentity:
      owned === null
        ? null
        : `pid-start:${owned.startedAt}${owned.identity === undefined ? "" : `:${owned.identity}`}`,
    sessionId: attestation.sessionAsid === null ? null : String(attestation.sessionAsid),
    sessionKind: evidenceSessionKindFor(session),
    sessionRoot: driver.sessionRoot,
    adapter: driver.transportKind,
  };
}

/** The render-evidence context for one session. */
export function renderEvidenceContextFor(session: Session): RenderEvidenceContext {
  return {
    artifactsDir: session.driver.artifactsDir,
    session: renderEvidenceSession(session),
    trace: session.trace,
  };
}

/**
 * Binds a successful `comp.renderFrame` result into the evidence index:
 * finds the driver's trace row for the call (requestId + seq), records
 * the `render-frame` artifact and operation row — joining any covering
 * recording segment for `coverage: "both"` — writes the supplementary
 * `comp.renderFrame.evidence` trace row carrying `result.evidenceId`,
 * and sweeps `artifactsDir` for unindexed render outputs.
 *
 * Never throws and never blocks the render's own result: every failure
 * degrades to an `indexError` on the trace row / index gaps.
 */
export async function recordRenderedFrameEvidence(
  session: Session,
  rendered: RenderedFrame,
  call: RenderFrameCallRef,
): Promise<void> {
  try {
    const ctx = renderEvidenceContextFor(session);
    const traceEvent = findRenderFrameTraceEvent(session.events, rendered);
    const binding = await recordRenderFrame(rendered, ctx, {
      requestId: traceEvent?.requestId ?? null,
      ...(traceEvent?.seq === undefined ? {} : { traceSeq: traceEvent.seq }),
      comp: call.comp,
    });
    traceRenderEvidence(ctx, {
      requestId: traceEvent?.requestId ?? null,
      evidenceId: binding.evidenceId,
      path: rendered.path,
      coverage: binding.coverage,
      ...(binding.indexError === undefined
        ? {}
        : { indexError: binding.indexError }),
    });
    // Automatic discovery: render outputs that landed under
    // artifactsDir without a bound call (render-queue products, files
    // written between sessions) join the index on the next render.
    // Best-effort — a discovery failure never fails the render.
    try {
      await discoverRenderArtifacts(ctx.artifactsDir, ctx);
    } catch {
      // Discovery is a sweep; its problems surface on the next call.
    }
  } catch {
    // Evidence binding must never break the render it describes.
  }
}

/**
 * Records a failed `comp.renderFrame` as an index gap (`uncapturable` +
 * `coverage: "none"` operation row). The driver's own trace row already
 * carries the error; this adds the evidence-side accounting. Never
 * throws.
 */
export function noteRenderFrameFailureEvidence(
  session: Session,
  call: RenderFrameCallRef,
  error: unknown,
): void {
  try {
    const ctx = renderEvidenceContextFor(session);
    const traceEvent = findRenderFrameErrorTraceEvent(session.events, call);
    noteRenderFrameFailure(
      ctx,
      {
        requestId: traceEvent?.requestId ?? null,
        ...(traceEvent?.seq === undefined ? {} : { traceSeq: traceEvent.seq }),
      },
      error,
    );
  } catch {
    // Same rule: evidence never masks the render error being thrown.
  }
}

/* ------------------------------------------------------------------ */
/* `ae.evidence` — the consumer handoff surface                         */
/* ------------------------------------------------------------------ */

/** What `ae.evidence` exposes to consumers (ae-test#145 / ae-devtools#426). */
export type EvidenceApi = {
  /**
   * The current `ae-a8n.gui-evidence/v1` document, or `null` when no
   * index exists yet — a normal first-run state, not an error.
   */
  document(): GuiEvidenceIndexDocument | null;
  /**
   * Echoes caller-supplied consumer identities (`testId`/`runId`/
   * `suite`) onto the index — spec §5.3 rule 5: ae-a8n never invents
   * them, it only stores what the caller passes. Creates the index
   * when absent. Returns the save error, when one occurred.
   */
  setConsumerRefs(refs: EvidenceConsumerRefs): { readonly error?: string };
  /** The `consumerRefs` block as stored, or `null` when never given. */
  consumerRefs(): EvidenceConsumerRefs | null;
  /**
   * The ae-test `Artifact { name, path, bytes, kind }` projection of
   * `artifacts[]` — `render-*` → `"render"`, `"trace"` → `"trace"`,
   * everything else → `"attachment"`.
   */
  consumerArtifacts(): readonly ConsumerArtifact[];
  /**
   * The same-run join for one `requestId` (T003 contract): which
   * Channel-S/Channel-R evidence the index binds, and whether the join
   * is proven (`sameRun.verified`) or honestly unverified with the
   * failing checks named. `null` when no index exists.
   */
  joinOperation(requestId: string): OperationEvidenceJoin | null;
  /**
   * Scans `session.artifactsDir` for render outputs no index artifact
   * references and registers them (`render-frame`, plus
   * `render-sequence` rollups for numbered groups). Returns the added
   * artifact ids, or the discovery error.
   */
  discoverRenderOutputs(): Promise<{
    readonly added: readonly string[];
    readonly error?: string;
  }>;
};

/**
 * The `ae.evidence` API bound to one session. Every read loads the
 * index fresh from disk — the file under
 * `<sessionRoot>/artifacts/evidence-index.json` is the contract
 * consumers (ae-test) share, and this surface is the in-process view
 * of the same document.
 */
export function evidenceApiFor(session: Session): EvidenceApi {
  const load = (): GuiEvidenceIndex | null =>
    GuiEvidenceIndex.load(session.driver.artifactsDir);
  return {
    document: () => load()?.document ?? null,
    setConsumerRefs: (refs) => {
      try {
        const ctx = renderEvidenceContextFor(session);
        const index =
          load() ?? GuiEvidenceIndex.create(ctx.session);
        index.setConsumerRefs(refs);
        const saved = index.save(ctx.artifactsDir);
        return saved.error === undefined ? {} : { error: saved.error };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    consumerRefs: () => {
      const doc = load()?.document ?? null;
      return doc === null ? null : consumerRefs(doc);
    },
    consumerArtifacts: () => {
      const doc = load()?.document ?? null;
      return doc === null ? [] : consumerArtifacts(doc);
    },
    joinOperation: (requestId) => {
      const doc = load()?.document ?? null;
      return doc === null ? null : joinOperationEvidence(doc, requestId);
    },
    discoverRenderOutputs: async () => {
      try {
        const ctx = renderEvidenceContextFor(session);
        const result = await discoverRenderArtifacts(ctx.artifactsDir, ctx);
        return result.error === undefined
          ? { added: result.added }
          : { added: result.added, error: result.error };
      } catch (error) {
        return {
          added: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
