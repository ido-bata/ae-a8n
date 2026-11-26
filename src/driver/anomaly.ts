/**
 * Anomaly classification for the standard lifecycle (#342, parent program
 * #337 US-A1).
 *
 * A timed-out or blocked call is classified into one anomaly kind so the
 * trace, the recovery evidence manifest and the caller-facing error all
 * name the same thing. The classes mirror what the platform can actually
 * prove today:
 *
 *   - `known-safe-modal` — a measured `auto-safe` dialog class; the only
 *     kind automation may press.
 *   - `expected-modal` — a window a session-registered expectation
 *     classified (#342); resolution is the registrant's, not the taxonomy's.
 *   - `human-required-modal` / `unpressable-dialog` — measured classes
 *     that belong to a human decision; never pressed.
 *   - `unknown-modal` — an unmeasured blocking window; quarantined.
 *   - `process-gone` / `host-unresponsive` / `comms-lost` / `host-busy` —
 *     host-level states from the transport's own evidence.
 *   - `cep-anomaly` — a CEP/CEPHtmlEngine fault. Nothing detects this
 *     automatically yet: it is only ever reported from diagnostics
 *     evidence (#336 owns the collector sources), never guessed.
 *   - `unknown` — the honest remainder.
 *
 * This module is pure: it maps already-collected facts to a kind. It
 * never inspects windows, processes or pixels itself.
 */

import type { HostCondition } from "./driver.js";

export type AnomalyKind =
  | "known-safe-modal"
  | "expected-modal"
  | "human-required-modal"
  | "unpressable-dialog"
  | "unknown-modal"
  | "process-gone"
  | "host-unresponsive"
  | "comms-lost"
  | "host-busy"
  | "cep-anomaly"
  | "unknown";

/** The dialog-tier facts the classifier may read (taxonomy vocabulary). */
export type AnomalyDialogTier =
  | "auto-safe"
  | "human-required"
  | "report-only"
  | "unknown";

export type AnomalyInput = {
  /** The transport-level host condition, when one was classified. */
  readonly hostCondition?: HostCondition | undefined;
  /** The blocking window's taxonomy tier, when a window was classified. */
  readonly dialogTier?: AnomalyDialogTier | undefined;
  /** The registered expectation name, when one classified the window. */
  readonly expectedModal?: string | undefined;
  /** Explicit kind for evidence-driven callers (e.g. diagnostics → cep-anomaly). */
  readonly reported?: AnomalyKind | undefined;
};

/**
 * Maps collected facts to one anomaly kind. Precedence is deliberate:
 * an explicit `reported` kind wins (it carries evidence the classifier
 * cannot see), then a registered expectation (it re-classifies the window
 * by contract), then the window tier, then the host condition.
 */
export function classifyAnomaly(input: AnomalyInput): AnomalyKind {
  if (input.reported !== undefined) {
    return input.reported;
  }
  if (input.expectedModal !== undefined) {
    return "expected-modal";
  }
  switch (input.dialogTier) {
    case "auto-safe":
      return "known-safe-modal";
    case "human-required":
      return "human-required-modal";
    case "report-only":
      // A report-only window is informational; the anomaly is whatever
      // the host condition says, not the window.
      break;
    case "unknown":
      return "unknown-modal";
    default:
      break;
  }
  switch (input.hostCondition) {
    case "gone":
      return "process-gone";
    case "unresponsive":
      return "host-unresponsive";
    case "modal":
      // A blocking window was seen but its tier was not carried here;
      // "modal" alone cannot say which kind, so stay honest.
      return "unknown-modal";
    case "unknown":
    default:
      return "unknown";
  }
}
