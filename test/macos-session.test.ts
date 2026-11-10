/**
 * The macOS session boundary: which session a script goes to, which process
 * list belongs to it, and what the GUI fallback is allowed to press.
 *
 * These are the parts that decide whether an isolated test can touch the
 * console user's desktop. They are checked here with the parsers as seams,
 * so no test needs a second user or a second session.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLICK_AT_SCRIPT,
  LIST_WINDOWS_SCRIPT,
  MacGuiRecovery,
  PRESS_BUTTON_SCRIPT,
  isBlockingWindow,
  parseUiListing,
} from "../src/driver/gui-recovery.js";
import { consoleSessionUid, parseLaunchctlGuiSession, parseLsappinfo, startInSession } from "../src/driver/mac-session.js";
import { RECOVERY_BUTTONS, describeWindow, isHumanOnlyWindow } from "../src/driver/recovery.js";

describe("the login session of a user", () => {
  it("reads the session kind and the session id from the launchctl document", () => {
    const text = [
      "gui/501 = {",
      "\ttype = login",
      "\thandle = 100021",
      "\tsession = Aqua",
      "\t\tgui asid = 100021",
      "}",
    ].join("\n");
    expect(parseLaunchctlGuiSession(text)).toEqual({ asid: 100021, kind: "Aqua" });
  });

  it("does not mistake a background session for a graphical one", () => {
    const text = ["gui/501 = {", "\tsession = Background", "\t\tasid = 100040", "}"].join("\n");
    expect(parseLaunchctlGuiSession(text)).toEqual({ asid: 100040, kind: "Background" });
  });

  it("reports nothing for a document without a session", () => {
    expect(parseLaunchctlGuiSession("gui/502 = {\n\ttype = login\n}")).toEqual({
      asid: null,
      kind: "none",
    });
  });
});

describe("the applications of the window server", () => {
  const listing = [
    ' 7) "Finder" ASN:0x0-0x12012: ',
    '    bundleID="com.apple.finder"',
    "    pid = 689 token=[sess=100021 pid=689 uid:501,501,501 g:20,20 pV:1698] type=\"Foreground\" flavor=3",
    ' 8) "Adobe After Effects 2026" ASN:0x0-0x9900: ',
    "    pid = 4242 token=[sess=100040 pid=4242 uid:502,502,502 g:20,20 pV:1698] type=\"Foreground\" flavor=2",
    " 9) \"Helper\" ASN:0x0-0x9901: ",
    "    pid = 4243",
  ].join("\n");

  it("reads the pid, the user and the session of every application", () => {
    const apps = parseLsappinfo(listing);
    expect(apps).toEqual([
      { name: "Finder", pid: 689, asid: 100021, uid: 501 },
      { name: "Adobe After Effects 2026", pid: 4242, asid: 100040, uid: 502 },
      { name: "Helper", pid: 4243, asid: null, uid: -1 },
    ]);
  });

  it("tells the two sessions apart", () => {
    const apps = parseLsappinfo(listing);
    const byUser = new Map(apps.filter((app) => app.uid > 0).map((app) => [app.uid, app.asid]));
    expect(byUser.get(501)).toBe(100021);
    expect(byUser.get(502)).toBe(100040);
  });
});

describe("what the accessibility query reports", () => {
  const listing = [
    "FRONTMOST|1",
    "W||AXWindow|AXDialog",
    "T|警告",
    "T|Adobe Creative Cloud にサインインしてください",
    "B|Cancel|ボタン|964,362|82,26",
    "B|OK|ボタン|872,362|82,26",
    "W|Adobe After Effects 2026|AXWindow|AXStandardWindow",
    "B|Close||1180,120|40,28",
  ].join("\n");

  it("reads the windows, their buttons and their frames", () => {
    const parsed = parseUiListing(listing);
    expect(parsed.frontmost).toBe(true);
    expect(parsed.windows).toHaveLength(2);
    expect(parsed.windows[0]).toEqual({
      title: "",
      role: "AXWindow",
      subrole: "AXDialog",
      texts: ["警告", "Adobe Creative Cloud にサインインしてください"],
      buttons: [
        { title: "Cancel", description: "ボタン", position: { x: 964, y: 362 }, size: { width: 82, height: 26 } },
        { title: "OK", description: "ボタン", position: { x: 872, y: 362 }, size: { width: 82, height: 26 } },
      ],
    });
  });

  it("knows a modal window from an ordinary one", () => {
    const parsed = parseUiListing(listing);
    expect(isBlockingWindow(parsed.windows[0] as never)).toBe(true);
    expect(isBlockingWindow(parsed.windows[1] as never)).toBe(false);
  });

  it("does not choke on a listing without frames", () => {
    const parsed = parseUiListing("W||AXWindow|AXDialog\nB|OK|||");
    expect(parsed.windows[0]?.buttons[0]).toEqual({
      title: "OK",
      description: "",
      position: null,
      size: null,
    });
  });

  it("keeps a window's own words with that window", () => {
    const parsed = parseUiListing(listing);
    expect(parsed.windows[1]?.texts).toEqual([]);
  });
});

describe("what the recovery may press", () => {
  const dialog = { title: "", role: "AXWindow", subrole: "AXDialog", buttons: [], texts: [] };

  it("presses only buttons that end a dialog", () => {
    expect(RECOVERY_BUTTONS).toEqual(["OK", "Cancel", "Close", "Dismiss"]);
    expect(RECOVERY_BUTTONS).not.toContain("Deactivate");
    expect(RECOVERY_BUTTONS).not.toContain("Sign Out");
  });

  it("refuses an Adobe account or licence window", () => {
    expect(isHumanOnlyWindow({ ...dialog, title: "Sign in" })).toBe(true);
    expect(isHumanOnlyWindow({ ...dialog, title: "Creative Cloud" })).toBe(true);
    expect(isHumanOnlyWindow({ ...dialog, title: "Activate" })).toBe(true);
    expect(isHumanOnlyWindow(dialog)).toBe(false);
  });

  it("refuses an Adobe account window whose wording is not English", () => {
    // The session runs in Japanese, so the sign-in prompt says "サインイン"
    // and its title is only "警告". Neither is findable by an English matcher.
    expect(isHumanOnlyWindow({ ...dialog, title: "警告" })).toBe(false);
    expect(
      isHumanOnlyWindow({ ...dialog, title: "警告", texts: ["Adobe Creative Cloud にサインインしてください"] }),
    ).toBe(true);
    expect(isHumanOnlyWindow({ ...dialog, texts: ["ライセンス契約に同意してください"] })).toBe(true);
    expect(isHumanOnlyWindow({ ...dialog, texts: ["ae-a8n: close me"] })).toBe(false);
  });

  it("says what it saw", () => {
    expect(describeWindow({ ...dialog, buttons: [{ title: "OK", description: "", position: null, size: null }] })).toBe(
      'AXWindow/AXDialog "" [OK]',
    );
    expect(
      describeWindow({
        ...dialog,
        title: "警告",
        texts: ["Adobe Creative Cloud にサインインしてください"],
        buttons: [{ title: "OK", description: "", position: null, size: null }],
      }),
    ).toBe(
      'AXWindow/AXDialog "警告" [OK] says "Adobe Creative Cloud にサインインしてください"',
    );
  });
});

describe("the GUI recovery", () => {
  it("calls its own handler with `my`, inside the tell block that wraps it", () => {
    // AppleScript sends an unqualified handler name to the application being
    // told, so `a8nClean(ttext)` inside `tell application "System Events"`
    // reaches System Events as a command it does not have and fails with
    // "Can't continue a8nClean (-1708)". That is a runtime error, not a
    // compile error, so osacompile cannot catch it — measured on a real
    // host, 2026-11-03.
    const text = LIST_WINDOWS_SCRIPT.join("\n");
    // The only call site, so qualifying it is the whole fix.
    expect(text.match(/a8nClean\(ttext\)/g)).toHaveLength(1);
    expect(text).toContain("my a8nClean(ttext)");
  });

  it("checks the window is still the one the caller chose before pressing", () => {
    // Listing and pressing are two calls; a sheet raised in between would
    // otherwise take the press meant for the dialog before it.
    const text = PRESS_BUTTON_SCRIPT.join("\n");
    expect(text).toContain("set expectedTitle to item 4 of argv");
    expect(text).toContain('if wtitle is not expectedTitle then return "CHANGED"');
    expect(text).toContain('if wsub is not expectedSubrole then return "CHANGED"');
  });

  it("never sends an untargeted escape key when the focused window cannot be proven", async () => {
    // Escape only reaches whatever window happens to be key. The recovery
    // identifies a window by listing index and title/subrole; a keystroke has
    // no such identity check, so it could close a different window in the
    // same process. The fallback is removed rather than guessed at.
    const gui = await import("../src/driver/gui-recovery.js");
    expect("PRESS_ESCAPE_SCRIPT" in gui).toBe(false);
    expect("pressEscape" in MacGuiRecovery.prototype).toBe(false);
    for (const script of [LIST_WINDOWS_SCRIPT, PRESS_BUTTON_SCRIPT, CLICK_AT_SCRIPT]) {
      expect(script.join("\n")).not.toContain("key code");
    }
  });

  it.runIf(process.platform === "darwin")("compiles every script it sends, host or not", () => {
    // A script that does not compile is only discovered on a real host, at
    // the moment a dialog is blocking After Effects. osacompile answers the
    // same question without sending anything to any application.
    const dir = mkdtempSync(join(tmpdir(), "a8n-osa-"));
    try {
      for (const [name, script] of Object.entries({
        "list-windows": LIST_WINDOWS_SCRIPT,
        "press-button": PRESS_BUTTON_SCRIPT,
        "click-at": CLICK_AT_SCRIPT,
      })) {
        const source = join(dir, `${name}.applescript`);
        writeFileSync(source, `${script.join("\n")}\n`);
        expect(
          () => execFileSync("osacompile", ["-o", join(dir, `${name}.scpt`), source], { stdio: "pipe" }),
          `${name} does not compile`,
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the console session, which is the screen the user is looking at", () => {
    const uid = consoleSessionUid();
    if (uid < 0) {
      return; // The console owner is unknown on this machine; nothing to refuse.
    }
    expect(
      () =>
        new MacGuiRecovery({
          session: { uid, username: "console", asid: 100021, kind: "Aqua" },
          pid: 4242,
        }),
    ).toThrow(/console session/);
  });

  it("can be told explicitly that the target is the console session", () => {
    // The refusal exists so that a recovery cannot be aimed at the human's
    // desktop by accident. A caller that is itself running there can say so,
    // and only then does the check not apply.
    expect(
      () =>
        new MacGuiRecovery({
          session: { uid: 501, username: "console", asid: 100021, kind: "Aqua" },
          pid: 4242,
          allowConsoleSession: true,
        }),
    ).not.toThrow();
  });

  it("refuses a session that has no screen", () => {
    expect(
      () =>
        new MacGuiRecovery({
          session: { uid: 502, username: "test", asid: 100040, kind: "Background" },
          pid: 4242,
        }),
    ).toThrow(/no Aqua session/);
  });

  it("refuses a GUI action when the pid no longer names the run's process", () => {
    // A pid is not an identity. The process is re-read immediately before the
    // Accessibility query; a recycled pid is refused with A8N-AE-004 rather
    // than queried or clicked.
    const gui = new MacGuiRecovery({
      session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
      pid: 4242,
      verifyProcess: () => false,
    });
    expect(() => gui.listWindows()).toThrow(/A8N-AE-004/);
    expect(() => gui.capture(join(tmpdir(), "a8n-not-this-process.png"))).toThrow(/A8N-AE-004/);
  });
});

describe("starting a process in another user's session", () => {
  it("refuses when this process can neither be inside it nor enter it as root", () => {
    const target = { uid: 9999, username: "someone-else", asid: 1234, kind: "Aqua" as const };
    const patched = process as { getuid?: (() => number) | undefined };
    const original = patched.getuid;
    patched.getuid = () => 501;
    try {
      expect(() => startInSession(target, "/bin/true", [])).toThrow(
        /cannot start \/bin\/true in the session of someone-else/,
      );
      expect(() => startInSession(target, "/bin/true", [])).toThrow(
        /Nothing was started in the console session/,
      );
    } finally {
      patched.getuid = original;
    }
  });
});
