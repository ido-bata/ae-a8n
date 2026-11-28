/**
 * Honest input capability reporting (spec §7, #371/#372).
 *
 * The macOS helpers landed in #372 (`scripts/isolated-session/input-*.swift`
 * + `src/input/darwin.ts`) and the Windows helpers in #373
 * (`src/platform/windows/input-*-script.ts` + `input.ts`): they exist,
 * compile, and pass argument validation tests — `implemented`/
 * `automated test` — but every mutation path still sits behind the
 * closed gate and real delivery is unverified on both OSes (no real
 * host lane for either). Nothing here may claim `verified on real
 * host`. When a platform helper's real-host evidence lands, its
 * ticket updates the corresponding row.
 */

import type { InputPlatform } from "./types.js";

/** Support honesty, mirroring `PanelCapability` plus gate states. */
export type InputCapabilitySupport =
  /** Code exists and compiles; delivery unproven or gated. */
  | "implemented"
  /** Works for a subset (e.g. contract logic only, no OS delivery). */
  | "partial"
  /** No implementation in this slice. */
  | "unsupported"
  /** Implemented but gated off pending a safety decision. */
  | "unavailable"
  /** Blocked on a human/environment fact (e.g. no Japanese IME). */
  | "needs-human";

/**
 * Verification level, the repo taxonomy plus the input-specific
 * honest answers spec §7 requires: `unverified` (mechanism named,
 * delivery unproven) and `needs-human` is carried by `support`, while
 * `unsupported` combinations are explicit values, not omissions.
 */
export type InputVerification =
  | "implemented"
  | "automated test"
  | "fake/mock only"
  | "verified on real host"
  | "unverified"
  | "unsupported";

export type InputGateState = "open" | "closed" | "needs-human";

export type InputCapability = {
  readonly support: InputCapabilitySupport;
  readonly verification: InputVerification;
  /** Whether the safety gate currently lets this run at all. */
  readonly gate: InputGateState;
  /** Why support is not full, or what gates it — always present when not "implemented". */
  readonly reason: string | null;
};

/** Per-capability honesty record for input on one OS/session kind. */
export type InputCapabilities = {
  readonly platform: InputPlatform;
  /**
   * The session kind capabilities were evaluated for. Shared console
   * sessions are held to the stricter §5.4 rule; dedicated sessions
   * still need the explicit grant.
   */
  readonly sessionKind: "shared" | "dedicated" | "unknown";
  readonly focus: InputCapability;
  readonly keyPosting: InputCapability;
  readonly sequentialText: InputCapability;
  readonly directText: InputCapability;
  readonly selectionOps: InputCapability;
  readonly clipboard: InputCapability;
  readonly mouseExtended: InputCapability;
  readonly imeMode: InputCapability;
  readonly compositionObserve: InputCapability;
  readonly osImeEndToEnd: InputCapability;
  readonly globalInputAuthorization: InputCapability;
};

const CLOSED_REASON =
  "the A-SAFETY input gate (docs/gui-supervision-safety-gates.md) has " +
  "cleared no input class and global-input authorization has no grant " +
  "path; platform helpers exist at implemented/automated-test level at " +
  "best and nothing is verified on a real host; the contract and gate " +
  "logic are implemented and fake-tested, delivery is not proven";

const DARWIN_HELPER_REASON =
  "macOS helpers implemented (#372): scripts/isolated-session/input-*.swift " +
  "+ src/input/darwin.ts over runInSession — compile/validation tested, " +
  "real delivery unverified, gate closed";

function gated(verification: InputVerification, reason: string): InputCapability {
  return { support: "unavailable", verification, gate: "closed", reason };
}

function unsupported(reason: string): InputCapability {
  return { support: "unsupported", verification: "unverified", gate: "closed", reason };
}

/**
 * The capability report for `platform` in `sessionKind`. Both OSes
 * now report helper rows at `implemented`/`automated test` (#372
 * darwin, #373 win32) with every gate closed and real delivery
 * unverified. OS-specific mechanism notes from spec
 * §7 (CGEvent/SendInput/TIS/TSF) live in `reason` strings so the
 * report stays truthful about *why* nothing runs.
 */
export function inputCapabilities(
  platform: InputPlatform,
  sessionKind: InputCapabilities["sessionKind"] = "unknown",
): InputCapabilities {
  const caps = inputCapabilitiesBase(platform, sessionKind);
  if (platform !== "win32") {
    return caps;
  }
  // #373 landed the Windows delivery helpers (`src/platform/windows/
  // input-*-script.ts` + `input.ts`): SendInput key/text/mouse posting,
  // Win32 clipboard, TSF profile query/activate, and GetGUIThreadInfo +
  // UIA focus readback/request. They are `implemented` +
  // `automated test` (script validation, fake-channel behavior) —
  // delivery itself is UNVERIFIED because no Windows host lane exists,
  // and every row keeps `gate: "closed"` because `inputMutationGate()`
  // still refuses all classes. Rows #373 does not cover
  // (composition-observe, os-IME end-to-end, global authorization)
  // keep their base values.
  return {
    ...caps,
    focus: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "GetGUIThreadInfo + UIA FocusedElement readback and a UIA " +
        "SetFocus/SetForegroundWindow request exist in " +
        "src/platform/windows/input-focus-script.ts, fake-channel " +
        "tested; delivery and UIPI/foreground-lock behavior are " +
        "unverified — no Windows host lane",
    },
    keyPosting: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "SendInput VK/scan/KEYEVENTF posting exists in " +
        "src/platform/windows/input-send-script.ts with modifier " +
        "readback; UIPI/integrity interaction and real delivery are " +
        "unverified — no Windows host lane",
    },
    sequentialText: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "per-char VK events through the same SendInput helper are the " +
        "Tier-1b candidate; characters without a VK mapping refuse " +
        "honestly; pacing is unimplemented and real-IME pass-through " +
        "is unverified",
    },
    directText: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "KEYEVENTF_UNICODE bulk posting exists and is explicitly the " +
        "IME-bypassing direct-entry channel — labelled, never Tier-1b " +
        "evidence (spec §4.2); delivery unverified",
    },
    selectionOps: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "select/replace/delete are modifier+key combos over the same " +
        "SendInput poster; selection readback coverage per control is " +
        "unverified",
    },
    clipboard: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "Win32 clipboard read/write exists in " +
        "src/platform/windows/input-clipboard-script.ts with " +
        "save/restore records; only the text flavor is restorable and " +
        "shared-state authorization still gates it",
    },
    mouseExtended: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "SendInput mouse move/down/up/wheel exists for click/drag/" +
        "scroll/hover; coordinates must come from the re-verified " +
        "element frame and multi-monitor absolute posting is " +
        "unimplemented — delivery unverified",
    },
    imeMode: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "TSF ITfInputProcessorProfileMgr query/list/activate/" +
        "deactivate exists in src/platform/windows/input-ime-script.ts " +
        "(COM interop, GUIDs per msctf.idl); a machine without a " +
        "Japanese IME reports unavailable — needs-human until a real " +
        "host answers, and activation behavior is unverified",
    },
  };
}

function inputCapabilitiesBase(
  platform: InputPlatform,
  sessionKind: InputCapabilities["sessionKind"],
): InputCapabilities {
  const osNote =
    platform === "darwin"
      ? "macOS candidates: CGEventCreateKeyboardEvent/CGEventPost, " +
        "CGEventPostToPid (IME behavior unverified — T001), NSPasteboard, " +
        "TIS input sources; requires Accessibility/Input-Monitoring grant"
      : "Windows candidates: SendInput, Win32 clipboard, TSF " +
        "ITfInputProcessorProfileMgr; UIPI/integrity interaction unstudied; " +
        "no CGEventPostToPid analog exists";

  const caps: InputCapabilities = {
    platform,
    sessionKind,
    focus: {
      support: "partial",
      verification: "automated test",
      gate: "closed",
      reason:
        "the three-step focus proof logic is implemented and tested " +
        "against fake focus-holder readbacks (src/input/focus.ts); OS " +
        "focus request/readback delivery is unverified — " +
        `${osNote}`,
    },
    keyPosting: unsupported(
      `no key-event posting implementation exists in this slice; ${osNote}`,
    ),
    sequentialText: unsupported(
      `per-char IME-path entry needs the key poster plus pacing; ${osNote}`,
    ),
    directText: unsupported(
      `direct/bulk entry (clipboard+paste or unicode post) is labelled ` +
        `direct-entry and is never IME evidence (spec §4.2); ${osNote}`,
    ),
    selectionOps: unsupported(
      `select/replace/delete are modifier+key combos over the session ` +
        `stream plus selection readback; ${osNote}`,
    ),
    clipboard: gated(
      "implemented",
      "clipboard save/restore record logic is implemented and tested; " +
        "NSPasteboard/Win32 delivery is not — shared-state gate applies",
    ),
    mouseExtended: {
      support: "partial",
      verification: "automated test",
      gate: "closed",
      reason:
        "click delivery exists for dialog recovery but drag/scroll/hover " +
        "are new and unverified; coordinates must come from the " +
        "re-verified element frame, never remembered positions",
    },
    imeMode: gated(
      "unverified",
      "IME mode select/query needs an installed Japanese IME and the " +
        "platform helper (TIS on macOS, TSF on Windows); a machine " +
        "without one reports unavailable — a valid answer, not a failure",
    ),
    compositionObserve: {
      support: "unsupported",
      verification: "implemented",
      gate: "closed",
      reason:
        "the Tier-1a contract exists (fixture self-report primary, CDP " +
        "feasibility unverified, AX marked-text best-effort); no fixture " +
        "panel or CDP investigation has run yet — real-host only",
    },
    osImeEndToEnd: {
      support: "unsupported",
      verification: "unverified",
      gate: "needs-human",
      reason:
        "the Tier-1b OS-IME end-to-end claim requires a real host with a " +
        "Japanese IME; blocked the same class as #339 until an owned AE " +
        "launch is possible — CDP/DOM-value shortcuts are forbidden " +
        "evidence (spec §4.2)",
    },
    globalInputAuthorization: {
      support: "unavailable",
      verification: "automated test",
      gate: "closed",
      reason:
        sessionKind === "shared"
          ? "shared console session: session-stream and shared-state " +
            "input can land in a foreign app if focus proof is wrong; " +
            "requires an explicit target-scoped grant plus the A-SAFETY " +
            "input gate — " + CLOSED_REASON
          : "requiresGlobalInputAuthorization is enforced by " +
            "inputAuthorizationVerdict (token/scope required, " +
            "unavailable-not-silent-noop) and inputMutationGate() " +
            "refuses all classes today — " + CLOSED_REASON,
    },
  };

  // #372 landed the macOS helpers: rows that were `unsupported` become
  // `implemented`/`automated test` with the gate still closed. Windows
  // rows are overridden by the caller (#373) after this base returns.
  if (platform !== "darwin") {
    return caps;
  }
  return {
    ...caps,
    focus: {
      ...caps.focus,
      reason:
        "focus readback helper implemented (input-focus.swift: " +
        "AXFocusedUIElement/AXFocusedWindow/kAXFocused path) plus the " +
        "fake-tested three-step proof; focus *request* is not " +
        "implemented, so session-stream ops still refuse focus-unproven — " +
        DARWIN_HELPER_REASON,
    },
    keyPosting: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "CGEventCreateKeyboardEvent/CGEventPost helpers implemented " +
        "(input-post.swift, kCGHIDEventTap/kCGSessionEventTap) with " +
        "modifier-flag tracking; whether posting traverses the " +
        "input-method stack is the unverified Tier-1b question — " +
        DARWIN_HELPER_REASON,
    },
    sequentialText: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "per-character unicode posting implemented (input-post type); " +
        "IME-path delivery unverified — " + DARWIN_HELPER_REASON,
    },
    directText: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "NSPasteboard write + bulk unicode post implemented; labelled " +
        "direct-entry and never IME evidence (spec §4.2) — " +
        DARWIN_HELPER_REASON,
    },
    selectionOps: {
      support: "partial",
      verification: "automated test",
      gate: "closed",
      reason:
        "modifier+key combos ride the key poster; selection readback " +
        "(AXSelectedTextRange) is not implemented — " + DARWIN_HELPER_REASON,
    },
    clipboard: {
      support: "implemented",
      verification: "automated test",
      gate: "closed",
      reason:
        "NSPasteboard snapshot/write/restore implemented with " +
        "promised-flavor capture and private stash restore; " +
        "shared-state gate applies — " + DARWIN_HELPER_REASON,
    },
    imeMode: {
      support: "needs-human",
      verification: "implemented",
      gate: "closed",
      reason:
        "TIS input-source helpers implemented (input-source.swift: " +
        "current/list/select); selecting needs an installed Japanese " +
        "input source — a machine without one reports unavailable, a " +
        "valid answer — " + DARWIN_HELPER_REASON,
    },
  };
}
