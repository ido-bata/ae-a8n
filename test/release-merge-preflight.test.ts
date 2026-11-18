/**
 * scripts/release-merge-preflight.js: the merge executor's second look.
 * evaluatePreflight is pure; these cases are the counterexamples the
 * release-gate workflow cannot cover by itself (variable changed after the
 * check ran, tip moved, stale check, non-Actions check, fork, stale train).
 */

import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const mod = (await import(
  pathToFileURL(fileURLToPath(new URL("../scripts/release-merge-preflight.js", import.meta.url))).href
)) as {
  REQUIRED_MAIN_CHECKS: string[];
  evaluatePreflight: (facts: {
    pr: { base?: { ref?: string; repo?: { full_name?: string } }; head?: { ref?: string; sha?: string; repo?: { full_name?: string } }; state?: string };
    train: string;
    tip: string;
    aheadBy: number;
    runs: Array<{ name?: string; status?: string; conclusion?: string | null; started_at?: string; app?: { slug?: string } | null }>;
  }) => { ok: boolean; reason?: string; headSha?: string };
};

const HEAD = "a".repeat(40);
const TIP = "b".repeat(40);

function facts(overrides: Record<string, unknown> = {}) {
  const runs = ["check", "release-tooling-windows", "windows"].map((name) => ({
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-11-18T00:00:00Z",
    app: { slug: "github-actions" },
  }));
  return {
    pr: {
      state: "open",
      base: { ref: "main", repo: { full_name: "ido-bata/ae-a8n" } },
      head: { ref: "release-0-3-0", sha: TIP, repo: { full_name: "ido-bata/ae-a8n" } },
    },
    train: "release-0-3-0",
    tip: TIP,
    aheadBy: 5,
    runs,
    ...overrides,
  } as Parameters<typeof mod.evaluatePreflight>[0];
}

describe("evaluatePreflight", () => {
  it("accepts the canonical release train at its tip with green Actions checks", () => {
    const v = mod.evaluatePreflight(facts());
    expect(v).toEqual({ ok: true, headSha: TIP });
  });

  it("rejects a non-release head into main", () => {
    const v = mod.evaluatePreflight(facts({ pr: { ...facts().pr, head: { ...facts().pr.head!, ref: "feature-x" } } }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("not the current release train");
  });

  it("rejects a spoofed release-* name that is not RELEASE_TRAIN", () => {
    const v = mod.evaluatePreflight(
      facts({ pr: { ...facts().pr, head: { ...facts().pr.head!, ref: "release-evil" } } }),
    );
    expect(v.ok).toBe(false);
  });

  it("rejects when RELEASE_TRAIN changed after the gate check ran", () => {
    const v = mod.evaluatePreflight(facts({ train: "release-0-4-0" }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("release-0-4-0");
  });

  it("rejects an unset or invalid RELEASE_TRAIN", () => {
    for (const train of ["", "release/../x", "bad name!"]) {
      expect(mod.evaluatePreflight(facts({ train })).ok).toBe(false);
    }
  });

  it("rejects a head SHA that is not the train tip", () => {
    const v = mod.evaluatePreflight(facts({ tip: HEAD }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("not the tip");
  });

  it("rejects a fully merged (stale) train", () => {
    const v = mod.evaluatePreflight(facts({ aheadBy: 0 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("stale");
  });

  it("rejects a fork head", () => {
    const v = mod.evaluatePreflight(
      facts({ pr: { ...facts().pr, head: { ...facts().pr.head!, repo: { full_name: "someone/ae-a8n" } } } }),
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("fork");
  });

  it("rejects a non-main base", () => {
    const v = mod.evaluatePreflight(
      facts({ pr: { ...facts().pr, base: { ref: "release-0-3-0", repo: { full_name: "ido-bata/ae-a8n" } } } }),
    );
    expect(v.ok).toBe(false);
  });

  it("rejects when a required check is pending on the head SHA", () => {
    const runs = facts().runs.map((r) => (r.name === "check" ? { ...r, status: "in_progress", conclusion: null } : r));
    const v = mod.evaluatePreflight(facts({ runs }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("in_progress");
  });

  it("rejects when a required check failed on the head SHA", () => {
    const runs = facts().runs.map((r) => (r.name === "windows" ? { ...r, conclusion: "failure" } : r));
    const v = mod.evaluatePreflight(facts({ runs }));
    expect(v.ok).toBe(false);
  });

  it("ignores same-named checks from non-Actions apps", () => {
    const runs = facts().runs.map((r) => ({ ...r, app: { slug: "some-other-app" } }));
    const v = mod.evaluatePreflight(facts({ runs }));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("no GitHub Actions run");
  });

  it("uses the latest run per check name", () => {
    const runs = [
      ...facts().runs,
      { name: "check", status: "completed", conclusion: "failure", started_at: "2026-11-18T01:00:00Z", app: { slug: "github-actions" } },
    ];
    const v = mod.evaluatePreflight(facts({ runs }));
    expect(v.ok).toBe(false);
  });
});
