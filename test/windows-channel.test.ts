/**
 * The directory channel: how much it reads, and how it publishes.
 *
 * The read limit is enforced while reading, not after: `readFile` buffers a
 * whole file before any check can run, so a writer that grows the file between
 * the size check and the read could force an allocation past the cap. These
 * tests pin the limit from the outside; the bounded loop is what makes it hold
 * against a racing writer.
 *
 * `writeAtomic` renames over the destination. Deleting the destination first
 * would leave the path absent between two calls — a reader can see that — so
 * the delete is only the last resort after a refused rename is retried.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChannelFileTooLargeError,
  DirectoryChannel,
  replaceByRename,
  UnsupportedChannelPathError,
} from "../src/platform/windows/channel.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a8n-channel-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function text(bytes: Uint8Array | null): string {
  return new TextDecoder().decode(bytes ?? new Uint8Array());
}

describe("reading a channel file", () => {
  it("returns the file's bytes, and null when it does not exist", async () => {
    const directory = await root();
    await writeFile(join(directory, "a.txt"), "hello");
    const files = new DirectoryChannel(directory);
    expect(text(await files.read("a.txt"))).toBe("hello");
    expect(await files.read("missing.txt")).toBeNull();
  });

  it("reads empty files as empty, not as absent", async () => {
    const directory = await root();
    await writeFile(join(directory, "empty.txt"), "");
    const files = new DirectoryChannel(directory);
    expect((await files.read("empty.txt"))?.length).toBe(0);
  });

  it("accepts a file exactly at the read limit", async () => {
    const directory = await root();
    await writeFile(join(directory, "exact.txt"), "abcd");
    const files = new DirectoryChannel(directory, { maxReadBytes: 4 });
    expect(text(await files.read("exact.txt"))).toBe("abcd");
  });

  it("refuses a file one byte past the limit, naming its size", async () => {
    const directory = await root();
    await writeFile(join(directory, "large.txt"), "abcde");
    const files = new DirectoryChannel(directory, { maxReadBytes: 4 });
    await expect(files.read("large.txt")).rejects.toBeInstanceOf(ChannelFileTooLargeError);
    await expect(files.read("large.txt")).rejects.toThrow("is 5 bytes, beyond the 4-byte read limit");
  });

  it("refuses a file that is already far past the limit without reading it", async () => {
    const directory = await root();
    await writeFile(join(directory, "huge.txt"), "x".repeat(256 * 1024));
    const files = new DirectoryChannel(directory, { maxReadBytes: 1024 });
    await expect(files.read("huge.txt")).rejects.toThrow("beyond the 1024-byte read limit");
  });

  it("refuses a path that leaves the channel root", async () => {
    const files = new DirectoryChannel(await root());
    await expect(files.read("../escape.txt")).rejects.toBeInstanceOf(UnsupportedChannelPathError);
  });
});

describe("publishing a channel file", () => {
  it("replaces the file and leaves no temporary behind", async () => {
    const directory = await root();
    const files = new DirectoryChannel(directory);
    await files.writeAtomic("nested/a.txt", new TextEncoder().encode("one"));
    await files.writeAtomic("nested/a.txt", new TextEncoder().encode("two"));
    expect(text(await files.read("nested/a.txt"))).toBe("two");
    expect(await readdir(join(directory, "nested"))).toEqual(["a.txt"]);
  });
});

describe("replaceByRename", () => {
  it("renames without deleting the destination", async () => {
    const calls: string[] = [];
    await replaceByRename("tmp", "target", {
      rename: (from, to) => {
        calls.push(`rename ${from} ${to}`);
        return Promise.resolve();
      },
      unlink: (path) => {
        calls.push(`unlink ${path}`);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual(["rename tmp target"]);
  });

  it("retries a transient sharing violation instead of deleting the destination", async () => {
    // The destination is usually open only for a moment. Deleting it in that
    // window is what makes a reader see "absent".
    const calls: string[] = [];
    let renames = 0;
    await replaceByRename("tmp", "target", {
      rename: () => {
        renames += 1;
        calls.push(`rename ${String(renames)}`);
        if (renames < 3) {
          return Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" }));
        }
        return Promise.resolve();
      },
      unlink: (path) => {
        calls.push(`unlink ${path}`);
        return Promise.resolve();
      },
      delay: () => Promise.resolve(),
    });
    expect(calls).toEqual(["rename 1", "rename 2", "rename 3"]);
  });

  it("deletes the destination only after the retries are used up, then renames", async () => {
    const calls: string[] = [];
    await replaceByRename("tmp", "target", {
      rename: (from) => {
        calls.push(`rename ${from}`);
        if (calls.filter((call) => call.startsWith("rename")).length <= 2) {
          return Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" }));
        }
        return Promise.resolve();
      },
      unlink: (path) => {
        calls.push(`unlink ${path}`);
        return Promise.resolve();
      },
      delay: () => Promise.resolve(),
      attempts: 2,
    });
    expect(calls).toEqual(["rename tmp", "rename tmp", "unlink target", "rename tmp"]);
  });

  it("does not retry or delete on an error that is not a sharing violation", async () => {
    const calls: string[] = [];
    await expect(
      replaceByRename("tmp", "target", {
        rename: (from) => {
          calls.push(`rename ${from}`);
          return Promise.reject(Object.assign(new Error("EXDEV"), { code: "EXDEV" }));
        },
        unlink: (path) => {
          calls.push(`unlink ${path}`);
          return Promise.resolve();
        },
        delay: () => Promise.resolve(),
      }),
    ).rejects.toThrow("EXDEV");
    expect(calls).toEqual(["rename tmp"]);
  });

  it("tolerates the destination disappearing before it is deleted", async () => {
    const calls: string[] = [];
    await replaceByRename("tmp", "target", {
      rename: (from) => {
        calls.push(`rename ${from}`);
        if (calls.filter((call) => call.startsWith("rename")).length === 1) {
          return Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" }));
        }
        return Promise.resolve();
      },
      unlink: () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      delay: () => Promise.resolve(),
      attempts: 1,
    });
    expect(calls).toEqual(["rename tmp", "rename tmp"]);
  });
});
