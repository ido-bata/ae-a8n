/**
 * Tier evidence record tests (#376, `specs/ime-input/spec.md` §4・§5.6,
 * parent #344 / program #337).
 *
 * These tests pin the evidence *boundary*: Tier-1a (CEP DOM composition
 * self-report), Tier-1b (OS IME end-to-end) and Tier-2 (real key +
 * committed result) are separate schemas/fields and are never merged
 * into one verdict; the spec §4.2 forbidden-evidence list is rejected,
 * not ignored; and every channel/capability answer is honest
 * (`supported`/`unsupported`/`unverified`). Verification level:
 * `automated test` — fixture JSONL is parsed from scripted text; no
 * real composition or IME event has been observed.
 */

import { describe, expect, it } from "vitest";

import {
  buildCompositionObserveReport,
  buildInputEvidenceReport,
  buildTier1aRecord,
  buildTier2Record,
  classifyInputDelivery,
  classifyInputDeliveryForTier2,
  compositionCoverage,
  compositionObserveChannels,
  evaluateTier1bEvidence,
  INPUT_EVIDENCE_REPORT_SCHEMA,
  INPUT_FIXTURE_ID,
  INPUT_TIER1A_SCHEMA,
  INPUT_TIER1B_SCHEMA,
  INPUT_TIER2_SCHEMA,
  parseFixtureReport,
  parseFixtureReportLine,
} from "../src/input/evidence.js";

// ------------------------------------------------------------ fixtures

function fixtureLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    fixture: INPUT_FIXTURE_ID,
    surface: "cep-composition",
    ts: "2026-11-27T00:00:00.000Z",
    kind: "compositionupdate",
    channel: "composition-event",
    tier: "1a",
    provesOsIme: false,
    verification: "implemented",
    data: { data: "にほん" },
    ...overrides,
  });
}

const READY_1A = fixtureLine({
  kind: "surface-ready",
  channel: "none",
  data: {
    compositionObserve: "supported",
    valueReadback: "supported",
    observation: ["composition-event", "dom-value"],
  },
});

const COMPOSITION_SEQUENCE = [
  fixtureLine({ kind: "compositionstart", data: { data: "" } }),
  fixtureLine({ kind: "compositionupdate", data: { data: "に" } }),
  fixtureLine({
    kind: "compositionend",
    data: { data: "にほん" },
    committedValue: "にほん",
    domValue: "にほん",
  }),
].join("\n");

const READY_2_UNSUPPORTED = fixtureLine({
  surface: "cep-custom-drawn",
  kind: "surface-ready",
  channel: "none",
  tier: "2",
  data: {
    compositionObserve: "unsupported",
    valueReadback: "unsupported",
    observation: ["key-event", "draw-state"],
  },
});

// ------------------------------------------------------- fixture ingest

describe("parseFixtureReportLine / parseFixtureReport", () => {
  it("accepts a well-formed fixture record", () => {
    const result = parseFixtureReportLine(fixtureLine());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.fixture).toBe(INPUT_FIXTURE_ID);
      expect(result.record.tier).toBe("1a");
      expect(result.record.provesOsIme).toBe(false);
    }
  });

  it("rejects a record claiming provesOsIme — overclaiming is not evidence", () => {
    const result = parseFixtureReportLine(fixtureLine({ provesOsIme: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("provesOsIme");
    }
  });

  it("rejects wrong fixture id, bad tier, missing surface and bad JSON — nothing is silently dropped", () => {
    expect(parseFixtureReportLine(fixtureLine({ fixture: "other" })).ok).toBe(false);
    expect(parseFixtureReportLine(fixtureLine({ tier: "1b" })).ok).toBe(false);
    expect(parseFixtureReportLine(fixtureLine({ surface: "" })).ok).toBe(false);
    expect(parseFixtureReportLine("{not json").ok).toBe(false);
    expect(parseFixtureReportLine("[1,2,3]").ok).toBe(false);
    expect(parseFixtureReportLine(fixtureLine({ v: 2 })).ok).toBe(false);
  });

  it("ingests JSONL and reports per-line rejections", () => {
    const jsonl = [READY_1A, "{bad", COMPOSITION_SEQUENCE, ""].join("\n");
    const { records, rejections } = parseFixtureReport(jsonl);
    expect(records.length).toBe(4);
    expect(rejections).toEqual([{ line: 2, reason: expect.stringContaining("invalid JSON") }]);
  });
});

// --------------------------------------------------- coverage + channels

describe("compositionCoverage / compositionObserveChannels", () => {
  it("reports per-surface supported / unsupported / unverified honestly", () => {
    const { records } = parseFixtureReport(
      [READY_1A, COMPOSITION_SEQUENCE, READY_2_UNSUPPORTED, fixtureLine({
        surface: "scriptui-palette",
        tier: "2",
        kind: "draw-state",
        channel: "extendscript-readback",
      })].join("\n"),
    );
    const coverage = compositionCoverage(records);
    const bySurface = new Map(coverage.map((c) => [c.surface, c]));

    expect(bySurface.get("cep-composition")?.compositionObserve).toBe("supported");
    expect(bySurface.get("cep-composition")?.source).toBe("fixture-declared");
    expect(bySurface.get("cep-custom-drawn")?.compositionObserve).toBe("unsupported");
    expect(bySurface.get("cep-custom-drawn")?.valueReadback).toBe("unsupported");
    // Events but no surface-ready declaration → unverified, never guessed.
    expect(bySurface.get("scriptui-palette")?.compositionObserve).toBe("unverified");
    expect(bySurface.get("scriptui-palette")?.source).toBe("fixture-events");
  });

  it("reports CDP as unverified — never silently skipped, never counted", () => {
    const channels = compositionObserveChannels();
    const cdp = channels.find((c) => c.channel === "cdp");
    expect(cdp?.status).toBe("unverified");
    expect(cdp?.detail).toContain("unverified");
    const selfReport = channels.find((c) => c.channel === "fixture-self-report");
    expect(selfReport?.status).toBe("supported");
  });
});

// ------------------------------------------- delivery classification (§4.2)

describe("classifyInputDelivery — the forbidden-evidence boundary", () => {
  it("admits only the OS input stream for a Tier-1b verdict", () => {
    const admitted = classifyInputDelivery("platform-session-stream");
    expect(admitted.tier1b).toBe("admissible");
    expect(admitted.deliveryClass).toBe("os-input-stack");
  });

  it("keeps IME-unverified OS key mechanisms unverified for Tier-1b", () => {
    for (const mechanism of ["os-target-post", "system-events"] as const) {
      const assessment = classifyInputDelivery(mechanism);
      expect(assessment.tier1b).toBe("unverified");
      // Tier-2 claims only real-key delivery, so these ARE admissible there.
      expect(classifyInputDeliveryForTier2(mechanism).tier2).toBe("admissible");
    }
  });

  it("rejects every spec §4.2 forbidden mechanism for Tier-1b", () => {
    const forbidden = [
      "cdp-input",
      "dom-value-set",
      "extendscript-write",
      "cep-evalscript",
      "uia-set-value",
      "clipboard-paste",
    ] as const;
    for (const mechanism of forbidden) {
      const assessment = classifyInputDelivery(mechanism);
      expect(assessment.tier1b, mechanism).toBe("rejected");
      expect(assessment.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects synthesized/bulk mechanisms for Tier-2 real-key claims too", () => {
    for (const mechanism of [
      "cdp-input",
      "dom-value-set",
      "extendscript-write",
      "cep-evalscript",
      "uia-set-value",
      "clipboard-paste",
    ] as const) {
      expect(classifyInputDeliveryForTier2(mechanism).tier2, mechanism).toBe("rejected");
    }
    expect(classifyInputDeliveryForTier2("platform-session-stream").tier2).toBe("admissible");
  });

  it("treats unknown mechanisms as never creditable", () => {
    expect(classifyInputDelivery("unknown").tier1b).toBe("unverified");
    expect(classifyInputDelivery("unknown").tier2).toBe("unverified");
  });
});

// ------------------------------------------------------------ Tier-1a

describe("buildTier1aRecord", () => {
  const records = parseFixtureReport([READY_1A, COMPOSITION_SEQUENCE].join("\n")).records;

  it("observes DOM composition + committed DOM value — and still provesOsIme=false", () => {
    const record = buildTier1aRecord({
      surface: "cep-composition",
      records,
      observedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(record.schema).toBe(INPUT_TIER1A_SCHEMA);
    expect(record.verdict).toBe("observed");
    expect(record.committedDomValue).toBe("にほん");
    expect(record.provesOsIme).toBe(false);
    expect(record.eventCounts.compositionstart).toBe(1);
    expect(record.eventCounts.compositionend).toBe(1);
    expect(record.detail).toContain("does NOT prove the OS IME");
  });

  it("reports unsupported when the surface declares it", () => {
    const { records: drawn } = parseFixtureReport(READY_2_UNSUPPORTED);
    const record = buildTier1aRecord({ surface: "cep-custom-drawn", records: drawn });
    expect(record.verdict).toBe("unsupported");
  });

  it("stays unverified on value traffic without composition events", () => {
    const { records: valueOnly } = parseFixtureReport(
      fixtureLine({ kind: "input", channel: "dom-value", committedValue: "x" }),
    );
    const record = buildTier1aRecord({ surface: "cep-composition", records: valueOnly });
    expect(record.verdict).toBe("unverified");
  });
});

// ------------------------------------------------------------ Tier-1b

describe("evaluateTier1bEvidence — forbidden evidence is rejected", () => {
  it("rejects a Tier-1b claim built only on forbidden mechanisms", () => {
    const record = evaluateTier1bEvidence({
      deliveries: ["cdp-input", "dom-value-set", "uia-set-value", "clipboard-paste"],
      committedValue: "にほん",
      observedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(record.schema).toBe(INPUT_TIER1B_SCHEMA);
    expect(record.verdict).toBe("rejected");
    expect(record.rejectedEvidence.map((r) => r.mechanism)).toEqual([
      "cdp-input",
      "dom-value-set",
      "uia-set-value",
      "clipboard-paste",
    ]);
    // The committed value is still recorded as evidence of the RESULT —
    // it just cannot credit a forbidden delivery.
    expect(record.committedValue).toBe("にほん");
  });

  it("is unverified when only unverified mechanisms are supplied", () => {
    const record = evaluateTier1bEvidence({
      deliveries: ["os-target-post", "system-events"],
      committedValue: "にほん",
    });
    expect(record.verdict).toBe("unverified");
    expect(record.rejectedEvidence).toEqual([]);
  });

  it("observes only with admissible delivery AND committed proof", () => {
    const noProof = evaluateTier1bEvidence({
      deliveries: ["platform-session-stream"],
    });
    expect(noProof.verdict).toBe("unverified");

    const observed = evaluateTier1bEvidence({
      deliveries: ["platform-session-stream"],
      committedValue: "にほん",
      phases: {
        uncommitted: true,
        conversion: true,
        candidate: true,
        commit: true,
        cancel: false,
      },
      observedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(observed.verdict).toBe("observed");
    expect(observed.detail).not.toContain("partially observed");
  });

  it("observes via screen-change proof and reports unobserved phases honestly", () => {
    const record = evaluateTier1bEvidence({
      deliveries: ["platform-session-stream"],
      screenChangeObserved: true,
      screenChangeDetail: "capture diff at commit",
    });
    expect(record.verdict).toBe("observed");
    expect(record.phases).toBeNull();
    expect(record.detail).toContain("phases were not observed");
  });

  it("lists rejected claims even alongside admissible ones", () => {
    const record = evaluateTier1bEvidence({
      deliveries: ["platform-session-stream", "cdp-input"],
      committedValue: "にほん",
    });
    expect(record.verdict).toBe("observed");
    expect(record.rejectedEvidence).toHaveLength(1);
    expect(record.rejectedEvidence[0]?.mechanism).toBe("cdp-input");
  });
});

// ------------------------------------------------------------ Tier-2

describe("buildTier2Record", () => {
  it("rejects when every claim is forbidden as real-key input", () => {
    const record = buildTier2Record({
      surface: "scriptui-palette",
      deliveries: ["dom-value-set", "extendscript-write", "clipboard-paste"],
      committedResult: { kind: "value", value: "x", readbackChannel: "extendscript-readback" },
    });
    expect(record.schema).toBe(INPUT_TIER2_SCHEMA);
    expect(record.verdict).toBe("rejected");
    expect(record.rejectedEvidence).toHaveLength(3);
    expect(record.compositionObservationRequired).toBe(false);
  });

  it("observes real-key delivery plus a committed result — composition not required", () => {
    const record = buildTier2Record({
      surface: "scriptui-palette",
      deliveries: ["os-target-post"],
      committedResult: {
        kind: "capture-diff",
        observed: true,
        detail: "panel capture diff",
      },
      observedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(record.verdict).toBe("observed");
    expect(record.compositionObservationRequired).toBe(false);
    expect(record.detail).toContain("not required");
  });

  it("stays unverified when delivery is claimed but no committed result exists", () => {
    const record = buildTier2Record({
      surface: "scriptui-palette",
      deliveries: ["platform-session-stream"],
      committedResult: { kind: "value", value: "", readbackChannel: "extendscript-readback" },
    });
    expect(record.verdict).toBe("unverified");
  });
});

// ------------------------------------------------- the combined report

describe("buildInputEvidenceReport — tiers never merge", () => {
  it("expresses 'Tier1a observed / Tier1b unverified' as separate records", () => {
    const { records } = parseFixtureReport([READY_1A, COMPOSITION_SEQUENCE].join("\n"));
    const tier1a = buildTier1aRecord({ surface: "cep-composition", records });
    const tier1b = evaluateTier1bEvidence({
      deliveries: ["os-target-post"],
      committedValue: "にほん",
    });
    const report = buildInputEvidenceReport({
      tier1a,
      tier1b,
      records,
      observedAt: "2026-11-27T00:00:00.000Z",
    });

    expect(report.schema).toBe(INPUT_EVIDENCE_REPORT_SCHEMA);
    expect(report.tier1a?.schema).toBe(INPUT_TIER1A_SCHEMA);
    expect(report.tier1b?.schema).toBe(INPUT_TIER1B_SCHEMA);
    expect(report.tier1a?.verdict).toBe("observed");
    expect(report.tier1b?.verdict).toBe("unverified");
    // No merged verdict field exists by construction.
    expect("verdict" in report).toBe(false);
    expect(report.summary.tier1a).toContain("observed");
    expect(report.summary.tier1b).toContain("unverified");
    expect(report.summary.tier1a).not.toBe(report.summary.tier1b);
  });

  it("carries ingest rejections and the channel honesty table", () => {
    const { records, rejections } = parseFixtureReport(`{bad\n${READY_1A}`);
    const report = buildInputEvidenceReport({ records, ingestRejections: rejections });
    expect(report.ingestRejections).toHaveLength(1);
    expect(report.channels.find((c) => c.channel === "cdp")?.status).toBe("unverified");
    expect(report.tier2).toBeNull();
    expect(report.summary.tier2).toBe("Tier2: no record");
  });
});

// ------------------------------------------------- composition-observe

describe("buildCompositionObserveReport", () => {
  it("returns coverage + channels + the named surface's Tier-1a record", () => {
    const { records, rejections } = parseFixtureReport(
      [READY_1A, COMPOSITION_SEQUENCE, "{bad"].join("\n"),
    );
    const report = buildCompositionObserveReport({
      surface: "cep-composition",
      records,
      ingestRejections: rejections,
      observedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(report.surface).toBe("cep-composition");
    expect(report.tier1a?.verdict).toBe("observed");
    expect(report.tier1a?.provesOsIme).toBe(false);
    expect(report.coverage).toHaveLength(1);
    expect(report.ingestRejections).toHaveLength(1);
    expect(report.channels.find((c) => c.channel === "cdp")?.status).toBe("unverified");
  });

  it("answers honestly with no records and no surface", () => {
    const report = buildCompositionObserveReport({ records: [] });
    expect(report.surface).toBeNull();
    expect(report.tier1a).toBeNull();
    expect(report.coverage).toEqual([]);
    expect(report.channels.length).toBeGreaterThan(0);
  });
});
