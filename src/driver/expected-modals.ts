/**
 * Expected-modal registration (#342, parent program #337 US-A1/A5).
 *
 * A test that deliberately raises a dialog — an unsaved-changes prompt, a
 * script-error sheet, a consent it intends to answer — cannot let the
 * standard recovery path quarantine it as `unknown`: the run would stop
 * for a modal the caller itself created and knows how to resolve. This
 * module is the registration/delegation contract for exactly that case.
 *
 * Contract rules:
 *
 *   - Registration is per-session and explicit. Nothing is expected by
 *     default; an unregistered modal keeps the existing classification
 *     (measured class / human-required / unpressable / quarantine).
 *   - A registered expectation changes the *classification* of the
 *     matched window, never the *machinery*: a `press` resolution still
 *     goes through `MacGuiRecovery.pressButtonIn` — the GUI lease, the
 *     audit record, the pid/start-identity re-proof and the in-lease
 *     census re-attribution are identical to the measured-class press.
 *   - `human-only` windows are never pressable through an expectation.
 *     Adobe account/licence decisions and unattributed windows stay a
 *     human's, exactly as without registration (#342 safety gate G6).
 *   - `wait` is the default resolution: the modal is recorded as expected
 *     evidence and left for its owner — the test, ae-devtools, or a
 *     human — while the original request keeps its bounded wait. Nothing
 *     is pressed and nothing is resent.
 *   - Matchers see a deliberately small window shape
 *     (`ExpectedModalWindow`), not the internal `GuiWindowInfo`: title,
 *     role, subrole, static texts and button titles. Element positions,
 *     frames and census attribution stay inside the recovery path.
 */

/** The window facts a matcher may read. A subset of `GuiWindowInfo`. */
export type ExpectedModalWindow = {
  readonly title: string;
  readonly role: string;
  readonly subrole: string | null;
  readonly texts: readonly string[];
  /** Button titles, in listing order. */
  readonly buttons: readonly string[];
};

/**
 * What a matched expectation authorizes.
 *
 *   - `press` — press the named button through the audited GUI path. The
 *     name must be a button title the window offers or a title the press
 *     script can still address; a failed press is reported, never retried
 *     blindly.
 *   - `wait` — leave the window alone. The recovery reports the modal as
 *     expected (not unknown), captures its evidence, and the original
 *     request's bounded wait continues. This is also the resolution used
 *     when `resolve` is omitted.
 */
export type ExpectedModalResolution =
  | { readonly kind: "press"; readonly button: string }
  | { readonly kind: "wait" };

/** One registered expectation. */
export type ExpectedModalSpec = {
  /** Stable name for evidence and trace (`expected modal "<name>"`). */
  readonly name: string;
  /** Whether this window is the modal the caller expects. */
  readonly matches: (window: ExpectedModalWindow) => boolean;
  /**
   * How the expectation resolves the window. Synchronous by contract: the
   * recovery attempt is synchronous on macOS, so a resolver must decide
   * from the window facts alone (or from state the caller already holds).
   * Omitted means `{ kind: "wait" }`.
   */
  readonly resolve?: (
    window: ExpectedModalWindow,
  ) => ExpectedModalResolution;
};

/** A validated, registered expectation. */
export type ExpectedModal = ExpectedModalSpec & {
  readonly resolve: (
    window: ExpectedModalWindow,
  ) => ExpectedModalResolution;
};

const MAX_NAME_LENGTH = 120;

/**
 * Validates a spec at registration time. A matcher or resolver that is
 * not callable, an empty name, or a `press` resolution without a button
 * is refused here — at the boundary — rather than deep inside a recovery.
 */
export function requireExpectedModal(spec: unknown): ExpectedModal {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new TypeError("expected modal must be an object with name and matches");
  }
  const { name, matches, resolve } = spec as {
    name?: unknown;
    matches?: unknown;
    resolve?: unknown;
  };
  if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new TypeError(
      `expected modal name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`,
    );
  }
  if (typeof matches !== "function") {
    throw new TypeError("expected modal matches must be a function");
  }
  if (resolve !== undefined && typeof resolve !== "function") {
    throw new TypeError("expected modal resolve must be a function");
  }
  const specOut = { name: name.trim(), matches, resolve } as ExpectedModalSpec;
  return {
    ...specOut,
    resolve:
      resolve === undefined
        ? () => ({ kind: "wait" })
        : (window) => {
            const resolution = (resolve as NonNullable<ExpectedModalSpec["resolve"]>)(window);
            if (resolution === null || typeof resolution !== "object") {
              throw new TypeError(`expected modal "${specOut.name}" resolve must return an object`);
            }
            if (resolution.kind === "wait") {
              return { kind: "wait" };
            }
            if (resolution.kind === "press") {
              if (typeof resolution.button !== "string" || resolution.button.trim().length === 0) {
                throw new TypeError(
                  `expected modal "${specOut.name}" press resolution needs a non-empty button`,
                );
              }
              return { kind: "press", button: resolution.button };
            }
            throw new TypeError(
              `expected modal "${specOut.name}" resolution kind must be "press" or "wait"`,
            );
          },
  };
}

/**
 * Projects a recovery-path window onto the matcher shape. Structural on
 * purpose: `GuiWindowInfo` satisfies it, and so does any listing a future
 * platform probe produces.
 */
export function toExpectedModalWindow(window: {
  readonly title: string;
  readonly role: string;
  readonly subrole: string | null;
  readonly texts: readonly string[];
  readonly buttons: readonly { readonly title: string }[];
}): ExpectedModalWindow {
  return {
    title: window.title,
    role: window.role,
    subrole: window.subrole,
    texts: window.texts,
    buttons: window.buttons.map((button) => button.title),
  };
}

/** What a registry match produced: the spec, the window it saw, its verdict. */
export type ExpectedModalMatch = {
  readonly spec: ExpectedModal;
  readonly window: ExpectedModalWindow;
  readonly resolution: ExpectedModalResolution;
};

type Registered = {
  readonly spec: ExpectedModal;
};

/**
 * The per-session set of expected modals. Registration order is match
 * order: the first spec whose `matches` accepts the window wins, so a
 * caller that registers a broad expectation first shadows later, narrower
 * ones — register specific shapes before generic ones.
 *
 * The registry is mutable by design (a test registers what it is about to
 * raise), but it is only ever read inside the recovery attempt, on the
 * same thread of control — there is no cross-process view of it.
 */
export class ExpectedModalRegistry {
  readonly #entries: Registered[] = [];

  /**
   * Registers an expectation and returns its unregister function.
   * Registering the same spec object twice is allowed; each registration
   * is independent.
   */
  register(spec: ExpectedModalSpec): () => void {
    const expected = requireExpectedModal(spec);
    const entry: Registered = { spec: expected };
    this.#entries.push(entry);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      const index = this.#entries.indexOf(entry);
      if (index >= 0) {
        this.#entries.splice(index, 1);
      }
    };
  }

  /** The registered specs, in match order. */
  list(): readonly ExpectedModal[] {
    return this.#entries.map((entry) => entry.spec);
  }

  /**
   * The first registered expectation accepting `window`, with its
   * resolution already computed. `null` when nothing is registered or no
   * spec matches — the caller then keeps the unregistered classification.
   */
  match(window: ExpectedModalWindow): ExpectedModalMatch | null {
    for (const entry of this.#entries) {
      let matched = false;
      try {
        matched = entry.spec.matches(window);
      } catch {
        // A matcher that throws is a buggy expectation, not a modal
        // verdict: treat it as non-matching so the window keeps its
        // unregistered classification rather than crashing a recovery.
        matched = false;
      }
      if (!matched) {
        continue;
      }
      let resolution: ExpectedModalResolution;
      try {
        resolution = entry.spec.resolve(window);
      } catch {
        // A resolver that throws or returns garbage cannot authorize a
        // press: fall back to the safe default, `wait`.
        resolution = { kind: "wait" };
      }
      if (resolution === null || typeof resolution !== "object") {
        resolution = { kind: "wait" };
      }
      if (resolution.kind === "press" && typeof resolution.button !== "string") {
        resolution = { kind: "wait" };
      }
      return { spec: entry.spec, window, resolution };
    }
    return null;
  }
}
