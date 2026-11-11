/**
 * The `ae-a8n agent` argument check.
 *
 * This check used to read every token as a flag, so the documented command —
 * which passes a channel root, a key file, a host and a user — was refused
 * with "unknown option C:\...\channel" before the agent started. The values
 * are not flags and must not be inspected.
 */

import { describe, expect, it, vi } from "vitest";

import { agentFlagPresent, runAgentCommand, unknownAgentOption } from "../src/cli/agent.js";

const DOCUMENTED = [
  "--channel",
  "C:\\Users\\basic\\channel",
  "--key-file",
  "C:\\Users\\basic\\agent.key",
  "--host",
  "UUU",
  "--user",
  "basic",
];

describe("the agent command's argument check", () => {
  it("accepts the documented command, whose values are paths and names", () => {
    expect(unknownAgentOption(DOCUMENTED)).toBeNull();
  });

  it("accepts the documented command with --hidden and --log", () => {
    expect(
      unknownAgentOption(["--hidden", "--log", "D:\\logs\\a.log", ...DOCUMENTED]),
    ).toBeNull();
  });

  it("names the first real unknown option rather than a value", () => {
    expect(unknownAgentOption(["--channel", "C:\\ch", "--sneaky", "1"])).toBe("--sneaky");
  });

  it("does not accept --flag=value, which the agent itself cannot parse", () => {
    expect(unknownAgentOption(["--channel=C:\\ch"])).toBe("--channel=C:\\ch");
  });
});

describe("the agent command's process mode", () => {
  it("does not read a token in a value position as a flag", () => {
    // `--hidden` here is the value of --key-file, not a request to detach.
    const argv = ["--channel", "C:\\ch", "--key-file", "--hidden", "--host", "H", "--user", "u"];
    expect(unknownAgentOption(argv)).toBeNull();
    expect(agentFlagPresent(argv, "--hidden")).toBe(false);
  });

  it("recognises --hidden where it is a flag", () => {
    expect(agentFlagPresent(["--hidden", ...DOCUMENTED], "--hidden")).toBe(true);
  });

  it("refuses --log without --hidden instead of detaching", async () => {
    // The help documents --log as "With --hidden"; the documented foreground
    // command used to run detached whenever the value `--log <file>` was
    // given, changing process mode with exit 0.
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const result = await runAgentCommand([...DOCUMENTED, "--log", "D:\\logs\\a.log"]);
      expect(result.exitCode).toBe(2);
      expect(written.join("")).toMatch(/--log needs --hidden/);
    } finally {
      spy.mockRestore();
    }
  });
});
