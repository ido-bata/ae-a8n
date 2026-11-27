/**
 * OS-independent capability matrix for GUI evidence (#377, spec §6.3 T0
 * and §14). Emission is pure: the matrix states what this build can do
 * and — honestly — the strongest verification level behind each claim.
 * Nothing here performs an OS call, and nothing may report a higher
 * level than the evidence supports: a capability whose only proof is a
 * contract test says `"automated test"`, and one with no implementation
 * says `"unsupported"`/`"unavailable"` with the reason attached.
 */

import type { PanelCapability } from "../panels/types.js";

export type GuiEvidenceCapability = PanelCapability;

export type GuiEvidenceCapabilities = {
  readonly platform: "darwin" | "win32";
  /** The `ae-a8n.gui-evidence/v1` index itself: schema, IO, merge. */
  readonly index: GuiEvidenceCapability;
  /** Still captures bound into `EvidenceArtifact` records. */
  readonly screenStill: GuiEvidenceCapability;
  /** Bounded screen recording segments. */
  readonly screenRecording: GuiEvidenceCapability;
  /** Render-channel artifact records (`render-frame`/`render-sequence`). */
  readonly renderEvidence: GuiEvidenceCapability;
};

/** The verification level every evidence claim carries until real-host proof. */
const CONTRACT_TESTED: GuiEvidenceCapability["verification"] = "automated test";

/**
 * What this build supports for GUI evidence on `platform`. Windows has
 * a recording vehicle (the WGC helper, #384) but no still-capture
 * vehicle yet; the index contract is platform-neutral and its screen
 * artifacts are populated only where a backend exists.
 */
export function guiEvidenceCapabilities(
  platform: NodeJS.Platform,
): GuiEvidenceCapabilities {
  const index: GuiEvidenceCapability = {
    support: "implemented",
    verification: CONTRACT_TESTED,
    reason: null,
  };
  if (platform !== "darwin") {
    const unsupported: GuiEvidenceCapability = {
      support: "unsupported",
      verification: "implemented",
      reason:
        "no screen capture or recording vehicle is implemented on this " +
        "platform; the evidence index contract is platform-neutral but " +
        "cannot be populated with screen artifacts here",
    };
    return {
      platform: platform === "win32" ? "win32" : "darwin",
      index,
      screenStill: unsupported,
      screenRecording: {
        support: "partial",
        verification: CONTRACT_TESTED,
        reason:
          "the WGC backend is implemented (#384): a PowerShell+C# " +
          "Windows.Graphics.Capture → MediaFoundation helper records " +
          "window (HWND) and display/monitor scopes to H.264 .mp4, with " +
          "a declared ffmpeg gdigrab fallback for session scope. " +
          "Region scope has no vehicle, every Windows row stays " +
          "unverified (no real-host lane), and window capture can still " +
          "be refused per-window (protected content / UIPI) as " +
          "window-not-capturable",
      },
      renderEvidence: {
        support: "partial",
        verification: CONTRACT_TESTED,
        reason:
          "comp.renderFrame binds its PNG into the index as a " +
          "render-frame artifact with requestId/segment join and " +
          "coverage accounting (#385); artifactsDir discovery covers " +
          "the renderFrame naming pattern only — arbitrary render-queue " +
          "outputs are not guessed, and real-host render verification " +
          "is still pending",
      },
    };
  }
  return {
    platform: "darwin",
    index,
    screenStill: {
      support: "partial",
      verification: CONTRACT_TESTED,
      reason:
        "panel.capture binds capture/captureRegion/captureWindowById " +
        "output into screen-still EvidenceArtifact records (#380); " +
        "display/session scopes and direct (non-panel) capture ops are " +
        "not exposed, and real-host capture verification is still pending",
    },
    screenRecording: {
      support: "partial",
      verification: CONTRACT_TESTED,
      reason:
        "the record.start/stop lifecycle (#381) is backed on darwin by " +
        "the #382 recorder: screen-record.swift (ScreenCaptureKit " +
        "SCStream → .mov) with a screencapture -V fallback tier, always " +
        "inside the attested target session. SCStream delivery under " +
        "runInSession, TCC prompts, fps and finalize-on-signal are " +
        "unverified on a real host; display/session scopes still refuse " +
        "until recording authorization exists (#383)",
    },
    renderEvidence: {
      support: "partial",
      verification: CONTRACT_TESTED,
      reason:
        "comp.renderFrame binds its PNG into the index as a " +
        "render-frame artifact with requestId/segment join and " +
        "coverage accounting (#385); artifactsDir discovery covers " +
        "the renderFrame naming pattern only — arbitrary render-queue " +
        "outputs are not guessed, and real-host render verification " +
        "is still pending",
    },
  };
}
