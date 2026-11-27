/**
 * The session-stream focus proof (spec §5.3, #371).
 *
 * Session-stream input has no address: keystrokes land on whatever
 * holds focus in the foreground app. Every session-stream op is
 * therefore a three-step proof, all inside the mutation lease:
 *
 *   1. **Pre** — resolve target → verify attribution → request focus →
 *      read back *who actually holds focus*. If the readback does not
 *      name the intended pid/element, the op refuses *before posting*.
 *      Typing into whatever happens to be focused is the failure mode
 *      this contract exists to prevent.
 *   2. **Act** — post events; between posts the guard re-reads the
 *      holder. A focus change mid-sequence aborts the op — it never
 *      "finishes typing into the new focus".
 *   3. **Post** — read back the committed value / observable result;
 *      `requested` vs `observed` are reported separately.
 *
 * Everything here is logic over injected seams (`InputFocusOps`): the
 * OS readback/request delivery lands with the platform helpers
 * (#372/#373). Tests drive it with a fake focus-holder readback.
 */

import type {
  ExpectedFocus,
  FocusHolder,
  InputErrorCode,
} from "./types.js";

/**
 * The OS touches the focus proof needs, injected. `readFocusHolder`
 * returning `null` means "could not prove who holds focus" — treated
 * as unproven, never as a match.
 */
export type InputFocusOps = {
  /** Read the current focus holder in the target session. */
  readFocusHolder(): FocusHolder | null;
  /**
   * Request focus on the target element (AX `kAXFocused`/`AXMain`,
   * UIA `SetFocus`, or a verified click — the platform picks). Throws
   * or returns a refusal when the request cannot be proven delivered.
   */
  requestFocus(expected: ExpectedFocus): void | Promise<void>;
  /**
   * Restore the pre-op focus/frontmost state where we changed it
   * (spec §5.5). Optional: absent means "cannot restore", which the
   * cleanup report records honestly.
   */
  restoreFocus?(holder: FocusHolder): void | Promise<void>;
};

/** The result of the pre-post proof step. */
export type FocusProofResult =
  | {
      readonly proven: true;
      readonly holder: FocusHolder;
      /** Re-checks focus; `ok:false` means abort the sequence now. */
      readonly guard: FocusGuard;
    }
  | {
      readonly proven: false;
      readonly code: InputErrorCode;
      readonly reason: string;
      /** The holder actually observed, for evidence. */
      readonly observed: FocusHolder | null;
    };

/** Per-step focus re-check inside a posting sequence. */
export type FocusGuard = {
  /**
   * Re-read the focus holder. Returns `ok:false` with the abort code
   * when focus moved or became unreadable — the caller must stop
   * posting immediately.
   */
  assert(stepIndex: number):
    | { readonly ok: true; readonly holder: FocusHolder }
    | { readonly ok: false; readonly code: InputErrorCode; readonly reason: string };
};

/**
 * Two holders name the same focus when pid matches and — when the
 * expectation names an element — the element identity matches. A
 * pid-only expectation (`element: null`) accepts any holder inside
 * the pid; the audit record marks that proof as pid-level only.
 */
export function focusHoldersMatch(expected: ExpectedFocus, actual: FocusHolder): boolean {
  if (actual.pid !== expected.pid) return false;
  if (expected.element === null) return true;
  return actual.element === expected.element;
}

/**
 * Run the pre-act half of the three-step proof: request focus, then
 * read back who holds it. Any failure refuses before a single event
 * is posted.
 */
export async function proveSessionStreamFocus(
  expected: ExpectedFocus,
  ops: InputFocusOps,
): Promise<FocusProofResult> {
  try {
    await ops.requestFocus(expected);
  } catch (error) {
    return {
      proven: false,
      code: "focus-unproven",
      reason:
        "the focus request could not be proven delivered: " +
        (error instanceof Error ? error.message : String(error)),
      observed: null,
    };
  }

  const holder = ops.readFocusHolder();
  if (holder === null) {
    return {
      proven: false,
      code: "focus-unproven",
      reason:
        "focus readback failed: the OS could not name the current " +
        "focus holder, so posting would be blind",
      observed: null,
    };
  }
  if (!focusHoldersMatch(expected, holder)) {
    return {
      proven: false,
      code: "focus-unproven",
      reason:
        `focus readback names pid ${holder.pid}` +
        (holder.element === null ? " (window-level)" : ` element ${holder.element}`) +
        `, not the intended pid ${expected.pid}` +
        (expected.element === null ? "" : ` element ${expected.element}`) +
        " — refusing before posting",
      observed: holder,
    };
  }

  const guard: FocusGuard = {
    assert(stepIndex) {
      const now = ops.readFocusHolder();
      if (now === null) {
        return {
          ok: false,
          code: "focus-lost",
          reason:
            `focus became unreadable before step ${stepIndex}; ` +
            "aborting rather than typing into an unproven holder",
        };
      }
      if (!focusHoldersMatch(expected, now)) {
        return {
          ok: false,
          code: "focus-lost",
          reason:
            `focus moved before step ${stepIndex}: holder is now pid ` +
            `${now.pid}${now.element === null ? "" : ` element ${now.element}`}` +
            " — aborting the sequence, never finishing into the new focus",
        };
      }
      return { ok: true, holder: now };
    },
  };

  return { proven: true, holder, guard };
}
