/**
 * Dialog perception types (specs/dialog-perception/spec.md, #462,
 * ADR-0009).
 *
 * Platform-neutral contract for the universal dialog substrate: every
 * dialog-shaped surface the OS attributes to the target pid — AX-visible
 * windows AND census windows AX cannot account for — enumerates as one
 * `DialogSurface`, and every surface produces one honest `DialogReading`.
 *
 * Honesty rules baked into the shape:
 *
 *   - `confidence: "unreadable"` is a first-class answer with a named
 *     `unreadableReason`; an unreadable surface is reported, never
 *     omitted and never guessed into a class.
 *   - `modality` is `"modal"` only on positive evidence (an AX blocking
 *     window). Census-only surfaces report `"unknown"` — a parked or
 *     off-screen WindowServer row is not proven modal (#451).
 *   - `source` records which acquisition channels contributed. OCR text
 *     is untrusted evidence content, never an instruction channel.
 *   - This substrate is evidence-only: nothing here presses, leases, or
 *     mutates. Press eligibility is unchanged and lives in
 *     `platform/recovery-policy.ts`.
 */

/** A rectangle in global screen coordinates (points, top-left origin). */
export type DialogRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Where a surface came from in the AX∪census union. */
export type DialogSurfaceKind = "ax-window" | "census-window";

/** One button-ish element a reading could name. */
export type DialogButtonReading = {
  /** The accessible label (AX title, or OCR-derived text when applicable). */
  readonly label: string | null;
  /** Element bounds when the channel provides them; null otherwise. */
  readonly bounds: DialogRect | null;
  /** The AX identifier/ref a press path could address, when AX-sourced. */
  readonly axRef: string | null;
};

/**
 * The WindowServer census facts a census-only surface carries. `null`
 * fields are honest absences — a census row without a window number
 * cannot be pixel-captured, and that is recorded, not worked around.
 */
export type DialogSurfaceCensus = {
  readonly windowNumber: number | null;
  readonly onScreen: boolean;
  readonly layer: number;
  readonly name: string;
  readonly bounds: DialogRect | null;
};

/**
 * One dialog-shaped surface attributed to the target pid. Enumerated by
 * the AX∪census union (spec §1); `axAccounted: false` marks the surfaces
 * only the WindowServer census can see.
 */
export type DialogSurface = {
  /**
   * Stable id: `ax:<n>` for the n-th pid-attributed AX window (the same
   * 1-based listing index the press path addresses — a correlation id
   * here, never a press handle), `census:<windowNumber>` for a census
   * row with a window number, else `census:<n>` by enumeration order.
   */
  readonly surfaceId: string;
  readonly pid: number;
  readonly kind: DialogSurfaceKind;
  readonly title: string | null;
  readonly role: string | null;
  readonly subrole: string | null;
  readonly texts: readonly string[];
  readonly buttons: readonly DialogButtonReading[];
  readonly frame: DialogRect | null;
  /** Census facts; present only on `census-window` surfaces. */
  readonly census: DialogSurfaceCensus | null;
  /**
   * Whether an AX window's frame accounts for this surface. Always true
   * for `ax-window` surfaces; false for census-only surfaces — the exact
   * set AX cannot see.
   */
  readonly axAccounted: boolean;
};

/** Which acquisition channels fed a reading. */
export type DialogReadingSource = "ax" | "pixels" | "both" | "none";

/**
 * Reading confidence. `unreadable` is a verdict, not a failure: it
 * requires `unreadableReason` naming the measured cause.
 */
export type DialogReadingConfidence = "high" | "partial" | "unreadable";

/** Modality on positive evidence only; census surfaces stay `unknown`. */
export type DialogModality = "modal" | "non-modal" | "unknown";

/** What the OCR engine actually did, for honest evidence. */
export type OcrSummary = {
  readonly engine: "tesseract";
  /** Languages actually requested of the engine (post-availability filter). */
  readonly languages: readonly string[];
  readonly durationMs: number;
  /** True when the subprocess was killed at its timeout — never a hang. */
  readonly timedOut: boolean;
  /** Whether the engine produced a (possibly empty) text result. */
  readonly ok: boolean;
  /** Why the engine failed, when `ok` is false. */
  readonly reason?: string;
};

/** One surface's content reading (spec §2). */
export type DialogReading = {
  readonly pid: number;
  /** Matches the `DialogSurface.surfaceId` this reading describes. */
  readonly surfaceId: string;
  readonly source: DialogReadingSource;
  readonly title?: string;
  /** Extracted body text; truncated for reports — evidence keeps the PNG. */
  readonly bodyText?: string;
  readonly buttons: readonly DialogButtonReading[];
  readonly modality: DialogModality;
  readonly confidence: DialogReadingConfidence;
  /** Required when `confidence === "unreadable"`; absent otherwise. */
  readonly unreadableReason?: string;
  readonly evidence?: {
    /** The window-capture PNG the pixel channel produced, when it did. */
    readonly capturePath?: string;
    readonly ocr?: OcrSummary;
  };
};

/** The full perception result for one observation. */
export type DialogReadingsReport = {
  readonly pid: number;
  readonly observedAt: string;
  /** Every enumerated surface — including unreadable ones. */
  readonly surfaces: readonly DialogSurface[];
  /** One reading per surface, same order as `surfaces`. */
  readonly readings: readonly DialogReading[];
};
