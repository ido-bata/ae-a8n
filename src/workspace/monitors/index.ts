/**
 * Multi-monitor / DPI pure logic for workspace restore (#370). No OS
 * access lives here — the census arrives through `WorkspaceSurfaceOps.
 * enumerateDisplays` (production: `src/platform/darwin/display-census.ts`
 * via `censusRunnerInSession`; tests: fakes), and every function is
 * deterministic geometry over `PanelFrame`/`MonitorDisplay`.
 */

import type { PanelFrame } from "../../panels/types.js";
import type {
  FrameMonitorInfo,
  MonitorCensus,
  MonitorDisplay,
  MonitorEvidence,
  MonitorTopology,
} from "./types.js";

function intersects(a: PanelFrame, b: PanelFrame): boolean {
  // Positive-area overlap only: a frame edge flush with a display edge
  // shares no area and must not count as crossing the boundary.
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** The displays one frame's area intersects, in census order. */
export function displaysForFrame(
  frame: PanelFrame,
  displays: readonly MonitorDisplay[],
): readonly MonitorDisplay[] {
  return displays.filter((d) => intersects(frame, d.bounds));
}

/**
 * Assess one frame against the display list. `pixelSize` is computed
 * only under a uniform, proven backing scale — a mixed-DPI or
 * scale-unknown crossing reports `null` rather than guessing which
 * display's pixels apply (spec §9: per-monitor DPI is per-display
 * evidence, not a blended number).
 */
export function assessFrameMonitors(
  frame: PanelFrame,
  displays: readonly MonitorDisplay[],
): FrameMonitorInfo {
  const touched = displaysForFrame(frame, displays);
  const ids = touched.map((d) => d.id);
  const scales = new Set(touched.map((d) => d.backingScaleFactor));
  // A null scale is "unproven", not "1.0": it must not silently agree
  // with a proven scale on another display.
  const mixedDpi =
    touched.length > 1 &&
    (scales.size > 1 || (scales.size === 1 && scales.has(null)));
  const uniformScale =
    touched.length > 0 && !mixedDpi && scales.size === 1
      ? touched[0]!.backingScaleFactor
      : null;
  const scale = uniformScale;
  return {
    displayIds: ids,
    crossesDisplays: touched.length > 1,
    mixedDpi,
    pixelSize:
      scale !== null && scale !== undefined && scale > 0
        ? {
            width: frame.width * scale,
            height: frame.height * scale,
          }
        : null,
    backingScaleFactor: scale ?? null,
  };
}

/** Classify the topology honestly: unknown census is never "single". */
export function classifyTopology(census: MonitorCensus): MonitorTopology {
  if (!census.available) {
    return {
      status: "unknown",
      displayCount: null,
      reason: census.reason,
    };
  }
  if (census.displays.length === 0) {
    return {
      status: "unknown",
      displayCount: 0,
      reason: "display census returned an empty display list",
    };
  }
  return {
    status: census.displays.length === 1 ? "single" : "multi",
    displayCount: census.displays.length,
    reason: null,
  };
}

/**
 * Build the `MonitorEvidence` section for one set of panel frames —
 * used by `verifyRestore` (current observation) and by
 * `WorkspaceController.monitorReport` (a fresh observe). Frames are
 * matched by rectangle intersection; a frame touching no display
 * (off-screen, another Space, or a census/geometry skew) gets an empty
 * `displayIds` and is still recorded — absence of a display match is
 * itself evidence, not an error.
 */
export function monitorEvidence(
  census: MonitorCensus,
  frames: readonly { readonly frame: PanelFrame; readonly title: string | null }[],
): MonitorEvidence {
  const displays = census.available ? census.displays : [];
  const assessed = frames.map((f) => ({
    frame: f.frame,
    title: f.title,
    monitor: assessFrameMonitors(f.frame, displays),
  }));
  return {
    topology: classifyTopology(census),
    frames: assessed,
    mixedDpiFrames: assessed
      .filter((a) => a.monitor.mixedDpi)
      .map((a) => ({ frame: a.frame, title: a.title })),
    censusAvailable: census.available,
  };
}

/** Narrow a platform census row (`DisplayInfo`) into the contract shape. */
export function toMonitorDisplay(info: {
  readonly id: string | number;
  readonly bounds: PanelFrame;
  readonly pixelSize: { readonly width: number; readonly height: number } | null;
  readonly backingScaleFactor: number | null;
  readonly isMain?: boolean | null;
}): MonitorDisplay {
  return {
    id: String(info.id),
    bounds: info.bounds,
    pixelSize: info.pixelSize,
    backingScaleFactor: info.backingScaleFactor,
    isMain: info.isMain ?? null,
  };
}
