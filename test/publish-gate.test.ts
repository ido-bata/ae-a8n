/**
 * The publish gate: who may publish what, and that nothing is published twice.
 *
 * The repository has no server-side gate (GitHub Free, private: no required
 * reviewers, no tag rules), so scripts/publish-gate.js is the gate. `decide`
 * is checked case by case; the CLI is run for real against a throwaway git
 * repository and a local HTTP registry, because the wiring (ancestry,
 * registry parsing, $GITHUB_OUTPUT, exit code) is where a gate quietly opens.
 * Nothing here needs a POSIX shell: the gate asks the registry over HTTP and
 * the registry is a server in this process, so it runs the same on Windows.
 */

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
  registryState: (name: string, version: string, registry?: string, timeoutMs?: number) => Promise<RegistryState>;
  MANUAL_FIRST_PUBLISH: string;
};

const stage = (await import(pathToFileURL(fileURLToPath(new URL("../scripts/stage-publish.js", import.meta.url))).href)) as {
  versionAtLeast: (a: string, b: string) => boolean;
  MINIMUM_NPM: string;
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

/**
 * A registry in this process. It answers GET /<name>/<version> as
 * registry.npmjs.org does: 404 for a version it does not have, the version's
 * manifest (with dist.shasum) for one it does, or whatever a test sets.
 */
class FakeRegistry {
  server: Server = createServer((req, res) => {
    this.requests.push(req.url ?? "");
    const a = this.answer;
    if (a === "hang") {
      // Accepts the request and never answers; closed when the server stops.
      this.hanging.push(res);
      return;
    }
    if (a === "absent") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"version not found"}');
    } else if ("shasum" in a) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "@ido-bata/ae-a8n", version: NEXT, dist: { shasum: a.shasum } }));
    } else {
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(a.body);
    }
  });
  answer: "absent" | "hang" | { shasum: string } | { status: number; body: string } = "absent";
  requests: string[] = [];
  hanging: ServerResponse[] = [];
  url = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  async stop(): Promise<void> {
    for (const res of this.hanging.splice(0)) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("registryState", () => {
  const registry = new FakeRegistry();
  beforeEach(async () => {
    registry.requests = [];
    await registry.start();
  });
  afterEach(async () => {
    await registry.stop();
  });

  it("asks for the scoped version the way the registry names it", async () => {
    await gate.registryState("@ido-bata/ae-a8n", NEXT, registry.url);
    expect(registry.requests).toEqual([`/@ido-bata%2fae-a8n/${NEXT}`]);
  });

  it("reads 404 as absent and a manifest as present with its shasum", async () => {
    registry.answer = "absent";
    expect(await gate.registryState("@ido-bata/ae-a8n", NEXT, registry.url)).toEqual({ state: "absent" });
    registry.answer = { shasum: SHA };
    expect(await gate.registryState("@ido-bata/ae-a8n", NEXT, registry.url)).toEqual({ state: "present", shasum: SHA });
  });

  it.each([
    ["a refusal (403)", { status: 403, body: '{"error":"Forbidden"}' }],
    ["rate limiting (429)", { status: 429, body: '{"error":"Too Many Requests"}' }],
    ["a server error", { status: 503, body: "{}" }],
    ["another server error", { status: 500, body: "{}" }],
    ["a body that is not JSON", { status: 200, body: "<html>" }],
    ["a manifest without dist.shasum", { status: 200, body: '{"dist":{}}' }],
  ])("reads %s as unknown", async (_label, answer) => {
    registry.answer = answer;
    expect((await gate.registryState("@ido-bata/ae-a8n", NEXT, registry.url)).state).toBe("unknown");
  });

  it("reads a registry that does not answer in time as unknown", async () => {
    registry.answer = "hang";
    const state = await gate.registryState("@ido-bata/ae-a8n", NEXT, registry.url, 200);
    expect(state.state).toBe("unknown");
    expect(state).toMatchObject({ error: expect.stringContaining("TimeoutError") });
  });

  it("reads a registry nobody answers on as unknown", async () => {
    const closed = registry.url;
    await registry.stop();
    expect((await gate.registryState("@ido-bata/ae-a8n", NEXT, closed)).state).toBe("unknown");
    await registry.start();
  });
});

describe("the gate as the workflow runs it", () => {
  let dir: string;
  let repo: string;
  let tarball: string;
  let output: string;
  const registry = new FakeRegistry();

  function git(...args: string[]): string {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /**
   * Runs the gate as a separate process. Asynchronously: the registry is a
   * server in this process, and a synchronous spawn would stop it answering.
   */
  async function run(
    env: Record<string, string>,
  ): Promise<{ status: number | null; outputs: Record<string, string>; stderr: string }> {
    writeFileSync(output, "");
    const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [gatePath, tarball],
        {
          cwd: repo,
          encoding: "utf-8",
          env: {
            ...process.env,
            npm_config_registry: registry.url,
            NPM_PUBLISH_VERSION: "",
            GITHUB_OUTPUT: output,
            GITHUB_EVENT_NAME: "push",
            GITHUB_REF_TYPE: "tag",
            GITHUB_REF_NAME: `v${NEXT}`,
            ...env,
          },
        },
        (error, _stdout, stderr) => {
          resolve({ status: error === null ? 0 : typeof error.code === "number" ? error.code : null, stderr });
        },
      );
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("=") as [string, string]),
    );
    return { ...result, outputs };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "a8n-gate-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    tarball = join(dir, "package.tgz");
    writeFileSync(tarball, "not really a tarball, but the shasum is all the gate reads");
    output = join(dir, "github-output");
    git("init", "-q");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "@ido-bata/ae-a8n", version: NEXT }));
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "release");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    registry.answer = "absent";
    await registry.start();
  });

  afterEach(async () => {
    await registry.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes its decision, the tarball shasum and the registry state for the workflow", async () => {
    registry.answer = "absent";
    const result = await run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "1/merge" });
    expect(result.status).toBe(0);
    expect(result.outputs.publish).toBe("false");
    expect(result.outputs.registry).toBe("absent");
    expect(result.outputs.shasum).toBe(createHash("sha1").update(readFileSync(tarball)).digest("hex"));
  });

  it("skips a tag pushed for a version npm already has, built from the same tarball", async () => {
    registry.answer = "absent";
    const { outputs } = await run({});
    registry.answer = { shasum: outputs.shasum ?? "" };
    const result = await run({});
    expect(result.status).toBe(0);
    expect(result.outputs.publish).toBe("false");
    expect(result.outputs.registry).toBe("present");
  });

  it("fails a tag pushed for a published version whose contents differ", async () => {
    registry.answer = { shasum: "1".repeat(40) };
    const result = await run({});
    expect(result.status).toBe(1);
    expect(result.outputs.publish).toBe("false");
    expect(result.stderr).toContain("does not point at what was published");
  });

  it.each([
    ["403", { status: 403, body: "{}" }],
    ["429", { status: 429, body: "{}" }],
    ["503", { status: 503, body: "{}" }],
    ["a body that is not JSON", { status: 200, body: "<html>" }],
    ["a manifest without dist.shasum", { status: 200, body: '{"dist":{}}' }],
  ])("fails an approved version, and does not publish, when the registry answers %s", async (_label, answer) => {
    registry.answer = answer;
    const result = await run({ NPM_PUBLISH_VERSION: NEXT });
    expect(result.status).toBe(1);
    expect(result.outputs.publish).toBe("false");
    expect(result.outputs.registry).toBe("unknown");
    expect(result.stderr).toContain("cannot tell whether");
  });

  it("does not publish an unapproved version whose registry state is unknown", async () => {
    registry.answer = { status: 503, body: "{}" };
    const result = await run({});
    expect(result.status).toBe(0);
    expect(result.outputs.publish).toBe("false");
    expect(result.outputs.registry).toBe("unknown");
  });

  it("publishes an approved version tagged on main", async () => {
    registry.answer = "absent";
    const result = await run({ NPM_PUBLISH_VERSION: NEXT });
    expect(result.status).toBe(0);
    expect(result.outputs.publish).toBe("true");
  });

  it("checks ancestry against origin/main for real", async () => {
    registry.answer = "absent";
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "unreviewed");
    const result = await run({ NPM_PUBLISH_VERSION: NEXT });
    expect(result.status).toBe(1);
    expect(result.outputs.publish).toBe("false");
    expect(result.stderr).toContain("not on main");
  });

  it("lets this repository's real version through from CI once approved, and it is not the hand-published one", async () => {
    registry.answer = "absent";
    const real = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "@ido-bata/ae-a8n", version: real.version }));
    expect(real.version).not.toBe(gate.MANUAL_FIRST_PUBLISH);
    const unapproved = await run({ GITHUB_REF_NAME: `v${real.version}` });
    expect(unapproved.outputs.publish).toBe("false");
    const approved = await run({ GITHUB_REF_NAME: `v${real.version}`, NPM_PUBLISH_VERSION: real.version });
    expect(approved.status).toBe(0);
    expect(approved.outputs.publish).toBe("true");
  });
});

/**
 * The workflow as checked out, with \n line ends: Git for Windows defaults to
 * core.autocrlf=true, and the patterns below are written with \n.
 */
function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

describe("the publish workflow", () => {
  const workflow = lf(readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf-8"));
  const stageJob = workflow.slice(workflow.indexOf("\n  stage:"));
  const code = workflow
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  it("sends anything to npm only on the gate's word", () => {
    expect(stageJob).toMatch(/^\s+if: needs\.verify\.outputs\.publish == 'true'$/m);
    expect(workflow).toContain("NPM_PUBLISH_VERSION: ${{ vars.NPM_PUBLISH_VERSION }}");
    expect(code).not.toMatch(/NPM_PUBLISH_ENABLED|NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  });

  it("stages and never publishes directly", () => {
    expect(code).not.toMatch(/npm publish/);
    expect(stageJob).toContain("node scripts/stage-publish.js");
    expect(stageJob).not.toContain("--dry-run");
  });

  it("stages the tarball the gate checked", () => {
    expect(stageJob).toContain("EXPECTED_SHASUM: ${{ needs.verify.outputs.shasum }}");
  });

  it("pins one npm CLI, new enough for npm stage, in both jobs", () => {
    const pinned = /NPM_CLI_VERSION: "(\d+\.\d+\.\d+)"/.exec(workflow)?.[1];
    expect(pinned).toBeDefined();
    expect(stage.versionAtLeast(pinned ?? "0.0.0", stage.MINIMUM_NPM)).toBe(true);
    expect(workflow.match(/- name: Pin the npm CLI/g)).toHaveLength(2);
    // ...and both hand stage-publish.js the npm-cli.js of the CLI they pinned.
    expect(workflow.match(/echo "NPM_CLI_JS=\$cli" >> "\$GITHUB_ENV"/g)).toHaveLength(2);
    expect(workflow.match(/via=\$\(mise exec -- node "\$cli" --version\)/g)).toHaveLength(2);
    expect(workflow.indexOf("Pin the npm CLI", workflow.indexOf("\n  stage:"))).toBeLessThan(
      workflow.indexOf("stage-publish.js", workflow.indexOf("\n  stage:")),
    );
  });

  it("names no environment, which on this plan would be created unprotected", () => {
    expect(workflow).not.toMatch(/^\s+environment:/m);
  });

  it("has the history the ancestry check needs", () => {
    expect(workflow).toMatch(/fetch-depth: 0/);
  });

  it("reads a CRLF checkout of the workflow as the same text", () => {
    expect(lf(workflow.replace(/\n/g, "\r\n"))).toBe(workflow);
  });

  it("does not rehearse staging a published version", () => {
    expect(workflow).toMatch(/- name: Stage \(dry run\)\n\s+if: steps\.gate\.outputs\.registry != 'present'/);
  });
});
