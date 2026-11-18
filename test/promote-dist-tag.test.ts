/**
 * The managed `latest` promotion path (#75).
 *
 * `scripts/promote-dist-tag.js` is the only documented way to move `latest`:
 * it re-proves the candidate (tag, npm gitHead, published tarball hash) and
 * then runs the same evidence gate, and a deny must never reach the
 * `npm dist-tag` call. These tests pin that contract without npm or git.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("../scripts/promote-dist-tag.js", import.meta.url));
const promote = (await import(pathToFileURL(scriptPath).href)) as {
  evaluatePromotion: (input: {
    version: string;
    commit: string;
    tagCommit: string | null;
    gitHead: string | null;
    tarballSha256: string;
    records: Record<string, unknown>;
  }) => { action: "allow" | "deny"; reasons: string[]; notes: string[] };
  promoteDistTag: (input: {
    version: string;
    commit: string;
    dryRun: boolean;
    probes: {
      tagCommit: () => string | null;
      gitHead: () => string | null;
      tarballSha256: () => string;
      records: () => Record<string, unknown>;
      apply: () => void;
    };
  }) => { action: "allow" | "deny"; verdict: { reasons: string[] }; applied: boolean };
};

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const TARBALL = "c".repeat(64);
const VERSION = "0.2.0";

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

const PASSING = { macos: record("macos"), windows: record("windows") };

function evaluate(overrides: Record<string, unknown> = {}) {
  return promote.evaluatePromotion({
    version: VERSION,
    commit: COMMIT,
    tagCommit: COMMIT,
    gitHead: COMMIT,
    tarballSha256: TARBALL,
    records: PASSING,
    ...overrides,
  });
}

describe("evaluatePromotion", () => {
  it("allows when tag, gitHead, tarball and both platform records bind to the candidate", () => {
    expect(evaluate().action).toBe("allow");
  });

  it("denies when the version tag is missing or points elsewhere", () => {
    expect(evaluate({ tagCommit: null }).reasons).toContain(`missing-tag:v${VERSION}`);
    expect(evaluate({ tagCommit: OTHER }).reasons).toContain(`tag-mismatch:v${VERSION}`);
  });

  it("denies when npm's gitHead is absent or names another commit", () => {
    expect(evaluate({ gitHead: null }).reasons).toContain(`githead-missing:${VERSION}`);
    expect(evaluate({ gitHead: OTHER }).reasons).toContain(`githead-mismatch:${VERSION}`);
  });

  it("denies malformed versions and commits before consulting the gate", () => {
    const bad = evaluate({ version: "latest", commit: "xyz" });
    expect(bad.action).toBe("deny");
    expect(bad.reasons).toEqual(
      expect.arrayContaining(["invalid-version:latest", "invalid-candidate:commit"]),
    );
  });

  it("inherits every evidence-gate denial for latest", () => {
    const verdict = evaluate({ records: { macos: record("macos"), windows: null } });
    expect(verdict.action).toBe("deny");
    expect(verdict.reasons).toContain("missing-evidence:windows");

    const unverified = evaluate({
      records: {
        macos: record("macos"),
        windows: record("windows", { verdict: "unverified" }),
      },
    });
    expect(unverified.reasons).toContain("not-passed:windows:unverified");
  });
});

describe("promoteDistTag", () => {
  function probes(overrides: Record<string, unknown> = {}) {
    const applied: string[] = [];
    return {
      applied,
      value: {
        tagCommit: () => COMMIT,
        gitHead: () => COMMIT,
        tarballSha256: () => TARBALL,
        records: () => PASSING,
        apply: () => applied.push("dist-tag"),
        ...overrides,
      },
    };
  }

  it("runs the dist-tag move only after an allow", () => {
    const { applied, value } = probes();
    const outcome = promote.promoteDistTag({ version: VERSION, commit: COMMIT, dryRun: false, probes: value });
    expect(outcome.action).toBe("allow");
    expect(outcome.applied).toBe(true);
    expect(applied).toEqual(["dist-tag"]);
  });

  it("never reaches apply on a deny — the bypass stays closed", () => {
    const { applied, value } = probes({ gitHead: () => OTHER });
    const outcome = promote.promoteDistTag({ version: VERSION, commit: COMMIT, dryRun: false, probes: value });
    expect(outcome.action).toBe("deny");
    expect(outcome.applied).toBe(false);
    expect(applied).toEqual([]);
  });

  it("does not move the tag on --dry-run even when allowed", () => {
    const { applied, value } = probes();
    const outcome = promote.promoteDistTag({ version: VERSION, commit: COMMIT, dryRun: true, probes: value });
    expect(outcome.action).toBe("allow");
    expect(outcome.applied).toBe(false);
    expect(applied).toEqual([]);
  });
});
