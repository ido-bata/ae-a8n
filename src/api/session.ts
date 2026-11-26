/**
 * The internal call surface and the authorization rules around it.
 *
 * `Session` is not exported from the package: it is the seam every entity
 * handle (`Project`, `Comp`, …) uses to reach the driver, and the place the
 * consumer's launch-time grant is kept. The grant helpers live here too
 * because both session establishment (`launch.ts`) and entity methods
 * (`index.ts`) decide authorization through them.
 */

import type { AeDriver } from "../driver/driver.js";
import type { ExpectedModalRegistry } from "../driver/expected-modals.js";
import { requireExpectedModal, type ExpectedModalSpec } from "../driver/expected-modals.js";
import type { SessionSupervision } from "../driver/supervision-session.js";
import {
  AUTHORIZATION_SCOPES,
  type AuthorizationScope,
  type SessionAuthorization,
} from "../driver/transport.js";
import type { TraceRecorder, TraceEvent } from "../trace/trace.js";
import { HostNotOwnedError, contextualise } from "./errors.js";
import type { OperationOptions } from "./types.js";

/**
 * Internal call surface. Exported inside `src/api/` for `launch.ts` and
 * `index.ts` only; it is not part of the package's public exports, so
 * callers still cannot bypass the API.
 */
export class Session {
  readonly driver: AeDriver;
  readonly trace: TraceRecorder;
  readonly events: TraceEvent[] = [];
  /** The consumer's explicit grant for non-owned operations (#145). */
  readonly authorization: SessionAuthorization;
  /**
   * Live GUI supervision for this session (#285), when the platform and
   * target allow honest observation. Set by session establishment; `close`
   * stops it. Null means "no monitor" — the durable report stays
   * `unavailable`, never a fabricated clean state.
   */
  supervision: SessionSupervision | null = null;
  /**
   * The session's expected-modal registry (#342), when a GUI recovery path
   * is wired. `null` means expectations cannot be honoured — registering
   * one is refused rather than silently ignored, because an expected
   * modal that nothing watches would quarantine exactly like an
   * unexpected one while claiming otherwise.
   */
  modalExpectations: ExpectedModalRegistry | null = null;

  constructor(driver: AeDriver, trace: TraceRecorder, authorization: SessionAuthorization = {}) {
    this.driver = driver;
    this.trace = trace;
    this.authorization = authorization;
    trace.subscribe((event) => {
      this.events.push(event);
    });
  }

  /**
   * Registers an expected modal for this session (#342). Returns the
   * unregister function. Throws when no GUI recovery path is wired —
   * the expectation would otherwise be recorded nowhere.
   */
  expectModal(spec: ExpectedModalSpec): () => void {
    const registry = this.modalExpectations;
    if (registry === null) {
      throw new HostNotOwnedError(
        "session.expectModal",
        this.driver.ownership().kind,
        "this session has no GUI recovery path (the built-in script transport " +
          "with recovery enabled is required), so an expected modal could never be resolved",
      );
    }
    return registry.register(requireExpectedModal(spec));
  }

  async call<T>(
    op: string,
    method: string,
    params: Record<string, unknown> = {},
    options: OperationOptions = {},
  ): Promise<T> {
    const timeoutMs = optionalTimeout(options.timeoutMs);
    try {
      return await this.driver.call<T>(method, params, {
        opName: op,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      contextualise(op, error);
    }
  }
}

export function optionalTimeout(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  return value;
}

export function requirePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`);
  }
  return value;
}

/**
 * The operation classes a session grant can cover, for validation and for
 * the handshake's `grantedOperations` report (#145).
 */
const GRANT_SCOPES = AUTHORIZATION_SCOPES;

/**
 * Validates `LaunchOptions.authorization`: an object whose keys are grant
 * scopes, `extensionMethods` being `true`, `false`, or a list of declared
 * method names, the rest booleans. Anything else is refused before launch —
 * a grant that cannot be read is not a grant.
 */
export function requireAuthorization(value: unknown): SessionAuthorization {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("authorization must be an object of grant scopes");
  }
  const grant: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!(GRANT_SCOPES as readonly string[]).includes(key)) {
      throw new TypeError(
        `authorization.${key} is not a grant scope; known scopes: ${GRANT_SCOPES.join(", ")}`,
      );
    }
    if (key === "extensionMethods") {
      if (entry === true || entry === false) {
        grant[key] = entry;
      } else if (Array.isArray(entry) && entry.every((name) => typeof name === "string")) {
        // Snapshot: the session's grant must not follow later mutation of
        // the caller's array — authorization is fixed when the session opens.
        grant[key] = [...entry];
      } else {
        throw new TypeError("authorization.extensionMethods must be true, false, or a list of method names");
      }
    } else if (typeof entry === "boolean") {
      grant[key] = entry;
    } else {
      throw new TypeError(`authorization.${key} must be a boolean`);
    }
  }
  return grant;
}

/** The scope names this session is actually authorized for, for reporting. */
export function grantedScopes(session: Session): readonly AuthorizationScope[] {
  const ownership = session.driver.ownership();
  if (ownership.kind === "owned") {
    // An owned session needs no grant: every scope is allowed. Reporting the
    // full list keeps "what may this session do" answerable in one place.
    return GRANT_SCOPES;
  }
  if (ownership.kind === "unknown") {
    // A grant never authorizes an unproven target, so reporting scopes here
    // would overstate what the session may do.
    return [];
  }
  const grant = session.authorization;
  return GRANT_SCOPES.filter((scope) => {
    const value = grant[scope];
    return value === true || (Array.isArray(value) && value.length > 0);
  });
}

/**
 * Whether the session's grant covers `scope` for `method` (when the scope
 * is method-scoped, as `extensionMethods` is). Owned sessions are always
 * covered; anything else needs the explicit grant (#145).
 */
function grantCovers(session: Session, scope: AuthorizationScope, method?: string): boolean {
  const ownership = session.driver.ownership();
  if (ownership.kind === "owned") {
    return true;
  }
  if (ownership.kind === "unknown") {
    // The grant is the caller's consent for a *known attached* target. On a
    // host whose identity cannot be proven, consent alone must not carry an
    // operation — the session has to establish attached/owned first.
    return false;
  }
  const value = session.authorization[scope];
  if (value === true) {
    return true;
  }
  if (Array.isArray(value)) {
    return method !== undefined && value.includes(method);
  }
  return false;
}

/**
 * Refuses an operation the session is not authorized for.
 *
 * Three authorities stay separate (#145): quitting the host is owned-only
 * and is enforced in the driver, never here; operating the connected
 * target is what the session bound at launch; and each privileged
 * operation class needs either ownership or the matching grant. Unknown
 * ownership is never promoted: it is authorized exactly like "attached".
 */
export function requireAuthorized(
  session: Session,
  op: string,
  scope: AuthorizationScope,
  method?: string,
): void {
  const ownership = session.driver.ownership();
  if (ownership.kind === "owned" || grantCovers(session, scope, method)) {
    return;
  }
  const granted = grantedScopes(session);
  const hint =
    granted.length === 0
      ? `pass authorization: { ${scope}: true } (or the method names) in launch options`
      : `the grant covers ${granted.join(", ")} but not "${scope}"`;
  throw new HostNotOwnedError(
    op,
    ownership.kind,
    `${ownership.evidence}; ${hint}`,
  );
}
