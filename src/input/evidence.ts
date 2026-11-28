/**
 * Tier evidence records for OS-level input (#376,
 * `specs/ime-input/spec.md` §4・§5.6, parent #344 / program #337).
 *
 * The spec's load-bearing rule is that "composition" exists at two
 * layers and the evidence must never be blurred:
 *
 *   - **Tier-1a** — CEP/DOM composition protocol: what the panel's own
 *     DOM saw (fixture self-report is the primary channel, spec §4.1).
 *     A Tier-1a record NEVER claims the OS IME ran — DOM composition
 *     events also fire for synthesized input.
 *   - **Tier-1b** — OS IME end-to-end: key events traversing the
 *     platform text-input/IME stack, judged by committed value and/or
 *     observable screen change (spec §4.2). This is the ONLY record
 *     allowed to carry an OS-IME verdict, and only delivery through the
 *     OS input stack is admissible — CDP `Input.*`, DOM value
 *     assignment, ExtendScript/evalScript writes, UIA `SetValue` and
 *     paste-only are forbidden evidence and are rejected, not ignored.
 *   - **Tier-2** — ScriptUI/native/custom-drawn surfaces: real key
 *     input plus a committed result (value readback or capture diff);
 *     internal composition observation is explicitly non-required
 *     (spec §4.3).
 *
 * These records are a PARALLEL evidence channel to the
 * `ae-a8n.gui-evidence/v1` index (`src/evidence/`): that index binds
 * screen/render artifacts and the trace to operations; input tier
 * records are the §5.6 audit-side verdicts. Nothing here merges the
 * tiers — `buildInputEvidenceReport` keeps the three sections separate
 * and carries no combined "IME works" verdict by construction.
 *
 * Verification level: `automated test` — fixture JSONL is parsed from
 * scripted text; no real composition or IME event has been observed.
 * Every channel status this module can emit is capped at
 * `unverified`/`unsupported` honesty; nothing claims
 * `verified on real host`.
 */

import type { PanelTarget } from "../panels/types.js";

// ---------------------------------------------------------------------
// Schema ids
// ---------------------------------------------------------------------

export const INPUT_TIER1A_SCHEMA = "ae-a8n.input-tier1a/v1";
export const INPUT_TIER1B_SCHEMA = "ae-a8n.input-tier1b/v1";
export const INPUT_TIER2_SCHEMA = "ae-a8n.input-tier2/v1";
export const INPUT_EVIDENCE_REPORT_SCHEMA = "ae-a8n.input-evidence/v1";

/** The fixture id every `fixtures/input/` record carries (see its README). */
export const INPUT_FIXTURE_ID = "ae-a8n-ime-input";

// ---------------------------------------------------------------------
// Fixture self-report ingest (spec §4.1 channel 1 — primary Tier-1a)
// ---------------------------------------------------------------------

/** Record kinds the `fixtures/input/` surfaces emit (README contract). */
export const FIXTURE_REPORT_KINDS = [
  "surface-ready",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "input",
  "keydown",
  "keyup",
  "draw-state",
  "report-error",
] as const;

/** Observation channels a fixture record can arrive through. */
export const FIXTURE_REPORT_CHANNELS = [
  "composition-event",
  "dom-value",
  "key-event",
  "draw-state",
  "extendscript-readback",
  "none",
] as const;

/**
 * One parsed fixture self-report line. Shape mirrors
 * `fixtures/input/README.md`; unknown extra fields are preserved in
 * `data`/top-level extras are dropped — the record is evidence, not a
 * free-form bag.
 */
export type FixtureReportRecord = {
  readonly v: 1;
  readonly fixture: string;
  readonly surface: string;
  readonly ts: string | null;
  readonly kind: string;
  readonly channel: string;
  /** `"1a"` (CEP composition) or `"2"` (ScriptUI/native/custom-drawn). */
  readonly tier: "1a" | "2";
  /**
   * Always `false` by contract: a fixture record that claims
   * `provesOsIme: true` is rejected at parse time — it is attempting
   * to pass Tier-1a/Tier-2 observation off as an OS-IME verdict.
   */
  readonly provesOsIme: false;
  readonly verification: string;
  readonly data: unknown;
  readonly domValue?: string | null | undefined;
  readonly committedValue?: string | null | undefined;
  readonly drawnText?: string | null | undefined;
  readonly detail?: string | null | undefined;
};

/** A line that could not be accepted as fixture evidence — reported, never dropped. */
export type FixtureReportRejection = {
  /** 1-based line number in the JSONL source. */
  readonly line: number;
  readonly reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse one JSONL line into a `FixtureReportRecord`, or return the
 * rejection reason. Fail-closed on the evidence boundary: wrong schema
 * version, wrong fixture id, missing surface/kind, an unknown tier, or
 * any `provesOsIme` other than `false` are all rejections — a malformed
 * or overclaiming line is evidence of a broken bridge and is surfaced
 * in `rejections`, not silently skipped.
 */
export function parseFixtureReportLine(
  line: string,
): { ok: true; record: FixtureReportRecord } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      ok: false,
      reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "record is not a JSON object" };
  }
  if (parsed.v !== 1) {
    return { ok: false, reason: `unsupported schema version v=${String(parsed.v)}` };
  }
  if (parsed.fixture !== INPUT_FIXTURE_ID) {
    return {
      ok: false,
      reason: `fixture id is ${JSON.stringify(parsed.fixture)}, expected ${JSON.stringify(INPUT_FIXTURE_ID)}`,
    };
  }
  if (typeof parsed.surface !== "string" || parsed.surface === "") {
    return { ok: false, reason: "missing or empty surface" };
  }
  if (typeof parsed.kind !== "string" || parsed.kind === "") {
    return { ok: false, reason: "missing or empty kind" };
  }
  if (parsed.tier !== "1a" && parsed.tier !== "2") {
    return {
      ok: false,
      reason: `tier is ${JSON.stringify(parsed.tier)}; only "1a" and "2" exist`,
    };
  }
  if (parsed.provesOsIme !== false) {
    return {
      ok: false,
      reason:
        "record claims provesOsIme — fixture self-report can never " +
        "prove the OS IME ran (spec §4.1/§4.2); rejected",
    };
  }
  return {
    ok: true,
    record: {
      v: 1,
      fixture: INPUT_FIXTURE_ID,
      surface: parsed.surface,
      ts: typeof parsed.ts === "string" ? parsed.ts : null,
      kind: parsed.kind,
      channel: typeof parsed.channel === "string" ? parsed.channel : "none",
      tier: parsed.tier,
      provesOsIme: false,
      verification: typeof parsed.verification === "string" ? parsed.verification : "unverified",
      data: parsed.data ?? null,
      ...(optionalString(parsed.domValue) !== undefined
        ? { domValue: optionalString(parsed.domValue) ?? null }
        : {}),
      ...(optionalString(parsed.committedValue) !== undefined
        ? { committedValue: optionalString(parsed.committedValue) ?? null }
        : {}),
      ...(optionalString(parsed.drawnText) !== undefined
        ? { drawnText: optionalString(parsed.drawnText) ?? null }
        : {}),
      ...(optionalString(parsed.detail) !== undefined
        ? { detail: optionalString(parsed.detail) ?? null }
        : {}),
    },
  };
}

/**
 * Ingest a fixture JSONL stream (the `lib/report.js` file sink or an
 * exported buffer). Blank lines are skipped; every other line is either
 * a record or a named rejection — the ingest never silently drops.
 */
export function parseFixtureReport(jsonl: string): {
  readonly records: readonly FixtureReportRecord[];
  readonly rejections: readonly FixtureReportRejection[];
} {
  const records: FixtureReportRecord[] = [];
  const rejections: FixtureReportRejection[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") {
      continue;
    }
    const result = parseFixtureReportLine(line);
    if (result.ok) {
      records.push(result.record);
    } else {
      rejections.push({ line: i + 1, reason: result.reason });
    }
  }
  return { records, rejections };
}

// ---------------------------------------------------------------------
// Per-surface composition coverage (spec §4.1, §6 composition-observe)
// ---------------------------------------------------------------------

/** Honest support answer for one observation capability on one surface. */
export type CompositionSupport = "supported" | "unsupported" | "unverified";

/** Where a surface's coverage declaration came from. */
export type CompositionCoverageSource =
  /** The fixture's own `surface-ready` record declared it. */
  | "fixture-declared"
  /** Events exist but no `surface-ready` declaration was seen. */
  | "fixture-events"
  /** Nothing observed or declared for this surface. */
  | "none";

/**
 * Per-surface composition-observe coverage. `compositionObserve` and
 * `valueReadback` are the fixture's own declarations (or `unverified`
 * when undeclared); `unsupported` is a first-class honest answer —
 * e.g. the Tier-2 canvas declares both unsupported up front.
 */
export type CompositionSurfaceCoverage = {
  readonly surface: string;
  readonly tier: "1a" | "2" | "unknown";
  readonly compositionObserve: CompositionSupport;
  readonly valueReadback: CompositionSupport;
  /** Observation channels the surface declared (`surface-ready.data.observation`). */
  readonly observation: readonly string[];
  readonly source: CompositionCoverageSource;
  readonly detail: string | null;
};

function supportValue(value: unknown): CompositionSupport {
  if (value === "supported" || value === "unsupported" || value === "unverified") {
    return value;
  }
  return "unverified";
}

function dataRecord(record: FixtureReportRecord): Record<string, unknown> {
  return isRecord(record.data) ? record.data : {};
}

/**
 * Derive per-surface coverage from ingested fixture records. Every
 * surface that produced any record gets a row; a surface with events
 * but no `surface-ready` declaration reports `unverified`, never a
 * guessed `supported`.
 */
export function compositionCoverage(
  records: readonly FixtureReportRecord[],
): readonly CompositionSurfaceCoverage[] {
  const surfaces = new Map<
    string,
    { tier: "1a" | "2" | "unknown"; ready: FixtureReportRecord | null; sawEvents: boolean }
  >();
  for (const record of records) {
    let entry = surfaces.get(record.surface);
    if (entry === undefined) {
      entry = { tier: "unknown", ready: null, sawEvents: false };
      surfaces.set(record.surface, entry);
    }
    if (entry.tier === "unknown") {
      entry.tier = record.tier;
    }
    if (record.kind === "surface-ready") {
      entry.ready = record;
    } else {
      entry.sawEvents = true;
    }
  }

  const coverage: CompositionSurfaceCoverage[] = [];
  for (const [surface, entry] of surfaces) {
    if (entry.ready !== null) {
      const data = dataRecord(entry.ready);
      const observation = Array.isArray(data.observation)
        ? data.observation.filter((v): v is string => typeof v === "string")
        : [];
      coverage.push({
        surface,
        tier: entry.tier,
        compositionObserve: supportValue(data.compositionObserve),
        valueReadback: supportValue(data.valueReadback),
        observation,
        source: "fixture-declared",
        detail:
          typeof data.note === "string"
            ? data.note
            : entry.ready.detail ?? null,
      });
    } else {
      coverage.push({
        surface,
        tier: entry.tier,
        compositionObserve: "unverified",
        valueReadback: "unverified",
        observation: [],
        source: entry.sawEvents ? "fixture-events" : "none",
        detail:
          entry.sawEvents
            ? "events were observed but the surface never declared its " +
              "composition-observe capability in a surface-ready record"
            : "no surface-ready record or events were observed",
      });
    }
  }
  return coverage;
}

// ---------------------------------------------------------------------
// Observation channel honesty (spec §4.1 channels 2–3)
// ---------------------------------------------------------------------

/** The three observation channels spec §4.1 names, plus the fixture readback. */
export type InputObservationChannel =
  /** Fixture self-report through the extension's own bridge — primary Tier-1a. */
  | "fixture-self-report"
  /** CDP on AE's CEF — feasibility unverified (T001 investigation). */
  | "cdp"
  /** OS accessibility marked-text (AX/UIA) — best-effort only. */
  | "os-accessibility"
  /** ExtendScript retained-control readback (ScriptUI fixture, Tier-2 oracle). */
  | "fixture-readback";

export type InputObservationChannelReport = {
  readonly channel: InputObservationChannel;
  readonly status: CompositionSupport;
  readonly detail: string;
};

/**
 * The honest per-channel status table. `fixture-self-report` is
 * `supported` as a *mechanism* (fixture code + ingest exist and are
 * automated-tested) — whether a given surface actually emits is the
 * per-surface coverage's job. CDP is `unverified`: AE's CEF exposes no
 * documented remote-debugging endpoint and feasibility is a real-host
 * investigation, so it is reported, never silently skipped. OS
 * accessibility marked-text is `unverified`: no AX/UIA marked-text
 * reader exists yet and whether `AXValue` exposes in-progress
 * composition is unproven — best-effort only, never sole IME evidence.
 */
export function compositionObserveChannels(): readonly InputObservationChannelReport[] {
  return [
    {
      channel: "fixture-self-report",
      status: "supported",
      detail:
        "primary Tier-1a channel (spec §4.1 channel 1): the fixture's own " +
        "DOM listeners report through the extension bridge; ingest and " +
        "per-surface coverage are implemented — real-host delivery is " +
        "verified only when a fixture panel actually runs",
    },
    {
      channel: "cdp",
      status: "unverified",
      detail:
        "CDP feasibility on AE's CEF is unproven (spec §4.1 channel 2, " +
        "T001): no documented remote-debugging endpoint; reported as " +
        "unverified, never silently skipped and never counted as " +
        "evidence",
    },
    {
      channel: "os-accessibility",
      status: "unverified",
      detail:
        "AX/UIA marked-text read is best-effort only (spec §4.1 " +
        "channel 3): no marked-text reader exists and whether AXValue " +
        "exposes in-progress composition is unproven; never sole " +
        "Tier-1b evidence",
    },
    {
      channel: "fixture-readback",
      status: "supported",
      detail:
        "ExtendScript retained-control readback (ScriptUI fixture, " +
        "spec §4.3): read-only committed-value oracle for Tier-2; a " +
        "write through this channel is direct-set and never evidence",
    },
  ];
}

// ---------------------------------------------------------------------
// Delivery mechanism classification — the forbidden-evidence boundary
// ---------------------------------------------------------------------

/**
 * Every way input/text could be claimed to have reached a surface.
 * The union is deliberately closed: an unrecognized delivery claim is
 * `"unknown"` and is never upgraded to admissible.
 */
export const INPUT_DELIVERY_MECHANISMS = [
  /**
   * Real key/text events posted through the OS-wide input stream —
   * macOS `CGEventPost` to the HID/session tap, Windows `SendInput`.
   * The only channel spec §4.2 admits for a Tier-1b verdict.
   */
  "platform-session-stream",
  /**
   * `CGEventPostToPid`-style target-scoped posting. Delivers real key
   * events but its IME pass-through is unverified (spec §7 T001) —
   * admissible for Tier-2 real-key claims, never credited for Tier-1b
   * until measured.
   */
  "os-target-post",
  /**
   * `System Events keystroke`-style Apple-event delivery. Real key
   * events whose IME-stack traversal is unverified (spec §4.2) — same
   * standing as `os-target-post`.
   */
  "system-events",
  /** Any CDP `Input.*` dispatch (`insertText`, `imeSetComposition`, `dispatchKeyEvent`, …). */
  "cdp-input",
  /** DOM `value`/`textContent` assignment inside the panel. */
  "dom-value-set",
  /** ExtendScript property write reaching the control. */
  "extendscript-write",
  /** CEP `evalScript` write. */
  "cep-evalscript",
  /** UIA `ValuePattern.SetValue`. */
  "uia-set-value",
  /** Clipboard write + paste as the sole input mechanism. */
  "clipboard-paste",
  /** Anything not named above — never upgraded. */
  "unknown",
] as const;

export type InputDeliveryMechanism = (typeof INPUT_DELIVERY_MECHANISMS)[number];

/**
 * What kind of delivery a mechanism really is:
 *
 * - `"os-input-stack"`: posts through the platform input pipeline —
 *   the Tier-1b candidate channel.
 * - `"os-key-events"`: real OS key events whose IME-stack traversal is
 *   unproven — Tier-2 admissible, Tier-1b unverified.
 * - `"synthesized"`: never real OS input — forbidden evidence for both
 *   tiers (spec §4.2).
 * - `"bulk-entry"`: clipboard+paste — a legitimate operation class but
 *   never evidence that typing/IME works.
 * - `"unknown"`: unclassifiable — reported, never credited.
 */
export type InputDeliveryClass =
  | "os-input-stack"
  | "os-key-events"
  | "synthesized"
  | "bulk-entry"
  | "unknown";

/** Whether a mechanism may feed a tier verdict. */
export type DeliveryAdmissibility = "admissible" | "unverified" | "rejected";

export type DeliveryAssessment = {
  readonly mechanism: InputDeliveryMechanism;
  readonly deliveryClass: InputDeliveryClass;
  /** Admissibility toward a Tier-1b (OS IME) verdict. */
  readonly tier1b: DeliveryAdmissibility;
  /** Admissibility as Tier-2 "real key input". */
  readonly tier2: DeliveryAdmissibility;
  readonly reason: string;
};

const DELIVERY_CLASS: Readonly<Record<InputDeliveryMechanism, InputDeliveryClass>> = {
  "platform-session-stream": "os-input-stack",
  "os-target-post": "os-key-events",
  "system-events": "os-key-events",
  "cdp-input": "synthesized",
  "dom-value-set": "synthesized",
  "extendscript-write": "synthesized",
  "cep-evalscript": "synthesized",
  "uia-set-value": "synthesized",
  "clipboard-paste": "bulk-entry",
  unknown: "unknown",
};

const TIER1B_REASON: Readonly<Record<InputDeliveryMechanism, string>> = {
  "platform-session-stream":
    "posts through the OS input stream (CGEvent HID/session tap, " +
    "SendInput) — the only channel spec §4.2 admits; real IME " +
    "pass-through remains a real-host question but the mechanism is " +
    "the correct one",
  "os-target-post":
    "CGEventPostToPid delivers real key events but its IME " +
    "pass-through is unverified (spec §7 T001) — not credited as " +
    "Tier-1b until measured",
  "system-events":
    "System Events keystroke is unverified against the input-method " +
    "stack (spec §4.2) — neither credited nor debited until measured",
  "cdp-input":
    "forbidden Tier-1b evidence (spec §4.2): CDP Input.insertText / " +
    "imeSetComposition / dispatchKeyEvent bypass the OS input stack",
  "dom-value-set":
    "forbidden Tier-1b evidence (spec §4.2): DOM value/textContent " +
    "assignment is a direct set, not input",
  "extendscript-write":
    "forbidden Tier-1b evidence (spec §4.2): an ExtendScript property " +
    "write is a direct set, not input",
  "cep-evalscript":
    "forbidden Tier-1b evidence (spec §4.2): a CEP evalScript write is " +
    "a direct set, not input",
  "uia-set-value":
    "forbidden Tier-1b evidence (spec §4.2): UIA ValuePattern.SetValue " +
    "writes the value without any key/input path",
  "clipboard-paste":
    "forbidden as sole Tier-1b evidence (spec §4.2): a pasted string " +
    "is not evidence that typing/IME works; paste may be used for " +
    "setup when the assertion is labelled accordingly",
  unknown:
    "unrecognized delivery mechanism — reported, never credited",
};

const TIER2_REASON: Readonly<Record<InputDeliveryMechanism, string>> = {
  "platform-session-stream":
    "real key events through the OS input stream — admissible Tier-2 " +
    "delivery",
  "os-target-post":
    "real key events target-scoped; IME pass-through unverified but " +
    "Tier-2 does not claim IME — admissible real-key delivery",
  "system-events":
    "real key events via Apple events; IME path unverified but " +
    "Tier-2 claims only real-key delivery — admissible",
  "cdp-input":
    "forbidden: CDP input dispatch never traverses the OS key path",
  "dom-value-set":
    "forbidden: a DOM value assignment is not key input",
  "extendscript-write":
    "forbidden: an ExtendScript write is not key input",
  "cep-evalscript":
    "forbidden: an evalScript write is not key input",
  "uia-set-value":
    "forbidden: UIA SetValue is not key input",
  "clipboard-paste":
    "forbidden as the input claim: bulk paste is not real key input " +
    "(usable for setup only, labelled accordingly)",
  unknown: "unrecognized delivery mechanism — reported, never credited",
};

function tier1bAdmissibility(mechanism: InputDeliveryMechanism): DeliveryAdmissibility {
  switch (DELIVERY_CLASS[mechanism]) {
    case "os-input-stack":
      return "admissible";
    case "os-key-events":
    case "unknown":
      return "unverified";
    default:
      return "rejected";
  }
}

function tier2Admissibility(mechanism: InputDeliveryMechanism): DeliveryAdmissibility {
  switch (DELIVERY_CLASS[mechanism]) {
    case "os-input-stack":
    case "os-key-events":
      return "admissible";
    case "unknown":
      return "unverified";
    default:
      return "rejected";
  }
}

/**
 * Classify one claimed delivery mechanism against the spec §4.2
 * forbidden-evidence list. This is the single place the boundary is
 * enforced: callers submit *claims*, the assessment decides whether
 * each may feed a tier verdict. Rejected mechanisms are labelled with
 * the spec reason — they are never silently dropped.
 */
export function classifyInputDelivery(
  mechanism: InputDeliveryMechanism,
): DeliveryAssessment {
  return {
    mechanism,
    deliveryClass: DELIVERY_CLASS[mechanism],
    tier1b: tier1bAdmissibility(mechanism),
    tier2: tier2Admissibility(mechanism),
    reason: TIER1B_REASON[mechanism],
  };
}

/** Tier-2 reason variant for reports that display per-tier reasoning. */
export function classifyInputDeliveryForTier2(
  mechanism: InputDeliveryMechanism,
): DeliveryAssessment {
  return {
    ...classifyInputDelivery(mechanism),
    reason: TIER2_REASON[mechanism],
  };
}

// ---------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------

/**
 * Tier verdict vocabulary. `"rejected"` means every submitted evidence
 * channel was forbidden under spec §4.2 — distinct from `"failed"`
 * (an admissible attempt that did not produce the result) and
 * `"unverified"` (nothing admissible was observed).
 */
export type TierVerdict =
  | "observed"
  | "unverified"
  | "unsupported"
  | "failed"
  | "rejected";

function rejectedSummary(
  assessments: readonly DeliveryAssessment[],
): { entries: { mechanism: string; reason: string }[]; anyRejected: boolean } {
  const entries = assessments
    .filter((a) => a.tier1b === "rejected" || a.tier2 === "rejected")
    .map((a) => ({ mechanism: a.mechanism, reason: a.reason }));
  return { entries, anyRejected: entries.length > 0 };
}

// ---------------------------------------------------------------------
// Tier-1a record — CEP composition protocol (spec §4.1)
// ---------------------------------------------------------------------

const COMPOSITION_KINDS = new Set([
  "compositionstart",
  "compositionupdate",
  "compositionend",
]);

export type Tier1aEvidenceRecord = {
  readonly schema: typeof INPUT_TIER1A_SCHEMA;
  readonly surface: string;
  /** The observation channel the events arrived through. */
  readonly channel: InputObservationChannel;
  /** Per-surface capability as declared/observed — `unsupported` is honest. */
  readonly coverage: CompositionSurfaceCoverage;
  /** The fixture self-report events for this surface (tier "1a" only). */
  readonly events: readonly FixtureReportRecord[];
  /** Event counts keyed by `kind`. */
  readonly eventCounts: Readonly<Record<string, number>>;
  /**
   * Latest DOM value observed at `compositionend`/`input` — the
   * committed DOM value, reported separately from event payloads
   * (spec §4.1).
   */
  readonly committedDomValue: string | null;
  /** Literal `false`: Tier-1a never proves the OS IME ran. */
  readonly provesOsIme: false;
  readonly verdict: TierVerdict;
  readonly detail: string | null;
  readonly observedAt: string;
};

/**
 * Build the Tier-1a record for one surface from ingested fixture
 * records. Verdict rules:
 *
 *   - coverage `unsupported` → `unsupported`.
 *   - composition events AND a committed DOM value → `observed`
 *     (Tier-1a composition observed: yes — still `provesOsIme: false`).
 *   - composition events without a committed value → `unverified`.
 *   - only `input`/`dom-value` traffic, no composition events →
 *     `unverified` (value traffic alone is not composition evidence).
 *   - nothing → `unverified`.
 */
export function buildTier1aRecord(options: {
  readonly surface: string;
  readonly records: readonly FixtureReportRecord[];
  readonly channel?: InputObservationChannel | undefined;
  readonly observedAt?: string | undefined;
}): Tier1aEvidenceRecord {
  const surfaceRecords = options.records.filter(
    (r) => r.surface === options.surface && r.tier === "1a",
  );
  const coverage =
    compositionCoverage(options.records).find((c) => c.surface === options.surface) ?? {
      surface: options.surface,
      tier: "unknown" as const,
      compositionObserve: "unverified" as const,
      valueReadback: "unverified" as const,
      observation: [],
      source: "none" as const,
      detail: "no records observed for this surface",
    };

  const eventCounts: Record<string, number> = {};
  let committedDomValue: string | null = null;
  let sawComposition = false;
  for (const record of surfaceRecords) {
    eventCounts[record.kind] = (eventCounts[record.kind] ?? 0) + 1;
    if (COMPOSITION_KINDS.has(record.kind)) {
      sawComposition = true;
    }
    const value = record.committedValue ?? record.domValue;
    if (
      (record.kind === "compositionend" || record.kind === "input") &&
      typeof value === "string"
    ) {
      committedDomValue = value;
    }
  }

  let verdict: TierVerdict;
  let detail: string | null;
  if (coverage.compositionObserve === "unsupported") {
    verdict = "unsupported";
    detail =
      coverage.detail ??
      "the surface declares composition observation unsupported";
  } else if (sawComposition && committedDomValue !== null) {
    verdict = "observed";
    detail =
      "DOM composition events and a committed DOM value were " +
      "self-reported; this does NOT prove the OS IME ran";
  } else if (sawComposition) {
    verdict = "unverified";
    detail =
      "composition events were observed but no committed DOM value " +
      "was read back";
  } else if (surfaceRecords.length > 0) {
    verdict = "unverified";
    detail =
      "value/key traffic was observed but no DOM composition events — " +
      "input events alone are not Tier-1a composition evidence";
  } else {
    verdict = "unverified";
    detail = "no fixture self-report events for this surface";
  }

  return {
    schema: INPUT_TIER1A_SCHEMA,
    surface: options.surface,
    channel: options.channel ?? "fixture-self-report",
    coverage,
    events: surfaceRecords,
    eventCounts,
    committedDomValue,
    provesOsIme: false,
    verdict,
    detail,
    observedAt: options.observedAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------
// Tier-1b record — OS IME end-to-end (spec §4.2)
// ---------------------------------------------------------------------

/** The OS-level composition phases a Tier-1b run must traverse. */
export type Tier1bPhases = {
  readonly uncommitted: boolean;
  readonly conversion: boolean;
  readonly candidate: boolean;
  readonly commit: boolean;
  readonly cancel: boolean;
};

export type Tier1bEvidenceRecord = {
  readonly schema: typeof INPUT_TIER1B_SCHEMA;
  /** Every claimed delivery mechanism, each assessed — nothing dropped. */
  readonly deliveries: readonly DeliveryAssessment[];
  /**
   * Committed value readback (fixture readback, AX/UIA value, or the
   * fixture's `committedValue`) — evidence of the *result*, kept
   * separate from the delivery claim.
   */
  readonly committedValue: string | null;
  /** Observable screen change (capture diff) as commit evidence. */
  readonly screenChange: {
    readonly observed: boolean;
    readonly detail: string | null;
  } | null;
  /**
   * OS-level composition phases actually observed. `null` means no
   * channel observed them — honest, since OS marked-text observation
   * is itself unverified.
   */
  readonly phases: Tier1bPhases | null;
  /** Claims rejected under spec §4.2 — labelled, never silently ignored. */
  readonly rejectedEvidence: readonly {
    readonly mechanism: string;
    readonly reason: string;
  }[];
  readonly verdict: TierVerdict;
  readonly detail: string | null;
  readonly observedAt: string;
};

/**
 * Evaluate Tier-1b evidence. Verdict rules:
 *
 *   - No admissible OS-stack delivery: `rejected` when every claim was
 *     forbidden, `unverified` when only unverified/unknown mechanisms
 *     (or none) were supplied. Forbidden claims are ALWAYS listed in
 *     `rejectedEvidence`, even alongside admissible ones.
 *   - Admissible delivery but no committed value and no observed screen
 *     change → `unverified` (delivery claimed, commit unproven).
 *   - Admissible delivery + committed proof → `observed`. When no OS
 *     composition phases were observed the detail says so — commit
 *     evidence without phase observation is reported, not inflated.
 */
export function evaluateTier1bEvidence(options: {
  readonly deliveries: readonly InputDeliveryMechanism[];
  readonly committedValue?: string | null | undefined;
  readonly screenChangeObserved?: boolean | undefined;
  readonly screenChangeDetail?: string | null | undefined;
  readonly phases?: Tier1bPhases | null | undefined;
  readonly observedAt?: string;
}): Tier1bEvidenceRecord {
  const deliveries = options.deliveries.map(classifyInputDelivery);
  const { entries: rejectedEvidence } = rejectedSummary(deliveries);
  const committedValue =
    typeof options.committedValue === "string" && options.committedValue !== ""
      ? options.committedValue
      : null;
  const screenChange =
    options.screenChangeObserved === undefined &&
    options.screenChangeDetail === undefined
      ? null
      : {
          observed: options.screenChangeObserved === true,
          detail: options.screenChangeDetail ?? null,
        };
  const committedProof = committedValue !== null || screenChange?.observed === true;

  const admissible = deliveries.filter((d) => d.tier1b === "admissible");
  const hasRejected = rejectedEvidence.length > 0;
  const hasUnverified = deliveries.some((d) => d.tier1b === "unverified");

  let verdict: TierVerdict;
  let detail: string;
  if (admissible.length === 0) {
    if (hasRejected && !hasUnverified && deliveries.length > 0) {
      verdict = "rejected";
      detail =
        "every submitted delivery mechanism is forbidden Tier-1b " +
        "evidence under spec §4.2 — see rejectedEvidence";
    } else if (deliveries.length === 0) {
      verdict = "unverified";
      detail = "no delivery mechanism was supplied — nothing to credit";
    } else {
      verdict = "unverified";
      detail =
        "no admissible OS-stack delivery was supplied; unverified " +
        "candidate mechanisms are reported but not credited" +
        (hasRejected ? " (forbidden claims are listed in rejectedEvidence)" : "");
    }
  } else if (!committedProof) {
    verdict = "unverified";
    detail =
      "admissible OS-stack delivery was claimed but no committed value " +
      "or observable screen change was observed";
  } else {
    verdict = "observed";
    const phases = options.phases ?? null;
    detail =
      "committed result observed through an admissible OS-stack " +
      "delivery" +
      (phases === null
        ? "; OS composition phases were not observed by any channel"
        : phases.uncommitted && phases.conversion
          ? ""
          : "; composition phases were only partially observed");
  }

  return {
    schema: INPUT_TIER1B_SCHEMA,
    deliveries,
    committedValue,
    screenChange,
    phases: options.phases ?? null,
    rejectedEvidence,
    verdict,
    detail,
    observedAt: options.observedAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------
// Tier-2 record — ScriptUI/native/custom-drawn (spec §4.3)
// ---------------------------------------------------------------------

/** The committed-result oracle for a Tier-2 surface. */
export type Tier2CommittedResult =
  | {
      readonly kind: "value";
      /** The committed value read back (ExtendScript readback, AX/UIA value). */
      readonly value: string;
      /** Which readback channel produced it — evidence, not delivery. */
      readonly readbackChannel: string;
    }
  | {
      readonly kind: "capture-diff";
      /** Whether the capture diff observed a change. */
      readonly observed: boolean;
      readonly detail: string | null;
    };

export type Tier2EvidenceRecord = {
  readonly schema: typeof INPUT_TIER2_SCHEMA;
  readonly surface: string;
  /** Real-key delivery claims, each assessed for Tier-2 admissibility. */
  readonly deliveries: readonly DeliveryAssessment[];
  /** Committed result via value readback or capture diff — or null. */
  readonly committedResult: Tier2CommittedResult | null;
  /** Internal composition observation is explicitly non-required (§4.3). */
  readonly compositionObservationRequired: false;
  readonly rejectedEvidence: readonly {
    readonly mechanism: string;
    readonly reason: string;
  }[];
  readonly verdict: TierVerdict;
  readonly detail: string | null;
  readonly observedAt: string;
};

/**
 * Build the Tier-2 record. Verdict rules mirror Tier-1b except that
 * `os-key-events` mechanisms (target-post, System Events) ARE
 * admissible — Tier-2 claims real key delivery, not IME traversal —
 * and composition phases are never required.
 */
export function buildTier2Record(options: {
  readonly surface: string;
  readonly deliveries: readonly InputDeliveryMechanism[];
  readonly committedResult?: Tier2CommittedResult | null | undefined;
  readonly observedAt?: string;
}): Tier2EvidenceRecord {
  const deliveries = options.deliveries.map(classifyInputDeliveryForTier2);
  const rejectedEvidence = deliveries
    .filter((d) => d.tier2 === "rejected")
    .map((d) => ({ mechanism: d.mechanism, reason: d.reason }));
  const admissible = deliveries.filter((d) => d.tier2 === "admissible");
  const committed = options.committedResult ?? null;
  const committedProof =
    committed !== null &&
    (committed.kind === "value"
      ? committed.value !== ""
      : committed.observed);

  let verdict: TierVerdict;
  let detail: string;
  if (admissible.length === 0) {
    if (rejectedEvidence.length > 0 && deliveries.every((d) => d.tier2 === "rejected")) {
      verdict = "rejected";
      detail =
        "every submitted delivery mechanism is forbidden as real-key " +
        "input — see rejectedEvidence";
    } else {
      verdict = "unverified";
      detail =
        deliveries.length === 0
          ? "no delivery mechanism was supplied — nothing to credit"
          : "no admissible real-key delivery was supplied";
    }
  } else if (!committedProof) {
    verdict = "unverified";
    detail =
      "real-key delivery was claimed but no committed result (value " +
      "readback or capture diff) was observed";
  } else {
    verdict = "observed";
    detail =
      "real key input and a committed result were observed; internal " +
      "composition observation is not required at this tier (spec §4.3)";
  }

  return {
    schema: INPUT_TIER2_SCHEMA,
    surface: options.surface,
    deliveries,
    committedResult: committed,
    compositionObservationRequired: false,
    rejectedEvidence,
    verdict,
    detail,
    observedAt: options.observedAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------
// The combined report — channels kept separate, never merged
// ---------------------------------------------------------------------

/**
 * One input-evidence report. The three tier sections are independent
 * records with independent schemas; there is deliberately NO merged
 * verdict field — the spec forbids an "IME works" summary (issue AC:
 * "Tier1a observed=yes / Tier1b=unverified" must be expressible).
 */
export type InputEvidenceReport = {
  readonly schema: typeof INPUT_EVIDENCE_REPORT_SCHEMA;
  /** The resolved target the evidence belongs to, when known. */
  readonly target: {
    readonly pid: number;
    readonly surfaceKey: string | null;
  } | null;
  readonly tier1a: Tier1aEvidenceRecord | null;
  readonly tier1b: Tier1bEvidenceRecord | null;
  readonly tier2: Tier2EvidenceRecord | null;
  /** Per-surface composition coverage across all ingested records. */
  readonly coverage: readonly CompositionSurfaceCoverage[];
  /** Observation channel honesty table (spec §4.1). */
  readonly channels: readonly InputObservationChannelReport[];
  /** Fixture ingest rejections — a broken bridge is evidence, not noise. */
  readonly ingestRejections: readonly FixtureReportRejection[];
  /**
   * Per-tier one-line summaries for humans — e.g. "Tier1a composition
   * observed: yes; Tier1b OS IME commit: unverified". These are
   * presentations OF the separate records, never a new verdict.
   */
  readonly summary: {
    readonly tier1a: string;
    readonly tier1b: string;
    readonly tier2: string;
  };
  readonly observedAt: string;
};

function tierSummary(
  tier: "1a" | "1b" | "2",
  record: { verdict: TierVerdict } | null,
): string {
  if (record === null) {
    return `Tier${tier}: no record`;
  }
  const label =
    tier === "1a"
      ? "composition observed"
      : tier === "1b"
        ? "OS IME commit"
        : "real-key + committed result";
  return `Tier${tier} ${label}: ${record.verdict}`;
}

/**
 * Assemble the report. Each tier section is whatever record the caller
 * built — this function never derives one tier's verdict from
 * another's, which is what makes the separation structural rather
 * than conventional.
 */
export function buildInputEvidenceReport(options: {
  readonly target?: PanelTarget | null;
  readonly tier1a?: Tier1aEvidenceRecord | null;
  readonly tier1b?: Tier1bEvidenceRecord | null;
  readonly tier2?: Tier2EvidenceRecord | null;
  readonly records?: readonly FixtureReportRecord[];
  readonly ingestRejections?: readonly FixtureReportRejection[];
  readonly observedAt?: string;
}): InputEvidenceReport {
  const records = options.records ?? [];
  const observedAt = options.observedAt ?? new Date().toISOString();
  const tier1a = options.tier1a ?? null;
  const tier1b = options.tier1b ?? null;
  const tier2 = options.tier2 ?? null;
  return {
    schema: INPUT_EVIDENCE_REPORT_SCHEMA,
    target:
      options.target === undefined || options.target === null
        ? null
        : {
            pid: options.target.pid,
            surfaceKey: options.target.surface.windowNumber !== null
              ? `window:${options.target.surface.windowNumber}`
              : null,
          },
    tier1a,
    tier1b,
    tier2,
    coverage: compositionCoverage(records),
    channels: compositionObserveChannels(),
    ingestRejections: options.ingestRejections ?? [],
    summary: {
      tier1a: tierSummary("1a", tier1a),
      tier1b: tierSummary("1b", tier1b),
      tier2: tierSummary("2", tier2),
    },
    observedAt,
  };
}

// ---------------------------------------------------------------------
// composition-observe result (spec §6 observe op)
// ---------------------------------------------------------------------

/**
 * The `composition-observe` operation result: per-surface coverage,
 * the channel honesty table, ingest rejections, and — when a surface
 * was named — its Tier-1a record. Observe-class: nothing here posts
 * or mutates.
 */
export type CompositionObserveReport = {
  readonly surface: string | null;
  readonly coverage: readonly CompositionSurfaceCoverage[];
  readonly channels: readonly InputObservationChannelReport[];
  readonly tier1a: Tier1aEvidenceRecord | null;
  readonly ingestRejections: readonly FixtureReportRejection[];
  readonly observedAt: string;
};

export function buildCompositionObserveReport(options: {
  readonly surface?: string | null;
  readonly records: readonly FixtureReportRecord[];
  readonly ingestRejections?: readonly FixtureReportRejection[];
  readonly observedAt?: string;
}): CompositionObserveReport {
  const surface = options.surface ?? null;
  return {
    surface,
    coverage: compositionCoverage(options.records),
    channels: compositionObserveChannels(),
    tier1a:
      surface === null
        ? null
        : buildTier1aRecord({
            surface,
            records: options.records,
            observedAt: options.observedAt,
          }),
    ingestRejections: options.ingestRejections ?? [],
    observedAt: options.observedAt ?? new Date().toISOString(),
  };
}
