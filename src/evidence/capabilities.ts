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
 * What this build supports for GUI evidence on `platform`. Windows is
 * deliberately all-unsupported for screen channels: no capture or
 * recording vehicle exists there (spec §4.2), and the index contract is
 * platform-neutral but its screen artifacts cannot be produced.
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
          "the record.start/stop lifecycle is implemented (#381) against " +
          "a pluggable recorder seam, but no OS backend exists on this " +
          "platform — starts refuse until a backend (SCStream #382 / WGC " +
          "#384) registers",
      },
      renderEvidence: {
        support: "partial",
        verification: CONTRACT_TESTED,
        reason:
          "render-frame/render-sequence records are contract-only until " +
          "the E4 slice wires comp.renderFrame and render-queue outputs " +
          "into the index; the in-AE render path itself is host-provided",
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
        "the record.start/stop lifecycle is implemented (#381) against " +
        "a pluggable recorder seam, but no macOS backend exists yet " +
        "(ScreenCaptureKit is #382, screencapture -V its fallback tier) " +
        "— starts refuse until a backend registers",
    },
    renderEvidence: {
      support: "partial",
      verification: CONTRACT_TESTED,
      reason:
        "render-frame/render-sequence records are contract-only until " +
        "the E4 slice wires comp.renderFrame and render-queue outputs " +
        "into the index; the in-AE render path itself is host-provided",
    },
  };
}
