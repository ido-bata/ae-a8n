/**
 * Capability discovery and dispatch authorization (#102).
 *
 * The wire contract is ae-devtools' `ae-devtools.capability-handshake/v1`
 * (`specs/ae-capability-coverage/contracts/capability-catalog.md` §4 and
 * `packages/capability-catalog/src/handshake.ts`, contractVersion 1.0).
 * The catalog package is private and unpublished, so this file declares the
 * handshake *types* structurally and ports `negotiate`/`assertDispatchAllowed`
 * semantics — it does not vendor the catalog, its records, or its ID
 * inventory. Capability IDs ae-a8n emits are references into the ae-devtools
 * semantic-operation assignment (`ae.operation.*`, provisional per #11);
 * ae-a8n never invents IDs.
 *
 * Discovery and execution permission are separate: `capabilities()` only
 * advertises what this session can evidence. `assertDispatchAllowed` is the
 * authorization half a consumer runs before dispatching by capability ID —
 * it is not wired into the existing `AfterEffects` typed API or `ae.call`,
 * whose ownership/unknown-method/timeout contracts are unchanged.
 */

import { randomUUID } from "node:crypto";

import type { ApplicationInfo } from "./types.js";
import type { HostAttestation, HostOwnership } from "../driver/transport.js";
import { DISPATCHER_TRANSPORT_KIND } from "../driver/transport.js";
import { A8N_VERSION } from "../version.js";

export const CAPABILITY_CONTRACT_SCHEMA = "ae-devtools.capability-handshake/v1" as const;
export const CAPABILITY_CONTRACT_VERSION = { major: 1, minor: 0 } as const;
export type ContractVersion = { major: number; minor: number };

/**
 * The ae-devtools semantic-operation assignment this build references:
 * `inventories/tools/generated/semantics.json` last changed at this commit
 * (provisional normalization owned by ae-devtools #11). The catalog
 * manifest itself is not bundled; this revision names the ID snapshot only.
 */
export const CAPABILITY_ID_SNAPSHOT =
  "ae-devtools@8b07d9f92f5e54423213088702b9a9fb97e5a5d7:inventories/tools/generated/semantics.json";

export type ProofLevel =
  | "verified-real-host"
  | "automated-test"
  | "source-reviewed"
  | "unverified";

export const PERMISSION_VALUES = [
  "read",
  "write",
  "execute",
  "build-test",
  "host-callback",
] as const;
export type Permission = (typeof PERMISSION_VALUES)[number];

export const CAPABILITY_KINDS = [
  "scripting-symbol",
  "sdk-symbol",
  "tool-operation",
  "semantic-operation",
] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export type RowPersistence = "repository" | "build-time-supplied";

export type Compatibility = {
  aeBuilds?: string[];
  sdkVersions?: string[];
  os?: Array<"win32" | "darwin">;
  architectures?: string[];
  requiredPlugins?: string[];
  requiredPermissions?: string[];
};

export type ExecutionClass =
  | "extendscript"
  | "aegp-native"
  | "effect-native"
  | "native-io"
  | "cep"
  | "uxp"
  | "aerender"
  | "os-automation"
  | "unknown";

export type ExecutionDescriptor = {
  class: ExecutionClass;
  lifecycle: string;
  adapter?: string;
  /** `null` = unverified; never coerced to true or false. */
  canRemoteInvoke: boolean | null;
};

export const IMPLEMENTATION_AXES = [
  "none",
  "adapter-present",
  "implemented",
  "unsupported",
  "unknown",
] as const;
export type ImplementationAxis = (typeof IMPLEMENTATION_AXES)[number];

export const VERIFICATION_AXES = ["not-run", "automated-fake", "verified-real-host"] as const;
export type VerificationAxis = (typeof VERIFICATION_AXES)[number];

export type CapabilityAdvertisement = {
  id: string;
  kind: CapabilityKind;
  persistence: RowPersistence;
  permissions: Permission[];
  proofLevel: ProofLevel;
  compatibility: Compatibility;
  execution: ExecutionDescriptor;
  implementation: ImplementationAxis;
  verification: VerificationAxis;
};

export type HandshakeDiagnostic = {
  code: string;
  source?: "scripting" | "tools" | "sdk";
  effect: string;
};

export type OwnershipEvidence = "owned" | "explicitly-attached" | "unknown";
export type NonInterferenceEvidence = "proven" | "by-construction" | "unproven";

/**
 * ae-a8n's stability statement for an ADR-0003 execution mode (#129).
 * "experimental" is a product statement, not a transport claim: the mode
 * exists and is reachable, but it has no clean-machine acceptance evidence.
 * A mode the table does not know reports "unknown" — never upgraded.
 */
export type ExecutionModeStability = "stable" | "experimental" | "unknown";

/**
 * The execution-mode guarantees this connection can attest, per the spec
 * Capability contract (`specs/execution-model/spec.md`). Every field is
 * transport-attested evidence or null; `null` means unproven and is never
 * reported as a guarantee.
 */
export type ExecutionGuarantees = {
  /** The ADR-0003 mode the transport attests: "local", "remote", "isolated-user", or "unknown". */
  readonly mode: string;
  readonly stability: ExecutionModeStability;
  /**
   * Whether calls require delivery into a GUI login session. `null` = the
   * transport cannot say — reported as unproven, never guessed.
   */
  readonly requiresGuiDelivery: boolean | null;
  /**
   * Whether the transport proves it refuses to target the console
   * session's After Effects — the `isolated-user` invariant. `null` =
   * unproven.
   */
  readonly refusesConsoleTarget: boolean | null;
};

/** The OS user and login session the host was verified to belong to. */
export type HostSessionEvidence = {
  readonly uid: number | null;
  readonly asid: number | null;
  readonly user: string | null;
};

/**
 * What this build can say about GUI supervision (#287,
 * specs/gui-supervision/spec.md §Capability contract). Supervision is not
 * an `ae.operation.*` row — it is a session-level capability with its own
 * honesty axes, reported separately from the dispatch table.
 */
export type SupervisionAdvertisement = {
  /** Platforms with an implemented OS-native GUI probe. */
  readonly platforms: readonly ("win32" | "darwin")[];
  /**
   * The observation mechanism, or null when no probe exists. On darwin it
   * is the Accessibility tree plus the WindowServer window census — the
   * same sources `ae.guiState()` uses, independent of AE's script path.
   */
  readonly probe: "ax-windowserver" | null;
  /**
   * Whether durable supervision state for this session is being kept
   * fresh right now — an in-process monitor or a detached supervisor
   * whose heartbeat is still alive. `false` is honest absence, not a
   * claim that the target is unblocked.
   */
  readonly monitoring: boolean;
  /**
   * Strongest evidence level for the supervision path on this build.
   * `automated-fake` until a real-host run records the monitor end to end;
   * never upgraded by hope.
   */
  readonly verification: VerificationAxis;
  /** Where every consumer reads the same durable report. */
  readonly report: "ae.supervisionState()";
};

export type HandshakeTarget = {
  identity: string | null;
  ownership: OwnershipEvidence;
  nonInterference: NonInterferenceEvidence;
  /**
   * ae-a8n's native ownership kind — the attach-vs-owned distinction the
   * canonical `OwnershipEvidence` enum cannot express (#129). "attached"
   * means a pre-existing host that belongs to someone else; the canonical
   * `ownership` field still fails closed as "unknown" for it.
   */
  ownershipKind: HostOwnership["kind"];
  /** What the ownership decision rests on, for the trace and a human. */
  ownershipEvidence: string;
  /**
   * This session's quit policy, stated so a consumer need not infer it:
   * After Effects is quit only on proven ownership — an attached or
   * unidentified instance is never quit.
   */
  quitPolicy: "owned-only";
  /**
   * The operation classes this session is authorized to exercise on a host
   * it does not own (#145): the grant scopes that apply, or every scope for
   * an owned session. Empty for an attached/unknown session with no grant.
   */
  grantedOperations: readonly string[];
  /**
   * The dispatcher instance the session is bound to, when the transport
   * names one (#145) — the reconnect-pinning identity. `null` when the
   * transport cannot name an instance.
   */
  dispatcherInstance: string | null;
};

export type HandshakeResponse = {
  schema: typeof CAPABILITY_CONTRACT_SCHEMA;
  contractVersion: ContractVersion;
  catalogRevision: string;
  hostId: string;
  host: {
    ae?: { version?: string; build?: string; scriptingVersion?: string };
    os: string;
    arch: string;
    executionMode: string;
    transport: string;
    /** The OS user and login session the host was verified to belong to; null fields = unattested. */
    session: HostSessionEvidence;
  };
  /** The execution-mode guarantees this connection attests (#129). */
  execution: ExecutionGuarantees;
  target: HandshakeTarget;
  /** GUI supervision support for this session (#287). */
  supervision: SupervisionAdvertisement;
  inventorySupply: { scripting: SupplyState; tools: SupplyState; sdk: SupplyState };
  availableCapabilities: CapabilityAdvertisement[];
  diagnostics: HandshakeDiagnostic[];
  provenance: {
    catalogRevision: string;
    hostId: string;
    generatedAt: string;
    evidenceLevel: {
      inventory: string;
      verification: string;
      realHost: string;
      statement: string;
    };
    sources: Record<string, unknown>;
  };
};

type SupplyState = "supplied" | "not-supplied";

/* ------------------------------------------------------------------ */
/* Capability map: built-in host methods → ae.operation.* IDs          */
/* ------------------------------------------------------------------ */

type BuiltinCapability = {
  /** The host method name dispatched through the file-envelope transport. */
  readonly method: string;
  /** The ae-devtools semantic-operation ID this method implements. */
  readonly id: string;
  readonly permissions: readonly Permission[];
  readonly verification: VerificationAxis;
  /** Platforms with real-host evidence; absent means no platform claim. */
  readonly os?: readonly ("win32" | "darwin")[];
};

const BOTH: readonly ("win32" | "darwin")[] = ["win32", "darwin"];
const DARWIN: readonly ("win32" | "darwin")[] = ["darwin"];

/**
 * The built-in dispatch table, one row per host method in
 * `host/a8n-host.js`. `verification` records the strongest evidence level
 * documented in `docs/verification.md`, `docs/windows-verification.md` and
 * `docs/evidence/`: `verified-real-host` only where a real After Effects ran
 * the operation on the listed platforms, `automated-fake` everywhere the
 * in-repo fake host covers it. Nothing is marked `not-run`: these methods
 * are implemented and dispatchable, and marking them so would make the
 * dispatch gate refuse every built-in.
 */
const BUILTIN_CAPABILITIES: readonly BuiltinCapability[] = [
  { method: "app.info", id: "ae.operation.app.version-info", permissions: ["read"], verification: "verified-real-host", os: BOTH },
  { method: "ui.alert", id: "ae.operation.ui.alert", permissions: ["execute"], verification: "automated-fake" },
  { method: "app.quit", id: "ae.operation.app.quit", permissions: ["execute"], verification: "verified-real-host", os: BOTH },
  { method: "project.open", id: "ae.operation.project.open", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "project.close", id: "ae.operation.project.close", permissions: ["write"], verification: "automated-fake" },
  { method: "project.info", id: "ae.operation.project.info", permissions: ["read"], verification: "verified-real-host", os: BOTH },
  { method: "project.comps", id: "ae.operation.project.list-comps", permissions: ["read"], verification: "automated-fake" },
  { method: "comp.info", id: "ae.operation.comp.info", permissions: ["read"], verification: "verified-real-host", os: BOTH },
  { method: "comp.layers", id: "ae.operation.comp.list-layers", permissions: ["read"], verification: "verified-real-host", os: BOTH },
  { method: "comp.layer", id: "ae.operation.comp.get-layer", permissions: ["read"], verification: "verified-real-host", os: BOTH },
  { method: "layer.effects", id: "ae.operation.layer.list-effects", permissions: ["read"], verification: "verified-real-host", os: DARWIN },
  { method: "layer.applyEffect", id: "ae.operation.effect.apply", permissions: ["write"], verification: "verified-real-host", os: DARWIN },
  { method: "effect.parameters", id: "ae.operation.effect.list-parameters", permissions: ["read"], verification: "verified-real-host", os: DARWIN },
  { method: "effect.getParameter", id: "ae.operation.effect.get-parameter", permissions: ["read"], verification: "verified-real-host", os: DARWIN },
  { method: "effect.setParameter", id: "ae.operation.effect.set-parameter", permissions: ["write"], verification: "verified-real-host", os: DARWIN },
  { method: "comp.renderFrame", id: "ae.operation.render.frame", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "project.createComp", id: "ae.operation.comp.create", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "comp.openInViewer", id: "ae.operation.comp.open-in-viewer", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "comp.addText", id: "ae.operation.layer.add-text", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "comp.selectLayers", id: "ae.operation.layer.select", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "layer.setEnabled", id: "ae.operation.layer.set-enabled", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "layer.transform", id: "ae.operation.layer.get-transform", permissions: ["read"], verification: "automated-fake" },
  { method: "layer.shapePaths", id: "ae.operation.layer.get-shape-paths", permissions: ["read"], verification: "verified-real-host", os: BOTH },
  { method: "app.setEnvironment", id: "ae.operation.app.set-environment", permissions: ["write"], verification: "verified-real-host", os: BOTH },
  { method: "menu.find", id: "ae.operation.menu.find-command", permissions: ["read"], verification: "verified-real-host", os: BOTH },
  { method: "menu.execute", id: "ae.operation.menu.execute-command", permissions: ["execute"], verification: "verified-real-host", os: BOTH },
];

const BUILTIN_BY_METHOD = new Map(BUILTIN_CAPABILITIES.map((c) => [c.method, c]));

/**
 * Exported for the contract test that keeps this table in step with the
 * host dispatch table: a host method with no row would be undiscoverable,
 * and a row with no host method would advertise a capability that does not
 * exist.
 */
export const BUILTIN_HOST_METHODS: readonly string[] = BUILTIN_CAPABILITIES.map((c) => c.method);
export function builtinCapabilityFor(method: string): BuiltinCapability | undefined {
  return BUILTIN_BY_METHOD.get(method);
}

/* ------------------------------------------------------------------ */
/* Handshake construction                                              */
/* ------------------------------------------------------------------ */

export type CapabilityHandshakeInput = {
  readonly ae: ApplicationInfo;
  readonly transportKind: string;
  readonly attestation: HostAttestation;
  readonly ownership: HostOwnership;
  readonly extensionMethods: readonly string[];
  /** Grant scopes the session may exercise on a non-owned host (#145). */
  readonly grantedOperations?: readonly string[];
  /**
   * Whether durable supervision state for this session is being kept
   * fresh — computed by the caller from the live monitor and the durable
   * report's evaluated health (#287). Absent means "not monitoring".
   */
  readonly supervisionMonitoring?: boolean;
  /** Per-session nonce used when no process identity can be attested. */
  readonly hostNonce: string;
  readonly generatedAt: string;
};

function proofLevelFor(verification: VerificationAxis, inventoryReviewed: boolean): ProofLevel {
  if (verification === "verified-real-host") return "verified-real-host";
  if (verification === "automated-fake") return "automated-test";
  return inventoryReviewed ? "source-reviewed" : "unverified";
}

/**
 * `HostOwnership.kind` → canonical `OwnershipEvidence`.
 *
 * Only "owned" — this session launched the process and it is still that
 * process — is positive ownership proof. ae-a8n's "attached" means the host
 * was already running and belongs to someone else; the canonical enum has
 * no value for that, and "explicitly-attached" would overstate the evidence
 * (nothing here proves the operator explicitly attached to an identified
 * instance). It reports "unknown" and the dispatch gate refuses
 * `ownership-unproven` until the #97/#98 local-connection trust model
 * defines what attached evidence is sufficient.
 */
function ownershipEvidence(kind: HostOwnership["kind"]): OwnershipEvidence {
  return kind === "owned" ? "owned" : "unknown";
}

/**
 * ae-a8n's stability statement per ADR-0003 execution mode (#129).
 *
 * "local" is the shipping path. "remote" (dedicated host) and
 * "isolated-user" (another GUI user on the same machine) are experimental
 * until they have clean-machine acceptance evidence — ADR-0003 is still
 * Proposed. A mode absent from this table reports "unknown": ae-a8n makes
 * no stability claim it cannot back, which is also what lets a future
 * transport (the in-AE dispatcher, a dedicated-host broker) attest its own
 * mode without this file knowing it in advance.
 */
const EXECUTION_MODE_STABILITY: Readonly<Record<string, ExecutionModeStability>> = {
  local: "stable",
  remote: "experimental",
  "isolated-user": "experimental",
};

function executionModeStability(mode: string): ExecutionModeStability {
  return EXECUTION_MODE_STABILITY[mode] ?? "unknown";
}

/** Lowercase slug for capability-ID segments (canonical `slugSegment`). */
function slugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_$-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `ae.tool.<project>.<operation>` for a declared extension method, the
 * canonical `toolOperationId` shape: extension names are dot-separated
 * ("aulymo.buildScene"), so the first segment is the project and the rest
 * the operation. Returns null when the name cannot form a valid canonical
 * ID — an unmappable name is undiscoverable rather than mis-identified.
 */
function extensionCapabilityId(method: string): string | null {
  const parts = method.split(".");
  if (parts.length < 2) return null;
  const project = slugSegment(parts[0] ?? "");
  const operation = slugSegment(parts.slice(1).join("."));
  if (project === "" || operation === "") return null;
  const id = `ae.tool.${project}.${operation}`;
  return parseCapabilityId(id) === null ? null : id;
}

function builtinAdvertisement(
  capability: BuiltinCapability,
  adapter: string,
  verification: VerificationAxis,
): CapabilityAdvertisement {
  return {
    id: capability.id,
    kind: "semantic-operation",
    persistence: "repository",
    permissions: [...capability.permissions],
    proofLevel: proofLevelFor(verification, true),
    compatibility:
      capability.os === undefined ? {} : { os: [...capability.os] },
    execution: {
      class: "extendscript",
      lifecycle: "AE ExtendScript host via file-envelope dispatch",
      adapter,
      canRemoteInvoke: true,
    },
    implementation: "implemented",
    verification,
  };
}

function extensionAdvertisement(id: string, adapter: string): CapabilityAdvertisement {
  return {
    id,
    kind: "tool-operation",
    // Only sdk-symbol rows are build-time-supplied (canonical
    // `persistenceForKind`); extension operations are repository rows.
    persistence: "repository",
    // An extension method is consumer code: ae-a8n cannot attest what it
    // reads or writes, so it declares no permission. Discovery succeeds;
    // capability-addressed dispatch refuses `missing-permission` until the
    // consumer supplies evidence. `ae.call`'s own contract (declared name,
    // owned session) is unchanged.
    permissions: [],
    proofLevel: "unverified",
    compatibility: {},
    execution: {
      class: "extendscript",
      lifecycle: "AE ExtendScript host, consumer-declared static method",
      adapter,
      canRemoteInvoke: true,
    },
    implementation: "implemented",
    // ae-a8n has not run this method: "not-run" is the honest level, and it
    // is what keeps the dispatch gate closed for it.
    verification: "not-run",
  };
}

/**
 * Builds the `HandshakeResponse` for this session. Read-only: it reports
 * live transport/session evidence and the static capability map; it
 * dispatches nothing and mutates nothing.
 */
export function buildCapabilityHandshake(input: CapabilityHandshakeInput): HandshakeResponse {
  const { attestation } = input;
  const adapter = input.transportKind;

  // The dispatch table's `verified-real-host` rows were earned through the
  // script-invocation transport. Under the in-AE dispatcher (#127) the same
  // host methods run, but *this* transport has no real-host evidence yet —
  // the #98 gate is still open — so the advertised level is capped at
  // `automated-fake` rather than borrowing another transport's proof.
  const dispatcherUnproven = input.transportKind === DISPATCHER_TRANSPORT_KIND;
  const capVerification = (verification: VerificationAxis): VerificationAxis =>
    dispatcherUnproven && verification === "verified-real-host" ? "automated-fake" : verification;

  const owned = attestation.ownedProcess;
  const pid = attestation.pid ?? owned?.pid ?? null;
  const dispatcherInstance = attestation.targetInstance ?? null;
  const hostId =
    pid !== null
      ? `pid:${pid}`
      : dispatcherInstance !== null
        ? `dispatcher:${dispatcherInstance}`
        : `a8n-session:${input.hostNonce}`;
  const targetIdentity =
    owned !== null
      ? `${owned.executable} (pid ${owned.pid})`
      : pid !== null
        ? `pid:${pid}`
        : dispatcherInstance !== null
          ? `in-ae-dispatcher instance ${dispatcherInstance}`
          : null;

  const availableCapabilities: CapabilityAdvertisement[] = BUILTIN_CAPABILITIES.map((c) =>
    builtinAdvertisement(c, adapter, capVerification(c.verification)),
  );
  const seen = new Set(availableCapabilities.map((c) => c.id));
  for (const method of input.extensionMethods) {
    const id = extensionCapabilityId(method);
    if (id === null || seen.has(id)) {
      continue;
    }
    seen.add(id);
    availableCapabilities.push(extensionAdvertisement(id, adapter));
  }
  availableCapabilities.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const ownership = ownershipEvidence(input.ownership.kind);
  const executionMode = attestation.executionMode;
  const stability = executionModeStability(executionMode);
  const requiresGuiDelivery = attestation.requiresGuiDelivery ?? null;
  const refusesConsoleTarget = attestation.refusesConsoleTarget ?? null;
  const diagnostics: HandshakeDiagnostic[] = [];
  for (const source of ["scripting", "tools", "sdk"] as const) {
    diagnostics.push({
      code: "inventory-not-supplied",
      source,
      effect:
        `${source} inventory rows were not supplied to this host; ${source} capabilities are ` +
        "unassessed — missing rows are not absent capability (capability-catalog §1.1).",
    });
  }
  diagnostics.push({
    code: "catalog-manifest-not-supplied",
    effect:
      "the ae-devtools capability manifest is not bundled with ae-a8n; catalogRevision names " +
      "the semantic-operation ID snapshot only, and advertised rows carry ae-a8n's own evidence.",
  });
  diagnostics.push({
    code: "supported-release-set-not-recorded",
    effect:
      "the supported AE release set is not recorded; coverage percentages stay unknown rather " +
      "than 0% or 100%.",
  });
  if (ownership === "unknown") {
    diagnostics.push({
      code: "ownership-unproven",
      effect:
        `target ownership is unattested (${input.ownership.evidence}); capability-addressed ` +
        "dispatch would refuse ownership-unproven.",
    });
  }
  if (stability === "experimental") {
    diagnostics.push({
      code: "execution-mode-experimental",
      effect:
        `execution mode "${executionMode}" is experimental (ADR-0003): it has no ` +
        "clean-machine acceptance evidence, so no non-interference or unattended-use " +
        "guarantee is claimed for it.",
    });
  }
  if (executionMode === "isolated-user" && refusesConsoleTarget !== true) {
    diagnostics.push({
      code: "console-target-refusal-unproven",
      effect:
        "the transport attests isolated-user but cannot prove it refuses the console " +
        "session's After Effects; a start or script meant for another user could land " +
        "on the screen the user is looking at.",
    });
  }
  if (dispatcherUnproven) {
    diagnostics.push({
      code: "dispatcher-transport-unverified",
      effect:
        "the in-AE dispatcher transport has no real-host evidence yet (the #98 acceptance " +
        "gate is still open); advertised verification is capped at automated-fake and " +
        "non-interference remains unproven.",
    });
  }

  const anyRealHost = availableCapabilities.some((c) => c.proofLevel === "verified-real-host");
  const anyAutomated = availableCapabilities.some((c) => c.proofLevel === "automated-test");

  return {
    schema: CAPABILITY_CONTRACT_SCHEMA,
    contractVersion: { ...CAPABILITY_CONTRACT_VERSION },
    catalogRevision: CAPABILITY_ID_SNAPSHOT,
    hostId,
    host: {
      ae: {
        ...(input.ae.version === undefined ? {} : { version: input.ae.version }),
        ...(input.ae.build === undefined ? {} : { build: input.ae.build }),
      },
      os: attestation.platform?.os ?? "unknown",
      arch: attestation.platform?.arch ?? "unknown",
      executionMode,
      transport: input.transportKind,
      session: {
        uid: attestation.sessionUid ?? null,
        asid: attestation.sessionAsid ?? null,
        user: attestation.sessionUser ?? null,
      },
    },
    execution: {
      mode: executionMode,
      stability,
      requiresGuiDelivery,
      refusesConsoleTarget,
    },
    target: {
      identity: targetIdentity,
      ownership,
      // No dedicated-host non-interference proof exists yet (ADR-0003 is
      // still Proposed); nothing here may claim otherwise.
      nonInterference: "unproven",
      ownershipKind: input.ownership.kind,
      ownershipEvidence: input.ownership.evidence,
      quitPolicy: "owned-only",
      grantedOperations: [...(input.grantedOperations ?? [])],
      dispatcherInstance,
    },
    supervision: {
      // Only the macOS probe exists today (MacGuiProbe over AX +
      // WindowServer); Windows supervision is specified but unimplemented,
      // so it is not claimed. The verification level is the strongest
      // evidence the supervision path has — automated-fake until a
      // real-host run records the monitor end to end.
      platforms: ["darwin"],
      probe: "ax-windowserver",
      monitoring: input.supervisionMonitoring === true,
      verification: "automated-fake",
      report: "ae.supervisionState()",
    },
    inventorySupply: { scripting: "not-supplied", tools: "not-supplied", sdk: "not-supplied" },
    availableCapabilities,
    diagnostics,
    provenance: {
      catalogRevision: CAPABILITY_ID_SNAPSHOT,
      hostId,
      generatedAt: input.generatedAt,
      evidenceLevel: {
        inventory: "source-reviewed",
        verification: anyAutomated ? "automated-fake" : "not-run",
        realHost: anyRealHost ? "verified-real-host" : "not-run",
        statement:
          "advertised rows are ae-a8n's own built-in dispatch table and declared extensions; " +
          "ae-devtools inventory rows were not supplied, so unlisted capabilities are " +
          "unassessed, never absent.",
      },
      sources: {
        scripting: { supplied: false },
        tools: { supplied: false },
        sdk: { supplied: false },
        session: {
          pid,
          ownedProcess: owned,
          sessionUid: attestation.sessionUid ?? null,
          sessionAsid: attestation.sessionAsid ?? null,
          sessionUser: attestation.sessionUser ?? null,
          transport: input.transportKind,
          aeVersion: input.ae.version ?? null,
          runtime: `ae-a8n/${A8N_VERSION}`,
        },
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* negotiate / assertDispatchAllowed — canonical semantics port        */
/* ------------------------------------------------------------------ */

const ID_NAMESPACES = ["scripting", "sdk", "operation", "tool"] as const;
type IdNamespace = (typeof ID_NAMESPACES)[number];

const SEGMENT_RE = /^[A-Za-z0-9_$-]+$/;

function parseCapabilityId(id: string): { namespace: IdNamespace; segments: string[] } | null {
  const parts = id.split(".");
  if (parts.length < 4 || parts[0] !== "ae") return null;
  const ns = parts[1];
  if (ns === undefined || !(ID_NAMESPACES as readonly string[]).includes(ns)) return null;
  const segments = parts.slice(2);
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) return null;
  }
  return { namespace: ns as IdNamespace, segments };
}

const NAMESPACE_SUPPLY: Record<IdNamespace, "scripting" | "tools" | "sdk"> = {
  scripting: "scripting",
  sdk: "sdk",
  tool: "tools",
  operation: "tools",
};

export type RefusalReason =
  | "malformed-response"
  | "incompatible-contract-version"
  | "unsupported-minor-version"
  | "unknown-capability"
  | "capability-unassessed"
  | "missing-permission"
  | "ownership-unproven"
  | "not-implemented"
  | "unverified"
  | "no-execution-path";

export type NegotiationRequest = {
  contractVersion: ContractVersion;
  requestedCapability?: string;
  requiredPermission?: Permission;
};

export type NegotiationResult =
  | { status: "compatible" }
  | { status: "refused"; reason: RefusalReason; detail: string };

function negotiationRefused(reason: RefusalReason, detail: string): NegotiationResult {
  return { status: "refused", reason, detail };
}

function lookupCapability(
  response: HandshakeResponse,
  id: string,
): { kind: "found"; capability: CapabilityAdvertisement } | { kind: "unassessed" } | { kind: "unknown" } {
  const capability = response.availableCapabilities.find((c) => c.id === id);
  if (capability !== undefined) return { kind: "found", capability };
  const parsed = parseCapabilityId(id);
  if (parsed === null) return { kind: "unknown" };
  const supplyKey = NAMESPACE_SUPPLY[parsed.namespace];
  // Missing inventorySupply fails closed as unassessed, never as absent.
  return response.inventorySupply?.[supplyKey] === "supplied" ? { kind: "unknown" } : { kind: "unassessed" };
}

/**
 * Metadata preflight only — canonical `negotiate` (§4 rule 3): a
 * "compatible" result means contract version, capability existence and
 * declared permission line up. It assesses neither executability nor
 * ownership; `assertDispatchAllowed` is the per-dispatch authorization.
 */
export function negotiateCapabilities(
  response: HandshakeResponse,
  request: NegotiationRequest,
): NegotiationResult {
  // The schema field is read as unknown: a malformed response is exactly
  // what this check exists to refuse, so its declared type cannot be trusted.
  const advertised = (response as { schema?: unknown }).schema;
  if (advertised !== CAPABILITY_CONTRACT_SCHEMA) {
    return negotiationRefused(
      "malformed-response",
      `handshake schema ${JSON.stringify(advertised)} is not ${CAPABILITY_CONTRACT_SCHEMA}`,
    );
  }
  const client = request.contractVersion;
  const server = response.contractVersion;
  if (client.major !== server.major) {
    return negotiationRefused(
      "incompatible-contract-version",
      `client contract major ${client.major} is incompatible with server major ${server.major}`,
    );
  }
  if (client.minor > server.minor) {
    return negotiationRefused(
      "unsupported-minor-version",
      `client contract minor ${client.minor} is newer than server minor ${server.minor}`,
    );
  }
  if (request.requestedCapability !== undefined) {
    const lookup = lookupCapability(response, request.requestedCapability);
    if (lookup.kind === "unassessed") {
      return negotiationRefused(
        "capability-unassessed",
        `capability ${request.requestedCapability} belongs to an inventory not supplied to this host; unassessed is not absence`,
      );
    }
    if (lookup.kind === "unknown") {
      return negotiationRefused("unknown-capability", `capability ${request.requestedCapability} is not advertised`);
    }
    if (
      request.requiredPermission !== undefined &&
      !lookup.capability.permissions.includes(request.requiredPermission)
    ) {
      return negotiationRefused(
        "missing-permission",
        `capability ${lookup.capability.id} does not declare permission ${request.requiredPermission}`,
      );
    }
  }
  return { status: "compatible" };
}

export type DispatchCheck = {
  response: HandshakeResponse;
  capabilityId: string;
  /**
   * The permission class this dispatch exercises. Required: a dispatch that
   * does not declare its permission class cannot be authorized.
   */
  permission: Permission;
  /**
   * Optional caller-side ownership observation. A claim, never the
   * authority: authorization uses the ownership attested in
   * `response.target`; a contradicting claim refuses `ownership-unproven`.
   */
  ownership?: OwnershipEvidence;
};

export type DispatchResult =
  | { status: "pass" }
  | { status: "refused"; reason: RefusalReason; detail: string };

function dispatchRefused(reason: RefusalReason, detail: string): DispatchResult {
  return { status: "refused", reason, detail };
}

/**
 * Per-dispatch authorization gate — canonical `assertDispatchAllowed`
 * (§4 rule 3). Fails closed, in order: malformed response → executability
 * (`implementation`, `verification`, `canRemoteInvoke`) → declared
 * permission → ownership proven by the handshake's own `target` evidence.
 *
 * Trust boundary: this authorizes against an *authentic* `HandshakeResponse`
 * produced by `buildCapabilityHandshake` for a live session. A
 * caller-assembled lookalike is indistinguishable here — transport
 * integrity and ae-a8n's own consent/ownership checks are the layers above.
 */
export function assertDispatchAllowed(check: DispatchCheck): DispatchResult {
  if (
    check?.response?.schema !== CAPABILITY_CONTRACT_SCHEMA ||
    !Array.isArray(check.response?.availableCapabilities)
  ) {
    return dispatchRefused(
      "malformed-response",
      "dispatch authorization requires a well-formed handshake response",
    );
  }
  const lookup = lookupCapability(check.response, check.capabilityId);
  if (lookup.kind === "unassessed") {
    return dispatchRefused(
      "capability-unassessed",
      `capability ${check.capabilityId} is unassessed: its inventory was not supplied to this host; unassessed is not absence`,
    );
  }
  if (lookup.kind === "unknown") {
    return dispatchRefused(
      "unknown-capability",
      `capability ${check.capabilityId} is not advertised by this host`,
    );
  }
  const capability = lookup.capability;
  if (capability.implementation !== "implemented") {
    return dispatchRefused(
      "not-implemented",
      `capability ${capability.id} has implementation=${capability.implementation}; only "implemented" rows may dispatch`,
    );
  }
  if (
    !VERIFICATION_AXES.includes(capability.verification) ||
    capability.verification === "not-run"
  ) {
    return dispatchRefused(
      "unverified",
      `capability ${capability.id} has verification=${JSON.stringify(capability.verification)}; no behavioral proof exists for this host`,
    );
  }
  if (capability.execution?.canRemoteInvoke !== true) {
    return dispatchRefused(
      "no-execution-path",
      `capability ${capability.id} has canRemoteInvoke=${JSON.stringify(capability.execution?.canRemoteInvoke)}; no proven remote execution path`,
    );
  }
  if (
    check.permission === undefined ||
    !PERMISSION_VALUES.includes(check.permission) ||
    !Array.isArray(capability.permissions) ||
    !capability.permissions.includes(check.permission)
  ) {
    return dispatchRefused(
      "missing-permission",
      check.permission === undefined
        ? `dispatch for ${capability.id} declared no permission class; every dispatch must name the permission it exercises`
        : `capability ${capability.id} does not declare permission ${check.permission}`,
    );
  }
  const attested = check.response.target?.ownership ?? "unknown";
  if (check.ownership !== undefined && check.ownership !== attested) {
    return dispatchRefused(
      "ownership-unproven",
      `caller claims ownership=${check.ownership} but the handshake attests ${attested}; contradictory evidence is not proof`,
    );
  }
  if (attested !== "owned" && attested !== "explicitly-attached") {
    return dispatchRefused(
      "ownership-unproven",
      `target ownership is ${attested}; dispatch requires ownership proven by the handshake target evidence for this host/session`,
    );
  }
  return { status: "pass" };
}

/** Per-session nonce for `hostId` when no process identity is attested. */
export function newCapabilityHostNonce(): string {
  return randomUUID();
}
