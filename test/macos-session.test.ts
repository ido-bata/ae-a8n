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
      { name: "Finder", pid: 689, asid: 100021, uid: 501, bundleId: "com.apple.finder" },
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

  it("reads the G frame record onto the window it follows (#321)", () => {
    const parsed = parseUiListing(
      [
        "W||AXWindow|AXDialog",
        "G|640,480|410,342",
        "B|OK|||",
        "W|Main|AXLayoutArea|AXFloatingWindow",
        "G|0,39|1710,1073",
      ].join("\n"),
    );
    expect(parsed.windows[0]?.frame).toEqual({ x: 640, y: 480, width: 410, height: 342 });
    expect(parsed.windows[1]?.frame).toEqual({ x: 0, y: 39, width: 1710, height: 1073 });
    // Buttons still attach to their own window.
    expect(parsed.windows[0]?.buttons[0]?.title).toBe("OK");
  });

  it("leaves frame unset on a malformed G record — never a wrong match", () => {
    const parsed = parseUiListing("W||AXWindow|AXDialog\nG|garbage\nG|1,2\n");
    expect(parsed.windows[0]?.frame).toBeUndefined();
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
    // Two call sites — the `windows` listing and the `UI elements`
    // fallback for apps like AE that vend windows as AXLayoutArea — and
    // every one must be `my`-qualified.
    const calls = text.match(/(?<!my )a8nClean\(ttext\)/g) ?? [];
    expect(calls).toHaveLength(0);
    expect(text.match(/my a8nClean\(ttext\)/g)).toHaveLength(2);
  });

  it("checks the window is still the one the caller chose before pressing", () => {
    // Listing and pressing are two calls; a sheet raised in between would
    // otherwise take the press meant for the dialog before it.
    const text = PRESS_BUTTON_SCRIPT.join("\n");
    expect(text).toContain("set expectedTitle to item 4 of argv");
    expect(text).toContain('if wtitle is not expectedTitle then return "CHANGED"');
    expect(text).toContain('if wsub is not expectedSubrole then return "CHANGED"');
  });

  it("re-checks the dialog's text, the only identity an empty-title dialog has", () => {
    // The one measured class has an empty title, so title and subrole cannot
    // tell it from another empty-title window in the same process — and the
    // press is sent after a listing and a screenshot.
    const text = PRESS_BUTTON_SCRIPT.join("\n");
    expect(text).toContain("set expectedText to item 6 of argv");
    expect(text).toContain("contains expectedText then set found to true");
    expect(text).toContain('if not found then return "CHANGED"');
  });

  it("re-verifies the window frame before pressing — the bundle-confused listing guard (#330)", () => {
    // On multi-install hosts `windows of process` can enumerate ANOTHER
    // same-bundle-id instance's windows, so title/subrole/text can all
    // describe a foreign dialog. The caller passes the census-attributed
    // frame; the window at the index must still occupy it or the press is
    // refused as CHANGED — never clicked.
    const text = PRESS_BUTTON_SCRIPT.join("\n");
    expect(text).toContain("set expectedFrame to item 7 of argv");
    expect(text).toContain("get position of w");
    expect(text).toContain("get size of w");
    expect(text).toContain("if not frameOk then return \"CHANGED\"");
    // The check must run BEFORE the button loop that clicks.
    const frameCheck = text.indexOf("if not frameOk then return \"CHANGED\"");
    const click = text.indexOf("click b");
    expect(frameCheck).toBeGreaterThan(-1);
    expect(click).toBeGreaterThan(frameCheck);
  });

  it("emits a G frame record for both the windows and UI-elements listings (#321)", () => {
    // Census reconciliation needs every listed window's geometry; AE's
    // real windows arrive through the UI-elements path, so both loops
    // must emit `G|x,y|w,h`.
    const text = LIST_WINDOWS_SCRIPT.join("\n");
    expect(text.match(/set report to report & "G\|"/g)).toHaveLength(2);
    expect(text).toContain("get position of w");
    expect(text).toContain("get position of e");
  });

  it("cleans every label that goes into a listing line", () => {
    // A line break in a window or button label would split the record, and
    // the remainder would become an ignored line: a real dialog would then
    // read as non-blocking.
    const text = LIST_WINDOWS_SCRIPT.join("\n");
    expect(text).toContain("my a8nClean(wtitle)");
    expect(text).toContain("my a8nClean(btitle)");
    expect(text).toContain("my a8nClean(bdesc)");
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
    // osacompile is a real AppleScript compiler; on a loaded machine three
    // invocations can exceed the default timeout without anything being wrong.
  }, 30_000);

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

  it("refuses every GUI action when the pid no longer names the run's process", () => {
    // A pid is not an identity. The process is re-read immediately before
    // each session command; when the check cannot prove the pid still names
    // the process this run started, nothing — not even a read — is sent.
    let sessionCommands = 0;
    const gui = new MacGuiRecovery({
      session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
      pid: 4242,
      allowConsoleSession: true,
      readTargetSession: () => ({ uid: 502, username: "test", asid: 100040, kind: "Aqua" }),
      verifyProcess: () => false,
      census: () => ({ available: false, reason: "no census in test" }),
      lease: {
        acquire: () => ({ path: "/fake/lease", release: () => {} }),
        audit: () => {},
      },
      runSession: () => {
        sessionCommands += 1;
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    for (const act of [
      () => gui.listWindows(),
      () => gui.capture(join(tmpdir(), "a8n-not-this-process.png")),
      () => gui.pressButton(1, "OK"),
      () => gui.clickAt(10, 10),
      () => gui.pressButtonIn(1, "OK"),
    ]) {
      expect(act).toThrow(/A8N-AE-004/);
    }
    expect(sessionCommands).toBe(0);
  });

  it("treats a verifier that throws as 'cannot prove it is the same process'", () => {
    const gui = new MacGuiRecovery({
      session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
      pid: 4242,
      allowConsoleSession: true,
      readTargetSession: () => ({ uid: 502, username: "test", asid: 100040, kind: "Aqua" }),
      verifyProcess: () => {
        throw new Error("ps failed");
      },
      census: () => ({ available: false, reason: "no census in test" }),
      lease: {
        acquire: () => ({ path: "/fake/lease", release: () => {} }),
        audit: () => {},
      },
      runSession: () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
    });
    expect(() => gui.listWindows()).toThrow(/A8N-AE-004/);
  });

  it("stops acting mid-attempt when the process is swapped between actions", () => {
    // The listing proves the process; the process then exits and its pid is
    // reused. The press that follows must not reach the Accessibility API —
    // and the refusal is a plain GuiRecoveryError, not a GuiMutationError,
    // because nothing was pressed.
    let sameProcess = true;
    let sessionCommands = 0;
    const audits: { kind: string; outcome?: string | undefined }[] = [];
    const gui = new MacGuiRecovery({
      session: { uid: 502, username: "test", asid: 100040, kind: "Aqua" },
      pid: 4242,
      allowConsoleSession: true,
      readTargetSession: () => ({ uid: 502, username: "test", asid: 100040, kind: "Aqua" }),
      verifyProcess: () => sameProcess,
      census: () => ({ available: false, reason: "no census in test" }),
      lease: {
        acquire: () => ({ path: "/fake/lease", release: () => {} }),
        audit: (event) => audits.push({ kind: event.kind, outcome: event.outcome }),
      },
      runSession: () => {
        sessionCommands += 1;
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    gui.listWindows();
    expect(sessionCommands).toBe(1);
    sameProcess = false;
    let caught: unknown;
    try {
      gui.pressButton(1, "OK");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/A8N-AE-004/);
    expect((caught as { code?: string }).code).toBe("A8N-AE-004");
    // Provably nothing was pressed: the refusal is audited not-performed,
    // never "unknown", and no session command ran for the press.
    expect(sessionCommands).toBe(1);
    expect(audits).toContainEqual({ kind: "mutate", outcome: "not-performed" });
    expect(audits).not.toContainEqual({ kind: "mutate", outcome: "unknown" });
  });

  it("refuses every GUI action when the proven session changed since construction", () => {
    // The session was proven once, at construction. A re-login gives the
    // user a new asid; `runInSession` alone cannot see that on the root
    // path, which delivers by uid. Every action must refuse before a
    // single session command runs (issue #59 T035).
    const FOREIGN_UID = 4_000_000_000;
    const proven = { uid: FOREIGN_UID, username: "ae-test", asid: 100040, kind: "Aqua" as const };
    let sessionCommands = 0;
    const gui = new MacGuiRecovery({
      session: proven,
      pid: 4242,
      consoleUid: () => 1,
      readTargetSession: () => ({ ...proven, asid: 100099 }),
      census: () => ({ available: false, reason: "no census in test" }),
      lease: {
        acquire: () => ({ path: "/fake/lease", release: () => {} }),
        audit: () => {},
      },
      runSession: () => {
        sessionCommands += 1;
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    for (const act of [
      () => gui.listWindows(),
      () => gui.capture(join(tmpdir(), "a8n-not-this-session.png")),
      () => gui.pressButton(1, "OK"),
      () => gui.clickAt(10, 10),
      () => gui.pressButtonIn(1, "OK"),
    ]) {
      expect(act).toThrow(/no longer holds/);
    }
    expect(sessionCommands).toBe(0);
  });

  it("refuses when the proven session ended or became the console session", () => {
    const FOREIGN_UID = 4_000_000_000;
    const proven = { uid: FOREIGN_UID, username: "ae-test", asid: 100040, kind: "Aqua" as const };
    const mk = (read: () => typeof proven | null, console: () => number) =>
      new MacGuiRecovery({
        session: proven,
        pid: 4242,
        consoleUid: console,
        readTargetSession: read,
        census: () => ({ available: false, reason: "no census in test" }),
        lease: {
          acquire: () => ({ path: "/fake/lease", release: () => {} }),
          audit: () => {},
        },
        runSession: () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
      });
    // The session is gone entirely.
    expect(() => mk(() => null, () => 1).listWindows()).toThrow(/no login session/);
    // A fast user switch made the target the console session *after* the
    // recovery was constructed: the per-action re-proof must catch it.
    let console = 1;
    const flipped = mk(() => proven, () => console);
    console = FOREIGN_UID;
    expect(() => flipped.listWindows()).toThrow(/console session/);
    // The console owner cannot be read at action time, so "not the console"
    // cannot be shown.
    let reads = 0;
    const blind = mk(() => proven, () => (reads++ === 0 ? 1 : -1));
    expect(() => blind.listWindows()).toThrow(/console owner could not be read/);
  });
});

describe("the pid attribution of a press target (#330)", () => {
  const session = { uid: 502, username: "test", asid: 100040, kind: "Aqua" as const };
  const readSession = () => session;
  const lease = {
    acquire: () => ({ path: "/fake/lease", release: () => {} }),
    audit: () => {},
  };
  const censusOwned = {
    available: true as const,
    windows: [
      {
        pid: 4242,
        owner: "After Effects",
        layer: 0,
        onScreen: true,
        name: "dlg",
        bounds: { x: 650, y: 185, width: 410, height: 342 },
      },
    ],
  };
  const ownedWindow = {
    title: "",
    role: "AXWindow",
    subrole: "AXDialog",
    buttons: [{ title: "OK", description: "", position: null, size: null }],
    texts: ["ae-a8n: close me"],
    frame: { x: 650, y: 185, width: 410, height: 342 },
    censusAttribution: "owned" as const,
  };
  // The listings `listWindows()` answers inside the press's own lease
  // (#332): the re-attribution read and the coordinate fallback's re-list.
  // The owned one frames the window where the census says the target pid's
  // window is; the unmatched one frames it somewhere no census window is.
  const OWNED_LISTING =
    "FRONTMOST|1\n" +
    "W||AXWindow|AXDialog\n" +
    "G|650,185|410,342\n" +
    "T|ae-a8n: close me\n" +
    "B|OK||660,195|80,32\n";
  const UNMATCHED_LISTING =
    "FRONTMOST|1\n" +
    "W||AXWindow|AXDialog\n" +
    "G|10,10|100,100\n" +
    "T|ae-a8n: close me\n" +
    "B|OK||20,20|80,32\n";

  it("refuses to press a window the census attributes to another pid — before any session command", () => {
    let commands = 0;
    let acquisitions = 0;
    const gui = new MacGuiRecovery({
      session,
      pid: 4242,
      allowConsoleSession: true,
      readTargetSession: readSession,
      census: () => censusOwned,
      lease: {
        acquire: () => {
          acquisitions += 1;
          return { path: "/fake/lease", release: () => {} };
        },
        audit: () => {},
      },
      runSession: () => {
        commands += 1;
        return { status: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const foreign = { ...ownedWindow, censusAttribution: "foreign" as const };
    const unmatched = { ...ownedWindow, censusAttribution: "unmatched" as const };
    const { censusAttribution: _drop, ...unproven } = ownedWindow;
    for (const bad of [foreign, unmatched, unproven]) {
      expect(() => gui.pressButtonIn(1, "OK", bad, "ae-a8n:")).toThrow(/cannot be proven to belong/);
      expect(() => gui.pressButton(1, "OK", bad)).toThrow(/cannot be proven to belong/);
    }
    // The refusal precedes the lease and every session command: provably
    // nothing was pressed and nothing was even sent.
    expect(commands).toBe(0);
    expect(acquisitions).toBe(0);
  });

  it("passes the census-attributed frame to the press script as argv 7", () => {
    const calls: string[][] = [];
    const gui = new MacGuiRecovery({
      session,
      pid: 4242,
      allowConsoleSession: true,
      readTargetSession: readSession,
      census: () => censusOwned,
      lease,
      runSession: (_s, _p, args) => {
        calls.push([...args]);
        // First the re-attribution listing inside the lease, then the press.
        return calls.length === 1
          ? { status: 0, stdout: OWNED_LISTING, stderr: "", timedOut: false }
          : { status: 0, stdout: "CLICKED", stderr: "", timedOut: false };
      },
    });
    expect(gui.pressButtonIn(1, "OK", ownedWindow, "ae-a8n:")).toBe(true);
    expect(calls).toHaveLength(2);
    // argv: pid, index, title, expectedTitle, expectedSubrole, expectedText, expectedFrame
    expect(calls[1]?.at(-1)).toBe("650,185,410,342");
  });

  it("re-attributes the window at the index inside the lease before pressing (#332)", () => {
    // The attribution `expected` carries was taken at the caller's listing;
    // it can be stale. When the fresh listing inside the lease no longer
    // attributes the window at that index to the target pid, the press —
    // and its coordinate fallback — must not run at all.
    let commands = 0;
    const gui = new MacGuiRecovery({
      session,
      pid: 4242,
      allowConsoleSession: true,
      readTargetSession: readSession,
      census: () => censusOwned,
      lease,
      runSession: () => {
        commands += 1;
        return { status: 0, stdout: UNMATCHED_LISTING, stderr: "", timedOut: false };
      },
    });
    expect(gui.pressButtonIn(1, "OK", ownedWindow, "ae-a8n:")).toBe(false);
    // Only the re-attribution listing ran: no press, no fallback listing.
    expect(commands).toBe(1);
  });

  it("the coordinate fallback clicks nothing when the re-listed window is not pid-attributed", () => {
    // The accessibility press answers NOT_FOUND; the fresh listing then
    // shows the window at the index has a frame no census window owns.
    // The fallback must refuse rather than click raw coordinates that
    // could belong to another instance (#330).
    let commands = 0;
    const gui = new MacGuiRecovery({
      session,
      pid: 4242,
      allowConsoleSession: true,
      readTargetSession: readSession,
      census: () => censusOwned,
      lease,
      runSession: () => {
        commands += 1;
        // 1: the re-attribution listing (owned — the press may proceed);
        // 2: the accessibility press answers NOT_FOUND; 3: the fallback's
        // fresh listing shows the window where no census window is.
        if (commands === 2) {
          return { status: 0, stdout: "NOT_FOUND", stderr: "", timedOut: false };
        }
        return {
          status: 0,
          stdout: commands === 1 ? OWNED_LISTING : UNMATCHED_LISTING,
          stderr: "",
          timedOut: false,
        };
      },
    });
    expect(gui.pressButtonIn(1, "OK", ownedWindow, "ae-a8n:")).toBe(false);
    // re-list + press + fallback re-list; a clickAt would have been a
    // fourth command.
    expect(commands).toBe(3);
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
