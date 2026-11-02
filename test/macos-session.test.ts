/**
 * The macOS session boundary: which session a script goes to, which process
 * list belongs to it, and what the GUI fallback is allowed to press.
 *
 * These are the parts that decide whether an isolated test can touch the
 * console user's desktop. They are checked here with the parsers as seams,
 * so no test needs a second user or a second session.
 */

import { describe, expect, it } from "vitest";

import { MacGuiRecovery, isBlockingWindow, parseUiListing } from "../src/driver/gui-recovery.js";
import { consoleSessionUid, parseLaunchctlGuiSession, parseLsappinfo } from "../src/driver/mac-session.js";
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

  it("refuses a session that has no screen", () => {
    expect(
      () =>
        new MacGuiRecovery({
          session: { uid: 502, username: "test", asid: 100040, kind: "Background" },
          pid: 4242,
        }),
    ).toThrow(/no Aqua session/);
  });
});
