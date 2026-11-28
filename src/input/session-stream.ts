/**
 * Session-stream delivery seam for workspace-editing ops (#367,
 * `specs/workspace-editing/spec.md` §5/§6).
 *
 * Comp-view zoom shortcuts and Effect Controls value entry are
 * session-stream input (B-IME §6 `key`/`type-*` rows): keystrokes have no
 * address — they land on whatever holds focus — so they carry
 * `requiresGlobalInputAuthorization` and must pass through the
 * `GlobalInputAuthorization` check (`inputAuthorizationVerdict`) before
 * anything posts.
 *
 * This file is only the *contract* later consumers inject: the real
 * vehicle is `runInputPlan` + the platform poster/focus ops
 * (`src/input/runner.ts`, `src/input/darwin.ts`), which today refuse
 * `focus-unproven` because #372 ships focus readback only. Ops that take
 * this seam therefore report `unsupported`/`unavailable` honestly until
 * a poster is wired — never a silent no-op.
 */

import type {
  GlobalInputAuthorization,
  InputOperationKind,
} from "./types.js";

/** One unit of session-stream work: a key chord or a text entry. */
export type SessionStreamStep =
  | {
      readonly type: "key";
      /** Key name as the platform poster understands it (e.g. "=", "enter"). */
      readonly key: string;
      readonly modifiers?: readonly string[] | undefined;
    }
  | {
      readonly type: "text";
      readonly text: string;
    };

/** What a session-stream act asks the vehicle to post, in order. */
export type SessionStreamRequest = {
  /**
   * The B-IME operation kind this act maps to (`"key"` for a shortcut
   * chord, `"type-sequential"`/`"type-direct"` for value entry). It
   * selects the gate row — session-stream kinds all require global
   * input authorization.
   */
  readonly operation: InputOperationKind;
  readonly steps: readonly SessionStreamStep[];
  /** Human-readable audit summary (never the text payload itself). */
  readonly summary: string;
};

/** The vehicle's verdict, shaped like the input audit verdict. */
export type SessionStreamResult = {
  readonly verdict: "performed" | "refused" | "indeterminate" | "failed";
  /** Stable refusal code when the vehicle refused (e.g. "focus-unproven"). */
  readonly code?: string;
  readonly reason?: string | null;
};

/**
 * The delivery port. Implementations wrap `runInputPlan` (or a platform
 * equivalent); tests bind fakes. Authorization is evaluated by the
 * *caller* through `inputAuthorizationVerdict` before this is invoked —
 * the seam itself is delivery only.
 */
export type SessionStreamPoster = (
  request: SessionStreamRequest,
) => Promise<SessionStreamResult> | SessionStreamResult;

/** What a caller supplies alongside a session-stream act. */
export type SessionStreamAuthorization = {
  /** The explicit grant; absent on a gated scope refuses `unavailable`. */
  readonly authorization?: GlobalInputAuthorization | null;
  /** Session kind the act would run in — drives the §5.4 grant check. */
  readonly sessionKind: "shared" | "dedicated" | "unknown";
  readonly sessionId?: string | undefined;
};
