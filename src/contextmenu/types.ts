/**
 * Context-menu contract (#368, `specs/workspace-editing/spec.md` §3 W4+,
 * §6, §7, §9).
 *
 * A context menu is the surface a right-click raises on a layer, item or
 * pane: a NEW pid-attributed window that appears in the Accessibility
 * listing after the click and disappears on dismissal. This module fixes
 * the vocabulary every later real-host ticket must satisfy:
 *
 *   - The act is a **right-click posted inside a re-verified frame**
 *     (spec §6 coordinate rule): the target surface is re-resolved
 *     immediately before the post, and the point must lie inside the
 *     frame that resolution proved — never a remembered position.
 *   - The menu is recognised by **diff + declared titles**: it is a
 *     window that was not in the pre-click listing, carries pid
 *     attribution and a frame, and exposes at least one caller-declared
 *     localized item title. Titles are matched verbatim against what AX
 *     reports; there is no coordinate fallback and no locale guessing —
 *     an absent expected title refuses `unsupported-locale`.
 *   - The menu is classified like a dialog (spec §7): a NEW blocking
 *     window whose titles do not match is `unrecognized-dialog` — the
 *     flow refuses rather than pressing an unknown modal's items.
 *   - `invokeItem` is `mutate-gui`: gated, re-resolved immediately
 *     before the press, and never resent (spec §10).
 *
 * Verification level of everything here: `automated test` against
 * fakes. Whether AE exposes context menus as AX windows with stable
 * item titles, and whether a CGEvent right-button post opens them at
 * all, are the spec's real-host questions (§11) — unverified.
 */

import type { GuiFrame, GuiWindowInfo } from "../driver/gui-recovery.js";

/** Stable refusal codes a caller may act on. */
export type ContextMenuErrorCode =
  /** This platform/kind has no implementation (Windows in this slice). */
  | "unsupported"
  /** The expected surface or item title is absent — never a coordinate fallback. */
  | "unsupported-locale"
  /** The locator itself is malformed (bad index, point outside the frame). */
  | "invalid-locator"
  /** No candidate matched. */
  | "not-found"
  /** More than one candidate matched; never a guess. */
  | "ambiguous-target"
  /** The surface exists but pid attribution is not "owned". */
  | "unproven"
  /** The resolved window/item moved or vanished before the act. */
  | "stale-locator"
  /** The target session or window listing could not be produced. */
  | "unavailable"
  /** A safety gate or policy refuses the operation now. */
  | "refused"
  /** The bounded wait expired or an act's outcome is unknown. */
  | "indeterminate";

export class ContextMenuError extends Error {
  readonly code: ContextMenuErrorCode;
  /** Candidate summaries for `ambiguous-target`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: ContextMenuErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ContextMenuError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * The item titles the caller expects the context menu to show —
 * localized, matched verbatim against the observed window's buttons and
 * static texts. At least one must appear for a new window to classify
 * as the menu; an empty list can never classify anything.
 */
export type ContextMenuTitles = {
  readonly items: readonly string[];
};

/**
 * How a caller names the surface to right-click (spec §6): the window
 * listing index plus the identity that listing entry must still carry
 * at act time — title, subrole and frame, re-verified immediately
 * before the post. `at` is an absolute screen point that must lie
 * inside `expected.frame`; omitted means the frame's center.
 */
export type ContextMenuTargetLocator = {
  /** 1-based position in the `observe()` window listing. */
  readonly windowIndex: number;
  readonly expected: {
    readonly title: string;
    readonly subrole: string | null;
    readonly frame: GuiFrame;
  };
  /** Absolute point inside `expected.frame`; default is its center. */
  readonly at?: { readonly x: number; readonly y: number };
};

/** The target surface as resolved immediately before the right-click. */
export type ContextMenuSurface = {
  /** 1-based listing index the post addressed. */
  readonly windowIndex: number;
  /** The window as observed at resolution — the post's identity proof. */
  readonly window: GuiWindowInfo;
  /** The point the right-click was posted at (inside `window.frame`). */
  readonly point: { readonly x: number; readonly y: number };
  readonly resolvedAt: string;
};

/** One observed item candidate inside the context-menu window. */
export type ContextMenuItem = {
  readonly title: string;
  /** Which listing channel exposed the title. */
  readonly via: "button" | "text";
  /** The button's reported position/size when `via === "button"`. */
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly size: { readonly width: number; readonly height: number } | null;
};

/**
 * The context menu as resolved by the bounded wait: the new window that
 * classified, its observed item candidates, and the pre-click window
 * keys the resolution was proven new against — `invokeItem` re-checks
 * all of it before pressing.
 */
export type ContextMenuResolution = {
  /** 1-based position in the `observe()` listing the press addresses. */
  readonly index: number;
  /** The menu window as observed — the press's identity proof. */
  readonly window: GuiWindowInfo;
  /** Item candidates observed in the same listing. */
  readonly items: readonly ContextMenuItem[];
  /** Window keys present BEFORE the right-click — the "new window" proof. */
  readonly baselineKeys: readonly string[];
  readonly observedAt: string;
};

/** What an `open`/`invokeItem` attempt proved. */
export type ContextMenuActResult = {
  readonly action: "open" | "invoke-item";
  readonly detail: string;
  readonly actedAt: string;
};

/** Per-capability honesty record, same shape as `MenuCapability`. */
export type ContextMenuCapability = {
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  readonly reason: string | null;
};

/** What this build can do with context menus on this platform. */
export type ContextMenuCapabilities = {
  readonly platform: "darwin" | "win32";
  /** Right-click post + bounded menu-surface wait. */
  readonly open: ContextMenuCapability;
  /** Item enumeration inside the resolved menu (observe-class). */
  readonly items: ContextMenuCapability;
  /** Menu-item press (mutate-gui, gated). */
  readonly invokeItem: ContextMenuCapability;
};
