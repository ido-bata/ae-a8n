import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The vendored Agent Skills are copies of skills owned elsewhere. `skills-lock.json`
// records which revision each copy came from and a hash of its content, so a copy
// that was edited in place — or dropped from the repository — is visible here
// instead of quietly drifting from its source.
//
// This mirrors `evals/policy-evaluation/vendored-skills-contract.mts` in
// rebuildup/project-init. The hash is the sha256 of every file's relative path
// followed by its bytes, in case-insensitive path order.

const root = resolve(import.meta.dirname, "..");

type LockEntry = {
  source: string;
  ref?: string;
  sourceType: string;
  skillPath: string;
  computedHash: string;
};

type Lock = {
  version: number;
  skills: Record<string, LockEntry>;
};

function walk(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(directory, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function folderHash(directory: string): string {
  const files = walk(directory).sort((a, b) => {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const sha = createHash("sha256");
  for (const relative of files) {
    sha.update(relative);
    sha.update(readFileSync(join(directory, relative)));
  }
  return sha.digest("hex");
}

function readLock(): Lock {
  return JSON.parse(readFileSync(join(root, "skills-lock.json"), "utf8")) as Lock;
}

describe("vendored Agent Skills", () => {
  const lock = readLock();

  it("records every installed skill", () => {
    const names = Object.keys(lock.skills).sort();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(lock.skills[name]?.computedHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("commits the files of every locked skill", () => {
    for (const name of Object.keys(lock.skills)) {
      const candidates = [".claude/skills", ".agents/skills"].map((prefix) => join(root, prefix, name));
      const directory = candidates.find((path) => existsSync(join(path, "SKILL.md")));
      expect(directory, `${name} is in skills-lock.json but its files are not committed`).toBeDefined();
    }
  });

  it("keeps every copy identical to its locked revision", () => {
    for (const [name, entry] of Object.entries(lock.skills)) {
      const candidates = [".claude/skills", ".agents/skills"].map((prefix) => join(root, prefix, name));
      const directory = candidates.find((path) => existsSync(join(path, "SKILL.md")));
      expect(directory).toBeDefined();
      expect(folderHash(directory as string), `${name} differs from skills-lock.json`).toBe(entry.computedHash);
    }
  });

  it("does not publish a vendored copy from the shipped skills/ directory", () => {
    for (const name of Object.keys(lock.skills)) {
      expect(existsSync(join(root, "skills", name)), `${name} is both vendored and published from skills/`).toBe(false);
    }
  });

  it("ships the after-effects-automation skill from skills/, not from the lock", () => {
    const shipped = join(root, "skills", "after-effects-automation", "SKILL.md");
    expect(existsSync(shipped) && statSync(shipped).isFile()).toBe(true);
    expect(Object.keys(lock.skills)).not.toContain("after-effects-automation");
  });
});
