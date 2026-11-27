/**
 * Multi-monitor / DPI workspace-restore contract (#370,
 * `specs/workspace-editing/spec.md` §8, §9 "Multi-monitor / DPI", §12 W4+;
 * parent #345 / program #337).
 *
 * This module is the namespaced home for everything #370 adds on top of
 * the W1 workspace slice (#363): display enumeration results, the
 * coordinate-space mapping between point frames and device pixels, and
 * the monitor-aware evidence a restore verification records.
 *
 * Coordinate-space rules this contract fixes:
 *
 *   - Census/AX/`PanelFrame` geometry is in **points**, global
 *     top-left origin (the macOS convention; Windows census is physical
 *     pixels and needs `GetDpiForWindow` — design only, see
 *     `monitorCapabilities`).
 *   - `CGDisplayBounds` gives each display's bounds in the same global
 *     point space, so a frame's display membership is a rectangle
 *     intersection — no transform needed on macOS.
 *   - `backingScaleFactor` (device px per point) converts a frame to
 *     device pixels **only when every display the frame touches agrees
 *     on the scale**. A frame straddling displays with different
 *     backing scales has no single pixel footprint; the honest answer
 *     is `pixelSize: null` + `mixedDpi: true`, never a guessed scale.
 *   - Frame equality tolerance stays in **points** (spec §10 waits are
 *     point-based); DPI awareness is *recorded evidence*, not a silent
 *     tolerance change. A mixed-DPI crossing is flagged so a reviewer
 *     can widen tolerance deliberately rather than have it implied.
 *
 * Honest limits: what AE itself does when a saved workspace's monitor
 * configuration does not match the current desktop (panel frames
 * straddling a boundary, a display missing, DPI changed) is
 * `unverified` on a real host — every capability this module feeds
 * reports `automated test` at most, and single-display hosts get the
 * honest `single` topology, not a fabricated multi-monitor pass.
 */

import type { PanelFrame } from "../../panels/types.js";

/** What the display census proved about the session's monitors. */
export type MonitorCensus =
  | { readonly available: true; readonly displays: readonly MonitorDisplay[] }
  | { readonly available: false; readonly reason: string };

/**
 * One display as restore evidence records it. Structurally identical to
 * the platform census row (`DisplayInfo`) but owned by this contract so
 * non-macOS adapters (Windows `EnumDisplayMonitors` +
 * `GetDpiForWindow`, when that lane lands) feed the same shape.
 */
export type MonitorDisplay = {
  /** Platform display identifier rendered as a string. */
  readonly id: string;
  /** Bounds in global screen points, top-left origin. */
  readonly bounds: PanelFrame;
  /** Native device pixels, when the platform reports them. */
  readonly pixelSize: { readonly width: number; readonly height: number } | null;
  /** Device pixels per point; `null` when unproven — never guessed. */
  readonly backingScaleFactor: number | null;
  /**
   * `true` for the display whose bounds start at the global origin —
   * the main-display convention on macOS. `null` when the platform
   * cannot prove it.
   */
  readonly isMain: boolean | null;
};

/** Single vs multi vs unknown display topology for one observation. */
export type MonitorTopology = {
  readonly status: "single" | "multi" | "unknown";
  /** Number of enumerated displays; `null` when the census was unavailable. */
  readonly displayCount: number | null;
  /** Why `unknown` — the census failure reason, or null otherwise. */
  readonly reason: string | null;
};

/**
 * Which displays one frame touches and what that means for DPI. A
 * frame is matched by rectangle intersection against display bounds —
 * edge-touching (zero-area overlap) does not count as crossing.
 */
export type FrameMonitorInfo = {
  /** Ids of every display whose bounds intersect the frame's area. */
  readonly displayIds: readonly string[];
  /** True when the frame's area intersects more than one display. */
  readonly crossesDisplays: boolean;
  /**
   * True when the intersected displays disagree on `backingScaleFactor`
   * (including one side being `null` while another is known — an
   * unproven scale is never treated as agreement).
   */
  readonly mixedDpi: boolean;
  /**
   * The frame's size in device pixels, or `null` when it cannot be
   * honestly computed: no display matched, or the matched displays
   * disagree on scale (`mixedDpi`). Computed as `frame * scale` in each
   * axis; `pixelSize` from the census is display-native resolution and
   * is not substituted for it.
   */
  readonly pixelSize: { readonly width: number; readonly height: number } | null;
  /** The uniform backing scale the pixel size rests on, or `null`. */
  readonly backingScaleFactor: number | null;
};

/**
 * The monitor/DPI section of a workspace observation or restore report.
 * Observe-class evidence: it records what the display census and the
 * panel frames showed, and flags the conditions under which a point-
 * space frame comparison may under- or over-state a real restore.
 */
export type MonitorEvidence = {
  readonly topology: MonitorTopology;
  /** Per-panel-frame display/DPI assessment, in observation order. */
  readonly frames: readonly {
    readonly frame: PanelFrame;
    readonly title: string | null;
    readonly monitor: FrameMonitorInfo;
  }[];
  /**
   * Frames whose `monitor.mixedDpi` is true — the subset a reviewer
   * must look at before trusting a `restored` verdict on a
   * mixed-resolution desktop.
   */
  readonly mixedDpiFrames: readonly {
    readonly frame: PanelFrame;
    readonly title: string | null;
  }[];
  /**
   * True when the census was unavailable — every frame assessment is
   * then empty and topology is `unknown`. Never silently "no issues".
   */
  readonly censusAvailable: boolean;
};
