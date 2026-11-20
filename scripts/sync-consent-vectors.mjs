#!/usr/bin/env node
/**
 * sync-consent-vectors.mjs — vendor the canonical consent fixture from
 * ae-devtools instead of hand-copying it (ae-a8n #247).
 *
 * The contract fixture `native-consent-vectors.json` is owned by
 * ae-devtools (`packages/native-adapter/tests/fixtures/`). This script
 * fetches it, writes `test/fixtures/native-consent-vectors.json`, and
 * records provenance + SHA-256 in `test/fixtures/native-consent-vectors.meta.json`
 * so `test/native-consent.test.ts` can prove the vendored copy is
 * intact and traceable.
 *
 * Source resolution (first match wins):
 *   --file <path>     local JSON file
 *   --devtools <dir>  <dir>/packages/native-adapter/tests/fixtures/native-consent-vectors.json
 *   (default)         `gh api` against ido-bata/ae-devtools at --ref
 *
 * Modes:
 *   (default)   fetch + write fixture and meta
 *   --check     fetch + compare bytes; exit 1 on drift or hash mismatch
 *
 * Usage:
 *   npm run sync:consent-vectors                       # fetch release-0-5-0 head
 *   npm run sync:consent-vectors -- --ref <git-ref>
 *   node scripts/sync-consent-vectors.mjs --devtools ../ae-devtools
 *   node scripts/sync-consent-vectors.mjs --check --devtools ../ae-devtools
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UPSTREAM_REPO = "ido-bata/ae-devtools";
const UPSTREAM_PATH =
  "packages/native-adapter/tests/fixtures/native-consent-vectors.json";
const FIXTURE_PATH = join(ROOT, "test", "fixtures", "native-consent-vectors.json");
const META_PATH = join(
  ROOT,
  "test",
  "fixtures",
  "native-consent-vectors.meta.json",
);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Resolve the upstream fixture bytes plus provenance. */
function fetchSource() {
  const file = argValue("--file") ?? process.env.AE_DEVTOOLS_VECTORS;
  if (file !== undefined) {
    const path = resolve(file);
    if (!existsSync(path)) {
      throw new Error(`--file source does not exist: ${path}`);
    }
    return {
      bytes: readFileSync(path),
      /* `path` must stay the contract-relative UPSTREAM_PATH: the meta
         assertion and the AE_DEVTOOLS_ROOT drift check resolve it
         against a repo root. The absolute source goes in `ref`. */
      provenance: { repo: "local", path: UPSTREAM_PATH, ref: `file:${path}` },
    };
  }
  const devtools = argValue("--devtools") ?? process.env.AE_DEVTOOLS_ROOT;
  if (devtools !== undefined) {
    const repo = resolve(devtools);
    const path = join(repo, UPSTREAM_PATH);
    if (!existsSync(path)) {
      throw new Error(`fixture not found under --devtools repo: ${path}`);
    }
    let ref = "worktree";
    try {
      ref = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
        encoding: "utf-8",
      }).trim();
    } catch {
      /* non-git directory: provenance stays "worktree" */
    }
    return {
      bytes: readFileSync(path),
      provenance: { repo, path: UPSTREAM_PATH, ref },
    };
  }
  const ref = argValue("--ref") ?? "release-0-5-0";
  /* Fetch via the contents API's base64 `content` field, NOT the
     `application/vnd.github.raw+json` media type: gh api parses and
     re-serializes JSON bodies, decoding `\uXXXX` escapes into literal
     control bytes — the returned bytes then differ from the git blob
     and every --check reports false drift (#254). base64 `.content`
     decodes to the exact blob bytes. */
  const b64 = execFileSync(
    "gh",
    [
      "api",
      `repos/${UPSTREAM_REPO}/contents/${UPSTREAM_PATH}?ref=${encodeURIComponent(ref)}`,
      "--jq",
      ".content",
    ],
    { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
  );
  const raw = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  let sha = ref;
  try {
    sha = execFileSync(
      "gh",
      ["api", `repos/${UPSTREAM_REPO}/commits/${encodeURIComponent(ref)}`, "--jq", ".sha"],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    /* provenance falls back to the ref name */
  }
  return {
    bytes: raw,
    provenance: { repo: UPSTREAM_REPO, path: UPSTREAM_PATH, ref: sha },
  };
}

const { bytes, provenance } = fetchSource();

/* Validate before writing: the vendored copy must be the contract JSON. */
const parsed = JSON.parse(bytes.toString("utf-8"));
if (
  parsed?.v !== 1 ||
  !Array.isArray(parsed.canonicalVectors) ||
  !Array.isArray(parsed.wireCases)
) {
  throw new Error("source is not a native-consent-vectors/v1 fixture");
}

if (process.argv.includes("--check")) {
  const vendored = readFileSync(FIXTURE_PATH);
  if (!vendored.equals(bytes)) {
    console.error(
      "consent fixture drift: vendored copy differs from upstream source",
    );
    process.exit(1);
  }
  const meta = JSON.parse(readFileSync(META_PATH, "utf-8"));
  if (meta.sha256 !== sha256(vendored)) {
    console.error("consent fixture meta sha256 does not match vendored bytes");
    process.exit(1);
  }
  console.log(`consent fixture in sync (${sha256(vendored).slice(0, 12)}…)`);
  process.exit(0);
}

writeFileSync(FIXTURE_PATH, bytes);
writeFileSync(
  META_PATH,
  `${JSON.stringify(
    {
      v: 1,
      upstream: {
        repo: provenance.repo,
        path: provenance.path,
        ref: provenance.ref,
      },
      sha256: sha256(bytes),
    },
    null,
    2,
  )}\n`,
);
console.log(
  `vendored ${UPSTREAM_PATH} @ ${provenance.ref} -> test/fixtures/ (${bytes.length} bytes)`,
);
