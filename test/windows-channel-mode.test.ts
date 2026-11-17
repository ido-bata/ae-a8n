import { describe, expect, it } from "vitest";

import { channelModeVerdict, type ChannelModeStats } from "../src/platform/windows/channel-mode.js";

function stats(mode: number, directory = true): ChannelModeStats {
  return { isDirectory: () => directory, mode };
}

describe("channelModeVerdict", () => {
  it("accepts a directory only its owner can write", () => {
    expect(channelModeVerdict(stats(0o40700))).toEqual({ ok: true });
    expect(channelModeVerdict(stats(0o40600))).toEqual({ ok: true });
    // Read/execute for group and others is fine; only write is refused.
    expect(channelModeVerdict(stats(0o40755))).toEqual({ ok: true });
  });

  it("refuses group or other write, naming the mode", () => {
    for (const mode of [0o40777, 0o40020, 0o40002, 0o40666, 0o41777]) {
      const verdict = channelModeVerdict(stats(mode));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.detail).toContain("writable by group or others");
      }
    }
  });

  it("does not exempt the sticky bit: 1777 still lets anyone create entries", () => {
    const verdict = channelModeVerdict(stats(0o41777));
    expect(verdict.ok).toBe(false);
  });

  it("ignores file-type and special bits outside the permission mask", () => {
    // setuid/setgid/sticky above the low 12 bits must not change the verdict.
    expect(channelModeVerdict(stats(0o14700))).toEqual({ ok: true });
    expect(channelModeVerdict(stats(0o100700, false))).toEqual({
      ok: false,
      detail: "the channel root is not a directory",
    });
  });

  it("refuses a path that is not a directory", () => {
    const verdict = channelModeVerdict(stats(0o100644, false));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.detail).toContain("not a directory");
    }
  });
});
