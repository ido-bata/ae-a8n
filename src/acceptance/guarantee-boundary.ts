/**
 * Guarantee-boundary matrix (#435,
 * `specs/release-acceptance/spec.md` §9).
 *
 * Projects every public capability/operation into one machine-readable
 * row — `{ capability, op, platforms, support, verificationLevel, gate,
 * refuseConditions, evidenceRef }` — sourced from the live declarations,
 * never hand-maintained:
 *
 *   - `*Capabilities(platform)` per GUI/evidence/input surface;
 *   - the production `*MutationGate()` factories, probed with the op
 *     names their controllers actually pass (per-class where the gate
 *     scopes a permit, e.g. drag-drop `element-drag` targets);
 *   - `BUILTIN_CAPABILITIES` + `classifyOperationRetry` for the
 *     script-invocation dispatch table, with `assertDispatchAllowed`
 *     probed against a synthetic handshake for real refusal reasons;
 *   - `NEXT_ACTION_REASON_CODES` for the supervision next-action
 *     contract, and the supervision advertisement's platform/probe
 *     facts.
 *
 * `verificationLevel` is normalized to the repo taxonomy
 * (`implemented | automated test | fake/mock only | verified on real
 * host`); the surface's own string is preserved verbatim in
 * `verificationRaw` so nothing is silently upgraded or downgraded.
 * A level never exceeds what the source declares.
 */

import {
  assertDispatchAllowed,
  buildCapabilityHandshake,
  builtinCapabilityFor,
  BUILTIN_HOST_METHODS,
  type CapabilityHandshakeInput,
  type HandshakeResponse,
} from "../api/capabilities.js";
import type { ApplicationInfo } from "../api/types.js";
import type { HostAttestation, HostOwnership } from "../driver/transport.js";
import { panelCapabilities } from "../api/panels.js";
import { panelMutationGate } from "../panels/gate.js";
import { dragDropCapabilities } from "../api/drag-drop.js";
import { dragDropMutationGate } from "../dragdrop/gate.js";
import type { DragDropElementTarget, DragDropRequest } from "../dragdrop/index.js";
import { timelineCapabilities } from "../api/timeline.js";
import { timelineMutationGate } from "../timeline/gate.js";
import { windowOpsCapabilities } from "../api/window-ops.js";
import { windowOpsMutationGate } from "../windowops/gate.js";
import { contextMenuCapabilities } from "../api/context-menu.js";
import { contextMenuMutationGate } from "../contextmenu/gate.js";
import { effectControlsCapabilities } from "../api/effect-controls.js";
import { effectControlsMutationGate } from "../effect-controls/gate.js";
import { renderQueueCapabilities } from "../api/render-queue.js";
import { menuInvokeGate } from "../menus/gate.js";
import { compViewCapabilities } from "../api/comp-view.js";
import { compViewMutationGate } from "../comp-view/gate.js";
import { workspaceCapabilities } from "../api/workspace.js";
import { workspaceMutationGate } from "../workspace/gate.js";
import { fileDialogCapabilities } from "../api/file-dialog.js";
import { fileDialogMutationGate } from "../filedialog/gate.js";
import { projectDialogCapabilities } from "../api/project-dialog.js";
import { projectDialogMutationGate } from "../projectdialog/gate.js";
import { menuCapabilities } from "../api/menus.js";
import { inputCapabilities } from "../api/input.js";
import { guiEvidenceCapabilities } from "../evidence/capabilities.js";
import { classifyOperationRetry } from "../driver/operation-policy.js";
import { NEXT_ACTION_REASON_CODES } from "../supervision/next-actions.js";

export const GUARANTEE_BOUNDARY_SCHEMA_VERSION = 1;
export const GUARANTEE_BOUNDARY_KIND = "ae-a8n.guarantee-boundary/v1";

/** The repo verification taxonomy (`AGENTS.md` verification levels). */
export type GuaranteeVerificationLevel =
  | "implemented"
  | "automated test"
  | "fake/mock only"
  | "verified on real host";

export type GuaranteeSupport = "supported" | "partial" | "unsupported";

export type GuaranteeRow = {
  /** The surface or subsystem the op belongs to. */
  readonly capability: string;
  /** The operation within the surface (`resize`, `project.open`, …). */
  readonly op: string;
  /** Extra discriminator for per-class rows (e.g. drag element target). */
  readonly opClass?: string;
  readonly platforms: readonly ("macos" | "windows")[];
  readonly support: GuaranteeSupport;
  readonly supportRaw?: string;
  readonly verificationLevel: GuaranteeVerificationLevel;
  /** The source's own verification string, preserved verbatim. */
  readonly verificationRaw?: string;
  /** Gate name(s) governing mutation, or "none"/"dispatch-gate". */
  readonly gate: string;
  /** Named conditions under which the op refuses or cannot run. */
  readonly refuseConditions: readonly string[];
  /** Prose reason carried by the capability declaration, verbatim. */
  readonly reason?: string | null;
  /** Spec/ADR/docs pointer backing the row's claims. */
  readonly evidenceRef: string;
  /** Present on builtin rows: read-only / verified-retry / unknown-side-effect. */
  readonly retryClass?: string;
  /** Present on builtin rows: declared ae.operation.* id and permissions. */
  readonly capabilityId?: string;
  readonly permissions?: readonly string[];
  /** Input rows only: the session kind the capability report evaluated. */
  readonly sessionKind?: string;
  /** Gate probe outcome when a mutation gate was consulted. */
  readonly gateProbe?: {
    readonly allowed: boolean;
    readonly reason?: string;
  };
  /** Free-text honesty note (e.g. a capability-table gap). */
  readonly note?: string;
};

export type GuaranteeBoundaryMatrix = {
  readonly schemaVersion: typeof GUARANTEE_BOUNDARY_SCHEMA_VERSION;
  readonly kind: typeof GUARANTEE_BOUNDARY_KIND;
  readonly generatedFrom: string;
  readonly rows: readonly GuaranteeRow[];
};

const PLATFORM_MAP: Readonly<Record<string, "macos" | "windows">> = {
  darwin: "macos",
  win32: "windows",
};

function toPlatforms(os: readonly string[] | undefined): ("macos" | "windows")[] {
  if (os === undefined || os.length === 0) {
    return ["macos", "windows"];
  }
  const mapped = os.map((p) => PLATFORM_MAP[p] ?? (p as "macos" | "windows"));
  return [...new Set(mapped)].sort();
}

/**
 * Normalize a surface's verification string onto the repo taxonomy.
 * Unknown/"unverified"/"not-run" land on `implemented` — the taxonomy
 * floor means "code exists and compiles", which is exactly what those
 * declarations claim; the raw string is always preserved alongside.
 */
export function normalizeVerificationLevel(raw: string): GuaranteeVerificationLevel {
  switch (raw) {
    case "verified on real host":
    case "verified-real-host":
      return "verified on real host";
    case "automated test":
    case "automated-fake":
      return "automated test";
    case "fake/mock only":
      return "fake/mock only";
    case "implemented":
      return "implemented";
    default:
      return "implemented";
  }
}

function normalizeSupport(raw: string): GuaranteeSupport {
  switch (raw) {
    case "implemented":
      return "supported";
    case "partial":
      return "partial";
    // "unavailable" = implemented but gated off pending a safety
    // decision — the code path exists, so "partial" is the honest level.
    case "unavailable":
      return "partial";
    default:
      return "unsupported";
  }
}

type CapabilityLeaf = {
  readonly support: string;
  readonly verification: string;
  readonly reason?: string | null;
  readonly gate?: string;
};

function isCapabilityLeaf(value: unknown): value is CapabilityLeaf {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v["support"] === "string" && typeof v["verification"] === "string";
}

const NON_OP_KEYS = new Set(["platform", "sessionKind"]);

function capabilityEntries(caps: unknown): [string, CapabilityLeaf][] {
  const out: [string, CapabilityLeaf][] = [];
  if (typeof caps !== "object" || caps === null) {
    return out;
  }
  for (const [key, value] of Object.entries(caps as Record<string, unknown>)) {
    if (NON_OP_KEYS.has(key)) {
      continue;
    }
    if (isCapabilityLeaf(value)) {
      out.push([key, value]);
    }
  }
  return out;
}

export type GateProbe = { readonly allowed: boolean; readonly reason?: string };

/** A gate factory result erased to the probe shape (op unions differ per surface). */
type UntypedGate = (
  op: never,
  request?: never,
) => { readonly allowed: boolean; readonly reason?: string };

function probeGate(gate: UntypedGate): SurfaceGate["probe"] {
  return (op, request) => {
    const r = gate(op as never, request as never);
    return {
      allowed: r.allowed,
      ...(r.reason === undefined ? {} : { reason: r.reason }),
    };
  };
}

const asGate = (gate: unknown): UntypedGate => gate as UntypedGate;

/** A production mutation gate plus the op names its controller passes. */
type SurfaceGate = {
  readonly name: string;
  /** capability key → gate op name (undefined = observe-class, no gate). */
  readonly opFor: Readonly<Record<string, string | undefined>>;
  /** Per-class probes for gates that scope permits (drag-drop elements). */
  readonly classProbes?: readonly {
    readonly op: string;
    readonly request: DragDropRequest;
  }[];
  readonly probe: (op: string, request?: DragDropRequest) => GateProbe;
};

const ELEMENT_TARGETS: readonly DragDropElementTarget[] = [
  "project-item",
  "timeline-layer",
  "panel-tab",
  "other",
];

function elementDragRequest(element: DragDropElementTarget): DragDropRequest {
  // The gate reads only `kind`/`element`; the locator fields are never
  // consulted at gate time, so a minimal well-formed request suffices.
  return {
    kind: "element-drag",
    element,
    surface: { kind: "panel", name: "Project" },
    from: { x: 0, y: 0 },
    to: { x: 1, y: 1 },
  } as unknown as DragDropRequest;
}

const SURFACES: readonly {
  readonly capability: string;
  readonly spec: string;
  readonly caps: (platform: NodeJS.Platform, sessionKind?: string) => unknown;
  readonly sessionKinds?: readonly string[];
  /** Gate name applied to every row (input: gate state lives per-capability). */
  readonly gateAll?: string;
  readonly gate?: SurfaceGate;
}[] = [
  {
    capability: "panel",
    spec: "specs/panel-interaction/spec.md",
    caps: (p) => panelCapabilities(p),
    gate: {
      name: "panelMutationGate",
      opFor: { resize: "resize", restore: "restore" },
      probe: probeGate(asGate(panelMutationGate())),
    },
  },
  {
    capability: "dragDrop",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => dragDropCapabilities(p),
    gate: {
      name: "dragDropMutationGate",
      opFor: { dropFile: "drop-file", elementDrag: "element-drag" },
      probe: probeGate(asGate(dragDropMutationGate())),
    },
  },
  {
    capability: "timeline",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => timelineCapabilities(p),
    gate: {
      name: "timelineMutationGate",
      opFor: {
        scrub: "scrub",
        selectRow: "select-row",
        navigateKeyframe: "navigate-keyframe",
      },
      probe: probeGate(asGate(timelineMutationGate())),
    },
  },
  {
    capability: "windowOps",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => windowOpsCapabilities(p),
    gate: {
      name: "windowOpsMutationGate",
      opFor: {
        observe: undefined,
        focusedObserve: undefined,
        move: "move",
        resize: "resize",
        minimize: "minimize",
        restore: "restore",
        maximize: "maximize",
        focus: "focus",
      },
      probe: probeGate(asGate(windowOpsMutationGate())),
    },
  },
  {
    capability: "contextMenu",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => contextMenuCapabilities(p),
    gate: {
      name: "contextMenuMutationGate",
      opFor: { open: "open", items: undefined, invokeItem: "invoke-item" },
      probe: probeGate(asGate(contextMenuMutationGate())),
    },
  },
  {
    capability: "effectControls",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => effectControlsCapabilities(p),
    gate: {
      name: "effectControlsMutationGate",
      opFor: { setFolded: "set-folded", setParameter: "set-parameter" },
      probe: probeGate(asGate(effectControlsMutationGate())),
    },
  },
  {
    capability: "renderQueue",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => renderQueueCapabilities(p),
    // addViaMenu delegates to the gated menu invoke inside menuBarForTarget.
    gate: {
      name: "menuInvokeGate (delegated via menu invoke)",
      opFor: { observe: undefined, addViaMenu: "invoke" },
      probe: probeGate(asGate(menuInvokeGate())),
    },
  },
  {
    capability: "compView",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => compViewCapabilities(p),
    gate: {
      name: "compViewMutationGate",
      opFor: { pan: "pan", zoom: "zoom" },
      probe: probeGate(asGate(compViewMutationGate())),
    },
  },
  {
    capability: "workspace",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => workspaceCapabilities(p),
    gate: {
      name: "workspaceMutationGate",
      opFor: {
        observe: undefined,
        switchWorkspace: "switch",
        arrange: "arrange",
        verifyRestore: undefined,
        monitors: undefined,
      },
      probe: probeGate(asGate(workspaceMutationGate())),
    },
  },
  {
    capability: "fileDialog",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => fileDialogCapabilities(p),
    gate: {
      name: "fileDialogMutationGate",
      opFor: {
        awaitDialog: undefined,
        confirm: "confirm",
        cancel: "cancel",
        enterFilename: "enter-filename",
      },
      probe: probeGate(asGate(fileDialogMutationGate())),
    },
  },
  {
    capability: "projectDialog",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => projectDialogCapabilities(p),
    gate: {
      name: "projectDialogMutationGate",
      opFor: {
        openProject: "open",
        saveProjectAs: "save",
        cancelDialog: "cancel",
        roundTrip: "round-trip",
      },
      probe: probeGate(asGate(projectDialogMutationGate())),
    },
  },
  {
    capability: "menuBar",
    spec: "specs/workspace-editing/spec.md",
    caps: (p) => menuCapabilities(p),
    gate: {
      name: "menuInvokeGate",
      opFor: { enumerate: undefined, checkState: undefined, invoke: "invoke" },
      probe: probeGate(asGate(menuInvokeGate())),
    },
  },
  {
    capability: "input",
    spec: "specs/ime-input/spec.md",
    caps: (p, sessionKind) =>
      inputCapabilities(p, (sessionKind ?? "unknown") as "shared" | "dedicated" | "unknown"),
    sessionKinds: ["shared", "dedicated", "unknown"],
    gateAll: "inputMutationGate + inputAuthorizationVerdict",
  },
  {
    capability: "guiEvidence",
    spec: "specs/gui-evidence/spec.md",
    caps: (p) => guiEvidenceCapabilities(p),
  },
];

/** Refusal conditions every capability-addressed dispatch can hit. */
function builtinRefuseConditions(
  handshakes: readonly HandshakeResponse[],
  capability: NonNullable<ReturnType<typeof builtinCapabilityFor>>,
): string[] {
  const reasons = new Set<string>();
  for (const response of handshakes) {
    const permission = capability.permissions[0];
    const result = assertDispatchAllowed({
      response,
      capabilityId: capability.id,
      ...(permission === undefined ? { permission: "read" as const } : { permission }),
    });
    if (result.status === "refused") {
      reasons.add(result.reason);
    }
  }
  return [...reasons].sort();
}

function syntheticHandshake(ownership: HostOwnership["kind"]): HandshakeResponse {
  const ae: ApplicationInfo = { version: "synthetic" };
  const attestation: HostAttestation = {
    pid: null,
    ownedProcess: null,
    platform: { os: "synthetic", arch: "synthetic" },
    executionMode: "local",
    sessionUid: null,
    sessionAsid: null,
    sessionUser: null,
  };
  const input: CapabilityHandshakeInput = {
    ae,
    transportKind: "synthetic",
    attestation,
    ownership: { kind: ownership, evidence: "synthetic probe" },
    extensionMethods: [],
    hostNonce: "synthetic",
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
  return buildCapabilityHandshake(input);
}

function builtinRows(handshakes: readonly HandshakeResponse[]): GuaranteeRow[] {
  const rows: GuaranteeRow[] = [];
  for (const method of BUILTIN_HOST_METHODS) {
    const capability = builtinCapabilityFor(method);
    if (capability === undefined) {
      continue;
    }
    rows.push({
      capability: "builtin",
      op: method,
      platforms: toPlatforms(capability.os),
      support: "supported",
      verificationLevel: normalizeVerificationLevel(capability.verification),
      verificationRaw: capability.verification,
      gate: "assertDispatchAllowed",
      refuseConditions: builtinRefuseConditions(handshakes, capability),
      capabilityId: capability.id,
      permissions: capability.permissions,
      retryClass: classifyOperationRetry(method),
      evidenceRef: "src/api/capabilities.ts BUILTIN_CAPABILITIES; docs/verification.md",
    });
  }
  return rows;
}

function supervisionRows(): GuaranteeRow[] {
  const refuse = NEXT_ACTION_REASON_CODES.filter((c) => c !== "permitted");
  return [
    {
      capability: "supervision",
      op: "monitor",
      platforms: ["macos", "windows"],
      support: "supported",
      verificationLevel: "automated test",
      verificationRaw: "automated-fake",
      gate: "monitor lease + durable supervision state TTL",
      refuseConditions: refuse,
      evidenceRef: "specs/gui-supervision/spec.md; docs/adr/0005-session-supervision.md",
      note:
        "observation-only on every platform; no probe presses anything and " +
        "no Windows dialog class is registered as pressable",
    },
    {
      capability: "nextActions",
      op: "reason-codes",
      platforms: ["macos", "windows"],
      support: "supported",
      verificationLevel: "automated test",
      gate: "none",
      refuseConditions: NEXT_ACTION_REASON_CODES.filter((c) => c !== "permitted"),
      evidenceRef: "src/supervision/next-actions.ts; specs/release-acceptance/spec.md §11",
    },
  ];
}

function rowSignature(row: GuaranteeRow): string {
  return JSON.stringify([
    row.capability,
    row.op,
    row.opClass ?? null,
    [...row.platforms].sort(),
    row.sessionKind ?? null,
    row.support,
    row.verificationLevel,
    row.gate,
    [...row.refuseConditions].sort(),
    row.reason ?? null,
    row.sessionKind ?? null,
  ]);
}



/**
 * Build the full guarantee-boundary matrix. Pure: every input is a live
 * module declaration; nothing here performs I/O.
 */
export function buildGuaranteeBoundaryMatrix(): GuaranteeBoundaryMatrix {
  const rows: GuaranteeRow[] = [];

  // Builtin dispatch table, with dispatch-gate probes under both an
  // owned and an unattested target so refuseConditions are measured,
  // not assumed.
  rows.push(
    ...builtinRows([syntheticHandshake("owned"), syntheticHandshake("unknown")]),
  );

  for (const surface of SURFACES) {
    const sessionKinds = surface.sessionKinds ?? [""];
    for (const sessionKind of sessionKinds) {
      for (const platform of ["darwin", "win32"] as const) {
        const caps = surface.caps(platform, sessionKind === "" ? undefined : sessionKind);
        for (const [key, leaf] of capabilityEntries(caps)) {
          const gate = surface.gate;
          const gateOp =
            gate === undefined
              ? undefined
              : key === "elementDrag"
                ? "element-drag"
                : gate.opFor[key];
          const isMutation = gateOp !== undefined;
          // element-drag is gated per element class; the aggregate row
          // must not probe the gate without a class (it would read as a
          // refusal of the whole op). Per-class rows carry the probes.
          const skipProbe =
            surface.capability === "dragDrop" && key === "elementDrag";
          const probe =
            gate !== undefined && isMutation && !skipProbe
              ? (() => {
                  try {
                    return gate.probe(gateOp);
                  } catch {
                    return { allowed: false, reason: "gate probe threw" };
                  }
                })()
              : undefined;

          const refuseConditions = new Set<string>();
          if (probe !== undefined && !probe.allowed) {
            refuseConditions.add("mutation-gate-refused");
          }
          if (leaf.support === "unsupported") {
            refuseConditions.add(`unsupported:${PLATFORM_MAP[platform] ?? platform}`);
          }
          if (leaf.gate === "closed") {
            refuseConditions.add("safety-gate-closed");
          }
          if (leaf.gate === "needs-human") {
            refuseConditions.add("needs-human");
          }

          const aggregateNote =
            surface.capability === "dragDrop" && key === "elementDrag"
              ? "aggregate row; per-class gate decisions are the " +
                "opClass rows below (project-item/timeline-layer/panel-tab " +
                "permitted, other refused)"
              : undefined;
          const base: GuaranteeRow = {
            capability: surface.capability,
            op: key,
            platforms: [PLATFORM_MAP[platform] ?? (platform as "macos" | "windows")],
            support: normalizeSupport(leaf.support),
            supportRaw: leaf.support,
            verificationLevel: normalizeVerificationLevel(leaf.verification),
            verificationRaw: leaf.verification,
            gate: surface.gateAll ?? (isMutation ? (gate?.name ?? "none") : "none"),
            refuseConditions: [...refuseConditions].sort(),
            ...(leaf.reason === undefined || leaf.reason === null
              ? {}
              : { reason: leaf.reason }),
            evidenceRef: surface.spec,
            ...(probe === undefined ? {} : { gateProbe: probe }),
            ...(sessionKind === ""
              ? {}
              : { sessionKind }),
            ...(aggregateNote === undefined ? {} : { note: aggregateNote }),
          };
          rows.push(base);

          // Per-class granularity for drag-drop element drags: the
          // aggregate `elementDrag` row hides that the gate permits
          // project-item/timeline-layer/panel-tab and refuses `other`.
          // Emit one row per declared element class, support taken from
          // the probed gate decision.
          if (surface.capability === "dragDrop" && key === "elementDrag") {
            const gateFn = dragDropMutationGate();
            for (const element of ELEMENT_TARGETS) {
              let decision: GateProbe;
              try {
                const result = gateFn("element-drag", elementDragRequest(element));
                decision = result.allowed
                  ? { allowed: true }
                  : { allowed: false, reason: result.reason };
              } catch {
                decision = { allowed: false, reason: "gate probe threw" };
              }
              rows.push({
                ...base,
                op: "element-drag",
                opClass: element,
                support: decision.allowed
                  ? base.support
                  : base.support === "unsupported"
                    ? "unsupported"
                    : "partial",
                gateProbe: decision,
                refuseConditions: decision.allowed
                  ? base.refuseConditions
                  : [...new Set([...base.refuseConditions, "mutation-gate-refused"])].sort(),
                note: decision.allowed
                  ? "permitted element class (#427 A-SAFETY decision)"
                  : "refused element class — stays gated per the A-SAFETY audit",
              });
            }
          }
        }
      }
    }
  }

  rows.push(...supervisionRows());

  // Merge rows identical on every contract field across platforms
  // (e.g. input capabilities that do not differ by OS) into one row
  // with a `platforms` list, matching the spec's row shape.
  const merged = new Map<string, GuaranteeRow>();
  const order: string[] = [];
  for (const row of rows) {
    const sig = rowSignature(row);
    const existing = merged.get(sig);
    if (existing === undefined) {
      merged.set(sig, { ...row, platforms: [...row.platforms] });
      order.push(sig);
    } else {
      const platforms = new Set([...existing.platforms, ...row.platforms]);
      merged.set(sig, { ...existing, platforms: [...platforms].sort() });
    }
  }

  const finalRows: GuaranteeRow[] = order
    .map((sig) => merged.get(sig))
    .filter((r): r is GuaranteeRow => r !== undefined)
    .sort((a, b) =>
      a.capability === b.capability
        ? a.op === b.op
          ? (a.opClass ?? "").localeCompare(b.opClass ?? "")
          : a.op.localeCompare(b.op)
        : a.capability.localeCompare(b.capability),
    );

  return {
    schemaVersion: GUARANTEE_BOUNDARY_SCHEMA_VERSION,
    kind: GUARANTEE_BOUNDARY_KIND,
    generatedFrom:
      "src/api/*Capabilities(), src/*/gate.ts mutation gates, " +
      "BUILTIN_CAPABILITIES + classifyOperationRetry + " +
      "assertDispatchAllowed probes, NEXT_ACTION_REASON_CODES",
    rows: finalRows,
  };
}
