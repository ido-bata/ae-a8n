/**
 * The one place the Windows backend's capabilities are declared.
 *
 * Both the probe result and the adapter answer from here, so a claim cannot
 * drift between the two. Nothing is set to `true` until the corresponding
 * proof is implemented and covered by a test.
 */

import type { Capabilities, TargetSpec } from "../contract.js";

export function windowsCapabilities(isolation: TargetSpec["isolation"]): Capabilities {
  return {
    nonInterference: isolation === "remote-host" ? "by-construction" : "unproven",
    // Ownership (pid and start time) is not measured by this backend yet; the
    // direct driver path proves it, but the isolated run has no such fact.
    provesOwnership: false,
    // T090: the agent writes a per-run marker and the controller verifies it
    // names this run, this job and this agent before a close path may quit.
    // This proves the run's delivery, not which AE instance a script reached;
    // the driver's own marker covers that when a run talks to AE directly.
    provesDestination: true,
    // T089 reports blocking states; it has no GUI automation and presses nothing.
    guiRecovery: false,
    sessionIdentity: "host-and-user",
    // The close path quits only after the per-run session marker names this
    // run, this job and this agent (T090); a marker that does not match
    // means nothing is quit. That is the owned-only invariant without a
    // pid/start-time ownership proof, which this backend still lacks.
    quitsOnlyOwned: true,
  };
}
