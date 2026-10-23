/**
 * scripts/github-rulesets.js: what main and the release tags must be
 * protected by, and that re-running it against what it already applied
 * changes nothing. GitHub itself is not called here; the plan is checked
 * against rulesets in the shape the REST API returns them.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type Rule = { type: string; parameters?: Record<string, unknown> };
type Ruleset = { name: string; target: string; enforcement: string; conditions: unknown; bypass_actors: unknown[]; rules: Rule[] };

const rulesets = (await import(
  pathToFileURL(fileURLToPath(new URL("../scripts/github-rulesets.js", import.meta.url))).href
)) as {
  GITHUB_ACTIONS_APP_ID: number;
  REQUIRED_CHECKS: string[];
  desiredRulesets: (checks?: readonly string[]) => Ruleset[];
  differences: (actual: unknown, desired: Ruleset) => string[];
  plan: (existing: unknown[], desired: Ruleset[]) => Array<{ action: string; name: string; id?: number; changes: string[] }>;
  missingChecks: (checks: readonly string[], runs: Array<{ name: string; app?: { id?: number } | null }>) => string[];
};

const desired = rulesets.desiredRulesets();
const main = desired.find((ruleset) => ruleset.name === "main-branch-protection")!;
const tags = desired.find((ruleset) => ruleset.name === "release-tag-protection")!;
const rule = (ruleset: Ruleset, type: string) => ruleset.rules.find((r) => r.type === type);

/** A ruleset as GitHub returns it: ids, timestamps, extra defaults. */
function asReturned(ruleset: Ruleset, id: number): Record<string, unknown> {
  return {
    id,
    source_type: "Repository",
    current_user_can_bypass: "never",
    created_at: "2026-10-17T00:30:14.105+09:00",
    ...structuredClone(ruleset),
    rules: ruleset.rules.map((r) =>
      r.type === "pull_request"
        ? { ...r, parameters: { ...r.parameters, required_reviewers: [], dismissal_restriction: { enabled: false } } }
        : r,
    ),
  };
}

describe("main", () => {
  it("is refs/heads/main only, active, with no bypass", () => {
    expect(main.target).toBe("branch");
    expect(main.enforcement).toBe("active");
    expect(main.conditions).toEqual({ ref_name: { include: ["refs/heads/main"], exclude: [] } });
    expect(main.bypass_actors).toEqual([]);
  });

  it("takes changes only by pull request, merge commit, threads resolved, no approvals yet", () => {
    expect(rule(main, "pull_request")?.parameters).toMatchObject({
      allowed_merge_methods: ["merge"],
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
    });
  });

  it("needs the Linux and Windows CI jobs, reported by GitHub Actions", () => {
    expect(rule(main, "required_status_checks")?.parameters?.["required_status_checks"]).toEqual([
      { context: "check", integration_id: rulesets.GITHUB_ACTIONS_APP_ID },
      { context: "release-tooling-windows", integration_id: rulesets.GITHUB_ACTIONS_APP_ID },
    ]);
  });

  it("cannot be force-pushed or deleted, and does not require linear history", () => {
    expect(rule(main, "non_fast_forward")).toBeDefined();
    expect(rule(main, "deletion")).toBeDefined();
    expect(rule(main, "required_linear_history")).toBeUndefined();
  });
});

describe("release tags", () => {
  it("v* tags cannot be moved or deleted, but can be created", () => {
    expect(tags.target).toBe("tag");
    expect(tags.conditions).toEqual({ ref_name: { include: ["refs/tags/v*"], exclude: [] } });
    expect(tags.rules.map((r) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "update"]);
    expect(rule(tags, "creation")).toBeUndefined();
    expect(tags.bypass_actors).toEqual([]);
  });
});

describe("plan", () => {
  it("creates what is missing", () => {
    expect(rulesets.plan([], desired).map((step) => step.action)).toEqual(["create", "create"]);
  });

  it("changes nothing when run again against what it applied", () => {
    const existing = [asReturned(main, 1), asReturned(tags, 2)];
    expect(rulesets.plan(existing, desired)).toEqual([
      { action: "unchanged", name: "main-branch-protection", id: 1, changes: [] },
      { action: "unchanged", name: "release-tag-protection", id: 2, changes: [] },
    ]);
  });

  it("updates in place, by id, what differs", () => {
    const loose = asReturned(
      {
        ...tags,
        rules: tags.rules.filter((r) => r.type !== "update"),
        bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      },
      7,
    );
    const step = rulesets.plan([asReturned(main, 1), loose], desired)[1];
    expect(step).toMatchObject({ action: "update", id: 7 });
    expect(step?.changes).toEqual([
      expect.stringContaining("bypass_actors"),
      "rule update: absent -> present",
    ]);
  });

  it("sees checks that any app could report as a difference", () => {
    const parameters = rule(main, "required_status_checks")!.parameters!;
    const unpinned = {
      ...main,
      rules: main.rules.map((r) =>
        r.type === "required_status_checks"
          ? { ...r, parameters: { ...parameters, required_status_checks: [{ context: "release-tooling-windows" }, { context: "check" }] } }
          : r,
      ),
    };
    expect(rulesets.differences(asReturned(unpinned, 1), main)).toEqual([
      expect.stringContaining("rule required_status_checks.required_status_checks"),
    ]);
  });

  it("ignores rulesets with other names and refuses duplicates", () => {
    const other = { ...asReturned(main, 9), name: "someone-elses" };
    expect(rulesets.plan([other], desired)[0]?.action).toBe("create");
    expect(() => rulesets.plan([asReturned(main, 1), asReturned(main, 2)], desired)).toThrow(/2 rulesets named/);
  });
});

describe("missingChecks", () => {
  it("accepts only check runs from GitHub Actions", () => {
    const runs = [
      { name: "check", app: { id: rulesets.GITHUB_ACTIONS_APP_ID } },
      { name: "release-tooling-windows", app: { id: 347564 } },
    ];
    expect(rulesets.missingChecks(rulesets.REQUIRED_CHECKS, runs)).toEqual(["release-tooling-windows"]);
  });
});
