/**
 * `ae-a8n agent --hidden`.
 *
 * The point of the flag is that the resident agent does not bring a console
 * window with it. That property lives in the spawn call, so these tests assert
 * the call: `windowsHide`, `detached`, and the log as both output streams.
 * They also check the failure paths, because a start that hides its own
 * errors would be worse than a window.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultAgentLogPath,
  detachAgent,
  type DetachChild,
  type DetachSpawnOptions,
} from "../src/platform/windows/agent-detach.js";

const ENTRY = "C:\\node_modules\\@ido-bata\\ae-a8n\\dist\\cli.js";

function baseArgs(): string[] {
  return ["--channel", "C:\\channel", "--key-file", "C:\\key.json", "--host", "UUU", "--user", "basic"];
}

type Recorded = {
  program: string;
  args: readonly string[];
  options: DetachSpawnOptions;
};

function harness(overrides: { readonly throwOnSpawn?: boolean } = {}): {
  readonly recorded: Recorded[];
  readonly out: string[];
  readonly err: string[];
  readonly deps: Parameters<typeof detachAgent>[1];
} {
  const recorded: Recorded[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    platform: "win32" as const,
    entry: ENTRY,
    defaultLogPath: () => "C:\\Users\\basic\\AppData\\Local\\ae-a8n\\logs\\agent.log",
    openLog: () => 7,
    closeLog: () => undefined,
    makeDirectory: () => undefined,
    writeOut: (text: string) => out.push(text),
    writeErr: (text: string) => err.push(text),
    spawn: (program: string, args: readonly string[], options: DetachSpawnOptions): DetachChild => {
      recorded.push({ program, args, options });
      if (overrides.throwOnSpawn === true) {
        throw new Error("EINVAL: spawn failed");
      }
      return { pid: 4242, unref: () => undefined, on: () => undefined };
    },
  };
  return { recorded, out, err, deps };
}

describe("agent --hidden", () => {
  it("creates the agent with no console window and the log as its output", () => {
    const { recorded, out, deps } = harness();
    expect(detachAgent(baseArgs(), deps)).toBe(0);

    expect(recorded).toHaveLength(1);
    const [call] = recorded;
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.detached).toBe(true);
    expect(call?.options.stdio).toEqual(["ignore", 7, 7]);
    expect(call?.program).toBe(process.execPath);
    expect(call?.args).toEqual([ENTRY, "agent", ...baseArgs()]);
    expect(out.join("")).toContain("pid 4242");
    expect(out.join("")).toContain("agent.log");
  });

  it("keeps --hidden and --log out of the child's arguments", () => {
    const { recorded, deps } = harness();
    expect(detachAgent([...baseArgs(), "--hidden", "--log", "D:\\logs\\a.log"], deps)).toBe(0);
    expect(recorded[0]?.args).toEqual([ENTRY, "agent", ...baseArgs()]);
  });

  it("uses --log as the destination instead of the default", () => {
    const { recorded, out, deps } = harness();
    expect(detachAgent(["--hidden", "--log", "D:\\logs\\a.log", ...baseArgs()], deps)).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(out.join("")).toContain("D:\\logs\\a.log");
  });

  it("refuses a start with a missing identity flag, and starts nothing", () => {
    const { recorded, err, deps } = harness();
    const argv = baseArgs().filter((token) => token !== "--host" && token !== "UUU");
    expect(detachAgent(argv, deps)).toBe(2);
    expect(recorded).toEqual([]);
    expect(err.join("")).toContain("--host is required");
    expect(err.join("")).toContain("nothing was started");
  });

  it("refuses an unknown option", () => {
    const { recorded, err, deps } = harness();
    expect(detachAgent([...baseArgs(), "--sneaky", "1"], deps)).toBe(2);
    expect(recorded).toEqual([]);
    expect(err.join("")).toContain("--sneaky");
  });

  it("refuses the flag on a platform where it means nothing", () => {
    const { recorded, err, deps } = harness();
    expect(detachAgent(baseArgs(), { ...deps, platform: "darwin" })).toBe(2);
    expect(recorded).toEqual([]);
    expect(err.join("")).toContain("Windows console window");
  });

  it("reports a spawn failure instead of exiting silently", () => {
    const { err, deps } = harness({ throwOnSpawn: true });
    expect(detachAgent(baseArgs(), deps)).toBe(1);
    expect(err.join("")).toContain("could not be started");
    expect(err.join("")).toContain("EINVAL");
  });

  it("reports a log that cannot be opened, and starts nothing", () => {
    const { recorded, err, deps } = harness();
    const code = detachAgent(baseArgs(), {
      ...deps,
      openLog: () => {
        throw new Error("EPERM: denied");
      },
    });
    expect(code).toBe(1);
    expect(recorded).toEqual([]);
    expect(err.join("")).toContain("could not be opened");
  });
});

describe("the default agent log", () => {
  it("lives under the account's own local app data", () => {
    const local = join("C:\\", "Users", "basic", "AppData", "Local");
    expect(defaultAgentLogPath({ LOCALAPPDATA: local })).toBe(join(local, "ae-a8n", "logs", "agent.log"));
  });
});
