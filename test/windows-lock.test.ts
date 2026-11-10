import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectoryChannel } from "../src/platform/windows/channel.js";
import {
  DEFAULT_STALE_AFTER_MS,
  acquireRunLock,
  decodeRunLock,
  encodeRunLock,
  lockPath,
  releaseRunLock,
} from "../src/platform/windows/lock.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const RUN_ID = "20261110T120000Z-abcdef01";
const OWNER = { host: "WIN-AE-01", user: "a8n" };

const roots: string[] = [];

async function channel(): Promise<DirectoryChannel> {
  const root = await mkdtemp(join(tmpdir(), "a8n-lock-"));
  roots.push(root);
  return new DirectoryChannel(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function text(bytes: Uint8Array | null): string {
  return new TextDecoder().decode(bytes ?? new Uint8Array());
}

describe("the run lock", () => {
  it("is acquired once and busy for a second acquisition", async () => {
    const files = await channel();
    const first = await acquireRunLock(files, {
      runId: RUN_ID,
      owner: OWNER,
      now: () => NOW,
    });
    expect(first.state).toBe("acquired");

    const second = await acquireRunLock(files, {
      runId: RUN_ID,
      owner: { host: "OTHER", user: "someone" },
      now: () => NOW,
    });
    expect(second).toMatchObject({ state: "busy", lock: { runId: RUN_ID, owner: OWNER } });
    expect((await files.read(lockPath(RUN_ID))) !== null).toBe(true);
  });

  it("reports an old lock as stale and never overwrites it", async () => {
    const files = await channel();
    await acquireRunLock(files, { runId: RUN_ID, owner: OWNER, now: () => NOW });
    const before = text(await files.read(lockPath(RUN_ID)));

    const later = new Date(NOW.getTime() + DEFAULT_STALE_AFTER_MS + 1);
    const outcome = await acquireRunLock(files, {
      runId: RUN_ID,
      owner: { host: "OTHER", user: "someone" },
      now: () => later,
    });
    expect(outcome).toMatchObject({ state: "stale", lock: { owner: OWNER } });
    expect(text(await files.read(lockPath(RUN_ID)))).toBe(before);
  });

  it("honours an explicit stale threshold", async () => {
    const files = await channel();
    await acquireRunLock(files, { runId: RUN_ID, owner: OWNER, now: () => NOW });
    const slightlyLater = new Date(NOW.getTime() + 1001);
    expect(
      await acquireRunLock(files, {
        runId: RUN_ID,
        owner: OWNER,
        now: () => slightlyLater,
        staleAfterMs: 1000,
      }),
    ).toMatchObject({ state: "stale" });
  });

  it("treats a malformed lock as stale and leaves the bytes alone", async () => {
    const files = await channel();
    await files.writeAtomic(lockPath(RUN_ID), new TextEncoder().encode("{not json"));

    const outcome = await acquireRunLock(files, {
      runId: RUN_ID,
      owner: OWNER,
      now: () => NOW,
    });
    expect(outcome).toEqual({ state: "stale", lock: null });
    expect(text(await files.read(lockPath(RUN_ID)))).toBe("{not json");
  });

  it("treats a lock for another run id as malformed", async () => {
    const files = await channel();
    const other = "20261110T110000Z-00000000";
    const bytes = encodeRunLock({
      schemaVersion: "1.0",
      runId: other,
      owner: OWNER,
      acquiredAt: NOW.toISOString(),
    });
    await files.writeAtomic(lockPath(RUN_ID), bytes);
    const outcome = await acquireRunLock(files, {
      runId: RUN_ID,
      owner: OWNER,
      now: () => NOW,
    });
    // The filename is ours, so a well-formed lock naming another run is not
    // this run's lock; it is stale and, importantly, still untouched.
    expect(outcome).toEqual({ state: "stale", lock: null });
    expect(text(await files.read(lockPath(RUN_ID)))).toBe(text(bytes));
  });

  it("releases only for the same owner", async () => {
    const files = await channel();
    await acquireRunLock(files, { runId: RUN_ID, owner: OWNER, now: () => NOW });

    expect(
      await releaseRunLock(files, RUN_ID, { host: OWNER.host, user: "someone-else" }),
    ).toBe(false);
    expect(await files.read(lockPath(RUN_ID))).not.toBeNull();

    expect(await releaseRunLock(files, RUN_ID, OWNER)).toBe(true);
    expect(await files.read(lockPath(RUN_ID))).toBeNull();
  });

  it("decodes only a complete lock document", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "1.0",
        runId: RUN_ID,
        owner: OWNER,
        acquiredAt: NOW.toISOString(),
      }),
    );
    expect(decodeRunLock(bytes)).toMatchObject({ runId: RUN_ID, owner: OWNER });
    expect(decodeRunLock(new TextEncoder().encode("{}"))).toBeNull();
    expect(
      decodeRunLock(
        new TextEncoder().encode(
          JSON.stringify({ schemaVersion: "1.0", runId: RUN_ID, owner: OWNER, acquiredAt: "soon" }),
        ),
      ),
    ).toBeNull();
  });

  it("refuses a run id that is not one path component", async () => {
    const files = await channel();
    await expect(
      acquireRunLock(files, { runId: "../escape", owner: OWNER }),
    ).rejects.toThrow("path component");
  });
});
