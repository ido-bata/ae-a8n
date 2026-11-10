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
    // names the run before close acts. Until that code and its tests land,
    // neither proof may be claimed.
    provesDestination: false,
    // T089 reports blocking states; it has no GUI automation and presses nothing.
    guiRecovery: false,
    sessionIdentity: "host-and-user",
  };
}
