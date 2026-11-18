/**
 * The cross-platform evidence gate (#75, T093).
 *
 * `latest` promotion is fail-closed: every supported platform needs a
 * current real-host record bound to the exact candidate commit and tarball.
 * `next` staging may carry Windows as `unverified`, and only while the
 * package description and README still declare the gap. The fixtures here
 * stand in for `docs/evidence/platforms/<platform>.json`; the real records
 * are written by the human release step from acceptance runs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const gatePath = fileURLToPath(new URL("../scripts/evidence-gate.js", import.meta.url));
const gate = (await import(pathToFileURL(gatePath).href)) as {
  evaluateEvidenceGate: (input: {
    distTag: string;
    candidateCommit: string;
    tarballSha256: string;
    records: Record<string, unknown>;
    declarations: { description: string; readme: string };
  }) => { action: "allow" | "deny"; reasons: string[]; notes: string[] };
  recordProblems: (record: unknown, platform: string) => string[];
  declaresWindowsUnverified: (text: string) => boolean;
  loadRecords: (dir: string) => Record<string, unknown>;
};

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const TARBALL = "c".repeat(64);
const OTHER_TARBALL = "d".repeat(64);

const DECLARED = {
  description: "Early 0.x release; Windows real-host evidence is missing.",
  readme: "Windows real-host evidence for the dispatcher paths is absent.",
};
const UNDECLARED = { description: "Drive After Effects from Node.", readme: "# ae-a8n" };

function record(platform: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    platform,
    commit: COMMIT,
    tarballSha256: TARBALL,
    recordedAt: "2026-11-18",
    verdict: "pass",
    evidence: "docs/evidence/example",
    ...overrides,
  };
}

function records(overrides: Record<string, unknown> = {}) {
  return { macos: record("macos"), windows: record("windows"), ...overrides };
}

function evaluate(input: Partial<Parameters<typeof gate.evaluateEvidenceGate>[0]>) {
  return gate.evaluateEvidenceGate({
    distTag: "latest",
    candidateCommit: COMMIT,
    tarballSha256: TARBALL,
    declarations: DECLARED,
    records: {},
    ...input,
  });
}

describe("evaluateEvidenceGate", () => {
  it("allows latest when both platforms pass on the candidate", () => {
    expect(evaluate({ records: records() }).action).toBe("allow");
  });

  it("denies latest when the Windows record is missing", () => {
    const verdict = evaluate({ records: records({ windows: null }) });
    expect(verdict.action).toBe("deny");
    expect(verdict.reasons).toContain("missing-evidence:windows");
  });

  it("denies latest when the macOS record is missing", () => {
    const verdict = evaluate({ records: records({ macos: null }) });
    expect(verdict.reasons).toContain("missing-evidence:macos");
  });

  it("denies a record bound to a different commit as stale", () => {
    const verdict = evaluate({
      records: records({ windows: record("windows", { commit: OTHER_COMMIT }) }),
    });
    expect(verdict.reasons).toContain("stale-evidence:windows:commit");
  });

  it("denies a record bound to a different tarball as stale", () => {
    const verdict = evaluate({
      records: records({ windows: record("windows", { tarballSha256: OTHER_TARBALL }) }),
    });
    expect(verdict.reasons).toContain("stale-evidence:windows:tarball");
  });

  it("denies latest on an unverified verdict even when current", () => {
    const verdict = evaluate({
      records: records({ windows: record("windows", { verdict: "unverified" }) }),
    });
    expect(verdict.reasons).toContain("not-passed:windows:unverified");
  });

  it("denies any failed verdict", () => {
    const verdict = evaluate({
      distTag: "next",
      records: records({ macos: record("macos", { verdict: "fail" }) }),
    });
    expect(verdict.reasons).toContain("failed-evidence:macos");
  });

  it("allows next with Windows unverified while README and description declare it", () => {
    const verdict = evaluate({
      distTag: "next",
      records: records({ windows: record("windows", { verdict: "unverified" }) }),
    });
    expect(verdict.action).toBe("allow");
    expect(verdict.notes.join(" ")).toContain("UNVERIFIED");
  });

  it("denies next with Windows unverified once the declaration is gone", () => {
    const verdict = evaluate({
      distTag: "next",
      records: records({ windows: record("windows", { verdict: "unverified" }) }),
      declarations: UNDECLARED,
    });
    expect(verdict.reasons).toContain("unverified-undeclared:windows");
  });

  it("denies next when only one of description or README declares the gap", () => {
    const verdict = evaluate({
      distTag: "next",
      records: records({ windows: record("windows", { verdict: "unverified" }) }),
      declarations: { description: DECLARED.description, readme: UNDECLARED.readme },
    });
    expect(verdict.reasons).toContain("unverified-undeclared:windows");
  });

  it("denies next when macOS is unverified — the carve-out is Windows only", () => {
    const verdict = evaluate({
      distTag: "next",
      records: records({ macos: record("macos", { verdict: "unverified" }) }),
    });
    expect(verdict.reasons).toContain("unverified-not-allowed:macos");
  });

  it("names malformed records instead of crashing", () => {
    const verdict = evaluate({ records: records({ windows: { platform: "windows" } }) });
    expect(verdict.action).toBe("deny");
    expect(verdict.reasons.some((r) => r.startsWith("invalid-evidence:windows:"))).toBe(true);
  });

  it("rejects an unknown dist-tag", () => {
    const verdict = evaluate({ distTag: "beta", records: records() });
    expect(verdict.reasons).toContain("unknown-dist-tag:beta");
  });
});

describe("recordProblems", () => {
  it("accepts a well-formed record", () => {
    expect(gate.recordProblems(record("macos"), "macos")).toEqual([]);
  });

  it("flags a record filed under the wrong platform", () => {
    expect(gate.recordProblems(record("windows"), "macos")).toContain("invalid-evidence:macos:platform-mismatch");
  });

  it("flags non-ISO recordedAt and unknown verdicts", () => {
    const problems = gate.recordProblems(
      record("macos", { recordedAt: "November 18", verdict: "probably" }),
      "macos",
    );
    expect(problems).toContain("invalid-evidence:macos:recordedAt");
    expect(problems).toContain("invalid-evidence:macos:verdict");
  });
});

describe("declaresWindowsUnverified", () => {
  it("matches the shipped package description and README wording", () => {
    expect(gate.declaresWindowsUnverified(DECLARED.description)).toBe(true);
    expect(gate.declaresWindowsUnverified(DECLARED.readme)).toBe(true);
  });

  it("does not match a description that never mentions Windows", () => {
    expect(gate.declaresWindowsUnverified(UNDECLARED.description)).toBe(false);
  });
});

describe("loadRecords", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "evidence-gate-"));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  it("loads both platform files and reports missing ones as null", () => {
    const dir = fixture({ "macos.json": JSON.stringify(record("macos")) });
    const loaded = gate.loadRecords(dir);
    expect(loaded.macos).toMatchObject({ platform: "macos", verdict: "pass" });
    expect(loaded.windows).toBeNull();
  });

  it("surfaces a JSON parse failure as a record the gate will reject", () => {
    const dir = fixture({ "windows.json": "{not json" });
    const loaded = gate.loadRecords(dir);
    const verdict = gate.evaluateEvidenceGate({
      distTag: "next",
      candidateCommit: COMMIT,
      tarballSha256: TARBALL,
      records: { macos: record("macos"), windows: loaded.windows },
      declarations: DECLARED,
    });
    expect(verdict.action).toBe("deny");
    expect(verdict.reasons.some((r) => r.startsWith("invalid-evidence:windows:"))).toBe(true);
  });
});

describe("cli", () => {
  it("exits non-zero and names the reason when evidence is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-cli-"));
    try {
      const tarball = join(dir, "pkg.tgz");
      writeFileSync(tarball, "tarball bytes");
      let failed = false;
      try {
        execFileSync("node", [
          gatePath,
          "--dist-tag", "latest",
          "--commit", COMMIT,
          "--tarball", tarball,
          "--evidence-dir", join(dir, "empty"),
          "--root", fileURLToPath(new URL("..", import.meta.url)),
        ], { stdio: "pipe" });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
