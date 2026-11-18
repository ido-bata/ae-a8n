/**
 * The managed `latest` promotion path (#75).
 *
 *   node scripts/promote-dist-tag.js --version <semver> --commit <sha> [--dry-run]
 *
 * Moving `latest` is a promotion, not a publish: the version is already on
 * npm under `next`, and this script only re-points the tag — but only after
 * `scripts/evidence-gate.js` allows it for `latest`, which means every
 * supported platform has a current real-host evidence record bound to the
 * exact candidate.
 *
 * The candidate is proven three ways before the gate runs:
 *
 * - `v<version>` resolves to `--commit` in this repository;
 * - the version's manifest on npm carries `gitHead` equal to `--commit`,
 *   so the promoted bits are the candidate's, not a lookalike;
 * - the tarball hashed for the gate is the one npm actually serves for
 *   that version (`npm pack <pkg>@<version>`), not a locally rebuilt one.
 *
 * Evidence records are read from this checkout's
 * `docs/evidence/platforms/`; each record's own `commit`/`tarballSha256`
 * fields do the binding to the candidate, so the records may have been
 * committed after the release commit.
 *
 * This is the supported path, not a sandbox: anyone holding npm publish
 * credentials can still run `npm dist-tag` by hand. What it removes is the
 * *accidental* bypass — a promotion attempted through the documented
 * procedure cannot skip the gate. docs/releasing.md states the residual.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateEvidenceGate, loadRecords } from "./evidence-gate.js";
import { npmCommand } from "./npm-cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_TAG = "latest";
const SHA1 = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Everything the promotion decision rests on, already collected. Pure, so
 * the deny/allow matrix is testable without npm or git.
 *
 * @param {{
 *   version: string,
 *   commit: string,
 *   tagCommit: string | null,
 *   gitHead: string | null,
 *   tarballSha256: string,
 *   records: Record<string, unknown>,
 * }} input
 */
export function evaluatePromotion({ version, commit, tagCommit, gitHead, tarballSha256, records }) {
  /** @type {string[]} */
  const reasons = [];
  /** @type {string[]} */
  const notes = [];

  if (!VERSION.test(version)) {
    reasons.push(`invalid-version:${version}`);
  }
  if (!SHA1.test(commit)) {
    reasons.push("invalid-candidate:commit");
  }
  if (tagCommit === null) {
    reasons.push(`missing-tag:v${version}`);
  } else if (tagCommit !== commit) {
    reasons.push(`tag-mismatch:v${version}`);
  }
  if (gitHead === null) {
    reasons.push(`githead-missing:${version}`);
  } else if (gitHead !== commit) {
    reasons.push(`githead-mismatch:${version}`);
  }

  const gate = evaluateEvidenceGate({
    distTag: DIST_TAG,
    candidateCommit: commit,
    tarballSha256,
    records,
    // `latest` never accepts `unverified`, so the Windows-gap declarations
    // cannot influence the verdict; empty strings keep the input honest.
    declarations: { description: "", readme: "" },
  });
  reasons.push(...gate.reasons);
  notes.push(...gate.notes);

  return { action: reasons.length === 0 ? "allow" : "deny", reasons, notes };
}

/**
 * The side-effecting half, with every outside fact behind `probes` so a
 * test can prove a deny never reaches `apply` (the `npm dist-tag` call).
 *
 * @param {{
 *   version: string,
 *   commit: string,
 *   dryRun: boolean,
 *   probes: {
 *     tagCommit: () => string | null,
 *     gitHead: () => string | null,
 *     tarballSha256: () => string,
 *     records: () => Record<string, unknown>,
 *     apply: () => void,
 *   },
 * }} input
 */
export function promoteDistTag({ version, commit, dryRun, probes }) {
  const verdict = evaluatePromotion({
    version,
    commit,
    tagCommit: probes.tagCommit(),
    gitHead: probes.gitHead(),
    tarballSha256: probes.tarballSha256(),
    records: probes.records(),
  });
  if (verdict.action !== "allow") {
    return { action: "deny", verdict, applied: false };
  }
  if (!dryRun) {
    probes.apply();
  }
  return { action: "allow", verdict, applied: !dryRun };
}

function git(args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function npm(args) {
  const command = npmCommand();
  const result = spawnSync(command.command, [...command.args, ...args], {
    encoding: "utf-8",
    cwd: root,
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} exited ${result.status}: ${result.stderr ?? result.error?.message ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

/** The sha256 of the tarball npm serves for `spec`, fetched not rebuilt. */
function publishedTarballSha256(spec) {
  const packDir = mkdtempSync(join(tmpdir(), "a8n-promote-"));
  try {
    npm(["pack", spec, "--pack-destination", packDir, "--silent"]);
    const packed = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
    if (packed === undefined) {
      throw new Error(`npm pack produced no tarball for ${spec}`);
    }
    return createHash("sha256").update(readFileSync(join(packDir, packed))).digest("hex");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg?.startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return { args, dryRun };
}

function main() {
  const { args, dryRun } = parseArgs(process.argv.slice(2));
  const version = args.version ?? "";
  const commit = args.commit ?? "";
  if (version === "" || commit === "") {
    console.error("usage: promote-dist-tag.js --version <semver> --commit <full sha> [--dry-run]");
    process.exit(2);
  }

  const name = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).name;
  const spec = `${name}@${version}`;

  const outcome = promoteDistTag({
    version,
    commit,
    dryRun,
    probes: {
      tagCommit: () => {
        try {
          return git(["rev-list", "-n", "1", `v${version}`]);
        } catch {
          return null;
        }
      },
      gitHead: () => {
        try {
          const manifest = JSON.parse(npm(["view", spec, "--json"]));
          return typeof manifest.gitHead === "string" ? manifest.gitHead : null;
        } catch {
          return null;
        }
      },
      tarballSha256: () => publishedTarballSha256(spec),
      records: () => loadRecords(join(root, "docs/evidence/platforms")),
      apply: () => {
        npm(["dist-tag", "add", spec, DIST_TAG]);
      },
    },
  });

  for (const reason of outcome.verdict.reasons) console.error(`::error::promote-gate: ${reason}`);
  for (const note of outcome.verdict.notes) console.log(`note: ${note}`);
  if (outcome.action !== "allow") {
    process.exit(1);
  }
  if (dryRun) {
    console.log(`would run: npm dist-tag add ${spec} ${DIST_TAG}`);
    return;
  }
  console.log(`${spec} -> dist-tag ${DIST_TAG} — done; verify with: npm view ${name} dist-tags`);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
