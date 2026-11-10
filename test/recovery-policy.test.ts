/**
 * The neutral recovery policy, pinned as a table.
 *
 * These tests are the policy: a measured pressable class presses, a
 * human-only or non-pressable class never presses, an unknown blocking window
 * quarantines with `A8N-SEC-001`, and a human-only window anywhere stops every
 * press.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MEASURED_DIALOG_CLASSES,
  RECOVERY_BUTTONS,
  chooseAction,
  classifyDialog,
  isHumanOnlyWindow,
  type DialogWindow,
} from "../src/platform/recovery-policy.js";

function window(overrides: Partial<DialogWindow> = {}): DialogWindow {
  return {
    title: "",
    role: "AXWindow",
    subrole: "AXDialog",
    texts: [],
    buttons: ["OK"],
    blocking: true,
    ...overrides,
  };
}

const ALERT = window({ texts: ["ae-a8n: unable to open the project"], buttons: ["OK"] });
const LICENCE = window({ title: "Adobe", texts: ["License agreement"], buttons: ["Accept", "Quit"] });
const SIGN_IN = window({ title: "Adobe", texts: ["Sign in to continue"], buttons: ["Sign In"] });
const PERMISSION = window({
  title: "After Effects",
  texts: ["Allow scripts to write files and access network"],
  buttons: ["OK"],
});
const CRASH_REPAIR = window({
  title: "After Effects",
  texts: ["Crash Repair Options", "Recover unsaved changes?"],
  buttons: ["Recover", "Close"],
});
const SECOND_SCRIPT = window({
  title: "After Effects warning",
  texts: [
    "Attempt was made to run a second script while another script was already running.",
  ],
  buttons: ["OK"],
});
const UNKNOWN = window({ title: "Something new", texts: ["unmeasured wording"], buttons: ["OK"] });

describe("classifyDialog", () => {
  it("names the measured pressable class", () => {
    const classified = classifyDialog(ALERT);
    expect(classified).toMatchObject({
      kind: "known",
      dialogClass: { name: "ae-a8n ui.alert", presses: true, button: "OK" },
    });
  });

  it.each([
    ["after-effects-crash-repair", CRASH_REPAIR],
    ["after-effects-second-script", SECOND_SCRIPT],
    ["adobe-licence", LICENCE],
    ["adobe-sign-in", SIGN_IN],
    ["script-file-network-permission", PERMISSION],
  ])("names %s and marks it non-pressable", (name, observed) => {
    const classified = classifyDialog(observed);
    expect(classified.kind).toBe("known");
    if (classified.kind === "known") {
      expect(classified.dialogClass.name).toBe(name);
      expect(classified.dialogClass.presses).toBe(false);
      expect(classified.dialogClass.button).toBeNull();
    }
  });

  it("returns the quarantine code for anything it has not measured", () => {
    expect(classifyDialog(UNKNOWN)).toEqual({ kind: "unknown", code: "A8N-SEC-001" });
  });
});

describe("the measured class table", () => {
  it("only ever names buttons the policy allows", () => {
    for (const dialogClass of MEASURED_DIALOG_CLASSES) {
      if (dialogClass.presses) {
        expect(dialogClass.button).not.toBeNull();
        expect(RECOVERY_BUTTONS).toContain(dialogClass.button);
      } else {
        expect(dialogClass.button).toBeNull();
      }
    }
  });

  it("does not import macOS or Windows code", () => {
    const source = readFileSync(
      new URL("../src/platform/recovery-policy.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/platform\/(macos|windows)\//u);
  });
});

describe("chooseAction", () => {
  it("does nothing when no window is blocking", () => {
    expect(chooseAction([window({ blocking: false, texts: ["unmeasured"] })])).toMatchObject({
      action: "none",
      presses: [],
    });
  });

  it("presses a measured pressable class", () => {
    const decision = chooseAction([ALERT]);
    expect(decision.action).toBe("known");
    expect(decision.presses).toHaveLength(1);
    expect(decision.presses[0]).toMatchObject({ dialogClass: "ae-a8n ui.alert", button: "OK" });
  });

  it.each([
    ["a licence window", LICENCE],
    ["a sign-in window", SIGN_IN],
    ["a permission window", PERMISSION],
    ["crash repair", CRASH_REPAIR],
    ["the second-script dialog", SECOND_SCRIPT],
  ])("never presses %s and stops every other press", (_label, humanOnly) => {
    const decision = chooseAction([ALERT, humanOnly]);
    expect(decision.action).toBe("human-only");
    expect(decision.presses).toEqual([]);
  });

  it("quarantines an unknown blocking window and presses nothing", () => {
    const decision = chooseAction([ALERT, UNKNOWN]);
    expect(decision).toEqual(
      expect.objectContaining({
        action: "quarantine",
        code: "A8N-SEC-001",
        presses: [],
      }),
    );
  });

  it("prefers the human-only answer to quarantine when both are present", () => {
    const decision = chooseAction([UNKNOWN, SIGN_IN]);
    expect(decision.action).toBe("human-only");
    expect(decision.presses).toEqual([]);
  });

  it("does not press a non-blocking unknown window", () => {
    const decision = chooseAction([window({ ...UNKNOWN, blocking: false })]);
    expect(decision).toMatchObject({ action: "none", presses: [] });
  });
});

describe("human-only detection", () => {
  it.each([LICENCE, SIGN_IN, PERMISSION])("recognises a human decision in any language", (observed) => {
    expect(isHumanOnlyWindow(observed)).toBe(true);
  });

  it("recognises a Japanese sign-in prompt", () => {
    expect(isHumanOnlyWindow(window({ title: "", texts: ["サインインしてください"] }))).toBe(true);
  });

  it("does not widen the alert the run itself raised", () => {
    expect(isHumanOnlyWindow(ALERT)).toBe(false);
  });
});
