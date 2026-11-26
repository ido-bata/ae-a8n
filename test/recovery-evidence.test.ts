/**
 * Recovery evidence manifest and anomaly/retry classification (#342).
 *
 * The contract under test: every standard-path recovery attempt — press,
 * expected-modal resolution, quarantine, honest refusal — binds its facts
 * into `artifacts/recovery-<requestId>.evidence.json` next to the
 * screenshots, records what could not be captured instead of omitting it,
 * and never lets an evidence-write failure break the recovery. The op
 * trace row carries the operation's retry class and the anomaly kind the
 * unresolved wait classified.
 *
 * Level: fake/mock only — the transport is a stub; nothing here has run
 * against a real After Effects.
 */

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyAnomaly } from "../src/driver/anomaly.js";
import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import { classifyOperationRetry } from "../src/driver/operation-policy.js";
import {
  RECOVERY_EVIDENCE_KIND,
  uncapturableEvidence,
  type RecoveryEvidenceRecord,
} from "../src/driver/recovery-evidence.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import type { RecoveryOutcome } from "../src/driver/recovery.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-recovery-evidence-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A host that accepts the request and never answers by itself. */
class BlockedTransport implements HostTransport {
  readonly kind = "blocked";
  invocations = 0;
  pendingId: string | null = null;

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async launch(): Promise<void> {
    // Nothing to start.
  }

  invoke(_entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    this.invocations += 1;
    const inbox = join(root, "inbox");
    const file = readdirSync(inbox).find((name) => name.endsWith(".request.json"));
    this.pendingId = file === undefined ? null : file.replace(".request.json", "");
    return Promise.resolve();
  }

  ownership(): HostOwnership {
    return { kind: "owned", evidence: "blocked test host" };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function startDriver(
  transport: BlockedTransport,
  outcome: RecoveryOutcome,
): { driver: AeDriver; transport: BlockedTransport } {
  const trace = new TraceRecorder({ file: join(root, "trace.jsonl") });
  const driver = new AeDriver({
    transport,
    sessionRoot: root,
    trace,
    defaultTimeoutMs: 200,
    recovery: { attempt: () => Promise.resolve(outcome) },
    recoveryGraceMs: 100,
  });
  return { driver, transport };
}

function traceRows(op?: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "trace.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => op === undefined || row.op === op);
}

function readManifest(): RecoveryEvidenceRecord {
  const dir = join(root, "artifacts");
  const file = readdirSync(dir).find((name) => name.endsWith(".evidence.json"));
  if (file === undefined) {
    throw new Error(`no evidence manifest in ${dir}`);
  }
  return JSON.parse(readFileSync(join(dir, file), "utf-8")) as RecoveryEvidenceRecord;
}

describe("classifyAnomaly", () => {
  it("prefers an explicit reported kind, then an expectation, then the window tier, then the host condition", () => {
    expect(classifyAnomaly({ reported: "cep-anomaly" })).toBe("cep-anomaly");
    expect(
      classifyAnomaly({ reported: "cep-anomaly", expectedModal: "x", dialogTier: "auto-safe" }),
    ).toBe("cep-anomaly");
    expect(classifyAnomaly({ expectedModal: "plugin-prompt" })).toBe("expected-modal");
    expect(classifyAnomaly({ dialogTier: "auto-safe" })).toBe("known-safe-modal");
    expect(classifyAnomaly({ dialogTier: "human-required" })).toBe("human-required-modal");
    expect(classifyAnomaly({ dialogTier: "unknown" })).toBe("unknown-modal");
    expect(classifyAnomaly({ hostCondition: "gone" })).toBe("process-gone");
    expect(classifyAnomaly({ hostCondition: "unresponsive" })).toBe("host-unresponsive");
    expect(classifyAnomaly({ hostCondition: "modal" })).toBe("unknown-modal");
    expect(classifyAnomaly({})).toBe("unknown");
    // report-only is informational: it defers to the host condition.
    expect(classifyAnomaly({ dialogTier: "report-only", hostCondition: "unresponsive" })).toBe(
      "host-unresponsive",
    );
    expect(classifyAnomaly({ dialogTier: "report-only" })).toBe("unknown");
  });
});

describe("classifyOperationRetry", () => {
  it("marks only the measured read-only methods; everything else is unknown-side-effect", () => {
    expect(classifyOperationRetry("app.info")).toBe("read-only");
    expect(classifyOperationRetry("project.open")).toBe("unknown-side-effect");
    expect(classifyOperationRetry("extension.call")).toBe("unknown-side-effect");
    expect(classifyOperationRetry("render.frame")).toBe("unknown-side-effect");
  });
});

describe("the recovery evidence manifest", () => {
  it("binds the operation, outcome, window, images and uncapturable gaps into one artifact", async () => {
    const transport = new BlockedTransport();
    const { driver } = startDriver(transport, {
      recovered: false,
      outcome: "refused",
      evidence: 'expected modal "plugin-prompt" seen; nothing pressed',
      window: 'AXWindow/AXDialog "Plugin Prompt" [OK]',
      expectedModal: "plugin-prompt",
      screenshotPath: join(root, "shots", "before.png"),
      screenshotAfterPath: join(root, "shots", "after.png"),
    });
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);

    const manifest = readManifest();
    expect(manifest.kind).toBe(RECOVERY_EVIDENCE_KIND);
    expect(manifest.method).toBe("app.info");
    expect(manifest.recovered).toBe(false);
    expect(manifest.outcome).toBe("refused");
    expect(manifest.expectedModal).toBe("plugin-prompt");
    expect(manifest.screenshot.before).toContain("before.png");
    expect(manifest.screenshot.after).toContain("after.png");
    expect(manifest.uncapturable).toEqual([]);
    // The CEP/CSXS gap is named, not implied covered.
    expect(manifest.hostLogs.cepCsxs).toContain("#336");
    // The session.recover row points at the manifest.
    const recover = traceRows("session.recover").at(-1) as {
      result?: { evidence?: string; expectedModal?: string };
    };
    expect(recover.result?.evidence).toContain(".evidence.json");
    expect(recover.result?.expectedModal).toBe("plugin-prompt");
  });

  it("records an uncapturable screenshot instead of omitting it", async () => {
    const transport = new BlockedTransport();
    const { driver } = startDriver(transport, {
      recovered: false,
      outcome: "refused",
      evidence: "a window was seen; capture failed",
      window: 'AXWindow/AXDialog "Plugin Prompt" [OK]',
      screenshotNote: "screen capture failed: denied",
    });
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    const manifest = readManifest();
    expect(manifest.screenshot.before).toBeNull();
    expect(manifest.screenshot.note).toContain("screen capture failed");
    expect(manifest.uncapturable).toEqual(["screen-image:before (screen capture failed: denied)"]);
  });

  it("writes the manifest for a quarantine too — the refusal is evidence", async () => {
    const transport = new BlockedTransport();
    const { driver } = startDriver(transport, {
      recovered: false,
      outcome: "quarantined",
      code: "A8N-SEC-001",
      evidence: "an unmeasured window is up; nothing was pressed",
      window: 'AXWindow/AXDialog "Mystery" [OK]',
      dialogTier: "unknown",
    });
    const error = (await driver.call("app.info", {}).catch((reason: unknown) => reason)) as {
      code?: string;
    };
    expect(error.code).toBe("A8N-SEC-001");
    const manifest = readManifest();
    expect(manifest.outcome).toBe("quarantined");
    expect(manifest.code).toBe("A8N-SEC-001");
    // A blocking window with no image owes the before capture as a gap.
    expect(manifest.uncapturable).toContain("screen-image:before");
  });

  it("keeps the timeout and traces the failure when the manifest cannot be written", async () => {
    // The artifacts directory is made read-only after the driver created
    // it, so the manifest write fails. Evidence must never break the
    // recovery it describes.
    const transport = new BlockedTransport();
    const { driver } = startDriver(transport, {
      recovered: false,
      outcome: "refused",
      evidence: "no window found",
    });
    chmodSync(join(root, "artifacts"), 0o555);
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    const evidenceRows = traceRows("session.recover-evidence");
    expect(evidenceRows.at(-1)?.status).toBe("error");
    // The recovery row itself still recorded the attempt.
    const recover = traceRows("session.recover").at(-1) as {
      result?: { recovered?: boolean };
    };
    expect(recover.result?.recovered).toBe(false);
  });

  it("carries the retry class and anomaly kind on the operation's trace row", async () => {
    const transport = new BlockedTransport();
    const { driver } = startDriver(transport, {
      recovered: false,
      outcome: "refused",
      evidence: "a human-required window was seen; nothing pressed",
      window: 'AXWindow/AXDialog "Script Error" [OK]',
      dialogTier: "human-required",
    });
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    const op = traceRows("app.info").at(-1) as {
      status?: string;
      result?: { retryClass?: string; hostCondition?: string; anomaly?: string };
    };
    expect(op.status).toBe("timeout");
    expect(op.result?.retryClass).toBe("read-only");
    expect(op.result?.hostCondition).toBe("modal");
    expect(op.result?.anomaly).toBe("human-required-modal");
  });

  it("does not repeat the request while its result is still uncertain", async () => {
    const transport = new BlockedTransport();
    const { driver } = startDriver(transport, {
      recovered: true,
      evidence: "pressed OK",
      outcome: "dismissed",
    });
    // The recovery claims success but the host never answers inside the
    // grace: the timeout stands and the request was sent exactly once.
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    expect(transport.invocations).toBe(1);
    expect(readManifest().recovered).toBe(true);
  });
});

describe("uncapturableEvidence", () => {
  it("owes an after image only when a mutation ran or was uncertain", () => {
    const base = {
      recovered: false,
      evidence: "x",
      window: "w",
      screenshotPath: "/tmp/before.png",
    } satisfies Partial<RecoveryOutcome>;
    // refused: no press ran, no after image owed.
    expect(uncapturableEvidence({ ...base, outcome: "refused" })).toEqual([]);
    // dismissed without an after path is contradictory but still not a gap
    // the list invents: the gap rule only covers mutation-uncertain states.
    expect(uncapturableEvidence({ ...base, outcome: "dismissed" })).toEqual(["screen-image:after"]);
    expect(
      uncapturableEvidence({
        ...base,
        outcome: "quarantined",
        code: "A8N-SEC-001",
      }),
    ).toEqual(["screen-image:after"]);
    // No window seen → no capture was applicable → no gaps.
    expect(uncapturableEvidence({ recovered: false, evidence: "x" })).toEqual([]);
  });
});
