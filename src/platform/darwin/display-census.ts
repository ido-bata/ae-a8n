/**
 * Display (monitor) census for macOS — the multi-monitor / DPI half of
 * workspace restore (#370, `specs/workspace-editing/spec.md` §8/§9
 * "Multi-monitor / DPI"; parent #345 / program #337).
 *
 * Why this exists: census+AX frames are in *points* in the global
 * top-left coordinate space, and a workspace's panel frames can straddle
 * display boundaries — a restore that "matches" in points can still be
 * wrong on a mixed-DPI desktop, and a frame's device-pixel footprint
 * depends on which display's backing scale applies. Restore verification
 * therefore needs the display list itself: bounds in points, native
 * pixel size, and `CGDisplayBackingScaleFactor` per display.
 *
 * The probe is read-only and session-scoped by the caller (it runs
 * through `runInSession`, like the window census and screencapture). It
 * needs a real Python 3 with ctypes — the Command Line Tools
 * interpreter, same as `window-census.ts`. When that is absent the
 * census reports `available: false` rather than guessing; consumers must
 * treat that as degraded observation, never as "one display".
 *
 * Honest limits (spec §9/§11): what AE does with a workspace whose saved
 * monitor configuration does not match the current desktop is
 * `unverified` on a real host. This module only enumerates what the
 * WindowServer reports; it proves nothing about AE's restore behavior.
 */

import { errorMessage } from "../../errors.js";
import { WINDOW_CENSUS_PYTHON, type CensusRunner } from "./window-census.js";

export { WINDOW_CENSUS_PYTHON };

/**
 * One display row, parsed. `bounds` is `CGDisplayBounds` — global
 * screen coordinates in points, top-left origin, with the main display's
 * top-left at (0,0). `pixelSize` is `CGDisplayPixelsWide/High` — the
 * display's native device pixels, which is what `bounds * scale`
 * approximates but is reported separately because the two can disagree
 * (e.g. scaled resolutions). `backingScaleFactor` is
 * `CGDisplayBackingScaleFactor` — device pixels per point.
 */
export type DisplayInfo = {
  /** `CGDirectDisplayID` rendered as a decimal string. */
  readonly id: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly pixelSize: {
    readonly width: number;
    readonly height: number;
  } | null;
  /** Device pixels per point; `null` when the probe could not read it. */
  readonly backingScaleFactor: number | null;
  /**
   * True when this display's bounds start at the global origin (0,0) —
   * the macOS convention for the main display. `null` is never produced
   * here; callers that cannot prove it say so in their own evidence.
   */
  readonly isMain: boolean;
};

export type DisplayCensus =
  | { readonly available: true; readonly displays: readonly DisplayInfo[] }
  | { readonly available: false; readonly reason: string };

/**
 * The probe itself. One pipe-delimited line per active display:
 *   id|x|y|width|height|pixelWidth|pixelHeight|backingScaleFactor
 * `CGGetActiveDisplayList` (option 0 semantics — active displays only,
 * mirroring what the WindowServer currently drives) replaces the online
 * flag with the active list, which is the set a workspace can actually
 * be restored onto.
 */
export const DISPLAY_CENSUS_SCRIPT = String.raw`
import ctypes
cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]
class CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]
class CGRect(ctypes.Structure):
    _fields_ = [("origin", CGPoint), ("size", CGSize)]

cg.CGGetActiveDisplayList.restype = ctypes.c_int32
cg.CGGetActiveDisplayList.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]
cg.CGDisplayBounds.restype = CGRect
cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
cg.CGDisplayPixelsWide.restype = ctypes.c_size_t
cg.CGDisplayPixelsWide.argtypes = [ctypes.c_uint32]
cg.CGDisplayPixelsHigh.restype = ctypes.c_size_t
cg.CGDisplayPixelsHigh.argtypes = [ctypes.c_uint32]
cg.CGDisplayBackingScaleFactor.restype = ctypes.c_double
cg.CGDisplayBackingScaleFactor.argtypes = [ctypes.c_uint32]

count = ctypes.c_uint32(0)
# Two-call pattern: first with a NULL list to learn the count.
err = cg.CGGetActiveDisplayList(0, None, ctypes.byref(count))
if err != 0:
    raise SystemExit("CGGetActiveDisplayList count failed: %d" % err)
n = count.value
if n == 0:
    raise SystemExit("no active displays")
arr = (ctypes.c_uint32 * n)()
count2 = ctypes.c_uint32(n)
err = cg.CGGetActiveDisplayList(n, arr, ctypes.byref(count2))
if err != 0:
    raise SystemExit("CGGetActiveDisplayList failed: %d" % err)
for i in range(count2.value):
    did = arr[i]
    r = cg.CGDisplayBounds(did)
    pw = cg.CGDisplayPixelsWide(did)
    ph = cg.CGDisplayPixelsHigh(did)
    scale = cg.CGDisplayBackingScaleFactor(did)
    def num(v):
        return ("%g" % v) if v == v else ""
    print("%d|%s|%s|%s|%s|%d|%d|%s" % (
        did, num(r.origin.x), num(r.origin.y), num(r.size.width), num(r.size.height),
        int(pw), int(ph), num(scale),
    ))
`;

function num(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse the census listing. Malformed lines are skipped. */
export function parseDisplayCensus(text: string): DisplayInfo[] {
  const displays: DisplayInfo[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const p = trimmed.split("|");
    if (p.length < 8) continue;
    const id = num(p[0]);
    const x = num(p[1]);
    const y = num(p[2]);
    const w = num(p[3]);
    const h = num(p[4]);
    if (id === null || x === null || y === null || w === null || h === null) {
      continue;
    }
    const pw = num(p[5]);
    const ph = num(p[6]);
    displays.push({
      id: String(Math.trunc(id)),
      bounds: { x, y, width: w, height: h },
      pixelSize:
        pw !== null && ph !== null && pw > 0 && ph > 0
          ? { width: pw, height: ph }
          : null,
      backingScaleFactor: num(p[7]),
      isMain: x === 0 && y === 0,
    });
  }
  return displays;
}

/**
 * Run the display census. `run` is the session-scoped exec seam —
 * production passes a `censusRunnerInSession`-bound function; tests pass
 * a stub. Any failure (missing interpreter, non-zero exit, unparseable
 * output) is `available: false`, which callers must treat as degraded
 * observation — never as "one display".
 */
export function displayCensus(
  run: CensusRunner,
  options: { pythonPath?: string } = {},
): DisplayCensus {
  const python = options.pythonPath ?? WINDOW_CENSUS_PYTHON;
  let stdout: string;
  try {
    stdout = run(python, ["-c", DISPLAY_CENSUS_SCRIPT]);
  } catch (error) {
    return {
      available: false,
      reason: `display census could not run (${python}): ${errorMessage(error)}`,
    };
  }
  try {
    const displays = parseDisplayCensus(stdout);
    if (displays.length === 0) {
      return { available: false, reason: "display census returned no displays" };
    }
    return { available: true, displays };
  } catch (error) {
    return {
      available: false,
      reason: `display census output was not parseable: ${errorMessage(error)}`,
    };
  }
}
