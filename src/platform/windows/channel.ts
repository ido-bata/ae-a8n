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
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

export interface FileChannel {
  /** The file bytes, or null when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Replace the file so that a reader sees either the old or the new bytes. */
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  /** Create the file only if it does not exist; false when it already did. */
  createExclusive(path: string, bytes: Uint8Array): Promise<boolean>;
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

/** A channel over a directory: a mounted share, or the same directory in a test. */
export class DirectoryChannel implements FileChannel {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
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
    try {
      return new Uint8Array(await readFile(this.#resolve(path)));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const target = this.#resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, bytes);
    try {
      await rename(temporary, target);
    } catch (error) {
      // Windows refuses to rename onto an existing file.
      if (!isRenameRefused(error)) {
        throw error;
      }
      await unlink(target).catch(ignoreMissing);
      await rename(temporary, target);
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
