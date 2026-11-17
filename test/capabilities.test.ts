/**
 * Capability handshake (#102).
 *
 * Contract tests for `ae.capabilities()` and the negotiation / dispatch
 * helpers, structurally conforming to ae-devtools
 * `ae-devtools.capability-handshake/v1`. Everything runs against the fake
 * transport: this proves the advertisement's shape and the gate's refusals,
 * not that a real After Effects reports the same evidence — that stays
 * `fake/mock only` until a real-host run records it.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AfterEffects,
  assertDispatchAllowed,
  CAPABILITY_CONTRACT_SCHEMA,
  CAPABILITY_CONTRACT_VERSION,
  negotiateCapabilities,
} from "../src/index.js";
// Test-only surface: the built-in method table and its capability rows stay
// out of the package's public exports (they name internal host methods).
import {
  BUILTIN_HOST_METHODS,
  builtinCapabilityFor,
} from "../src/api/capabilities.js";
import { builtinMethodNames } from "../src/cli/extension.js";
import { buildHostScript } from "../src/extensions/manifest.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_SCRIPT = join(PACKAGE_ROOT, "host", "a8n-host.js");

let sessionRoot: string;
let transport: FakeAfterEffectsTransport;

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "a8n-cap-"));
  transport = new FakeAfterEffectsTransport();
});

afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
});

function launch(): Promise<AfterEffects> {
  return AfterEffects.launch({ sessionRoot, transport });
}

describe("capabilities() handshake", () => {
  it("returns a structurally conforming HandshakeResponse from live session evidence", async () => {
    transport.hostPidValue = 4242;
    transport.ownedProcessValue = {
      pid: 4242,
      startedAt: 1_700_000_000_000,
      executable: "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects",
    };
    const ae = await launch();
    const response = await ae.capabilities();

    expect(response.schema).toBe(CAPABILITY_CONTRACT_SCHEMA);
    expect(response.contractVersion).toEqual(CAPABILITY_CONTRACT_VERSION);
    expect(response.catalogRevision).toContain("ae-devtools@");
    expect(response.hostId).toBe("pid:4242");
    expect(response.host.ae?.version).toBe("26.0.0");
    expect(response.host.os).toBe(process.platform);
    expect(response.host.arch).toBe(process.arch);
    expect(response.host.executionMode).toBe("local");
    expect(response.host.transport).toBe("fake-in-process");
    // The spec Capability contract's host OS/user/session report (#129):
    // the fake attests no session, so every field stays null — never the
    // controller's account.
    expect(response.host.session).toEqual({ uid: null, asid: null, user: null });

    // The execution-mode guarantees: "local" is the stable shipping mode;
    // the fake stands in for the script transport, so calls need GUI
    // delivery and no console refusal is claimed.
    expect(response.execution).toEqual({
      mode: "local",
      stability: "stable",
      requiresGuiDelivery: true,
      refusesConsoleTarget: false,
    });
    expect(response.host.executionMode).toBe(response.execution.mode);

    expect(response.target.ownership).toBe("owned");
    expect(response.target.nonInterference).toBe("unproven");
    expect(response.target.identity).toContain("After Effects");
    // The attach-vs-owned distinction the canonical enum cannot express,
    // plus the quit invariant stated for consumers (#129).
    expect(response.target.ownershipKind).toBe("owned");
    expect(response.target.ownershipEvidence).toBe("fake transport");
    expect(response.target.quitPolicy).toBe("owned-only");

    expect(response.inventorySupply).toEqual({
      scripting: "not-supplied",
      tools: "not-supplied",
      sdk: "not-supplied",
    });

    const codes = response.diagnostics.map((d) => d.code);
    expect(codes).toContain("inventory-not-supplied");
    expect(codes).toContain("catalog-manifest-not-supplied");
    expect(codes).toContain("supported-release-set-not-recorded");
    expect(codes).not.toContain("ownership-unproven");

    await ae.close({ unsavedChanges: "discard" });
  });

  it("maps every built-in host method to an ae.operation.* advertisement", async () => {
    const ae = await launch();
    const response = await ae.capabilities();
    const byId = new Map(response.availableCapabilities.map((c) => [c.id, c]));

    expect(response.availableCapabilities).toHaveLength(BUILTIN_HOST_METHODS.length);
    for (const method of BUILTIN_HOST_METHODS) {
      const capability = builtinCapabilityFor(method);
      expect(capability, `no capability row for host method ${method}`).toBeDefined();
      const advertised = byId.get(capability!.id);
      expect(advertised, `no advertisement for ${capability!.id}`).toBeDefined();
      expect(advertised!.kind).toBe("semantic-operation");
      expect(advertised!.persistence).toBe("repository");
      expect(advertised!.implementation).toBe("implemented");
      expect(advertised!.verification).not.toBe("not-run");
      expect(advertised!.execution.canRemoteInvoke).toBe(true);
      expect(advertised!.execution.class).toBe("extendscript");
      expect(advertised!.proofLevel).not.toBe("unverified");
    }
    // No SDK or scripting-symbol claims: nothing is advertised that this
    // host cannot evidence.
    for (const capability of response.availableCapabilities) {
      expect(capability.id.startsWith("ae.operation.")).toBe(true);
    }
    await ae.close({ unsavedChanges: "discard" });
  });

  it("keeps the capability map in step with the host dispatch table", () => {
    const hostSource = readFileSync(HOST_SCRIPT, "utf-8");
    expect(new Set(BUILTIN_HOST_METHODS)).toEqual(new Set(builtinMethodNames(hostSource)));
  });

  it("advertises declared extension methods as discoverable but never dispatchable", async () => {
    const built = buildHostScript(readFileSync(HOST_SCRIPT, "utf-8"), [
      { name: "aulymo.buildScene", source: "function (params) { return params.name; }" },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const hostScript = join(sessionRoot, "ext-host.js");
    writeFileSync(hostScript, built.source);

    const ae = await AfterEffects.launch({ sessionRoot, transport, hostScript });
    const response = await ae.capabilities();
    // Canonical ae.tool.<project>.<operation>: slugged, lowercase segments.
    const extension = response.availableCapabilities.find((c) => c.id === "ae.tool.aulymo.buildscene");

    expect(extension).toBeDefined();
    expect(extension!.kind).toBe("tool-operation");
    expect(extension!.persistence).toBe("repository");
    expect(extension!.verification).toBe("not-run");
    expect(extension!.permissions).toEqual([]);

    // Discovery yes, capability-addressed dispatch no.
    const gate = assertDispatchAllowed({
      response,
      capabilityId: "ae.tool.aulymo.buildscene",
      permission: "read",
    });
    expect(gate.status).toBe("refused");
    if (gate.status === "refused") {
      expect(gate.reason).toBe("unverified");
    }
    // The existing extension contract is unchanged: declared name + owned.
    await expect(ae.call("aulymo.buildScene", { name: "x" })).resolves.toBe("x");
    await ae.close({ unsavedChanges: "discard" });
  });

  it("attests unknown ownership honestly and refuses capability dispatch", async () => {
    transport.ownershipKind = "unknown";
    const ae = await launch();
    const response = await ae.capabilities();

    expect(response.target.ownership).toBe("unknown");
    expect(response.diagnostics.map((d) => d.code)).toContain("ownership-unproven");
    expect(response.hostId).toMatch(/^a8n-session:/);

    const gate = assertDispatchAllowed({
      response,
      capabilityId: "ae.operation.app.version-info",
      permission: "read",
    });
    expect(gate.status).toBe("refused");
    if (gate.status === "refused") {
      expect(gate.reason).toBe("ownership-unproven");
    }
    await ae.close({ unsavedChanges: "discard" });
  });

  it("reports attached ownership as unknown — the canonical enum cannot express it", async () => {
    transport.ownershipKind = "attached";
    const ae = await launch();
    const response = await ae.capabilities();

    // "attached" means a pre-existing host that belongs to someone else;
    // claiming "explicitly-attached" would overstate the evidence, so the
    // handshake fails closed and capability dispatch refuses. The native
    // kind still tells the consumer it is an attach, not an own (#129).
    expect(response.target.ownership).toBe("unknown");
    expect(response.target.ownershipKind).toBe("attached");
    expect(response.target.quitPolicy).toBe("owned-only");
    expect(response.diagnostics.map((d) => d.code)).toContain("ownership-unproven");
    const gate = assertDispatchAllowed({
      response,
      capabilityId: "ae.operation.app.version-info",
      permission: "read",
    });
    expect(gate.status).toBe("refused");
    if (gate.status === "refused") {
      expect(gate.reason).toBe("ownership-unproven");
    }
    await ae.close({ unsavedChanges: "discard" });
  });
});

describe("execution-mode guarantees (#129)", () => {
  it("surfaces the attested host session and marks isolated-user experimental", async () => {
    transport.attestationOverrides = {
      executionMode: "isolated-user",
      sessionUid: 502,
      sessionAsid: 100021,
      sessionUser: "ae-test",
      refusesConsoleTarget: true,
    };
    transport.ownershipKind = "attached";
    const ae = await launch();
    const response = await ae.capabilities();

    expect(response.host.session).toEqual({ uid: 502, asid: 100021, user: "ae-test" });
    expect(response.host.executionMode).toBe("isolated-user");
    expect(response.execution).toEqual({
      mode: "isolated-user",
      // Experimental per ADR-0003: reachable, but no clean-machine
      // acceptance evidence — never reported as stable or proven.
      stability: "experimental",
      requiresGuiDelivery: true,
      refusesConsoleTarget: true,
    });
    expect(response.target.nonInterference).toBe("unproven");
    const codes = response.diagnostics.map((d) => d.code);
    expect(codes).toContain("execution-mode-experimental");
    expect(codes).not.toContain("console-target-refusal-unproven");
    await ae.close({ unsavedChanges: "discard" });
  });

  it("reports an isolated-user claim without console-refusal proof as unproven", async () => {
    transport.attestationOverrides = {
      executionMode: "isolated-user",
      sessionUid: 502,
      refusesConsoleTarget: null,
    };
    const ae = await launch();
    const response = await ae.capabilities();

    expect(response.execution.refusesConsoleTarget).toBeNull();
    expect(response.diagnostics.map((d) => d.code)).toContain("console-target-refusal-unproven");
    await ae.close({ unsavedChanges: "discard" });
  });

  it("makes no stability claim for a mode ae-a8n does not know", async () => {
    transport.attestationOverrides = {
      executionMode: "quantum-foam",
      requiresGuiDelivery: null,
      refusesConsoleTarget: null,
    };
    const ae = await launch();
    const response = await ae.capabilities();

    // A future transport (the in-AE dispatcher, a dedicated-host broker)
    // attests its own mode; unknown stays unknown rather than borrowing
    // "local"'s stability.
    expect(response.execution).toEqual({
      mode: "quantum-foam",
      stability: "unknown",
      requiresGuiDelivery: null,
      refusesConsoleTarget: null,
    });
    await ae.close({ unsavedChanges: "discard" });
  });
});

describe("negotiateCapabilities", () => {
  it("accepts a compatible version and refuses incompatible ones", async () => {
    const ae = await launch();
    const response = await ae.capabilities();

    expect(
      negotiateCapabilities(response, { contractVersion: { major: 1, minor: 0 } }).status,
    ).toBe("compatible");
    expect(
      negotiateCapabilities(response, { contractVersion: { major: 1, minor: 1 } }),
    ).toEqual({ status: "refused", reason: "unsupported-minor-version", detail: expect.any(String) });
    expect(
      negotiateCapabilities(response, { contractVersion: { major: 2, minor: 0 } }),
    ).toEqual({ status: "refused", reason: "incompatible-contract-version", detail: expect.any(String) });
    await ae.close({ unsavedChanges: "discard" });
  });

  it("distinguishes unassessed inventory from unknown capability", async () => {
    const ae = await launch();
    const response = await ae.capabilities();

    // A well-formed ID in an unsupplied namespace is unassessed, not absent.
    expect(
      negotiateCapabilities(response, {
        contractVersion: { major: 1, minor: 0 },
        requestedCapability: "ae.scripting.app.version",
      }),
    ).toEqual({ status: "refused", reason: "capability-unassessed", detail: expect.any(String) });

    // A malformed ID is simply unknown.
    expect(
      negotiateCapabilities(response, {
        contractVersion: { major: 1, minor: 0 },
        requestedCapability: "not-a-capability",
      }),
    ).toEqual({ status: "refused", reason: "unknown-capability", detail: expect.any(String) });

    // A declared built-in with the wrong permission refuses missing-permission.
    expect(
      negotiateCapabilities(response, {
        contractVersion: { major: 1, minor: 0 },
        requestedCapability: "ae.operation.app.version-info",
        requiredPermission: "write",
      }),
    ).toEqual({ status: "refused", reason: "missing-permission", detail: expect.any(String) });
    await ae.close({ unsavedChanges: "discard" });
  });
});

describe("assertDispatchAllowed", () => {
  it("passes a proven built-in read on an owned session", async () => {
    const ae = await launch();
    const response = await ae.capabilities();
    const result = assertDispatchAllowed({
      response,
      capabilityId: "ae.operation.app.version-info",
      permission: "read",
    });
    expect(result).toEqual({ status: "pass" });
    await ae.close({ unsavedChanges: "discard" });
  });

  it("refuses each gate in order without dispatching", async () => {
    const ae = await launch();
    const response = await ae.capabilities();

    const cases: Array<{ check: Parameters<typeof assertDispatchAllowed>[0]; reason: string }> = [
      {
        check: { response: { ...response, schema: "bogus" as never }, capabilityId: "ae.operation.app.version-info", permission: "read" },
        reason: "malformed-response",
      },
      {
        check: { response, capabilityId: "ae.scripting.app.version", permission: "read" },
        reason: "capability-unassessed",
      },
      {
        check: { response, capabilityId: "ae.operation.does.not-exist", permission: "read" },
        reason: "capability-unassessed",
      },
      {
        check: { response, capabilityId: "ae.operation.app.version-info", permission: "execute" },
        reason: "missing-permission",
      },
    ];
    for (const { check, reason } of cases) {
      const result = assertDispatchAllowed(check);
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe(reason);
      }
    }
    await ae.close({ unsavedChanges: "discard" });
  });

  it("refuses a caller ownership claim that contradicts the attested target", async () => {
    const ae = await launch();
    const response = await ae.capabilities();
    const result = assertDispatchAllowed({
      response,
      capabilityId: "ae.operation.app.version-info",
      permission: "read",
      ownership: "unknown",
    });
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("ownership-unproven");
    }
    await ae.close({ unsavedChanges: "discard" });
  });
});
