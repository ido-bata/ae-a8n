/**
 * Panel interaction contract — B-PLATFORM shared types (#343,
 * `specs/panel-interaction/spec.md` §6).
 *
 * These types are the coordination surface with A-RUNTIME (#342): target
 * identity, operation authorization and the capture artifact model are
 * defined here once and consumed by the API layer, the OS adapters and
 * ae-test. Names are the contract's working names; nothing here implies a
 * public command exists yet.
 */

/** A rectangle in the target session's global screen coordinates. */
export type PanelFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * How a caller names the panel it wants. Every field is a hint for
 * resolution, never identity: two same-bundle-id After Effects versions
 * can enumerate each other's windows (#330), so resolution always goes
 * through the pid-attributed census before anything acts.
 */
export type PanelLocator = {
  /** Window title, matched exactly or as a substring. */
  readonly title?: string;
  readonly titleMatch?: "exact" | "contains";
  /** AX role, e.g. "AXWindow" or "AXLayoutArea". */
  readonly role?: string;
  /** AX subrole, e.g. "AXFloatingWindow". */
  readonly subrole?: string;
  /**
   * The OS window number (CGWindowID on macOS) when the caller already
   * knows it — the strongest locator because it survives title changes.
   * Still re-verified against the census and the AX frame before use.
   */
  readonly windowNumber?: number;
};

/**
 * Who a resolved panel surface belongs to. Mirrors the census attribution
 * vocabulary of `src/driver/gui-recovery.ts`: only `"owned"` may drive a
 * mutation; `"unproven"` is what an unavailable census degrades to.
 */
export type PanelAttribution = "owned" | "foreign" | "unmatched" | "unproven";

/** The resolved surface a panel operation addresses. */
export type PanelSurface = {
  /**
   * `"window"` is a top-level window (floating panel/palette, or a
   * dialog-shaped surface the locator named). `"docked-region"` — a panel
   * docked inside the main window with no window of its own — resolves
   * through the bounded pane walk (`src/panels/docked/`, #361) as an
   * observe-class surface; it is not resizable or capturable by window
   * number because it is not a window.
   */
  readonly kind: "window" | "docked-region";
  /**
   * 1-based position in the Accessibility listing the OS adapter uses for
   * mutation scripts. Meaningful only for `kind: "window"` on platforms
   * whose mutation vehicle is index-addressed (macOS System Events).
   */
  readonly windowIndex: number | null;
  /** OS window number (CGWindowID on macOS), when the census provided one. */
  readonly windowNumber: number | null;
  /** What the locator asked for, echoed for evidence. */
  readonly locator: PanelLocator;
  /** The surface's frame in points, global screen coordinates. */
  readonly frame: PanelFrame;
  /**
   * Surface state as last observed. `occluded` is honestly `"unknown"`:
   * neither CGWindowList nor the AX frame proves what covers the surface,
   * and guessing would make captures claim more than they show.
   */
  readonly state: {
    /** `null` when the census could not prove screen presence. */
    readonly onScreen: boolean | null;
    readonly occluded: "none" | "partial" | "full" | "unknown";
  };
  readonly attribution: PanelAttribution;
};

/** A panel resolved against one concrete After Effects process. */
export type PanelTarget = {
  readonly pid: number;
  readonly surface: PanelSurface;
  /** ISO timestamp of the observation the target was resolved from. */
  readonly resolvedAt: string;
};

/** A requested or observed panel size, in points. */
export type PanelSize = {
  readonly width: number;
  readonly height: number;
};

/**
 * What `measure` proved. `readback` is the in-AE channel (e.g. a ScriptUI
 * `Window.size` the surface itself reports) when one is configured;
 * `readbackSource` says which evidence the size rests on so a caller never
 * mistakes an OS-only geometry read for an in-AE confirmation.
 */
export type PanelMeasurement = {
  readonly target: PanelTarget;
  /** The OS-observed frame — the authoritative geometry for this slice. */
  readonly frame: PanelFrame;
  /** The in-AE readback, or null when no readback channel exists. */
  readonly readback: PanelSize | null;
  readonly readbackSource: "in-ae" | "os-only" | "unavailable";
  /** True when `frame` size equals the size last requested through this controller. */
  readonly matchesRequested: boolean | null;
  readonly observedAt: string;
};

/** One screenshot artifact and its provenance (spec §6.3). */
export type PanelCapture = {
  /** `"original"` is the untouched OS capture; `"derived"` is a transform of it. */
  readonly kind: "original" | "derived";
  /** Correlates the artifact with the operation that produced it. */
  readonly operationId: string;
  /**
   * Which capture vehicle produced `original`: `"window"` is the
   * window-number capture (`screencapture -l`), `"region"` the frame
   * rectangle (`screencapture -R`). Evidence binding (#380) records this
   * as the artifact's `CaptureScope` — the controller is the authority
   * on which branch ran, so it reports it rather than letting a consumer
   * re-derive the choice.
   */
  readonly vehicle: "window" | "region";
  readonly target: PanelTarget;
  readonly capturedAt: string;
  /** Geometry the capture was taken for, in points. */
  readonly geometry: {
    readonly frame: PanelFrame;
    readonly coordinateSpace: "points-top-left";
    /**
     * Device pixels per point, derived from the captured image when the
     * format exposes it; `null` when it cannot be proven — never guessed.
     */
    readonly backingScale: number | null;
    readonly occlusion: "none" | "partial" | "full" | "unknown";
    /**
     * What else the image may contain beyond the target. `"region"` means
     * the capture was scoped to the target's frame/window but overlapping
     * or adjacent surfaces can still appear; `"full-screen"` means the
     * whole session screen was captured.
     */
    readonly leakage: "region" | "full-screen" | "unknown";
  };
  /** The untouched capture file. */
  readonly original: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    /** Pixel dimensions read from the image header, when decodable. */
    readonly pixelSize: { readonly width: number; readonly height: number } | null;
  };
  /**
   * A transformed artifact (crop/scale) — a separate file with its
   * transform recorded. `null` in this slice: only originals are produced,
   * and callers must not mistake an original for a derived image.
   */
  readonly derived: null;
};

/** Per-capability honesty record for `ae.panelCapabilities()`. */
export type PanelCapability = {
  /**
   * `"implemented"` — code exists; `"partial"` — works for a subset
   * (e.g. floating windows only); `"unsupported"` — no implementation;
   * `"unavailable"` — implemented but gated off pending a safety decision.
   */
  readonly support: "implemented" | "partial" | "unsupported" | "unavailable";
  /** Strongest evidence level, in the repo's verification taxonomy. */
  readonly verification:
    | "implemented"
    | "automated test"
    | "fake/mock only"
    | "verified on real host";
  /** Why support is not full, or what gates it — always present when not "implemented". */
  readonly reason: string | null;
};

/** What this build can do with panels on this platform. */
export type PanelCapabilities = {
  readonly platform: "darwin" | "win32";
  readonly identify: PanelCapability;
  readonly measure: PanelCapability;
  readonly resize: PanelCapability;
  readonly captureRegion: PanelCapability;
  readonly captureWindow: PanelCapability;
  readonly dockedRegion: PanelCapability;
  readonly inAeReadback: PanelCapability;
};

/** Stable refusal codes a caller may act on. */
export type PanelErrorCode =
  /** No window matched the locator. */
  | "not-found"
  /** More than one window matched; the candidates are named. */
  | "ambiguous"
  /** The surface exists but its pid attribution is not "owned". */
  | "unproven"
  /** This platform/kind has no implementation (e.g. win32 panels). */
  | "unsupported"
  /** The capability exists but a safety/permission gate refuses it now. */
  | "refused"
  /**
   * A recorded locator (e.g. an `axPath` inside a walked pane subtree)
   * no longer resolves to the same element — the tree drifted. The
   * caller re-walks; nothing is remapped by guesswork (#361, spec §6).
   */
  | "stale-locator"
  /** The target session or process could not be entered/proven. */
  | "unavailable"
  /** A mutation was attempted and its outcome is unknown. */
  | "indeterminate";

export class PanelError extends Error {
  readonly code: PanelErrorCode;
  /** Candidate summaries for `ambiguous`; empty otherwise. */
  readonly candidates: readonly string[];

  constructor(
    code: PanelErrorCode,
    message: string,
    options: { candidates?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "PanelError";
    this.code = code;
    this.candidates = options.candidates ?? [];
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
