/**
 * Read-only experiment for Issue #98. NOT the public AE bridge or a production
 * dispatcher. Activation is deliberate: user runs bridge-start.jsx inside AE.
 *
 * Usage:
 *   node scripts/inprocess-proof.mjs prepare <absolute-private-channel>
 *   node scripts/inprocess-proof.mjs ping <same-channel> [timeout-ms]
 */
import { randomBytes } from "node:crypto";
import {
  copyFile, lstat, mkdir, open, readFile, rename, writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, "..");
const maxTimeout = 30_000;

function stringLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function checkChannel(folder) {
  if (!isAbsolute(folder)) {
    throw new Error("channel must be an absolute path");
  }
  const root = resolve(folder);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("channel must be a real private directory, not a symlink");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("channel is accessible to group/other; use chmod 700");
  }
  return root;
}

export async function prepare(folder) {
  if (!isAbsolute(folder)) {
    throw new Error("channel must be an absolute path");
  }
  const root = resolve(folder);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkChannel(root);
  // Refuse re-preparation before touching an active channel's subdirectories.
  const metadataPath = join(root, "proof.json");
  try {
    await lstat(metadataPath);
    throw new Error("channel already prepared; do not replace an active AE bridge");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of ["inbox", "outbox"]) {
    await mkdir(join(root, name), { mode: 0o700 });
  }

  // This capability is intentionally only an unpredictable channel token,
  // NOT strong authentication against a malicious process of the same OS user.
  const token = randomBytes(32).toString("hex");
  const template = await readFile(join(here, "inprocess-proof-host.jsx"), "utf8");
  const source = template
    .replace("__A8N_PROOF_ROOT__", stringLiteral(root.replace(/\\/g, "/")))
    .replace("__A8N_PROOF_TOKEN__", stringLiteral(token));

  await copyFile(join(sourceRoot, "host", "a8n-json.js"), join(root, "a8n-json.js"));
  await writeFile(join(root, "bridge-start.jsx"), source, { mode: 0o600, flag: "wx" });
  await writeFile(metadataPath, JSON.stringify({ version: 1, token }) + "\n", {
    mode: 0o600, flag: "wx",
  });
  return join(root, "bridge-start.jsx");
}

async function atomicRequest(filePath, content) {
  const part = filePath + ".part";
  const handle = await open(part, "wx", 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  await rename(part, filePath);
}

export async function ping(folder, timeout = 8_000) {
  const root = await checkChannel(folder);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > maxTimeout) {
    throw new Error("timeout must be 100..30000 ms");
  }
  const config = JSON.parse(await readFile(join(root, "proof.json"), "utf8"));
  if (config.version !== 1 || typeof config.token !== "string" || !/^[a-f0-9]{64}$/.test(config.token)) {
    throw new Error("invalid channel metadata");
  }
  const id = randomBytes(16).toString("hex");
  const end = Date.now() + timeout;
  const request = { v: 1, id, token: config.token, method: "app.version", deadlineMs: end };
  await atomicRequest(join(root, "inbox", id + ".request.json"), JSON.stringify(request));
  const responsePath = join(root, "outbox", id + ".result.json");

  while (Date.now() < end) {
    let text;
    try {
      text = await readFile(responsePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await sleep(100);
      continue;
    }
    let response;
    try {
      response = JSON.parse(text);
    } catch {
      throw new Error("invalid response: quarantine the channel; do not retry");
    }
    if (response.v !== 1 || response.id !== id || response.token !== config.token) {
      throw new Error("response identity mismatch: quarantine the channel; do not retry");
    }
    if (response.ok !== true || typeof response.aeVersion !== "string") {
      throw new Error("host refused request: " + String(response.message ?? "unknown"));
    }
    return { aeVersion: response.aeVersion, requestId: id };
  }
  // The host may still execute a claimed request after the caller exits.
  // It is UNKNOWN, not safe to retry; never remove or recreate the request.
  throw new Error("UNKNOWN: AE did not answer before deadline; do not retry this request");
}

async function main(argv) {
  const action = argv[2];
  const folder = argv[3];
  if (folder === undefined || !["prepare", "ping"].includes(action)) {
    throw new Error("usage: inprocess-proof.mjs <prepare|ping> <absolute-channel> [timeout-ms]");
  }
  if (action === "prepare") {
    const path = await prepare(folder);
    console.log("In After Effects choose File > Scripts > Run Script File and select:\n" + path);
    console.log("Then run: node scripts/inprocess-proof.mjs ping " + JSON.stringify(folder));
    return;
  }
  const timeout = argv[4] === undefined ? 8_000 : Number(argv[4]);
  console.log(JSON.stringify(await ping(folder, timeout)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  });
}
