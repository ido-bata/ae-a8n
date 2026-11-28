/**
 * Consumer handoff — render-evidence join and the ae-test `Artifact`
 * mapping (#385, spec `specs/gui-evidence/spec.md` §3.3, §5.3, §5.5;
 * E4 of program #337 / tracking #346).
 *
 * Two contracts live here, both pure functions over the
 * `ae-a8n.gui-evidence/v1` document:
 *
 *   - `joinOperationEvidence` — the same-run verification query
 *     (T003 contract side): given a `requestId`, answer which Channel-S
 *     (screen) and Channel-R (render) evidence the index binds to it,
 *     and whether the join is *proven* — segment time window +
 *     requestId + session identity — or honestly `verified: false`
 *     with the failing checks named. An unproven join is reported as
 *     unproven; nothing here upgrades a guess into a fact.
 *   - `consumerArtifacts` — the ae-test `Artifact { name, path, bytes,
 *     kind }` mapping (ae-test#145) plus the `consumerRefs` echo
 *     contract (spec §5.3 rule 5): ae-a8n echoes caller-supplied
 *     `testId`/`runId`/`suite`, it never invents them.
 *
 * Channel separation is preserved end-to-end: `render-*` artifacts map
 * to consumer kind `"render"`, screen artifacts map to `"attachment"`
 * (ae-test has no screen-evidence kind — they are stored, not asserted
 * as render correctness), and a consumer asserting "GUI op → render
 * result" must cite BOTH the segment/still ref and the render ref —
 * `joinOperationEvidence` returns them separately for exactly that.
 *
 * Level: pure contract — no I/O, no OS calls.
 */

import { isAbsolute, join } from "node:path";

import type {
  EvidenceArtifact,
  EvidenceConsumerRefs,
  EvidenceCoverage,
  EvidenceKind,
  EvidenceOperation,
  EvidenceSegment,
  GuiEvidenceIndexDocument,
} from "./types.js";

/* ------------------------------------------------------------------ */
/* Same-run join — T003 contract                                        */
/* ------------------------------------------------------------------ */

const SCREEN_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "screen-still",
  "screen-recording",
]);
const RENDER_KINDS: ReadonlySet<EvidenceKind> = new Set([
  "render-frame",
  "render-sequence",
]);

/** One named check inside `sameRun.checks`. */
export type OperationEvidenceCheck = {
  readonly name: string;
  readonly ok: boolean;
  /** Why the check passed or what is missing — always populated. */
  readonly detail: string;
};

/**
 * The same-run verdict for one operation. `verified` is true only when
 * every check passed: an operation row exists, render-channel evidence
 * is bound, screen-channel evidence is bound by a CLOSED segment (or a
 * still) covering the operation, and the bound artifacts prove the same
 * session identity as the index itself. Anything less is `verified:
 * false` with the failing checks spelled out — the honest "unverified"
 * the issue requires.
 */
export type OperationEvidenceJoin = {
  readonly requestId: string;
  /** The index `operations[]` row, when one exists. */
  readonly operation: EvidenceOperation | null;
  /** Channel-R artifacts bound to this operation. */
  readonly renderArtifacts: readonly EvidenceArtifact[];
  /** Channel-S artifacts bound to this operation. */
  readonly screenArtifacts: readonly EvidenceArtifact[];
  /** Segments whose `operationIds` or time window cover this op. */
  readonly segments: readonly EvidenceSegment[];
  /** The operation row's stored coverage verdict, when a row exists. */
  readonly coverage: EvidenceCoverage | null;
  readonly sameRun: {
    readonly verified: boolean;
    readonly checks: readonly OperationEvidenceCheck[];
  };
};

function artifactById(
  doc: GuiEvidenceIndexDocument,
  id: string,
): EvidenceArtifact | undefined {
  return doc.artifacts.find((a) => a.id === id);
}

function epochOf(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whether `segment` covers `epochMs`: its `[t0EpochMs, endEpochMs]`
 * window contains the instant. An open segment (`endEpochMs === null`)
 * covers only up to "now" — reported via `open`, never counted as a
 * completed cover.
 */
function segmentCoversEpoch(
  segment: EvidenceSegment,
  epochMs: number,
): { readonly covers: boolean; readonly open: boolean } {
  const open = segment.endEpochMs === null;
  const end = segment.endEpochMs ?? Number.POSITIVE_INFINITY;
  return {
    covers: segment.t0EpochMs <= epochMs && epochMs <= end,
    open,
  };
}

/**
 * The latest epoch a render artifact claims (`time.capturedAt`, falling
 * back to `t0EpochMs`). `null` when the artifact carries no usable
 * timestamp — such an artifact cannot time-join a segment.
 */
function artifactEpoch(artifact: EvidenceArtifact): number | null {
  return epochOf(artifact.time.capturedAt) ?? artifact.time.t0EpochMs;
}

/**
 * Session-identity agreement between an artifact and the index's own
 * session block. Only fields proven on BOTH sides are compared; when
 * no field overlaps the answer is "unproven", not "match".
 */
function sessionIdentityCheck(
  doc: GuiEvidenceIndexDocument,
  artifact: EvidenceArtifact,
): { readonly ok: boolean; readonly detail: string } {
  const pairs: readonly [string, string | number | null, string | number | null][] = [
    ["pid", doc.session.pid, artifact.session.pid],
    [
      "processStartIdentity",
      doc.session.processStartIdentity,
      artifact.session.processStartIdentity,
    ],
    ["sessionId", doc.session.sessionId, artifact.session.sessionId],
    ["sessionKind", doc.session.sessionKind, artifact.session.sessionKind],
  ];
  const compared: string[] = [];
  for (const [name, indexValue, artifactValue] of pairs) {
    if (indexValue === null || artifactValue === null) {
      continue;
    }
    compared.push(name);
    if (indexValue !== artifactValue) {
      return {
        ok: false,
        detail: `artifact session.${name} ${JSON.stringify(artifactValue)} ` +
          `differs from the index session ${JSON.stringify(indexValue)}`,
      };
    }
  }
  if (compared.length === 0) {
    return {
      ok: false,
      detail: "no session identity field is proven on both the artifact " +
        "and the index — same-run is unproven",
    };
  }
  return {
    ok: true,
    detail: `session identity agrees on ${compared.join(", ")}`,
  };
}

/**
 * The same-run join for one `requestId` (spec §5.3 rules 2–3, T003):
 *
 *   1. The index `operations[]` row for the requestId — absent means
 *      the operation ran unrecorded; that is reported, not hidden.
 *   2. Channel split: `evidenceRefs` resolve to `render-*` (Channel R)
 *      and `screen-*`/segment (Channel S) artifacts separately — the
 *      coexistence rule keeps them distinct claims.
 *   3. Screen coverage: a segment counts when its `operationIds` lists
 *      the requestId (the `record.stop`-computed answer) OR its time
 *      window covers a bound render artifact's `capturedAt`. An OPEN
 *      segment (`endEpochMs === null`) never satisfies the check —
 *      coverage is provisional until finalize (spec §5.3 rule 3).
 *   4. Session identity: every bound artifact must agree with the
 *      index session on at least one proven field, with no proven
 *      field disagreeing.
 *
 * `verified` requires all checks; each check's `detail` says what was
 * found or what is missing.
 */
export function joinOperationEvidence(
  doc: GuiEvidenceIndexDocument,
  requestId: string,
): OperationEvidenceJoin {
  const operation =
    doc.operations.find((o) => o.requestId === requestId) ?? null;

  const refIds = new Set<string>(operation?.evidenceRefs ?? []);
  // Segments bound by their own operationIds join even when the
  // operation row's evidenceRefs were never written (e.g. the op row
  // predates segment finalize).
  const candidateSegments = doc.segments.filter(
    (segment) =>
      refIds.has(segment.id) || segment.operationIds.includes(requestId),
  );

  const renderArtifacts: EvidenceArtifact[] = [];
  const screenArtifacts: EvidenceArtifact[] = [];
  const seen = new Set<string>();
  const pushArtifact = (artifact: EvidenceArtifact | undefined): void => {
    if (artifact === undefined || seen.has(artifact.id)) {
      return;
    }
    seen.add(artifact.id);
    if (RENDER_KINDS.has(artifact.kind)) {
      renderArtifacts.push(artifact);
    } else if (SCREEN_KINDS.has(artifact.kind)) {
      screenArtifacts.push(artifact);
    }
    // "trace"/"index"/"derived-tool" kinds are channel-neutral
    // bookkeeping — they never upgrade either channel.
  };
  for (const ref of refIds) {
    pushArtifact(artifactById(doc, ref));
  }
  // A render artifact can also bind the requestId through its own
  // `operationIds` without an operation row ref (defensive join).
  for (const artifact of doc.artifacts) {
    if (
      artifact.operationIds.includes(requestId) &&
      (RENDER_KINDS.has(artifact.kind) || SCREEN_KINDS.has(artifact.kind))
    ) {
      pushArtifact(artifact);
    }
  }

  // Time-window join: a segment covers the operation when it lists the
  // requestId, or when its window covers a bound render artifact's
  // capturedAt (the render happened while the screen was recording).
  const segments: EvidenceSegment[] = [];
  const renderEpochs = renderArtifacts
    .map(artifactEpoch)
    .filter((ms): ms is number => ms !== null);
  for (const segment of doc.segments) {
    if (candidateSegments.includes(segment)) {
      segments.push(segment);
      continue;
    }
    const windowHit = renderEpochs.some((ms) => {
      const { covers } = segmentCoversEpoch(segment, ms);
      return covers;
    });
    if (windowHit) {
      segments.push(segment);
    }
  }

  const checks: OperationEvidenceCheck[] = [];

  checks.push(
    operation === null
      ? {
          name: "operation-row",
          ok: false,
          detail: `no operations[] row for requestId ${requestId} — the ` +
            "operation ran unrecorded or the index predates it",
        }
      : {
          name: "operation-row",
          ok: true,
          detail: `operations[] row found (op=${operation.op}, ` +
            `coverage=${operation.coverage})`,
        },
  );

  checks.push(
    renderArtifacts.length === 0
      ? {
          name: "render-channel",
          ok: false,
          detail: "no render-frame/render-sequence artifact is bound " +
            "to this requestId — Channel R is unproven",
        }
      : {
          name: "render-channel",
          ok: true,
          detail: `${renderArtifacts.length} render artifact(s) bound: ` +
            renderArtifacts.map((a) => a.id).join(", "),
        },
  );

  // Screen channel: satisfied by a bound screen-still, or by a CLOSED
  // segment covering the op. An open segment is listed but fails the
  // check — provisional coverage is not proof (spec §5.3 rule 3).
  const closedCovering = segments.filter(
    (segment) => segment.endEpochMs !== null,
  );
  const openCovering = segments.filter(
    (segment) => segment.endEpochMs === null,
  );
  const screenOk =
    screenArtifacts.length > 0 ||
    closedCovering.some(
      (segment) =>
        segment.operationIds.includes(requestId) ||
        renderEpochs.some((ms) => segmentCoversEpoch(segment, ms).covers),
    );
  checks.push({
    name: "screen-channel",
    ok: screenOk,
    detail: screenOk
      ? `${screenArtifacts.length} screen artifact(s), ` +
        `${closedCovering.length} closed covering segment(s)` +
        (openCovering.length > 0
          ? `; ${openCovering.length} segment(s) still open (provisional)`
          : "")
      : screenArtifacts.length === 0 && closedCovering.length === 0
        ? "no screen-still and no closed segment covers this requestId" +
          (openCovering.length > 0
            ? ` — ${openCovering.length} segment(s) still open, coverage provisional`
            : "")
        : "bound segments exist but none closed covers this requestId",
  });

  // Session identity across every bound artifact (render + screen).
  const bound = [...renderArtifacts, ...screenArtifacts];
  if (bound.length === 0) {
    checks.push({
      name: "session-identity",
      ok: false,
      detail: "no artifacts are bound, so same-session is unproven",
    });
  } else {
    const mismatches = bound
      .map((artifact) => sessionIdentityCheck(doc, artifact))
      .filter((result) => !result.ok);
    checks.push(
      mismatches.length === 0
        ? {
            name: "session-identity",
            ok: true,
            detail: `all ${bound.length} bound artifact(s) agree with ` +
              "the index session identity",
          }
        : {
            name: "session-identity",
            ok: false,
            detail: mismatches.map((m) => m.detail).join("; "),
          },
    );
  }

  const verified = checks.every((check) => check.ok);
  return {
    requestId,
    operation,
    renderArtifacts,
    screenArtifacts,
    segments,
    coverage: operation?.coverage ?? null,
    sameRun: { verified, checks },
  };
}

/* ------------------------------------------------------------------ */
/* ae-test consumer mapping (ae-test#145)                               */
/* ------------------------------------------------------------------ */

/**
 * The consumer-side artifact kind — structurally identical to ae-test's
 * `Artifact.kind` (`"render" | "trace" | "attachment" | "diff"`). ae-a8n
 * never emits `"diff"`; that is the consumer's own product.
 */
export type ConsumerArtifactKind = "render" | "trace" | "attachment" | "diff";

/**
 * One artifact as ae-test consumes it: `name` is the index artifact id
 * (what `evidenceRefs` cite), `path` the artifact's recorded path,
 * `bytes` the recorded size (`null` when unknown), `kind` the mapped
 * consumer kind, and `absolutePath` the resolved location under the
 * session artifacts dir when it can be proven.
 */
export type ConsumerArtifact = {
  readonly name: string;
  readonly path: string;
  readonly bytes: number | null;
  readonly kind: ConsumerArtifactKind;
  readonly absolutePath?: string;
};

/**
 * Maps an index `EvidenceKind` to the consumer kind. `render-*` →
 * `"render"` (the only channel ae-test treats as render evidence);
 * `"trace"` stays `"trace"`; everything else — screen stills,
 * recordings, the index itself — is `"attachment"`: stored evidence a
 * consumer may cite, never render correctness.
 */
export function consumerArtifactKind(kind: EvidenceKind): ConsumerArtifactKind {
  if (RENDER_KINDS.has(kind)) {
    return "render";
  }
  if (kind === "trace") {
    return "trace";
  }
  return "attachment";
}

function isAbsoluteArtifactPath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * The ae-test `Artifact` projection of the index's `artifacts[]`
 * (spec §4.3/§5.5, ae-test#145). `path` stays exactly as recorded —
 * relative to the session artifacts dir in the normal case — and
 * `absolutePath` resolves it under `<sessionRoot>/artifacts` so a
 * consumer scanning `session.artifactsDir` (ae-test `collectRenders`)
 * finds the same files the index references. Paths that were recorded
 * absolute (the `artifactRelativePath` fallback) pass through.
 */
export function consumerArtifacts(
  doc: GuiEvidenceIndexDocument,
): readonly ConsumerArtifact[] {
  const artifactsDir = join(doc.session.sessionRoot, "artifacts");
  return doc.artifacts.map((artifact) => {
    const absolutePath = isAbsoluteArtifactPath(artifact.path)
      ? artifact.path
      : join(artifactsDir, ...artifact.path.split("/"));
    return {
      name: artifact.id,
      path: artifact.path,
      bytes: artifact.bytes,
      kind: consumerArtifactKind(artifact.kind),
      absolutePath,
    };
  });
}

/**
 * The `consumerRefs` block as it appears on the document — echoed
 * caller-supplied identities only (spec §5.3 rule 5). Returns `null`
 * when the caller never supplied refs; consumers must not read absence
 * as an empty identity.
 */
export function consumerRefs(
  doc: GuiEvidenceIndexDocument,
): EvidenceConsumerRefs | null {
  return doc.consumerRefs === undefined ? null : { ...doc.consumerRefs };
}
