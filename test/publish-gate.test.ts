/**
 * The publish gate: who may publish what, and that nothing is published twice.
 *
 * The repository has no server-side gate (GitHub Free, private: no required
 * reviewers, no tag rules), so scripts/publish-gate.js is the gate. `decide`
 * is checked case by case; the CLI is run for real against a throwaway git
 * repository and a stand-in `npm` on PATH, because the wiring (ancestry,
 * registry parsing, $GITHUB_OUTPUT, exit code) is where a gate quietly opens.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type RegistryState = { state: "absent" } | { state: "present"; shasum: string } | { state: "unknown"; error: string };
interface Facts {
  event: string;
  refType: string;
  ref: string;
  version: string;
  approvedVersion: string;
  onMain: boolean;
  registry: RegistryState;
  packedShasum: string;
}
interface Decision {
  action: "publish" | "skip" | "fail";
  reason: string;
}

const gatePath = fileURLToPath(new URL("../scripts/publish-gate.js", import.meta.url));
const gate = (await import(pathToFileURL(gatePath).href)) as {
  decide: (facts: Facts) => Decision;
  MANUAL_FIRST_PUBLISH: string;
};

const NEXT = "0.1.0-alpha.1";
const SHA = "459a618f74a3e7937fe794f2343497d729c0ed90";

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    event: "push",
    refType: "tag",
    ref: `v${NEXT}`,
    version: NEXT,
    approvedVersion: NEXT,
    onMain: true,
    registry: { state: "absent" },
    packedShasum: SHA,
    ...overrides,
  };
}

describe("decide", () => {
  it("publishes an approved, merged, unpublished version tag", () => {
    expect(gate.decide(facts()).action).toBe("publish");
  });

  it.each([
    ["pull_request", "branch"],
    ["workflow_dispatch", "branch"],
    ["workflow_dispatch", "tag"],
    ["push", "branch"],
  ])("never publishes from %s on a %s", (event, refType) => {
    expect(gate.decide(facts({ event, refType })).action).toBe("skip");
  });

  it("fails a tag that does not match the package version", () => {
    expect(gate.decide(facts({ ref: "v0.1.0-alpha.2" })).action).toBe("fail");
  });

  it.each([
    ["unset", ""],
    ["the old boolean", "true"],
    ["a stale version", "0.1.0-alpha.0"],
    ["a version without exactness", "0.1.0-alpha"],
  ])("does not publish when NPM_PUBLISH_VERSION is %s", (_label, approvedVersion) => {
    const decision = gate.decide(facts({ approvedVersion }));
    expect(decision.action).toBe("skip");
    expect(decision.reason).toContain("NPM_PUBLISH_VERSION");
  });

  it("fails rather than publish a tag that is not on main", () => {
    expect(gate.decide(facts({ onMain: false })).action).toBe("fail");
  });

  it("never publishes the first version, even when approved", () => {
    const first = gate.MANUAL_FIRST_PUBLISH;
    const decision = gate.decide(facts({ version: first, ref: `v${first}`, approvedVersion: first }));
    expect(decision.action).toBe("fail");
    expect(decision.reason).toContain("by hand");
  });

  describe("a version already on npm", () => {
    const published: RegistryState = { state: "present", shasum: SHA };

    it("is not published again; tagging it afterwards is fine when it packs to the same tarball", () => {
      const first = gate.MANUAL_FIRST_PUBLISH;
      const decision = gate.decide(
        facts({ version: first, ref: `v${first}`, approvedVersion: "", registry: published }),
      );
      expect(decision.action).toBe("skip");
      expect(decision.reason).toContain("same tarball");
    });

    it("fails when the tag packs to something other than what was published", () => {
      const decision = gate.decide(facts({ approvedVersion: "", registry: { state: "present", shasum: "0".repeat(40) } }));
      expect(decision.action).toBe("fail");
      expect(decision.reason).toContain("does not point at what was published");
    });

    it("fails when still approved, so a stale variable is noticed", () => {
      expect(gate.decide(facts({ registry: published })).action).toBe("fail");
    });
  });

  it("fails closed when the registry cannot be asked and the version is approved", () => {
    expect(gate.decide(facts({ registry: { state: "unknown", error: "ETIMEDOUT" } })).action).toBe("fail");
  });

  it("only skips when the registry cannot be asked and nothing was approved", () => {
    expect(gate.decide(facts({ approvedVersion: "", registry: { state: "unknown", error: "ETIMEDOUT" } })).action).toBe(
      "skip",
    );
  });
});

describe("the gate as the workflow runs it", () => {
  let dir: string;
  let repo: string;
  let bin: string;
  let tarball: string;
  let output: string;

  function git(...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A stand-in `npm` whose `view` answers as the registry would. */
  function registryAnswers(answer: "absent" | { shasum: string } | "down"): void {
    const body =
      answer === "absent"
        ? `echo '{"error":{"code":"E404","summary":"Not Found"}}'; exit 1`
        : answer === "down"
          ? `echo '{"error":{"code":"ETIMEDOUT"}}'; exit 1`
          : `echo '"${answer.shasum}"'; exit 0`;
    writeFileSync(join(bin, "npm"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, "npm"), 0o755);
  }

  function run(env: Record<string, string>): { status: number | null; outputs: Record<string, string>; stderr: string } {
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [gatePath, tarball], {
      cwd: repo,
      encoding: "utf-8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: `v${NEXT}`,
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("=") as [string, string]),
    );
    return { status: result.status, outputs, stderr: result.stderr };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "a8n-gate-"));
    repo = join(dir, "repo");
    bin = join(dir, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    tarball = join(dir, "package.tgz");
    writeFileSync(tarball, "not really a tarball, but the shasum is all the gate reads");
    output = join(dir, "github-output");
    git("init", "-q");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "@ido-bata/ae-a8n", version: NEXT }));
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "release");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes its decision, the tarball shasum and the registry state for the workflow", () => {
    registryAnswers("absent");
    const result = run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "1/merge" });
    expect(result.status).toBe(0);
    expect(result.outputs.publish).toBe("false");
    expect(result.outputs.registry).toBe("absent");
    expect(result.outputs.shasum).toBe(createHash("sha1").update(readFileSync(tarball)).digest("hex"));
  });

  it("skips a tag pushed for a version npm already has, built from the same tarball", () => {
    registryAnswers("absent");
    const { outputs } = run({});
    registryAnswers({ shasum: outputs.shasum ?? "" });
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.outputs.publish).toBe("false");
    expect(result.outputs.registry).toBe("present");
  });

  it("fails a tag pushed for a published version whose contents differ", () => {
    registryAnswers({ shasum: "1".repeat(40) });
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.outputs.publish).toBe("false");
    expect(result.stderr).toContain("does not point at what was published");
  });

  it("fails an approved version when the registry is unreachable", () => {
    registryAnswers("down");
    const result = run({ NPM_PUBLISH_VERSION: NEXT });
    expect(result.status).toBe(1);
    expect(result.outputs.registry).toBe("unknown");
  });

  it("publishes an approved version tagged on main", () => {
    registryAnswers("absent");
    const result = run({ NPM_PUBLISH_VERSION: NEXT });
    expect(result.status).toBe(0);
    expect(result.outputs.publish).toBe("true");
  });

  it("checks ancestry against origin/main for real", () => {
    registryAnswers("absent");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "unreviewed");
    const result = run({ NPM_PUBLISH_VERSION: NEXT });
    expect(result.status).toBe(1);
    expect(result.outputs.publish).toBe("false");
    expect(result.stderr).toContain("not on main");
  });

  it("refuses the first version from CI with this repository's real package.json", () => {
    registryAnswers("absent");
    const real = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "@ido-bata/ae-a8n", version: real.version }));
    const result = run({ GITHUB_REF_NAME: `v${real.version}`, NPM_PUBLISH_VERSION: real.version });
    expect(real.version).toBe(gate.MANUAL_FIRST_PUBLISH);
    expect(result.status).toBe(1);
    expect(result.outputs.publish).toBe("false");
    expect(result.stderr).toContain("by hand");
  });
});

describe("the publish workflow", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf-8");
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));

  it("publishes only on the gate's word", () => {
    expect(publishJob).toMatch(/^\s+if: needs\.verify\.outputs\.publish == 'true'$/m);
    expect(workflow).toContain("NPM_PUBLISH_VERSION: ${{ vars.NPM_PUBLISH_VERSION }}");
    const code = workflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/NPM_PUBLISH_ENABLED|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  });

  it("publishes the tarball the gate checked", () => {
    expect(publishJob).toContain("EXPECTED_SHASUM: ${{ needs.verify.outputs.shasum }}");
  });

  it("names no environment, which on this plan would be created unprotected", () => {
    expect(workflow).not.toMatch(/^\s+environment:/m);
  });

  it("has the history the ancestry check needs", () => {
    expect(workflow).toMatch(/fetch-depth: 0/);
  });

  it("does not dry-run over a published version, which npm refuses", () => {
    expect(workflow).toMatch(/- name: Publish \(dry run\)\n\s+if: steps\.gate\.outputs\.registry != 'present'/);
  });
});
