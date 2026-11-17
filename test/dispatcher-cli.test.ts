/**
 * Contract tests for `ae-a8n dispatcher` (#147): envelope shape, exit
 * codes, and human rendering for prepare / status / startup install|remove.
 *
 * Everything here is fake/mock evidence: the heartbeat is hand-written and
 * Startup placement lands under a temporary home directory. Whether a real
 * After Effects executes a Startup entry remains unproven and the command
 * says so.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDispatcherCommand } from "../src/cli/dispatcher.js";
import { EXIT } from "../src/cli/exit-code.js";
import type { CliEnvelope } from "../src/cli/envelope.js";
import { dispatcherStartupDir } from "../src/driver/dispatcher-transport.js";

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Harness = {
  readonly out: () => string;
  readonly err: () => string;
  readonly deps: {
    writeOut: (text: string) => void;
    writeErr: (text: string) => void;
    homeDir: string;
    platform: NodeJS.Platform;
  };
};

function harness(homeDir: string): Harness {
  let out = "";
  let err = "";
  return {
    out: () => out,
    err: () => err,
    deps: {
      writeOut: (text) => {
        out += text;
      },
      writeErr: (text) => {
        err += text;
      },
      homeDir,
      platform: "darwin",
    },
  };
}

function envelope(text: string): CliEnvelope {
  return JSON.parse(text) as CliEnvelope;
}

function channelDir(): string {
  return tmpDir("a8n-disp-cli-channel-");
}

function writeHeartbeat(dir: string, lastTick: number): void {
  const meta = JSON.parse(readFileSync(join(dir, "channel.json"), "utf-8")) as {
    token: string;
  };
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      v: 1,
      token: meta.token,
      instance: "i1234abcd",
      aeVersion: "26.5",
      activatedAt: lastTick - 60_000,
      lastTick,
      pollMs: 250,
    }),
    "utf-8",
  );
}

describe("ae-a8n dispatcher prepare", () => {
  it("creates the channel, prints the human steps, and is idempotent", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const dir = channelDir();
    const h = harness(home);

    const first = await runDispatcherCommand(["prepare", "--channel-dir", dir, "--json"], h.deps);
    expect(first.exitCode).toBe(EXIT.ok);
    const doc = envelope(h.out());
    expect(doc.schemaVersion).toBe("1.0");
    expect(doc.command).toBe("dispatcher.prepare");
    expect(doc.status).toBe("ok");
    expect(doc.exitCode).toBe(EXIT.ok);
    expect(doc.nextActions.length).toBeGreaterThan(0);
    expect(doc.nextActions.every((a) => a.kind === "human")).toBe(true);
    expect(existsSync(join(dir, "activate.jsx"))).toBe(true);
    expect(existsSync(join(dir, "channel.json"))).toBe(true);

    // Second run keeps the token and still exits 0.
    const second = await runDispatcherCommand(["prepare", "--channel-dir", dir], h.deps);
    expect(second.exitCode).toBe(EXIT.ok);
    expect(h.out()).toContain("activate.jsx");
    expect(h.out()).toContain("Run Script File");
  });
});

describe("ae-a8n dispatcher status", () => {
  it("reports blocked — never a pass — when no dispatcher has answered", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const dir = channelDir();
    const h = harness(home);
    await runDispatcherCommand(["prepare", "--channel-dir", dir], h.deps);

    const before = h.out().length;
    const result = await runDispatcherCommand(["status", "--channel-dir", dir, "--json"], h.deps);
    expect(result.exitCode).toBe(EXIT.blocked);
    const doc = envelope(h.out().slice(before));
    expect(doc.status).toBe("blocked");
    expect(doc.exitCode).toBe(EXIT.blocked);
    const facts = doc.facts as { heartbeat: unknown };
    expect(facts.heartbeat).toBeNull();
    expect(doc.notice).toMatch(/unproven|not a pass/i);
  });

  it("reports a fresh heartbeat with instance, version, age and extensions", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const dir = channelDir();
    const h = harness(home);
    await runDispatcherCommand(["prepare", "--channel-dir", dir], h.deps);
    writeHeartbeat(dir, Date.now());

    const before = h.out().length;
    const result = await runDispatcherCommand(["status", "--channel-dir", dir, "--json"], h.deps);
    expect(result.exitCode).toBe(EXIT.ok);
    const doc = envelope(h.out().slice(before));
    expect(doc.status).toBe("ok");
    const facts = doc.facts as {
      instance: string;
      aeVersion: string;
      fresh: boolean;
      ageMs: number;
      extensionMethods: string[];
    };
    expect(facts.instance).toBe("i1234abcd");
    expect(facts.aeVersion).toBe("26.5");
    expect(facts.fresh).toBe(true);
    expect(facts.ageMs).toBeGreaterThanOrEqual(0);
    expect(facts.extensionMethods).toEqual([]);
  });

  it("reports a stale heartbeat as unknown, not ok", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const dir = channelDir();
    const h = harness(home);
    await runDispatcherCommand(["prepare", "--channel-dir", dir], h.deps);
    writeHeartbeat(dir, Date.now() - 60_000);

    const before = h.out().length;
    const result = await runDispatcherCommand(["status", "--channel-dir", dir], h.deps);
    expect(result.exitCode).toBe(EXIT.unknown);
    expect(h.out().slice(before)).toContain("unknown");
  });
});

describe("ae-a8n dispatcher startup", () => {
  it("installs the Startup entry under the computed per-user dir and removes it", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const dir = channelDir();
    const h = harness(home);
    await runDispatcherCommand(["prepare", "--channel-dir", dir], h.deps);

    const outLen = h.out().length;
    const install = await runDispatcherCommand(
      ["startup", "install", "--channel-dir", dir, "--ae-version", "26.5", "--json"],
      h.deps,
    );
    expect(install.exitCode).toBe(EXIT.ok);
    const doc = envelope(h.out().slice(outLen));
    const expectedDir = dispatcherStartupDir({
      aeVersion: "26.5",
      platform: "darwin",
      homeDir: home,
    });
    const installed = join(expectedDir, "a8n-dispatcher.jsx");
    expect((doc.facts as { installed: string }).installed).toBe(installed);
    expect(existsSync(installed)).toBe(true);
    // The command must not claim Startup execution is proven.
    expect(doc.notice).toMatch(/unproven|unverified/i);

    const removeOutLen = h.out().length;
    const remove = await runDispatcherCommand(
      ["startup", "remove", "--channel-dir", dir, "--ae-version", "26.5", "--json"],
      h.deps,
    );
    expect(remove.exitCode).toBe(EXIT.ok);
    const removed = envelope(h.out().slice(removeOutLen));
    expect((removed.facts as { removed: string }).removed).toBe(installed);
    expect(existsSync(installed)).toBe(false);
  });

  it("refuses to remove a file that is not recognisably ours", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const dir = channelDir();
    const h = harness(home);
    await runDispatcherCommand(["prepare", "--channel-dir", dir], h.deps);
    const expectedDir = dispatcherStartupDir({
      aeVersion: "26.5",
      platform: "darwin",
      homeDir: home,
    });
    mkdirSync(expectedDir, { recursive: true });
    const foreign = join(expectedDir, "a8n-dispatcher.jsx");
    writeFileSync(foreign, "// someone else's script\n", "utf-8");

    const result = await runDispatcherCommand(
      ["startup", "remove", "--channel-dir", dir, "--ae-version", "26.5", "--json"],
      h.deps,
    );
    expect(result.exitCode).toBe(EXIT.refused);
    expect(existsSync(foreign)).toBe(true);
  });

  it("requires --ae-version or --install-dir and rejects both together", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const dir = channelDir();
    const h = harness(home);

    const missing = await runDispatcherCommand(
      ["startup", "install", "--channel-dir", dir],
      h.deps,
    );
    expect(missing.exitCode).toBe(EXIT.usage);
    expect(h.err()).toContain("--ae-version");

    const both = await runDispatcherCommand(
      [
        "startup",
        "install",
        "--channel-dir",
        dir,
        "--ae-version",
        "26.5",
        "--install-dir",
        "/Applications/After Effects",
      ],
      h.deps,
    );
    expect(both.exitCode).toBe(EXIT.usage);
  });
});

describe("ae-a8n dispatcher usage errors", () => {
  it("exits 2 on an unknown subcommand or flag", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const h = harness(home);
    const bad = await runDispatcherCommand(["bogus"], h.deps);
    expect(bad.exitCode).toBe(EXIT.usage);
    const badFlag = await runDispatcherCommand(["prepare", "--bogus"], h.deps);
    expect(badFlag.exitCode).toBe(EXIT.usage);
  });

  it("prints help without touching the channel", async () => {
    const home = tmpDir("a8n-disp-cli-home-");
    const h = harness(home);
    const result = await runDispatcherCommand(["--help"], h.deps);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(h.out()).toContain("dispatcher");
    expect(h.out()).toContain("Run Script File");
  });
});
