/**
 * WindowServer-level window census for macOS.
 *
 * Why this exists: the Accessibility API (`System Events` → `windows of
 * process`) is the primary observation channel for GUI recovery, but it is
 * not authoritative. A process can be alive, own real windows in the
 * WindowServer, and still answer AX with an empty tree — observed on a real
 * host 2026-11-15: After Effects 26.5.3 (pid-owned, state S, 0% CPU) owned
 * six WindowServer windows including a 525x377 dialog while
 * `count of windows` and `count of UI elements` both returned 0. A crash
 * repair dialog was on screen while every AX-based check reported "no
 * windows".
 *
 * The census asks the WindowServer directly (CGWindowListCopyWindowInfo via
 * CoreGraphics/COREFoundation ctypes) which windows exist and who owns
 * them. It sees windows on every Space, not only the on-screen one, which
 * is exactly what residue detection needs: a dialog parked on another
 * desktop is still a dialog.
 *
 * The probe is read-only and session-scoped by the caller (it runs through
 * `runInSession`, like screencapture). It needs a real Python 3 with
 * ctypes — the Command Line Tools interpreter. When that is absent the
 * census reports `available: false` rather than guessing; consumers must
 * treat that as degraded observation, never as "no windows".
 */

/** Real Python 3 shipped with the Xcode Command Line Tools — never the
 *  /usr/bin/python3 stub, which can raise an installer dialog when the CLT
 *  is missing. */
export const WINDOW_CENSUS_PYTHON =
  "/Library/Developer/CommandLineTools/usr/bin/python3";

export type WindowServerWindow = {
  readonly pid: number;
  readonly owner: string;
  readonly layer: number;
  /** 1 when the window is on the currently visible Space(s), else 0. */
  readonly onScreen: boolean;
  readonly name: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
};

export type WindowCensus =
  | { readonly available: true; readonly windows: readonly WindowServerWindow[] }
  | { readonly available: false; readonly reason: string };

/**
 * The probe itself. One pipe-delimited line per window:
 *   pid|owner|layer|onscreen|name|x|y|width|height
 * `optionAll` (0) is used so windows on other Spaces and minimized windows
 * are included — residue is residue wherever it is parked.
 */
export const WINDOW_CENSUS_SCRIPT = String.raw`
import ctypes
cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFDictionaryGetValue.restype = ctypes.c_void_p
cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
cf.CFNumberGetValue.restype = ctypes.c_bool
cf.CFNumberGetValue.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
cf.CFRelease.argtypes = [ctypes.c_void_p]
def cfstr(s):
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    return cf.CFStringCreateWithCString(None, s.encode(), 0x08000100)
def gs(d, k):
    kk = cfstr(k); v = cf.CFDictionaryGetValue(d, kk); cf.CFRelease(kk)
    if not v: return None
    b = ctypes.create_string_buffer(4096)
    if not cf.CFStringGetCString(v, b, 4096, 0x08000100): return ""
    return b.value.decode("utf-8", "replace")
def gn(d, k):
    kk = cfstr(k); v = cf.CFDictionaryGetValue(d, kk); cf.CFRelease(kk)
    if not v: return None
    o = ctypes.c_double()
    return o.value if cf.CFNumberGetValue(v, 13, ctypes.byref(o)) else None
def clean(s):
    return (s or "").replace("|", " ").replace("\n", " ").replace("\r", " ")
arr = cg.CGWindowListCopyWindowInfo(0, 0)
n = cf.CFArrayGetCount(arr)
for i in range(n):
    w = cf.CFArrayGetValueAtIndex(arr, i)
    pid = gn(w, "kCGWindowOwnerPID")
    layer = gn(w, "kCGWindowLayer")
    ons = gn(w, "kCGWindowIsOnscreen")
    kb = cfstr("kCGWindowBounds"); bd = cf.CFDictionaryGetValue(w, kb); cf.CFRelease(kb)
    vals = {}
    if bd:
        for kk in ("X", "Y", "Width", "Height"):
            k2 = cfstr(kk); v2 = cf.CFDictionaryGetValue(bd, k2); cf.CFRelease(k2)
            if v2:
                o = ctypes.c_double()
                if cf.CFNumberGetValue(v2, 13, ctypes.byref(o)): vals[kk] = o.value
    print("%s|%s|%s|%s|%s|%s|%s|%s|%s" % (
        int(pid) if pid is not None else -1,
        clean(gs(w, "kCGWindowOwnerName") or "?"),
        int(layer) if layer is not None else -2147483648,
        1 if ons == 1.0 else 0,
        clean(gs(w, "kCGWindowName") or ""),
        vals.get("X", ""), vals.get("Y", ""), vals.get("Width", ""), vals.get("Height", ""),
    ))
cf.CFRelease(arr)
`;

/** Parse the census listing. Unknown/malformed lines are skipped. */
export function parseWindowCensus(text: string): WindowServerWindow[] {
  const windows: WindowServerWindow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const p = trimmed.split("|");
    if (p.length < 9) continue;
    const pid = Number(p[0]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const num = (s: string | undefined): number | null => {
      if (s === undefined || s === "") return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };
    const x = num(p[5]); const y = num(p[6]);
    const w = num(p[7]); const h = num(p[8]);
    windows.push({
      pid,
      owner: p[1] ?? "?",
      layer: num(p[2]) ?? 0,
      onScreen: p[3] === "1",
      name: p[4] ?? "",
      bounds: x !== null && y !== null && w !== null && h !== null
        ? { x, y, width: w, height: h }
        : null,
    });
  }
  return windows;
}

/** Windows the WindowServer attributes to `pid`, across all Spaces. */
export function censusForPid(census: WindowCensus, pid: number): {
  readonly windowCount: number;
  readonly onScreenCount: number;
} {
  if (!census.available) return { windowCount: 0, onScreenCount: 0 };
  const mine = census.windows.filter((w) => w.pid === pid);
  return {
    windowCount: mine.length,
    onScreenCount: mine.filter((w) => w.onScreen).length,
  };
}

export type CensusRunner = (program: string, args: readonly string[]) => string;

/**
 * Run the census. `run` is the session-scoped exec seam — production passes
 * a `runInSession`-bound function; tests pass a stub. Any failure (missing
 * interpreter, non-zero exit, unparseable output) is `available: false`,
 * which callers must treat as degraded observation.
 */
export function windowServerCensus(
  run: CensusRunner,
  options: { pythonPath?: string } = {},
): WindowCensus {
  const python = options.pythonPath ?? WINDOW_CENSUS_PYTHON;
  let stdout: string;
  try {
    stdout = run(python, ["-c", WINDOW_CENSUS_SCRIPT]);
  } catch (error) {
    return {
      available: false,
      reason: `window census could not run (${python}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    return { available: true, windows: parseWindowCensus(stdout) };
  } catch (error) {
    return {
      available: false,
      reason: `window census output was not parseable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
