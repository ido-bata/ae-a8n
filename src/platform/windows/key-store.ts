/**
 * Reading a provisioned channel key from disk.
 *
 * The key's confidentiality is the trust anchor for the whole Windows job
 * boundary: a process that can read it can forge jobs. This module therefore
 * refuses the shapes it can prove are unsafe — a symlink, a non-regular file,
 * group/other read access — and leaves the shapes it cannot prove (Windows
 * ACLs) to the real-host verification in T092 rather than claiming them.
 */

import { lstat, readFile } from "node:fs/promises";

import {
  MAX_KEY_FILE_BYTES,
  decodeKeyFile,
  isValidKey,
  type JobKey,
} from "./auth.js";

export type KeyFileLoad =
  | { readonly ok: true; readonly key: JobKey }
  | { readonly ok: false; readonly detail: string };

export async function loadKeyFile(path: string): Promise<KeyFileLoad> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    return { ok: false, detail: `the key file ${path} could not be read (${code})` };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, detail: `the key file ${path} is a symlink; a link is not a key` };
  }
  if (!info.isFile()) {
    return { ok: false, detail: `the key file ${path} is not a regular file` };
  }
  if (info.size > MAX_KEY_FILE_BYTES) {
    return {
      ok: false,
      detail: `the key file ${path} is ${info.size} bytes, beyond the ${MAX_KEY_FILE_BYTES}-byte limit`,
    };
  }
  // Windows does not model POSIX mode bits; ACLs are checked by the real-host
  // verification instead. Elsewhere a readable-by-others key is refused.
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    return {
      ok: false,
      detail:
        `the key file ${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); ` +
        "a shared secret must be readable only by its owner",
    };
  }
  const decoded = decodeKeyFile(new Uint8Array(await readFile(path)));
  if (!decoded.ok) {
    return { ok: false, detail: `the key file ${path} is invalid: ${decoded.detail}` };
  }
  if (!isValidKey(decoded.value)) {
    return { ok: false, detail: `the key file ${path} does not contain a usable key` };
  }
  return { ok: true, key: decoded.value };
}
