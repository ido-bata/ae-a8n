/**
 * scripts/stage-publish.js, run with the real npm CLI against a registry
 * that records what npm sends.
 *
 * What is checked is what reaches the registry, not what npm prints: npm
 * 11.19.1's log line reports the command-line tag only, so it said "latest"
 * for requests that carried `next` (see the script's header).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/stage-publish.js", import.meta.url));
const stage = (await import(pathToFileURL(scriptPath).href)) as {
  versionAtLeast: (a: string, b: string) => boolean;
  MINIMUM_NPM: string;
  DIST_TAG: string;
};

const NAME = "@ido-bata/ae-a8n";
const VERSION = "0.1.0-alpha.1";

interface Upload {
  method: string;
  url: string;
  distTags: Record<string, string>;
  versions: string[];
  attachmentSha1: string;
}

describe("versionAtLeast", () => {
  it.each([
    ["11.15.0", true],
    ["11.19.1", true],
    ["12.0.0", true],
    ["11.14.9", false],
    ["11.5.1", false],
    ["10.99.99", false],
    ["garbage", false],
  ])("%s ≥ 11.15.0 is %s", (version, expected) => {
    expect(stage.versionAtLeast(version, stage.MINIMUM_NPM)).toBe(expected);
  });
});

describe("staging with the real npm CLI", () => {
  let dir: string;
  let pkg: string;
  let tarball: string;
  let shasum: string;
  let server: Server;
  let registry: string;
  let uploads: Upload[];
  let answer: { status: number; body: string };

  function makePackage(publishConfigTag: string): void {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: NAME,
        version: VERSION,
        license: "MIT",
        publishConfig: { access: "public", tag: publishConfigTag, provenance: false },
      }),
    );
    writeFileSync(join(pkg, "index.js"), "export {};\n");
  }

  async function pack(): Promise<void> {
    const out = join(dir, "out");
    mkdirSync(out, { recursive: true });
    await run("npm", ["pack", "--pack-destination", out, ...npmIsolation()], { cwd: pkg });
    const [file] = readdirSync(out).filter((f) => f.endsWith(".tgz"));
    tarball = join(out, file ?? "");
    shasum = createHash("sha1").update(readFileSync(tarball)).digest("hex");
  }

  /** Keep the user's ~/.npmrc and cache out of it. */
  function npmIsolation(): string[] {
    return [`--userconfig=${join(dir, "npmrc")}`, `--cache=${join(dir, "cache")}`];
  }

  async function stageIt(
    extra: string[] = [],
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string; output: string; summary: string }> {
    const output = join(dir, "github-output");
    const summary = join(dir, "step-summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const host = registry.replace(/^http:/, "");
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        [
          scriptPath,
          tarball,
          "--expect-shasum",
          shasum,
          `--registry=${registry}`,
          `--${host}:_authToken=fake`,
          ...npmIsolation(),
          ...extra,
        ],
        { cwd: pkg, env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env } },
      );
      return { code: 0, stdout, stderr, output: readFileSync(output, "utf-8"), summary: readFileSync(summary, "utf-8") };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return {
        code: e.code,
        stdout: e.stdout,
        stderr: e.stderr,
        output: readFileSync(output, "utf-8"),
        summary: readFileSync(summary, "utf-8"),
      };
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "a8n-stage-"));
    pkg = join(dir, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(dir, "npmrc"), "");
    uploads = [];
    answer = { status: 201, body: '{"stageId":"stage-test-1"}' };
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        if (req.method === "GET") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end('{"error":"Not found"}');
          return;
        }
        const doc = JSON.parse(body) as {
          "dist-tags": Record<string, string>;
          versions: Record<string, unknown>;
          _attachments: Record<string, { data: string }>;
        };
        const attachment = Object.values(doc._attachments)[0]?.data ?? "";
        uploads.push({
          method: req.method ?? "",
          url: req.url ?? "",
          distTags: doc["dist-tags"],
          versions: Object.keys(doc.versions),
          attachmentSha1: createHash("sha1").update(Buffer.from(attachment, "base64")).digest("hex"),
        });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    makePackage("next");
    await pack();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("uploads to the stage queue, tagged next, the exact verified tarball", async () => {
    const result = await stageIt();
    expect(result.code).toBe(0);
    expect(uploads).toEqual([
      {
        method: "POST",
        url: "/-/stage/package/@ido-bata%2fae-a8n",
        distTags: { next: VERSION },
        versions: [VERSION],
        attachmentSha1: shasum,
      },
    ]);
    expect(result.output).toBe("stage-id=stage-test-1\n");
    expect(result.summary).toContain("npm stage approve stage-test-1");
    expect(result.summary).toContain(shasum);
  });

  it("sends nothing on a dry run", async () => {
    const result = await stageIt(["--dry-run"]);
    expect(result.code).toBe(0);
    expect(uploads).toEqual([]);
    expect(result.summary).toBe("");
  });

  it("refuses a tarball other than the verified one, before sending anything", async () => {
    writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from("x")]));
    const tampered = await stageIt();
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain("not the");
    expect(uploads).toEqual([]);
  });

  it("refuses when package.json would not publish to next", async () => {
    makePackage("latest");
    const result = await stageIt();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("publishConfig.tag is latest");
    expect(uploads).toEqual([]);
  });

  it("refuses an npm CLI other than the pinned one", async () => {
    const result = await stageIt([], { NPM_CLI_VERSION: "11.15.0-not-this-one" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the workflow pins");
    expect(uploads).toEqual([]);
  });

  it("fails when the registry refuses, as it does for a version already staged or published", async () => {
    answer = {
      status: 403,
      body: '{"error":"You cannot publish over the previously published versions: 0.1.0-alpha.1."}',
    };
    const result = await stageIt();
    expect(result.code).toBe(1);
    expect(result.output).toBe("");
    expect(result.summary).toBe("");
  });

  it("fails when the registry gives no stage id", async () => {
    answer = { status: 201, body: "{}" };
    const result = await stageIt();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no stage id");
  });
});
