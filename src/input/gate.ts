/**
 * The safety gate for real input delivery (#371,
 * `specs/ime-input/spec.md` §5, `docs/gui-supervision-safety-gates.md`).
 *
 * Session-stream key/text posting and shared-state mutation (clipboard,
 * IME mode) are global in effect: on a shared console session they can
 * land in a foreign app if focus proof is wrong, and on any session
 * they disturb the user's real input. Until the A-SAFETY input gate
 * (#338) clears a class *and* the caller passes an explicit
 * `GlobalInputAuthorization`, every such operation refuses —
 * fail-closed, with the refusal naming this document so the reason is
 * traceable. There is no silent no-op path: a missing token/scope is
 * reported as `unavailable`, not skipped.
 *
 * `inputMutationGate()` is the single flip point, mirroring
 * `panelMutationGate()`: when the audit clears an input class the
 * permit is added here — not ad-hoc at call sites.
 */

import type {
  GlobalInputAuthorization,
  InputAuthorizationRequest,
  InputAuthorizationVerdict,
  InputOperationClass,
} from "./types.js";

/** The mutation-gate verdict shape, identical in spirit to `PanelMutationGate`. */
export type InputMutationGate = (
  operationClass: InputOperationClass,
  scope: string,
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * The production mutation gate for input delivery. Always refuses
 * today: no input class is in the A-SAFETY auto-safe set, no OS posting
 * helper exists yet (#372/#373), and `requiresGlobalInputAuthorization`
 * has no granted path. The reason cites the audit so a caller can find
 * the unblock conditions.
 */
export function inputMutationGate(): InputMutationGate {
  return (_operationClass, scope) => ({
    allowed: false,
    reason:
      `input ${scope} mutations are not enabled: the A-SAFETY audit ` +
      "(docs/gui-supervision-safety-gates.md) has cleared no input class, " +
      "no OS posting helper is implemented (#372 macOS / #373 Windows), " +
      "and global-input authorization has no grant path — this gate is " +
      "the single flip point when that changes",
  });
}

/**
 * The stable surface key a `"target"`-scoped grant names. Prefers the
 * OS window number (CGWindowID) — it survives title changes — and
 * falls back to the AX-listing index. A surface with neither cannot
 * be granted target-scoped authorization.
 */
export function panelTargetSurfaceKey(target: {
  readonly surface: {
    readonly kind: string;
    readonly windowNumber: number | null;
    readonly windowIndex: number | null;
  };
}): string | null {
  if (target.surface.windowNumber !== null) {
    return `window:${target.surface.windowNumber}`;
  }
  if (target.surface.windowIndex !== null) {
    return `${target.surface.kind}:index:${target.surface.windowIndex}`;
  }
  return null;
}

/** The identity a `"target"`-scoped grant must match. */
function targetMatches(
  auth: Extract<GlobalInputAuthorization, { kind: "target" }>,
  req: InputAuthorizationRequest,
): boolean {
  const key = panelTargetSurfaceKey(req.target);
  return (
    auth.pid === req.target.pid &&
    key !== null &&
    auth.surfaceKey === key &&
    auth.classes.includes(req.operationClass)
  );
}

/**
 * Evaluate a `GlobalInputAuthorization` against what the operation
 * needs (spec §5.4). Authorization is per-operation-class and never
 * implied by a prior grant: a `"session"` grant covers dedicated
 * sessions by id; a `"target"` grant covers exactly one pid/surface and
 * the classes it lists.
 *
 * `undefined`/absent authorization on a scope that requires it is
 * `unavailable` — the honest "this cannot run yet" answer — while a
 * present-but-mismatched grant is `refused`.
 */
export function inputAuthorizationVerdict(
  auth: GlobalInputAuthorization | null | undefined,
  req: InputAuthorizationRequest,
): InputAuthorizationVerdict {
  if (auth === null || auth === undefined) {
    return {
      status: "unavailable",
      code: "unavailable",
      reason:
        "session-stream/shared-state input requires an explicit " +
        "GlobalInputAuthorization token or scope (spec §5.4); none was " +
        "provided — this is reported, never a silent no-op",
    };
  }

  if (auth.kind === "session") {
    if (
      req.sessionKind === "dedicated" &&
      req.sessionId !== undefined &&
      auth.sessionId === req.sessionId
    ) {
      return { status: "granted", tokenRef: auth.tokenRef };
    }
    // A session grant never covers a shared/attached session, and an
    // unknown session id cannot be proven dedicated.
    return {
      status: "refused",
      code: "unavailable",
      reason:
        "the session-scoped authorization does not cover this session: " +
        "it names a different dedicated session id, and shared or " +
        "unproven sessions need a target-scoped grant instead",
    };
  }

  // kind === "target"
  if (targetMatches(auth, req)) {
    return { status: "granted", tokenRef: auth.tokenRef };
  }
  const pidMatch = auth.pid === req.target.pid;
  const clsMatch = auth.classes.includes(req.operationClass);
  return {
    status: "refused",
    code: "refused",
    reason:
      "the target-scoped authorization does not cover this operation: " +
      `pid ${pidMatch ? "matches" : "differs"}, operation class ` +
      `${clsMatch ? "is covered" : `"${req.operationClass}" is not listed`} ` +
      "— grants are per PanelTarget and per class, never implied",
  };
}
