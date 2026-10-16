/**
 * openProject takes absolute paths only (#34).
 *
 * After Effects resolves a relative path against its own working directory,
 * not the caller's: on AE 26.5x89 `openProject("copy.aep")` failed with
 * "project file not found: copy.aep" while the file sat in the caller's cwd,
 * which is how the skill's example command was written. The API now refuses
 * such a path before sending anything, and never resolves it itself: the
 * caller's cwd is not necessarily on the machine that runs After Effects.
 * The check reads the text only, so it gives the same answer on any OS.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isAbsoluteProjectPath } from "../src/api/index.js";
import { AfterEffects, AfterEffectsError } from "../src/index.js";
import { FakeAfterEffectsTransport } from "../src/testing/index.js";

describe("isAbsoluteProjectPath", () => {
  it.each([
    "/Users/me/work/copy.aep",
    "/tmp/dir with spaces/copy.aep",
    "/Users/me/作業/日本語 プロジェクト.aep",
    "//server/share/copy.aep",
    "C:\\Users\\me\\copy.aep",
    "c:/Users/me/copy.aep",
    "D:\\作業\\日本語 プロジェクト.aep",
    "\\\\server\\share\\dir with spaces\\copy.aep",
    "\\\\?\\C:\\very\\long\\copy.aep",
  ])("accepts %s", (path) => {
    expect(isAbsoluteProjectPath(path)).toBe(true);
  });

  it.each([
    "copy.aep",
    "./copy.aep",
    "../work/copy.aep",
    "work/copy.aep",
    "work\\copy.aep",
    "~/work/copy.aep",
    "C:copy.aep",
    "\\work\\copy.aep",
    " /leading-space.aep",
    "日本語.aep",
  ])("refuses %s", (path) => {
    expect(isAbsoluteProjectPath(path)).toBe(false);
  });
});

describe("openProject", () => {
  let root: string;
  let transport: FakeAfterEffectsTransport;
  let ae: AfterEffects;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "a8n-path-"));
    transport = new FakeAfterEffectsTransport();
    ae = await AfterEffects.launch({ sessionRoot: join(root, "session"), transport });
  });

  afterEach(async () => {
    await ae.close({ unsavedChanges: "discard" });
    rmSync(root, { recursive: true, force: true });
  });

  const sentOpens = () =>
    readdirSync(join(root, "session", "inbox"))
      .map((f) => JSON.parse(readFileSync(join(root, "session", "inbox", f), "utf-8")) as { method: string; params: { path?: string } })
      .filter((r) => r.method === "project.open");

  it.each(["copy.aep", "./copy.aep", "../copy.aep", "~/copy.aep", "C:copy.aep"])(
    "refuses %s with a TypeError that says what to do, before sending anything",
    async (path) => {
      const error = await ae.openProject(path).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toContain("must be absolute");
      expect((error as TypeError).message).toContain("path.resolve(");
      expect(sentOpens()).toEqual([]);
      expect(transport.app.openedPaths).toEqual([]);
    },
  );

  it("opens an absolute path with spaces and Japanese, sending it unchanged", async () => {
    const dir = join(root, "作業 フォルダ");
    mkdirSync(dir);
    const path = join(dir, "日本語 プロジェクト.aep");
    writeFileSync(path, "fake");
    const project = await ae.openProject(path);
    expect((await project.info()).file).toBe(path);
    expect(sentOpens().map((r) => r.params.path)).toEqual([path]);
  });

  it("passes a Windows path through on any OS; only the host decides whether it exists", async () => {
    const path = "C:\\Users\\me\\作業\\copy.aep";
    const error = await ae.openProject(path).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toBeInstanceOf(AfterEffectsError);
    expect(sentOpens().map((r) => r.params.path)).toEqual([path]);
  });
});
