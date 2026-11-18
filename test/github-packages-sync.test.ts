import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type Decision =
  | { action: "publish"; versions: string[] }
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string };

const scriptPath = fileURLToPath(new URL("../scripts/github-packages-sync.js", import.meta.url));
const sync = (await import(pathToFileURL(scriptPath).href)) as {
  selectSyncVersions: (
    sourceVersions: readonly string[],
    targetVersions: readonly string[],
    requested: string | undefined,
  ) => Decision;
  planDistTagSync: (
    sourceTags: Record<string, string>,
    targetTags: Record<string, string>,
    presentVersions: ReadonlySet<string>,
  ) => { add: { tag: string; version: string }[]; remove: string[] };
  publishTagFor: (version: string, sourceTags: Record<string, string>) => string;
};

const workflow = readFileSync(
  fileURLToPath(new URL("../.github/workflows/github-packages.yml", import.meta.url)),
  "utf-8",
);

describe("selectSyncVersions", () => {
  const source = ["0.1.0-alpha.0", "0.2.0"];

  it("syncs every npmjs version missing on GitHub Packages", () => {
    expect(sync.selectSyncVersions(source, [], undefined)).toEqual({
      action: "publish",
      versions: ["0.1.0-alpha.0", "0.2.0"],
    });
  });

  it("skips versions GitHub Packages already has", () => {
    expect(sync.selectSyncVersions(source, ["0.1.0-alpha.0"], undefined)).toEqual({
      action: "publish",
      versions: ["0.2.0"],
    });
  });

  it("is a no-op when the mirror is complete", () => {
    const decision = sync.selectSyncVersions(source, [...source], undefined);
    expect(decision.action).toBe("skip");
  });

  it("syncs only the requested version", () => {
    expect(sync.selectSyncVersions(source, [], "0.2.0")).toEqual({
      action: "publish",
      versions: ["0.2.0"],
    });
  });

  it("refuses a requested version npmjs does not publish", () => {
    const decision = sync.selectSyncVersions(source, [], "9.9.9");
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.reason).toContain("9.9.9");
    }
  });

  it("skips a requested version already mirrored", () => {
    expect(sync.selectSyncVersions(source, ["0.2.0"], "0.2.0").action).toBe("skip");
  });
});

describe("planDistTagSync", () => {
  const present = new Set(["0.1.0-alpha.0", "0.2.0"]);

  it("adds the tags npmjs assigns and removes mirror-only tags", () => {
    const plan = sync.planDistTagSync(
      { latest: "0.1.0-alpha.0", next: "0.2.0" },
      { latest: "0.2.0", next: "0.2.0-beta.1" },
      present,
    );
    expect(plan.add).toEqual([
      { tag: "latest", version: "0.1.0-alpha.0" },
      { tag: "next", version: "0.2.0" },
    ]);
    expect(plan.remove).toEqual([]);
  });

  it("is a no-op when the mirror already matches npmjs", () => {
    const plan = sync.planDistTagSync(
      { latest: "0.1.0-alpha.0", next: "0.2.0" },
      { latest: "0.1.0-alpha.0", next: "0.2.0" },
      present,
    );
    expect(plan).toEqual({ add: [], remove: [] });
  });

  it("removes a tag that exists only on GitHub Packages", () => {
    const plan = sync.planDistTagSync(
      { latest: "0.2.0" },
      { latest: "0.2.0", beta: "0.2.0-beta.1" },
      present,
    );
    expect(plan.remove).toEqual(["beta"]);
  });

  it("ignores an npmjs tag whose version the mirror does not carry", () => {
    const plan = sync.planDistTagSync({ latest: "9.9.9" }, { latest: "0.2.0" }, present);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual(["latest"]);
  });
});

describe("publishTagFor", () => {
  it("prefers latest when npmjs tags the version latest", () => {
    expect(sync.publishTagFor("0.2.0", { latest: "0.2.0", next: "0.2.0" })).toBe("latest");
  });

  it("uses the npmjs tag for prereleases", () => {
    expect(sync.publishTagFor("0.1.0-alpha.0", { latest: "0.1.0-alpha.0", next: "0.2.0" })).toBe("latest");
    expect(sync.publishTagFor("0.2.0-beta.1", { latest: "0.1.0-alpha.0", next: "0.2.0" })).toBe("next");
  });

  it("falls back to next for an untagged version", () => {
    expect(sync.publishTagFor("0.0.0-stage", { latest: "0.1.0-alpha.0" })).toBe("next");
  });
});

describe("github-packages workflow", () => {
  it("runs only on manual dispatch, never on push or pull_request", () => {
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).not.toMatch(/on:\s*\n\s*push:/);
    expect(workflow).not.toContain("pull_request");
    expect(workflow).not.toContain("schedule:");
  });

  it("grants only contents:read and packages:write", () => {
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("packages: write");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("id-token: write");
  });

  it("invokes the sync script and verifies afterwards", () => {
    expect(workflow).toContain("scripts/github-packages-sync.js");
    expect(workflow).toContain("npm.pkg.github.com");
    expect(workflow).toContain("GITHUB_TOKEN");
  });
});
