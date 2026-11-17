/**
 * Packaged consumer paths must not carry developer-machine values.
 *
 * The npm tarball ships `dist` (compiled from `src`), `host`, `skills`,
 * `examples/*.ts` and `CHANGELOG.md`. A general user installing the package
 * must never inherit the maintainer's home path, uid, session identifiers,
 * terminal name or local checkout path — those are environment facts, not
 * product behaviour, and they leak into diagnostics and docs when pasted in
 * as "examples".
 *
 * The check scans the repository sources that produce the packaged files
 * (`src` for `dist`), so it does not need a build to have run. Test fixtures
 * under `test/` are deliberately out of scope: they are not packaged, and
 * naming a fixture user there is honest test data, not a shipped assumption.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8"),
) as { files: string[] };

/**
 * `files` entries mapped to the repository paths that produce them.
 * `dist` is build output of `src`; everything else ships verbatim.
 */
function packagedSources(): { shipped: string; scanned: string }[] {
  const sources: { shipped: string; scanned: string }[] = [];
  for (const entry of manifest.files) {
    if (entry === "dist") {
      sources.push({ shipped: entry, scanned: "src" });
    } else if (entry.endsWith("/*.ts")) {
      sources.push({ shipped: entry, scanned: entry.slice(0, -"/*.ts".length) });
    } else {
      sources.push({ shipped: entry, scanned: entry });
    }
  }
  return sources;
}

function* packagedFiles(): Generator<{ path: string; text: string }> {
  for (const { scanned } of packagedSources()) {
    const absolute = resolve(PACKAGE_ROOT, scanned);
    const info = statSync(absolute, { throwIfNoEntry: false });
    if (info === undefined) {
      throw new Error(`packaged source ${scanned} is missing`);
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute, { recursive: true })) {
        const child = join(absolute, String(name));
        if (statSync(child).isFile()) {
          yield { path: join(scanned, String(name)), text: readFileSync(child, "utf-8") };
        }
      }
    } else {
      yield { path: scanned, text: readFileSync(absolute, "utf-8") };
    }
  }
}

type Forbidden = { readonly pattern: RegExp; readonly why: string };

const FORBIDDEN: readonly Forbidden[] = [
  { pattern: /\/Users\//, why: "an absolute POSIX home path" },
  { pattern: /\/home\//, why: "an absolute Linux home path" },
  // `C:\Users\First Last` is the documented generic placeholder, not a name.
  { pattern: /C:\\Users\\(?!First Last)/i, why: "a Windows profile path" },
  { pattern: /\brebui\b/i, why: "a personal account name" },
  { pattern: /uid:501\b|gui\/501\b|sess=100021\b|\b100021\b/, why: "a captured session/uid identifier" },
  { pattern: /\biTerm\b|Terminal\.app|WezTerm|Alacritty|kitty/i, why: "a developer's terminal name" },
  { pattern: /ae-a8n-\d{2,}/, why: "a numbered worktree/checkout directory" },
];

describe("packaged consumer paths carry no developer-machine values", () => {
  it("ships only sources this audit can see", () => {
    // If `files` grows an entry this mapping does not cover, the audit would
    // silently skip it — fail loudly instead.
    const covered = new Set(packagedSources().map((source) => source.shipped));
    expect([...covered].sort()).toEqual([...manifest.files].sort());
  });

  it("contains no home path, uid, session id, terminal name or checkout path", () => {
    const offenders: string[] = [];
    for (const file of packagedFiles()) {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(file.text)) {
          offenders.push(`${file.path}: ${why} (${pattern})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
