/**
 * Cross-platform real-host evidence gate (#75, T093).
 *
 *   node scripts/evidence-gate.js --dist-tag <next|latest> \
 *     --commit <candidate sha> --tarball <packed .tgz> [--evidence-dir <dir>]
 *
 * `latest` is a promotion, not a publish: it may only happen when every
 * supported platform has a current real-host evidence record bound to the
 * exact candidate commit and tarball. `next` staging may proceed with
 * Windows marked `unverified`, and only while the package description and
 * README still say so — the declaration is checked, not trusted.
 *
 * One record per platform lives at
 * `docs/evidence/platforms/<platform>.json`:
 *
 *   {
 *     "schemaVersion": 1,
 *     "platform": "macos",
 *     "commit": "<full sha of the candidate commit>",
 *     "tarballSha256": "<sha256 hex of the packed tarball>",
 *     "recordedAt": "2026-11-18",
 *     "verdict": "pass" | "unverified" | "fail",
 *     "evidence": "docs/evidence/<run directory or file>"
 *   }
 *
 * A record is stale when it names a different commit or tarball hash than
 * the candidate being promoted; stale, missing, malformed and failed
 * records all deny, each with a named reason. Nothing here decides that a
 * real-host run happened — the record is written by the human release step
 * from the acceptance evidence, and this gate only enforces that the
 * record exists, is current and says what it claims.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PLATFORMS = ["macos", "windows"];
export const EVIDENCE_SCHEMA_VERSION = 1;
export const VERDICTS = ["pass", "unverified", "fail"];
export const DIST_TAGS = ["next", "latest"];

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{
 *   schemaVersion: number,
 *   platform: string,
 *   commit: string,
 *   tarballSha256: string,
 *   recordedAt: string,
 *   verdict: string,
 *   evidence?: string,
 * }} EvidenceRecord
 */

/**
 * Structural problems with one record, as named reasons. An empty array
 * means the record is well-formed; currency and verdict are judged by
 * `evaluateEvidenceGate`, not here.
 *
 * @param {unknown} record
 * @param {string} platform
 * @returns {string[]}
 */
export function recordProblems(record, platform) {
  const problems = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return [`invalid-evidence:${platform}:not-an-object`];
  }
  const r = /** @type {Record<string, unknown>} */ (record);
  if (r.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    problems.push(`invalid-evidence:${platform}:schemaVersion`);
  }
  if (r.platform !== platform) {
    problems.push(`invalid-evidence:${platform}:platform-mismatch`);
  }
  if (typeof r.commit !== "string" || !SHA1.test(r.commit)) {
    problems.push(`invalid-evidence:${platform}:commit`);
  }
  if (typeof r.tarballSha256 !== "string" || !SHA256.test(r.tarballSha256)) {
    problems.push(`invalid-evidence:${platform}:tarballSha256`);
  }
  if (typeof r.recordedAt !== "string" || !ISO_DATE.test(r.recordedAt) || Number.isNaN(Date.parse(r.recordedAt))) {
    problems.push(`invalid-evidence:${platform}:recordedAt`);
  }
  if (!VERDICTS.includes(/** @type {string} */ (r.verdict))) {
    problems.push(`invalid-evidence:${platform}:verdict`);
  }
  return problems;
}

/**
 * Does the text declare that Windows real-host evidence is absent?
 * Checked in the package description and README so an `unverified`
 * Windows record cannot outlive the statement that explains it.
 *
 * @param {string} text
 */
export function declaresWindowsUnverified(text) {
  return /windows/i.test(text) && /(unverified|not verified|missing|absent|no .*run|未検証|未確認)/i.test(text);
}

/**
 * @param {{
 *   distTag: string,
 *   candidateCommit: string,
 *   tarballSha256: string,
 *   records: Record<string, unknown>,
 *   declarations: { description: string, readme: string },
 * }} input
 * @returns {{ action: "allow" | "deny", reasons: string[], notes: string[] }}
 */
export function evaluateEvidenceGate({ distTag, candidateCommit, tarballSha256, records, declarations }) {
  const reasons = [];
  const notes = [];

  if (!DIST_TAGS.includes(distTag)) {
    return { action: "deny", reasons: [`unknown-dist-tag:${distTag}`], notes };
  }
  if (!SHA1.test(candidateCommit)) {
    reasons.push("invalid-candidate:commit");
  }
  if (!SHA256.test(tarballSha256)) {
    reasons.push("invalid-candidate:tarballSha256");
  }

  const windowsDeclared =
    declaresWindowsUnverified(declarations.description) && declaresWindowsUnverified(declarations.readme);

  for (const platform of PLATFORMS) {
    const record = records[platform];
    if (record === undefined || record === null) {
      reasons.push(`missing-evidence:${platform}`);
      continue;
    }
    reasons.push(...recordProblems(record, platform));
    const r = /** @type {EvidenceRecord} */ (record);
    if (typeof r.commit === "string" && SHA1.test(r.commit) && r.commit !== candidateCommit) {
      reasons.push(`stale-evidence:${platform}:commit`);
    }
    if (typeof r.tarballSha256 === "string" && SHA256.test(r.tarballSha256) && r.tarballSha256 !== tarballSha256) {
      reasons.push(`stale-evidence:${platform}:tarball`);
    }
    if (r.verdict === "fail") {
      reasons.push(`failed-evidence:${platform}`);
    }
    if (distTag === "latest" && r.verdict !== "pass") {
      reasons.push(`not-passed:${platform}:${String(r.verdict)}`);
    }
    if (distTag === "next" && r.verdict === "unverified") {
      if (platform !== "windows") {
        reasons.push(`unverified-not-allowed:${platform}`);
      } else if (!windowsDeclared) {
        reasons.push("unverified-undeclared:windows");
      } else {
        notes.push("windows evidence is UNVERIFIED; README and package description declare it");
      }
    }
    if (distTag === "next" && r.verdict === "fail") {
      // already reported as failed-evidence; nothing further
    }
  }

  return { action: reasons.length === 0 ? "allow" : "deny", reasons, notes };
}

/**
 * Reads `docs/evidence/platforms/<platform>.json` for every platform.
 * A missing file yields `null`; a malformed file yields the parse error
 * text so the gate can name it instead of crashing.
 *
 * @param {string} dir
 * @returns {Record<string, unknown>}
 */
export function loadRecords(dir) {
  /** @type {Record<string, unknown>} */
  const records = {};
  for (const platform of PLATFORMS) {
    const file = join(dir, `${platform}.json`);
    if (!existsSync(file)) {
      records[platform] = null;
      continue;
    }
    try {
      records[platform] = JSON.parse(readFileSync(file, "utf-8"));
    } catch (error) {
      records[platform] = { __parseError: String(error) };
    }
  }
  return records;
}

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      args[arg.slice(2)] = argv[i + 1] ?? "";
      i += 1;
    }
  }
  return args;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const distTag = args["dist-tag"] ?? "";
  const candidateCommit = args.commit ?? "";
  const tarball = args.tarball ?? "";
  const evidenceDir = args["evidence-dir"] ? resolve(args["evidence-dir"]) : join(root, "docs/evidence/platforms");
  const packageRoot = args.root ? resolve(args.root) : root;

  const problems = [];
  if (!existsSync(tarball)) problems.push(`tarball-not-found:${tarball}`);
  const tarballSha256 = problems.length === 0
    ? createHash("sha256").update(readFileSync(tarball)).digest("hex")
    : "";

  /** @type {{ description: string, readme: string }} */
  const declarations = { description: "", readme: "" };
  try {
    declarations.description = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")).description ?? "";
  } catch {
    problems.push("package-json-unreadable");
  }
  try {
    declarations.readme = readFileSync(join(packageRoot, "README.md"), "utf-8");
  } catch {
    problems.push("readme-unreadable");
  }

  const verdict = evaluateEvidenceGate({
    distTag,
    candidateCommit,
    tarballSha256,
    records: loadRecords(evidenceDir),
    declarations,
  });

  for (const problem of problems) console.error(`::error::${problem}`);
  for (const reason of verdict.reasons) console.error(`::error::evidence-gate: ${reason}`);
  for (const note of verdict.notes) console.log(`note: ${note}`);

  if (problems.length > 0 || verdict.action !== "allow") {
    process.exit(1);
  }
  console.log(`evidence gate (${distTag}): ${PLATFORMS.join(" + ")} records current for ${candidateCommit.slice(0, 12)} — ok`);
}
