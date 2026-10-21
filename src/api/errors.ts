/**
 * Errors the public API throws.
 *
 * Every failure a caller can meaningfully branch on has its own type. A
 * `HostError` bubbling out of the bridge with a raw ExtendScript message is a
 * leak, not an API.
 */

import { HostError, ProtocolError } from "../protocol/envelope.js";
import { HostUnavailableError, TimeoutError } from "../driver/driver.js";
import type { PropertyKind } from "./types.js";

export { HostUnavailableError, ProtocolError, TimeoutError };

export class AfterEffectsError extends Error {
  /** Operation that failed, as it appears in the trace. */
  readonly op: string;

  constructor(message: string, op: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AfterEffectsError";
    this.op = op;
  }
}

export class EntityNotFoundError extends AfterEffectsError {
  /** Entity kind, e.g. `composition` or `effect`. */
  readonly kind: string;

  constructor(kind: string, identifier: string, op: string) {
    super(`${kind} not found: ${identifier}`, op);
    this.name = "EntityNotFoundError";
    this.kind = kind;
  }
}

/**
 * The open project has unsaved changes and the operation would discard them.
 * Not a failure of After Effects: a decision the caller has to make, by
 * repeating the call with `unsavedChanges: "discard"`.
 */
export class UnsavedChangesError extends AfterEffectsError {
  constructor(op: string, options?: { cause?: unknown }) {
    super(`${op} refused: the open project has unsaved changes`, op, options);
    this.name = "UnsavedChangesError";
  }
}

/**
 * The operation changes After Effects in a way only the session that started
 * it may: running a menu command, or setting the process environment. A host
 * that was already running, or whose identity cannot be confirmed, belongs to
 * someone else. `ownership` is what the session saw.
 */
export class HostNotOwnedError extends AfterEffectsError {
  readonly ownership: string;

  constructor(op: string, ownership: string, evidence: string) {
    super(`${op} refused: this session does not own After Effects (${ownership}: ${evidence})`, op);
    this.name = "HostNotOwnedError";
    this.ownership = ownership;
  }
}

/**
 * A read or write of a property that has no value a script can use: a
 * NO_VALUE or CUSTOM_VALUE property, or a group. Nothing was written.
 */
export class PropertyHasNoValueError extends AfterEffectsError {
  /** Why there is no value: `no-value`, `custom-value`, or `group`. */
  readonly kind: Exclude<PropertyKind, "value">;
  /** The parameter identifier the caller used. */
  readonly property: string;

  constructor(
    kind: Exclude<PropertyKind, "value">,
    property: string,
    op: string,
    options?: { cause?: unknown },
  ) {
    super(`${op} refused: ${property} has no value to read or write (${kind})`, op, options);
    this.name = "PropertyHasNoValueError";
    this.kind = kind;
    this.property = property;
  }
}

/**
 * A value of the wrong shape for the property's type: a number for a point
 * or colour, an array for a single number, the wrong number of elements, or
 * a non-finite element. The host refuses before writing; nothing changed.
 */
export class ParameterValueError extends AfterEffectsError {
  /** The property's value type, e.g. `COLOR`. */
  readonly valueType: string;
  /** The parameter identifier the caller used. */
  readonly property: string;

  constructor(valueType: string, property: string, op: string, message: string, options?: { cause?: unknown }) {
    super(`${op} refused: ${message}`, op, options);
    this.name = "ParameterValueError";
    this.valueType = valueType;
    this.property = property;
  }
}

export { HostError };

/**
 * Re-labels a transport error with the operation that produced it, keeping the
 * original as `cause` so nothing is lost.
 */
export function contextualise(op: string, error: unknown): never {
  if (error instanceof EntityNotFoundError) {
    throw error;
  }
  if (error instanceof HostError && error.name === "UnsavedChangesError") {
    throw new UnsavedChangesError(op, { cause: error });
  }
  if (error instanceof HostError) {
    throw new AfterEffectsError(
      `${op} failed in After Effects: ${error.message}` +
        (error.aeError === undefined ? "" : ` (AE error ${error.aeError})`),
      op,
      { cause: error },
    );
  }
  if (error instanceof TimeoutError) {
    throw new AfterEffectsError(error.message, op, { cause: error });
  }
  if (error instanceof ProtocolError) {
    throw new AfterEffectsError(
      `${op} got an unreadable response from the After Effects bridge: ${error.message}`,
      op,
      { cause: error },
    );
  }
  if (error instanceof AfterEffectsError) {
    throw error;
  }
  throw new AfterEffectsError(
    `${op} failed: ${error instanceof Error ? error.message : String(error)}`,
    op,
    { cause: error },
  );
}
