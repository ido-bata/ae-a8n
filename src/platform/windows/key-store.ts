/**
 * Reading a provisioned channel key from disk.
 *
 * The key's confidentiality is the trust anchor for the whole Windows job
 * boundary: a process that can read it can forge jobs. This module therefore
 * refuses the shapes it can prove are unsafe: a symlink, a non-regular file,
 * group/other read access on POSIX, and an ACL that names accounts other than
 * the owner on Windows. The Windows check is `icacls` — the OS's own account
 * of the ACL — not a promise deferred to real-host verification.
 */

import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { promisify } from "node:util";

import {
  keyFileAclVerdict,
  ownerQualifiers,
  parseIcacls,
  type AccessControlEntry,
} from "./acl.js";

import {
  MAX_KEY_FILE_BYTES,
  decodeKeyFile,
  isValidKey,
  type JobKey,
} from "./auth.js";

const run = promisify(execFile);

/** Reads a path's access-control entries, or null when they cannot be read. */
export type AclReader = (path: string) => Promise<readonly AccessControlEntry[] | null>;

/**
 * The OS's own ACL for a path. `icacls` needs no elevation to read an ACL, and
 * on a machine that does not have it the check fails closed: null, refused.
 */
async function readAclWithIcacls(path: string): Promise<readonly AccessControlEntry[] | null> {
  try {
    const { stdout } = await run("icacls", [path], { windowsHide: true });
    return parseIcacls(stdout, path);
  } catch {
    return null;
  }
}

export type KeyFileOptions = {
  /** Injected in tests. Defaults to `icacls` on Windows, unused elsewhere. */
  readonly acl?: AclReader;
  /** The account the key must belong to. Defaults to this process's user. */
  readonly owner?: string | null;
};

function currentUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

export type KeyFileRefusal = {
  readonly ok: false;
  readonly detail: string;
  /** The diagnostic to report it under; permission refusals say so. */
  readonly code: "A8N-JOB-003" | "A8N-PERM-005";
};

export type KeyFileLoad = { readonly ok: true; readonly key: JobKey } | KeyFileRefusal;

/**
 * True when `after` still describes the file `before` described.
 *
 * The checks above inspect the path at earlier moments than the read. These
 * stats are how the read is bound to the file that was checked: a different
 * inode, a different size or modification time, a link, or no longer a regular
 * file means the bytes are not the ones that were proven safe.
 */
export function unchangedSince(before: Stats, after: Stats): boolean {
  return (
    !after.isSymbolicLink() &&
    after.isFile() &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs
  );
}

export async function loadKeyFile(
  path: string,
  options: KeyFileOptions = {},
): Promise<KeyFileLoad> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    return { ok: false, code: "A8N-JOB-003", detail: `the key file ${path} could not be read (${code})` };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, code: "A8N-JOB-003", detail: `the key file ${path} is a symlink; a link is not a key` };
  }
  if (!info.isFile()) {
    return { ok: false, code: "A8N-JOB-003", detail: `the key file ${path} is not a regular file` };
  }
  if (info.size > MAX_KEY_FILE_BYTES) {
    return {
      ok: false,
      code: "A8N-JOB-003",
      detail: `the key file ${path} is ${info.size} bytes, beyond the ${MAX_KEY_FILE_BYTES}-byte limit`,
    };
  }
  if (process.platform === "win32") {
    const readAcl = options.acl ?? readAclWithIcacls;
    const entries = await readAcl(path);
    if (entries === null) {
      // No ACL read means no proof, and an unproven key is not accepted.
      return {
        ok: false,
        code: "A8N-PERM-005",
        detail:
          `the key file ${path} has no readable access control list; ` +
          "run icacls on it to see why",
      };
    }
    const verdict = keyFileAclVerdict(
      entries,
      options.owner ?? currentUser(),
      ownerQualifiers(),
    );
    if (!verdict.ok) {
      return { ok: false, code: "A8N-PERM-005", detail: `the key file ${path} ${verdict.detail}` };
    }
  }
  // A readable-by-others key is refused on the platforms that model mode bits.
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    return {
      ok: false,
      code: "A8N-PERM-005",
      detail:
        `the key file ${path} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); ` +
        "a shared secret must be readable only by its owner",
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    // The path passed lstat and the ACL check, but reading it can still fail
    // (it was replaced, permissions changed, the share dropped). That is a
    // structured refusal like every other failure here, not a raw exception.
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    return { ok: false, code: "A8N-JOB-003", detail: `the key file ${path} could not be read (${code})` };
  }
  // The path was checked before the read. Confirm it still names the file that
  // was checked: a replacement between the checks and the read would otherwise
  // make the accepted bytes something no check ever saw.
  let after: Stats;
  try {
    after = await lstat(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    return { ok: false, code: "A8N-JOB-003", detail: `the key file ${path} could not be read (${code})` };
  }
  if (!unchangedSince(info, after)) {
    return {
      ok: false,
      code: "A8N-JOB-003",
      detail: `the key file ${path} changed while it was being checked`,
    };
  }
  const decoded = decodeKeyFile(bytes);
  if (!decoded.ok) {
    return { ok: false, code: "A8N-JOB-003", detail: `the key file ${path} is invalid: ${decoded.detail}` };
  }
  if (!isValidKey(decoded.value)) {
    return { ok: false, code: "A8N-JOB-003", detail: `the key file ${path} does not contain a usable key` };
  }
  return { ok: true, key: decoded.value };
}
