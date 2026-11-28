/**
 * GUI probe contract and observation→blocking mapping (#281,
 * specs/gui-supervision/spec.md §Observation).
 *
 * A probe is the OS-native eye supervision uses. It must work while AE's
 * own execution path is dead, and it must be honest about its own failure:
 * a probe that cannot see returns `failed`, which the monitor records as
 * degraded observation — never as a clean screen.
 *
 * The mapping from raw windows to `SupervisionWindow` tiers is pure and
 * classifier-injected, so the same contract serves macOS (AX/WindowServer)
 * and Windows (Win32/UIA) probes.
 */

import {
  classifyDialog,
  isHumanOnlyWindow,
  type DialogWindow,
} from "../platform/recovery-policy.js";
import type { DialogReading } from "../platform/dialog-reading.js";
import {
  extractDialogContent,
  type StructuredDialogContent,
} from "../platform/dialog-taxonomy.js";
import type {
  BlockingInfo,
  DialogTier,
  HostLevelState,
  SupervisionWindow,
} from "./types.js";

/**
 * Structured census counts behind the `degraded[]` strings (#452). The
 * numbers a consumer needs to tell "the host is alive but its screen is
 * unusable to the accessibility layer" from an ordinary silent host,
 * without parsing prose. Optional on the snapshot: a probe with no
 * second census — or a platform whose observation is single-source —
 * omits it, and a consumer reading `undefined` must treat the census as
 * unproven, never as "no windows".
 */
export type ProbeCensus = {
  /** Whether the OS window census ran at all. */
  readonly available: boolean;
  /** Windows the census attributes to the target pid. */
  readonly windowCount: number;
  /** Of those, the ones currently on screen. */
  readonly onScreenCount: number;
  /**
   * On-screen census windows no listed window accounts for (#321):
   * surfaces the OS shows that the listing cannot see.
   */
  readonly unaccountedWindowCount: number;
  /**
   * Listing windows the census attributes to the target pid — the count
   * behind `windows` before any synthetic blocking entries the probe
   * added for unobservable surfaces.
   */
  readonly attributedWindowCount: number;
  /**
   * The listing reported zero attributable windows while the census
   * lists some for the pid (the `axSuspect` shape, #322/#330): an
   * unobservable or untrusted listing. Suspect *evidence*, not a
   * verdict — the probe's own grace and confirmation rules already
   * decided whether it may block, and consumers must not upgrade it.
   */
  readonly listingSuspect: boolean;
};

/** What one probe observation produced. */
export type ProbeSnapshot =
  | {
      readonly ok: true;
      /** Every top-level window the OS attributes to the target pid. */
      readonly windows: readonly DialogWindow[];
      /** Host-level state the probe could prove; "unknown" when it cannot. */
      readonly host: HostLevelState;
      /** Whether the target process is frontmost, when known. */
      readonly frontmost?: boolean;
      /** Degradation notes (e.g. census unavailable, AX suspect). */
      readonly degraded?: readonly string[];
      /**
       * The census/AX counts behind `degraded[]` and `windows` (#452),
       * when the probe has a second census to report. Absent means
       * unproven — never "zero windows".
       */
      readonly census?: ProbeCensus;
    }
  | {
      readonly ok: false;
      /** Why observation failed; becomes the degraded/monitor evidence. */
      readonly reason: string;
    };

/** The OS-native eye. Implementations must not throw for expected failure. */
export interface GuiProbe {
  observe(): ProbeSnapshot | Promise<ProbeSnapshot>;
  /**
   * On-demand dialog readings (#462, specs/dialog-perception/spec.md):
   * one `DialogReading` per AX∪census surface, including honest
   * `unreadable` answers. Optional — a probe without perception support
   * omits it, and consumers must treat absence as "readings unproven",
   * never as "no dialogs". Pull-based by contract: the monitor's
   * `observe()` tick never calls this, because pixel acquisition + OCR
   * are bounded-but-slow (tens of seconds per surface) and must never
   * block supervision.
   */
  readings?(): Promise<readonly DialogReading[]>;
}

/**
 * Tier for one window under the measured-class policy. Only `blocking`
 * windows get a meaningful tier; non-blocking windows are `report-only`
 * because they carry no decision.
 */
export function windowTier(window: DialogWindow): {
  readonly tier: DialogTier;
  readonly dialogClass: string | null;
  readonly code: string | null;
  readonly content: StructuredDialogContent;
} {
  // Structured content is extracted for every window: it is the honest
  // record of what the OS showed, including for windows that turn out not
  // to block. `dialogClass: null` + `tier: "unknown"` inside it means
  // unmeasured — the quarantine answer, never a guess.
  const content = extractDialogContent(window);
  if (!window.blocking) {
    return { tier: "report-only", dialogClass: null, code: null, content };
  }
  if (isHumanOnlyWindow(window)) {
    const known = classifyDialog(window);
    return {
      tier: "human-required",
      dialogClass: known.kind === "known" ? known.dialogClass.name : null,
      code: known.kind === "known" ? known.dialogClass.code : "A8N-PERM-004",
      content,
    };
  }
  const classified = classifyDialog(window);
  if (classified.kind === "known") {
    // The taxonomy tier is authoritative (#284): auto-safe is the only
    // pressable tier; human-required and report-only are never pressed.
    return {
      tier: classified.dialogClass.tier,
      dialogClass: classified.dialogClass.name,
      code: classified.dialogClass.code,
      content,
    };
  }
  return { tier: "unknown", dialogClass: null, code: "A8N-SEC-001", content };
}

/**
 * Turn a probe snapshot into `BlockingInfo`. `blocking` windows are those
 * the probe marked blocking; host-level state is carried through verbatim
 * — the probe is the only authority on what the OS showed.
 */
export function snapshotToBlocking(snapshot: Extract<ProbeSnapshot, { ok: true }>): BlockingInfo {
  const windows: SupervisionWindow[] = snapshot.windows.map((window) => {
    const tier = windowTier(window);
    return { ...window, ...tier };
  });
  const blocking = windows.filter((window) => window.blocking);
  const detail =
    snapshot.host !== "none" && snapshot.host !== "unknown"
      ? `host state: ${snapshot.host}`
      : blocking.length === 0
        ? "no blocking window observed"
        : `${blocking.length} blocking window(s): ${blocking
            .map((window) => window.dialogClass ?? window.title)
            .join(", ")}`;
  return { host: snapshot.host, windows, detail };
}

/** The worst host-level state across a snapshot and explicit overrides. */
export function mergeHostState(
  observed: HostLevelState,
  override: HostLevelState | undefined,
): HostLevelState {
  if (override === undefined || override === "none") {
    return observed;
  }
  // Explicit evidence outranks "none"; two non-none answers prefer the
  // more severe known state, and "unknown" never masks a proven one.
  const rank: Record<HostLevelState, number> = {
    none: 0,
    "busy-suspected": 1,
    "not-responding": 2,
    "gui-session-lost": 3,
    "process-gone": 4,
    unknown: 0,
  };
  if (observed === "unknown") {
    return override;
  }
  return rank[override] > rank[observed] ? override : observed;
}
