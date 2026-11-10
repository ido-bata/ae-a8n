/**
 * The `ae-a8n agent` argument check.
 *
 * This check used to read every token as a flag, so the documented command —
 * which passes a channel root, a key file, a host and a user — was refused
 * with "unknown option C:\...\channel" before the agent started. The values
 * are not flags and must not be inspected.
 */

import { describe, expect, it } from "vitest";

import { unknownAgentOption } from "../src/cli/agent.js";

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
