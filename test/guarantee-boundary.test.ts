/**
 * Guarantee-boundary matrix (#435, spec §9).
 *
 * The matrix is a projection of the live `*Capabilities()` /
 * `*MutationGate()` / `classifyOperationRetry` /
 * `assertDispatchAllowed` / `NEXT_ACTION_REASON_CODES` declarations —
 * these tests pin the contract shape, the per-class drag-drop
 * granularity, and agreement with the verification levels the safety
 * docs and specs already claim (where machine-checkable).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildGuaranteeBoundaryMatrix,
  GUARANTEE_BOUNDARY_KIND,
  GUARANTEE_BOUNDARY_SCHEMA_VERSION,
  normalizeVerificationLevel,
  type GuaranteeRow,
} from "../src/acceptance/guarantee-boundary.js";

const LEVELS = new Set([
  "implemented",
  "automated test",
  "fake/mock only",
  "verified on real host",
]);
const PLATFORMS = new Set(["macos", "windows"]);
const SUPPORTS = new Set(["supported", "partial", "unsupported"]);

function rows(): GuaranteeRow[] {
  return [...buildGuaranteeBoundaryMatrix().rows];
}

function find(
  predicate: (r: GuaranteeRow) => boolean,
): GuaranteeRow {
  const row = rows().find(predicate);
  expect(row, "expected matrix row").toBeDefined();
  return row!;
}

describe("guarantee-boundary matrix: contract shape", () => {
  it("carries the versioned kind and spec-required fields on every row", () => {
    const matrix = buildGuaranteeBoundaryMatrix();
    expect(matrix.kind).toBe(GUARANTEE_BOUNDARY_KIND);
    expect(matrix.schemaVersion).toBe(GUARANTEE_BOUNDARY_SCHEMA_VERSION);
    expect(matrix.rows.length).toBeGreaterThan(100);
    for (const row of matrix.rows) {
      expect(row.capability).toBeTruthy();
      expect(row.op).toBeTruthy();
      expect(row.platforms.length).toBeGreaterThan(0);
      for (const p of row.platforms) expect(PLATFORMS.has(p)).toBe(true);
      expect(SUPPORTS.has(row.support)).toBe(true);
      expect(LEVELS.has(row.verificationLevel)).toBe(true);
      expect(Array.isArray(row.refuseConditions)).toBe(true);
      expect(row.evidenceRef).toBeTruthy();
      expect(row.gate).toBeTruthy();
    }
  });

  it("normalizes verification strings without inventing levels", () => {
    expect(normalizeVerificationLevel("verified-real-host")).toBe("verified on real host");
    expect(normalizeVerificationLevel("verified on real host")).toBe("verified on real host");
    expect(normalizeVerificationLevel("automated-fake")).toBe("automated test");
    expect(normalizeVerificationLevel("automated test")).toBe("automated test");
    expect(normalizeVerificationLevel("fake/mock only")).toBe("fake/mock only");
    expect(normalizeVerificationLevel("implemented")).toBe("implemented");
    // Below the taxonomy floor the honest floor is `implemented`
    // (code exists and compiles); the raw string is preserved on the row.
    expect(normalizeVerificationLevel("unverified")).toBe("implemented");
    expect(normalizeVerificationLevel("not-run")).toBe("implemented");
  });

  it("the committed artifact under docs/evidence matches a fresh build", () => {
    const artifactPath = fileURLToPath(
      new URL("../docs/evidence/guarantee-boundary-matrix.json", import.meta.url),
    );
    const committed = JSON.parse(readFileSync(artifactPath, "utf-8"));
    expect(committed).toEqual(buildGuaranteeBoundaryMatrix());
  });
});

describe("guarantee-boundary matrix: per-class granularity", () => {
  const ELEMENT_CLASSES = ["project-item", "timeline-layer", "panel-tab", "other"];

  it("projects drag-drop element-drag per declared element class", () => {
    for (const element of ELEMENT_CLASSES) {
      const row = find(
        (r) =>
          r.capability === "dragDrop" &&
          r.op === "element-drag" &&
          r.opClass === element &&
          r.platforms.includes("macos"),
      );
      expect(row.gate).toBe("dragDropMutationGate");
      expect(row.gateProbe).toBeDefined();
    }
    for (const element of ["project-item", "timeline-layer", "panel-tab"]) {
      const row = find(
        (r) =>
          r.capability === "dragDrop" &&
          r.op === "element-drag" &&
          r.opClass === element &&
          r.platforms.includes("macos"),
      );
      expect(row.gateProbe?.allowed).toBe(true);
      expect(row.support).toBe("supported");
    }
    const other = find(
      (r) =>
        r.capability === "dragDrop" &&
        r.op === "element-drag" &&
        r.opClass === "other" &&
        r.platforms.includes("macos"),
    );
    expect(other.gateProbe?.allowed).toBe(false);
    expect(other.refuseConditions).toContain("mutation-gate-refused");
  });

  it("keeps the aggregate elementDrag row with a pointer to the classes", () => {
    const row = find(
      (r) => r.capability === "dragDrop" && r.op === "elementDrag" && r.opClass === undefined,
    );
    expect(row.note ?? "").toContain("per-class");
  });
});

describe("guarantee-boundary matrix: agreement with documented levels", () => {
  // Machine-checkable anchors from docs/gui-supervision-safety-gates.md
  // and the per-surface specs. A disagreement here is a spec/source bug,
  // not a run finding (spec §9 requirement).

  it("panel resize is verified on real host on macOS only (#358 class decision)", () => {
    const row = find(
      (r) => r.capability === "panel" && r.op === "resize" && r.platforms.includes("macos"),
    );
    expect(row.verificationLevel).toBe("verified on real host");
    expect(row.support).toBe("supported");
    expect(row.gate).toBe("panelMutationGate");
    expect(row.gateProbe?.allowed).toBe(true);

    const win = find(
      (r) => r.capability === "panel" && r.op === "resize" && r.platforms.includes("windows"),
    );
    expect(win.support).toBe("unsupported");
  });

  it("panel restore is advertised like resize — no capability-table gap (#445)", () => {
    const row = find(
      (r) => r.capability === "panel" && r.op === "restore" && r.platforms.includes("macos"),
    );
    expect(row.support).toBe("supported");
    expect(row.verificationLevel).toBe("verified on real host");
    expect(row.gate).toBe("panelMutationGate");
    expect(row.gateProbe?.allowed).toBe(true);
    expect(row.note ?? "").not.toContain("not advertised");

    const win = find(
      (r) => r.capability === "panel" && r.op === "restore" && r.platforms.includes("windows"),
    );
    expect(win.support).toBe("unsupported");
    expect(win.refuseConditions).toContain("unsupported:windows");
  });

  it("observe-class panel ops carry no mutation gate", () => {
    const row = find(
      (r) => r.capability === "panel" && r.op === "measure" && r.platforms.includes("macos"),
    );
    expect(row.gate).toBe("none");
  });

  it("builtin rows carry capability id, permissions, retryClass and dispatch refuse reasons", () => {
    const row = find((r) => r.capability === "builtin" && r.op === "project.open");
    expect(row.capabilityId).toBe("ae.operation.project.open");
    expect(row.permissions).toContain("write");
    expect(row.retryClass).toBe("unknown-side-effect");
    expect(row.gate).toBe("assertDispatchAllowed");
    expect(row.refuseConditions).toContain("ownership-unproven");

    const readOnly = find((r) => r.capability === "builtin" && r.op === "project.info");
    expect(readOnly.retryClass).toBe("read-only");
  });

  it("gated-off surfaces report partial/unsupported with the gate named", () => {
    const invoke = find(
      (r) => r.capability === "menuBar" && r.op === "invoke" && r.platforms.includes("macos"),
    );
    expect(invoke.gate).toBe("menuInvokeGate");
    expect(invoke.gateProbe?.allowed).toBe(false);
    expect(invoke.refuseConditions).toContain("mutation-gate-refused");

    const timeline = find(
      (r) => r.capability === "timeline" && r.op === "scrub" && r.platforms.includes("macos"),
    );
    expect(timeline.gate).toBe("timelineMutationGate");
    expect(timeline.gateProbe?.allowed).toBe(false);
  });

  it("supervision and next-action contracts are present with honest levels", () => {
    const supervision = find((r) => r.capability === "supervision" && r.op === "monitor");
    expect(supervision.verificationLevel).toBe("automated test");
    expect(supervision.platforms).toEqual(["macos", "windows"]);

    const codes = find((r) => r.capability === "nextActions" && r.op === "reason-codes");
    expect(codes.refuseConditions).toContain("monitor-lost");
    expect(codes.refuseConditions).toContain("unknown-outcome");
    expect(codes.refuseConditions).not.toContain("permitted");
  });

  it("input capabilities are reported per session kind", () => {
    const kinds = new Set(
      rows()
        .filter((r) => r.capability === "input" && r.op === "clipboard")
        .map((r) => r.sessionKind),
    );
    expect(kinds).toEqual(new Set(["shared", "dedicated", "unknown"]));
  });
});
