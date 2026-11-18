import { describe, expect, it } from "vitest";

import { classifyAppleEventError } from "../src/driver/apple-event-denials.js";

describe("classifyAppleEventError", () => {
  it("maps -1743 to the Automation-consent next action", () => {
    const denial = classifyAppleEventError(
      'execution error: Not authorized to send Apple events to After Effects. (-1743)',
    );
    expect(denial?.code).toBe(-1743);
    expect(denial?.nextAction).toContain("responsible terminal application");
  });

  it("maps -1708 to the script-folder approval action", () => {
    const denial = classifyAppleEventError("execution error: AE (-1708)");
    expect(denial?.code).toBe(-1708);
    expect(denial?.nextAction).toContain("Scripting & Expressions");
  });

  it("maps -1712 to the modal/sign-in action, never a permission fix", () => {
    const denial = classifyAppleEventError("execution error: timeout (-1712)");
    expect(denial?.code).toBe(-1712);
    expect(denial?.meaning).toContain("not answering");
  });

  it("maps -609 to the process-gone action", () => {
    const denial = classifyAppleEventError("execution error: connection invalid (-609)");
    expect(denial?.code).toBe(-609);
  });

  it("maps -2741 to a transport-bug note, not a permission", () => {
    const denial = classifyAppleEventError(
      'execution error: Can\'t get application "Foo". (-2741)',
    );
    expect(denial?.code).toBe(-2741);
    expect(denial?.nextAction).toContain("transport bug");
  });

  it("reads the LAST parenthesised number — AE's own text may contain earlier ones", () => {
    const denial = classifyAppleEventError(
      'execution error: AE said "retry (-1708)" then failed (-1743)',
    );
    expect(denial?.code).toBe(-1743);
  });

  it("returns null for stderr with no parenthesised number", () => {
    expect(classifyAppleEventError("osascript: command not found")).toBeNull();
  });

  it("returns null for an unknown Apple Event number", () => {
    expect(classifyAppleEventError("execution error: (-600)")).toBeNull();
  });
});
