/**
 * Honest input capability reporting (spec §7, #371).
 *
 * Every value here is a contract-level claim and nothing more: the
 * delivery helpers do not exist yet (#372 macOS / #373 Windows), no
 * real host has been touched, and the mutation gate is closed. The
 * report therefore says `unsupported`/`unavailable`/`needs-human`
 * with reasons — never `verified on real host`. When a platform
 * helper lands, its ticket updates the corresponding row with the
 * evidence it actually has.
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
  "cleared no input class and no OS posting helper exists yet " +
  "(#372 macOS / #373 Windows); the contract and gate logic are " +
  "implemented and fake-tested, delivery is not";

function gated(verification: InputVerification, reason: string): InputCapability {
  return { support: "unavailable", verification, gate: "closed", reason };
}

function unsupported(reason: string): InputCapability {
  return { support: "unsupported", verification: "unverified", gate: "closed", reason };
}

/**
 * The capability report for `platform` in `sessionKind`. Both OSes
 * report the same honest shape today: contract implemented, delivery
 * unimplemented, gate closed. OS-specific mechanism notes from spec
 * §7 (CGEvent/SendInput/TIS/TSF) live in `reason` strings so the
 * report stays truthful about *why* nothing runs.
 */
export function inputCapabilities(
  platform: InputPlatform,
  sessionKind: InputCapabilities["sessionKind"] = "unknown",
): InputCapabilities {
  const osNote =
    platform === "darwin"
      ? "macOS candidates: CGEventCreateKeyboardEvent/CGEventPost, " +
        "CGEventPostToPid (IME behavior unverified — T001), NSPasteboard, " +
        "TIS input sources; requires Accessibility/Input-Monitoring grant"
      : "Windows candidates: SendInput, Win32 clipboard, TSF " +
        "ITfInputProcessorProfileMgr; UIPI/integrity interaction unstudied; " +
        "no CGEventPostToPid analog exists";

  return {
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
}
