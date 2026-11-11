/**
 * The file channel between the controller and the Windows agent.
 *
 * The interface is the whole transport contract: a mounted share and an
 * SSH/SFTP implementation differ only in this file. Paths are relative to a
 * root the caller configured, never absolute, and a caller cannot escape it.
 *
 * Publication is atomic — write a temporary file, then rename — so a reader
 * never sees half a job or half a result.
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export interface FileChannel {
  /** The file bytes, or null when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Replace the file so that a reader sees either the old or the new bytes. */
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  /** Create the file only if it does not exist; false when it already did. */
  createExclusive(path: string, bytes: Uint8Array): Promise<boolean>;
  /**
   * Create a directory, and its parents.
   *
   * Existence is not only a protocol question. A client caches the answer "no
   * such directory" and keeps giving it after the directory appears; the
   * controller on a mounted share was blind to a result for a minute because
   * of exactly that. Making the directory before anyone polls it is the cure.
   */
  ensureDirectory(path: string): Promise<void>;
  /** Names in a directory; empty when it does not exist. */
  list(directory: string): Promise<readonly string[]>;
  /** Subdirectory names; empty when the directory does not exist. */
  listDirectories(directory: string): Promise<readonly string[]>;
  /** True only when the path is a readable directory. */
  isDirectory(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export class UnsupportedChannelPathError extends Error {
  constructor(path: string) {
    super(`channel path "${path}" must stay inside the channel root`);
    this.name = "UnsupportedChannelPathError";
  }
}

/** A file the channel refuses to read into memory. */
export class ChannelFileTooLargeError extends Error {
  readonly path: string;
  readonly size: number;

  constructor(path: string, size: number, limit: number) {
    super(`channel file "${path}" is ${size} bytes, beyond the ${limit}-byte read limit`);
    this.name = "ChannelFileTooLargeError";
    this.path = path;
    this.size = size;
  }
}

/** Backstop for every read; job/result/payload have their own tighter limits. */
export const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;

export type DirectoryChannelOptions = {
  readonly maxReadBytes?: number;
};

/** A channel over a directory: a mounted share, or the same directory in a test. */
export class DirectoryChannel implements FileChannel {
  readonly #root: string;
  readonly #maxReadBytes: number;

  constructor(root: string, options: DirectoryChannelOptions = {}) {
    this.#root = root;
    this.#maxReadBytes =
      options.maxReadBytes !== undefined && options.maxReadBytes > 0
        ? options.maxReadBytes
        : DEFAULT_MAX_READ_BYTES;
  }

  #resolve(path: string): string {
    const normalized = normalize(path);
    if (
      normalized === "" ||
      isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith(`..${sep}`)
    ) {
      throw new UnsupportedChannelPathError(path);
    }
    return join(this.#root, normalized);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const target = this.#resolve(path);
    let handle: FileHandle | undefined;
    try {
      handle = await open(target, "r");
      // Refuse a file that is already too large before reading any of it.
      const before = await handle.stat();
      if (before.size > this.#maxReadBytes) {
        throw new ChannelFileTooLargeError(path, before.size, this.#maxReadBytes);
      }
      // Read through the handle with a hard bound. `readFile` buffers the
      // whole file before any post-check can run, so a writer that grows the
      // file after this stat — the untrusted writer this cap exists for —
      // could force an allocation far past it. Reading at most
      // maxReadBytes + 1 bytes refuses a growing file at the cap instead.
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, this.#maxReadBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) {
          break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
        if (total > this.#maxReadBytes) {
          throw new ChannelFileTooLargeError(path, total, this.#maxReadBytes);
        }
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const target = this.#resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, bytes);
    try {
      await replaceByRename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(ignoreMissing);
      throw error;
    }
  }

  async createExclusive(path: string, bytes: Uint8Array): Promise<boolean> {
    const target = this.#resolve(path);
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(target, bytes, { flag: "wx" });
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(this.#resolve(path), { recursive: true });
  }

  async list(directory: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.#resolve(directory), { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
  }

  async listDirectories(directory: string): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.#resolve(directory), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(this.#resolve(path))).isDirectory();
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    await unlink(this.#resolve(path)).catch(ignoreMissing);
  }
}

/** One read buffer; a bounded read never holds more than this at a time. */
const READ_CHUNK_BYTES = 64 * 1024;
/** How often a refused rename is retried before the destination is deleted. */
const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 50;

export type ReplaceOptions = {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly unlink?: (path: string) => Promise<void>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly attempts?: number;
  readonly retryMs?: number;
};

/**
 * Publish a finished temporary file at `target`.
 *
 * Windows normally replaces an existing destination, so a refused rename is a
 * transient sharing violation: the destination is open. Retrying keeps the
 * path present the whole time. Deleting the destination first makes the path
 * absent between two calls — a reader of a heartbeat can see "no file", and a
 * crash in that window loses it — so it is the last resort, after the retries.
 */
export async function replaceByRename(
  temporary: string,
  target: string,
  options: ReplaceOptions = {},
): Promise<void> {
  const renameFile = options.rename ?? rename;
  const unlinkFile = options.unlink ?? unlink;
  const wait =
    options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A non-positive or non-finite count would make the loop unable to end.
  const configured = options.attempts ?? RENAME_ATTEMPTS;
  const attempts = Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : RENAME_ATTEMPTS;
  const retryMs = options.retryMs ?? RENAME_RETRY_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(temporary, target);
      return;
    } catch (error) {
      if (!isRenameRefused(error)) {
        throw error;
      }
      if (attempt >= attempts) {
        break;
      }
      await wait(retryMs);
    }
  }
  await unlinkFile(target).catch(ignoreMissing);
  await renameFile(temporary, target);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function isRenameRefused(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "EPERM";
}

function ignoreMissing(error: unknown): void {
  if (!isMissing(error)) {
    throw error;
  }
}
