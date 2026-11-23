/**
 * Dialog taxonomy v2 (#284): the canonical registry, its honesty rules,
 * structured content extraction, and the dispatch-contention evidence path.
 *
 * These are contract tests against fixtures shaped like the recorded
 * real-host evidence (docs/windows-verification.md,
 * docs/offstage-macos.md, docs/evidence/g0-startup-2026-11-16). They prove
 * the classification logic, not that a real After Effects shows the same
 * windows — real-host verification stays at the level recorded per class
 * in `DIALOG_TAXONOMY[].evidence`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DIALOG_TAXONOMY,
  describeDialogEvidence,
  dialogClassByName,
  extractDialogContent,
  matchDialogClass,
} from "../src/platform/dialog-taxonomy.js";
import type { DialogWindow } from "../src/platform/recovery-policy.js";
import { MEASURED_DIALOG_CLASSES, chooseAction } from "../src/platform/recovery-policy.js";
import { windowTier } from "../src/supervision/probe.js";
import { SupervisionMonitor } from "../src/supervision/monitor.js";
import type { GuiProbe, ProbeSnapshot } from "../src/supervision/probe.js";
import type { PendingRequest } from "../src/supervision/types.js";

function win(overrides: Partial<DialogWindow> = {}): DialogWindow {
  return {
    title: "",
    role: "AXWindow",
    subrole: "AXDialog",
    texts: [],
    buttons: ["OK"],
    blocking: true,
    ...overrides,
  };
}

const ALERT = win({ texts: ["ae-a8n: close me"] });
const SECOND_SCRIPT = win({
  title: "After Effects warning",
  texts: [
    "After Effects warning: Attempt was made to run a second script while another script was already running. Second script was not run.",
  ],
});
const SCRIPT_ERROR = win({
  title: "After Effects",
  texts: ["Unable to execute script at line 0. Object is invalid"],
});
const SCRIPT_PROGRESS = win({
  title: "After Effects",
  texts: ["Executing Script long.jsx... Script execution time 0 minutes 3 seconds."],
  buttons: ["Cancel"],
});
const UNSAVED = win({
  title: "After Effects",
  texts: ["Do you want to save changes to project.aep?"],
  buttons: ["Save", "Don't Save", "Cancel"],
});
const UNKNOWN = win({ title: "Mystery", texts: ["never measured wording"], buttons: ["Maybe"] });

describe("registry invariants", () => {
  it("only auto-safe entries name a press button, and only safe endings", () => {
    const autoSafe = DIALOG_TAXONOMY.filter((spec) => spec.tier === "auto-safe");
    expect(autoSafe.map((spec) => spec.name)).toEqual(["ae-a8n ui.alert"]);
    for (const spec of DIALOG_TAXONOMY) {
      if (spec.tier === "auto-safe") {
        expect(spec.button).not.toBeNull();
      } else {
        expect(spec.button).toBeNull();
      }
      expect(["real-host", "policy"]).toContain(spec.evidence.level);
      // Policy-level evidence can never back an auto-safe press.
      if (spec.evidence.level === "policy") {
        expect(spec.tier).not.toBe("auto-safe");
      }
      expect(spec.evidence.source.length).toBeGreaterThan(0);
      expect(spec.evidence.detail.length).toBeGreaterThan(0);
      expect(spec.pressPolicy.length).toBeGreaterThan(0);
    }
  });

  it("stays in sync with the neutral measured-class table", () => {
    expect(MEASURED_DIALOG_CLASSES.map((c) => c.name)).toEqual(
      DIALOG_TAXONOMY.map((spec) => spec.name),
    );
    for (const dialogClass of MEASURED_DIALOG_CLASSES) {
      expect(dialogClass.presses).toBe(dialogClass.tier === "auto-safe");
      expect(dialogClass.evidence.length).toBeGreaterThan(0);
      expect(dialogClass.pressPolicy.length).toBeGreaterThan(0);
    }
  });
});

describe("classification", () => {
  it.each([
    ["ae-a8n ui.alert", "auto-safe", ALERT],
    ["after-effects-second-script", "human-required", SECOND_SCRIPT],
    ["after-effects-script-error", "human-required", SCRIPT_ERROR],
    ["after-effects-script-progress", "report-only", SCRIPT_PROGRESS],
    ["after-effects-unsaved-changes", "human-required", UNSAVED],
  ] as const)("classifies %s as %s", (name, tier, window) => {
    const spec = matchDialogClass(window);
    expect(spec?.name).toBe(name);
    expect(spec?.tier).toBe(tier);
  });

  it("keeps the measured script-permission 警告 modal unclassified", () => {
    // docs/offstage-macos.md measured that this dialog appears, but its
    // wording was never recorded — no honest matcher exists, so it stays
    // unknown → A8N-SEC-001 quarantine (pinned by recovery.test.ts too).
    const permission = win({
      title: "警告",
      texts: ["スクリプトを実行するには許可が必要です"],
    });
    expect(matchDialogClass(permission)).toBeNull();
    expect(extractDialogContent(permission).tier).toBe("unknown");
  });

  it("returns null and the quarantine content for an unmeasured window", () => {
    expect(matchDialogClass(UNKNOWN)).toBeNull();
    const content = extractDialogContent(UNKNOWN);
    expect(content.dialogClass).toBeNull();
    expect(content.tier).toBe("unknown");
    expect(content.code).toBe("A8N-SEC-001");
    expect(content.evidenceLevel).toBeNull();
  });

  it("never lets a non-auto-safe class press through chooseAction", () => {
    for (const window of [SECOND_SCRIPT, SCRIPT_ERROR, UNSAVED]) {
      const decision = chooseAction([ALERT, window]);
      expect(decision.presses).toEqual([]);
      expect(decision.action).not.toBe("known");
    }
  });
});

describe("structured content", () => {
  it("extracts the script error line and message", () => {
    const content = extractDialogContent(SCRIPT_ERROR);
    expect(content.dialogClass).toBe("after-effects-script-error");
    expect(content.tier).toBe("human-required");
    expect(content.code).toBe("A8N-AE-010");
    expect(content.fields["line"]).toBe(0);
    expect(String(content.fields["message"])).toContain("Unable to execute script");
    expect(content.summary).toContain("after-effects-script-error");
  });

  it("extracts the second-script dialog text verbatim", () => {
    const content = extractDialogContent(SECOND_SCRIPT);
    expect(content.dialogClass).toBe("after-effects-second-script");
    expect(content.code).toBe("A8N-AE-004");
    expect(String(content.fields["detail"])).toContain("second script");
  });

  it("carries evidence level through to the content", () => {
    expect(extractDialogContent(ALERT).evidenceLevel).toBe("real-host");
    expect(extractDialogContent(UNSAVED).evidenceLevel).toBe("policy");
  });
});

describe("windowTier integration", () => {
  it("reports the taxonomy tier and attaches content", () => {
    const tier = windowTier(SCRIPT_PROGRESS);
    expect(tier.tier).toBe("report-only");
    expect(tier.dialogClass).toBe("after-effects-script-progress");
    expect(tier.content.dialogClass).toBe("after-effects-script-progress");

    const error = windowTier(SCRIPT_ERROR);
    expect(error.tier).toBe("human-required");
    expect(error.code).toBe("A8N-AE-010");
    expect(error.content.fields["line"]).toBe(0);
  });

  it("keeps an unmeasured blocking window unknown with A8N-SEC-001", () => {
    const tier = windowTier(UNKNOWN);
    expect(tier.tier).toBe("unknown");
    expect(tier.code).toBe("A8N-SEC-001");
    expect(tier.content.tier).toBe("unknown");
  });
});

describe("dispatch contention evidence (#41)", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop() as string, { recursive: true, force: true });
    }
  });

  it("records the in-flight request and transport when the contention dialog blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "a8n-tax-"));
    roots.push(dir);
    const pending: PendingRequest[] = [
      {
        id: "req-7",
        method: "project.open",
        since: "2026-01-01T00:00:00Z",
        state: "in-flight",
        transport: "in-ae-dispatcher",
      },
    ];
    const probe: GuiProbe = {
      observe(): ProbeSnapshot {
        return { ok: true, host: "none", windows: [SECOND_SCRIPT] };
      },
    };
    const started = SupervisionMonitor.start({
      sessionDir: dir,
      probe,
      ownerId: "test-monitor",
      pid: process.pid,
      pendingRequests: () => pending,
      now: () => new Date("2026-01-01T00:00:00Z"),
      sleep: async () => {},
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    try {
      await started.monitor.tick();
      const report = started.monitor.report();
      expect(report.status).toBe("observed");
      if (report.status !== "observed") return;
      const doc = report.doc;
      expect(doc.phase).toBe("blocked");
      const window = doc.blocking?.windows[0];
      expect(window?.dialogClass).toBe("after-effects-second-script");
      expect(window?.tier).toBe("human-required");
      // The contention note names the in-flight request and its transport,
      // in both the blocking detail and the durable evidence log.
      expect(doc.blocking?.detail).toContain("req-7");
      expect(doc.blocking?.detail).toContain("in-ae-dispatcher");
      expect(doc.blocking?.detail).toContain("#41");
      expect(doc.evidence.join("\n")).toContain("dispatch contention");
      expect(doc.evidence.join("\n")).toContain("req-7");
      expect(doc.pendingRequests[0]?.transport).toBe("in-ae-dispatcher");
    } finally {
      started.monitor.stop();
    }
  });

  it("does not annotate unrelated dialog classes as contention", async () => {
    const dir = mkdtempSync(join(tmpdir(), "a8n-tax-"));
    roots.push(dir);
    const probe: GuiProbe = {
      observe(): ProbeSnapshot {
        return { ok: true, host: "none", windows: [SCRIPT_ERROR] };
      },
    };
    const started = SupervisionMonitor.start({
      sessionDir: dir,
      probe,
      ownerId: "test-monitor",
      pid: process.pid,
      pendingRequests: () => [
        { id: "r1", method: "app.info", since: "2026-01-01T00:00:00Z", state: "in-flight" },
      ],
      now: () => new Date("2026-01-01T00:00:00Z"),
      sleep: async () => {},
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    try {
      await started.monitor.tick();
      const report = started.monitor.report();
      if (report.status !== "observed") return;
      expect(report.doc.blocking?.detail).not.toContain("dispatch contention");
      expect(report.doc.evidence.join("\n")).not.toContain("dispatch contention");
    } finally {
      started.monitor.stop();
    }
  });
});

describe("evidence provenance", () => {
  it("names the honest level of each registered class", () => {
    const byName = (name: string) => dialogClassByName(name);
    expect(byName("ae-a8n ui.alert")?.evidence.level).toBe("real-host");
    expect(byName("after-effects-second-script")?.evidence.level).toBe("real-host");
    expect(byName("after-effects-script-error")?.evidence.level).toBe("real-host");
    expect(byName("after-effects-crash-repair")?.evidence.level).toBe("real-host");
    expect(byName("after-effects-scripting-component-missing")?.evidence.level).toBe("real-host");
    // Policy-level classes are honestly marked: the window was not captured.
    expect(byName("after-effects-unsaved-changes")?.evidence.level).toBe("policy");
    expect(byName("adobe-licence")?.evidence.level).toBe("policy");
    for (const spec of DIALOG_TAXONOMY) {
      expect(describeDialogEvidence(spec.evidence)).toContain(spec.evidence.source);
    }
  });
});
