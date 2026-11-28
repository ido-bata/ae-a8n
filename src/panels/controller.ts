/**
 * Panel operation orchestration (#343, `specs/panel-interaction/spec.md`
 * §6). Platform-neutral: every OS-specific action arrives through the
 * injected `PanelSurfaceOps`, so the contract — identify → authorize →
 * act → readback → artifact — is identical on macOS, Windows (when it
 * lands) and in tests.
 *
 * Safety shape, mirroring `pressButton`'s rules:
 *
 *   - Resolution runs on every operation; nothing caches a window across
 *     calls, so a stale handle is re-proven or refused, never trusted.
 *   - `resize`/`restore` are `mutate-gui`: they require `attribution ===
 *     "owned"`, the injected mutation gate, and the surface's own
 *     in-session identity re-check. The gate is fail-closed — with no
 *     `authorizeMutation` the mutation refuses before anything is sent.
 *   - `measure`/`capture` are `observe`: no lease, but the same
 *     attribution honesty — a `foreign`/`unmatched`/`unproven` surface is
 *     reported with its attribution, and capture of an unproven surface
 *     is refused because the image could belong to another instance.
 *   - A resize reports `requested` vs `observed` separately; a mismatch
 *     is a measurement, not a silent success.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  GuiMutationError,
  type GuiAppState,
  type GuiFrame,
  type GuiWindowInfo,
} from "../driver/gui-recovery.js";
import type { WindowServerWindow } from "../platform/darwin/window-census.js";
import { resolvePanelTarget, type PanelResolution } from "./resolve.js";
import {
  PanelError,
  type PanelCapture,
  type PanelFrame,
  type PanelLocator,
  type PanelMeasurement,
  type PanelSize,
  type PanelTarget,
} from "./types.js";

/** The census view the resolver needs; `available:false` degrades honestly. */
export type PanelCensusView = {
  readonly available: boolean;
  readonly reason: string | null;
  readonly windows: readonly WindowServerWindow[];
};

/**
 * Every OS touch the controller needs, injected. The production adapter
 * (`src/api/panels.ts`) binds these to `MacGuiRecovery`; tests bind fakes.
 */
export type PanelSurfaceOps = {
  /** One Accessibility+WindowServer observation of the target pid. */
  observe(): GuiAppState;
  /** The pid's census rows; `available:false` when the census cannot run. */
  censusWindows(): PanelCensusView;
  /**
   * The resize mutation, already behind whatever lease/identity checks
   * the platform requires. Returns the platform verdict: true only when
   * the resize was applied; false when it provably was not. Throws when
   * the outcome is unknown.
   */
  resizePanel(expected: GuiWindowInfo & { frame: GuiFrame }, size: PanelSize): boolean;
  /** Region capture (`screencapture -R` on macOS). */
  captureRegion(path: string, frame: GuiFrame): void;
  /** Window-number capture (`screencapture -l` on macOS). */
  captureWindow(path: string, windowNumber: number): void;
  /**
   * In-AE size readback (e.g. ScriptUI `Window.size`), when a channel
   * exists. Absent or null means "no in-AE evidence" — reported as
   * `readbackSource: "unavailable"`, never guessed.
   */
  readback?(): PanelSize | null;
};

export type PanelMutationGate = (
  op: "resize" | "restore",
) => { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export type PanelControllerOptions = {
  readonly pid: number;
  readonly locator: PanelLocator;
  readonly ops: PanelSurfaceOps;
  /** Directory capture artifacts are written under. */
  readonly artifactDir: string;
  /**
   * The mutate-gui gate. Fail-closed: absent means every mutation refuses.
   * Production wires the A-SAFETY gate state; tests inject allow/deny.
   */
  readonly authorizeMutation?: PanelMutationGate;
  /** Settle delay after a resize before readback, ms. Default 250. */
  readonly settleMs?: number;
  /** Sleep seam for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  /** Operation-id seam for deterministic evidence in tests. */
  readonly newOperationId?: () => string;
};

const DEFAULT_SETTLE_MS = 250;

/** Pixel size from a PNG's IHDR; null for anything else or undecodable. */
export function pngPixelSize(path: string): { width: number; height: number } | null {
  try {
    const fd = readFileSync(path);
    // PNG signature (8) + IHDR length/type (8) + width/height (8).
    if (fd.length < 24) return null;
    if (fd.readUInt32BE(0) !== 0x89504e47) return null;
    const width = fd.readUInt32BE(16);
    const height = fd.readUInt32BE(20);
    if (width === 0 || height === 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function frameEquals(a: PanelSize, b: PanelSize, tolerance = 1): boolean {
  return Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The public surface is `PanelError` codes, not driver error types: an
 * observation that cannot run is `unavailable`; a mutation whose outcome
 * is unknown is `indeterminate` — never silently retried or reported as
 * a clean refusal.
 */
function asPanelError(error: unknown, code: "unavailable" | "indeterminate"): PanelError {
  if (error instanceof PanelError) {
    return error;
  }
  return new PanelError(code, errorText(error), { cause: error });
}

export class PanelController {
  readonly #pid: number;
  readonly #locator: PanelLocator;
  readonly #ops: PanelSurfaceOps;
  readonly #artifactDir: string;
  readonly #authorizeMutation: PanelMutationGate | undefined;
  readonly #settleMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => Date;
  readonly #newOperationId: () => string;
  /** The frame first resolved — what `restore` returns to. */
  #originalFrame: PanelFrame | null = null;
  /** The last size a mutation requested, for `matchesRequested`. */
  #requestedSize: PanelSize | null = null;

  constructor(options: PanelControllerOptions) {
    this.#pid = options.pid;
    this.#locator = options.locator;
    this.#ops = options.ops;
    this.#artifactDir = options.artifactDir;
    this.#authorizeMutation = options.authorizeMutation;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => new Date());
    this.#newOperationId = options.newOperationId ?? (() => randomUUID());
  }

  /** One fresh resolution; also records the first-seen frame for restore. */
  #resolve(): PanelResolution {
    let state: GuiAppState;
    try {
      state = this.#ops.observe();
    } catch (error) {
      throw asPanelError(error, "unavailable");
    }
    let census: PanelCensusView;
    try {
      census = this.#ops.censusWindows();
    } catch (error) {
      // A census that throws is an unavailable census — degraded
      // attribution, never a crash and never an empty "no windows".
      census = {
        available: false,
        reason: `window census failed: ${errorText(error)}`,
        windows: [],
      };
    }
    const resolution = resolvePanelTarget({
      pid: this.#pid,
      state,
      census: census.available ? census.windows : [],
      locator: this.#locator,
      now: this.#now,
    });
    if (this.#originalFrame === null) {
      this.#originalFrame = resolution.target.surface.frame;
    }
    return resolution;
  }

  /** Identify only — the read-only half of the slice. */
  identify(): PanelTarget {
    return this.#resolve().target;
  }

  /** OS geometry plus optional in-AE readback; never mutates. */
  measure(): PanelMeasurement {
    const resolution = this.#resolve();
    const frame = resolution.target.surface.frame;
    let readback: PanelSize | null = null;
    let readbackSource: PanelMeasurement["readbackSource"] = "unavailable";
    if (this.#ops.readback !== undefined) {
      try {
        readback = this.#ops.readback();
        readbackSource = readback === null ? "unavailable" : "in-ae";
      } catch {
        readback = null;
        readbackSource = "unavailable";
      }
    } else {
      readbackSource = "os-only";
    }
    return {
      target: resolution.target,
      frame,
      readback,
      readbackSource,
      matchesRequested:
        this.#requestedSize === null ? null : frameEquals(frame, this.#requestedSize),
      observedAt: this.#now().toISOString(),
    };
  }

  #requireMutationAllowed(op: "resize" | "restore"): void {
    const gate = this.#authorizeMutation?.(op) ?? {
      allowed: false as const,
      reason:
        "no mutation gate is configured for panel operations; panel resize is a " +
        "mutate-gui class pending the A-SAFETY review recorded in " +
        "docs/gui-supervision-safety-gates.md",
    };
    if (!gate.allowed) {
      throw new PanelError(
        "refused",
        `panel ${op} refused by the mutation gate: ${gate.reason}`,
      );
    }
  }

  /**
   * Resize the resolved panel to `size` (points), then measure again and
   * report requested vs observed. The mutation itself re-proves identity
   * inside the platform's lease; this layer additionally refuses anything
   * the census cannot attribute to the target pid.
   */
  async resize(size: PanelSize): Promise<PanelMeasurement> {
    return this.#resize("resize", size);
  }

  async #resize(op: "resize" | "restore", size: PanelSize): Promise<PanelMeasurement> {
    this.#requireMutationAllowed(op);
    const resolution = this.#resolve();
    const { target, window } = resolution;
    if (target.surface.attribution !== "owned" || target.surface.frame === null) {
      throw new PanelError(
        "unproven",
        `the resolved panel's pid attribution is "${target.surface.attribution}", not "owned"; ` +
          "resizing it could act on another After Effects instance — refused before any mutation",
      );
    }
    if (window.frame == null) {
      throw new PanelError("not-found", "the resolved window lost its frame before resize");
    }
    let applied: boolean;
    try {
      applied = this.#ops.resizePanel({ ...window, frame: window.frame }, size);
    } catch (error) {
      // A GuiMutationError means the platform mutation may have partially
      // applied — the honest code is `indeterminate`, and the caller must
      // re-observe before any retry. Anything else means the mutation
      // never ran (lease, session, identity) → `unavailable`.
      throw asPanelError(
        error,
        error instanceof GuiMutationError ? "indeterminate" : "unavailable",
      );
    }
    if (!applied) {
      throw new PanelError(
        "refused",
        "the platform resize reported the window changed or vanished between " +
          "resolution and mutation; nothing was resized — re-resolve and retry",
      );
    }
    this.#requestedSize = size;
    if (this.#settleMs > 0) {
      await this.#sleep(this.#settleMs);
    }
    return this.measure();
  }

  /** Restore the frame first observed by this controller. Same gate as resize. */
  async restore(): Promise<PanelMeasurement> {
    this.#requireMutationAllowed("restore");
    if (this.#originalFrame === null) {
      throw new PanelError(
        "not-found",
        "no panel has been resolved by this controller yet; there is no original frame to restore",
      );
    }
    const size: PanelSize = {
      width: this.#originalFrame.width,
      height: this.#originalFrame.height,
    };
    const measurement = await this.#resize("restore", size);
    this.#requestedSize = null;
    return { ...measurement, matchesRequested: null };
  }

  /**
   * Capture the resolved panel as an `original` artifact. The vehicle is
   * the window number when the census supplied one and the surface is on
   * screen (least leakage); otherwise the frame region. The artifact
   * records target, operation id, geometry and hashes — a derived image
   * is never produced by this slice.
   */
  capture(): PanelCapture {
    const resolution = this.#resolve();
    const { target } = resolution;
    if (target.surface.attribution !== "owned") {
      throw new PanelError(
        "unproven",
        `the resolved panel's pid attribution is "${target.surface.attribution}"; ` +
          "a capture of it could photograph another instance's window — refused",
      );
    }
    const operationId = this.#newOperationId();
    const dir = join(this.#artifactDir, "panels");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${operationId}.png`);
    const windowNumber = target.surface.windowNumber;
    const useWindowCapture =
      windowNumber !== null && target.surface.state.onScreen !== false;
    try {
      if (useWindowCapture) {
        this.#ops.captureWindow(path, windowNumber);
      } else {
        this.#ops.captureRegion(path, target.surface.frame);
      }
    } catch (error) {
      // A failed capture (TCC denial, screencapture error, session entry)
      // is an honest `unavailable` — never an empty artifact.
      throw asPanelError(error, "unavailable");
    }
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new PanelError(
        "unavailable",
        `the capture reported success but ${path} does not exist`,
      );
    }
    const pixelSize = pngPixelSize(path);
    const frameSize: PanelSize = {
      width: target.surface.frame.width,
      height: target.surface.frame.height,
    };
    // backingScale is proven only when the image is a decodable PNG whose
    // pixel size is an exact multiple of the point frame; anything else
    // stays null rather than guessed.
    const backingScale =
      pixelSize !== null &&
      frameSize.width > 0 &&
      pixelSize.width % frameSize.width === 0 &&
      pixelSize.height % frameSize.height === 0
        ? pixelSize.width / frameSize.width
        : null;
    return {
      kind: "original",
      operationId,
      vehicle: useWindowCapture ? "window" : "region",
      target,
      capturedAt: this.#now().toISOString(),
      geometry: {
        frame: target.surface.frame,
        coordinateSpace: "points-top-left",
        backingScale,
        occlusion: target.surface.state.occluded,
        // Both vehicles scope the capture to the target's own frame or
        // window; overlapping surfaces inside that scope are the honest
        // "region" leakage this slice reports.
        leakage: "region",
      },
      original: {
        path,
        sha256: sha256File(path),
        bytes: statSync(path).size,
        pixelSize,
      },
      derived: null,
    };
  }
}
