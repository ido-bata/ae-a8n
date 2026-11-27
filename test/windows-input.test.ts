/**
 * Windows input helper tests (#373, `specs/ime-input/spec.md` §5–§7,
 * parent #344 / program #337).
 *
 * Everything here is `implemented` + `automated test` level: argument
 * validation, script generation, NDJSON parsing, and poster behavior
 * against a fake command channel. No real `powershell.exe` posting is
 * exercised — there is no Windows host lane, and nothing here may be
 * read as "input delivery works". An optional pwsh parse check runs
 * only where a PowerShell binary is discoverable.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  encodeWindowsInputSendEvents,
  windowsInputSendScript,
  type WindowsInputSendEvent,
} from "../src/platform/windows/input-send-script.js";
import {
  encodeWindowsClipboardCommand,
  windowsClipboardScript,
} from "../src/platform/windows/input-clipboard-script.js";
import { windowsImeScript } from "../src/platform/windows/input-ime-script.js";
import { windowsFocusScript } from "../src/platform/windows/input-focus-script.js";
import {
  WindowsInputHelpers,
  type WindowsInputChannel,
  type WindowsInputChannelResult,
} from "../src/platform/windows/input.js";
import type { ClipboardSnapshot } from "../src/input/types.js";

const CLSID = "33c53a50-f456-4884-b049-85fd643ecfed";
const PROFILE_GUID = "4ea48a35-60ae-446f-8fd6-e6a8d82459f7";
const IME_MODE = `0x0411:${CLSID}:${PROFILE_GUID}`;

function ok(stdout: string): WindowsInputChannelResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function postedResult(extra = ""): string {
  return (
    `{"type":"meta","sessionId":1}\n` +
    `{"type":"result","status":"POSTED","sent":2,"expected":2,"modifiers":[]${extra}}\n`
  );
}

/** A channel that records scripts and answers from a responder. */
function fakeChannel(
  responder: (script: string) => WindowsInputChannelResult,
): { channel: WindowsInputChannel; scripts: string[] } {
  const scripts: string[] = [];
  return {
    scripts,
    channel: (script: string) => {
      scripts.push(script);
      return responder(script);
    },
  };
}

function makeHelpers(
  responder: (script: string) => WindowsInputChannelResult = () => ok(postedResult()),
): { helpers: WindowsInputHelpers; scripts: string[] } {
  const { channel, scripts } = fakeChannel(responder);
  return {
    helpers: new WindowsInputHelpers({ platform: "win32", channel }),
    scripts,
  };
}

/** Extract the base64 payload embedded in a generated script. */
function embeddedB64(script: string, varName: string): string {
  const match = script.match(new RegExp(`\\$script:${varName} = '([A-Za-z0-9+/=]+)'`));
  if (match === null) throw new Error(`no ${varName} payload in script`);
  return match[1]!;
}

function decodeEvents(script: string): Record<string, unknown>[] {
  const b64 = embeddedB64(script, "eventsB64");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<
    string,
    unknown
  >[];
}

// ------------------------------------------------------------ send script

describe("windowsInputSendScript", () => {
  it("embeds SendInput P/Invoke, both IME channels and modifier readback", () => {
    const script = windowsInputSendScript(
      encodeWindowsInputSendEvents({
        events: [{ type: "key", action: "down", vk: 0x41 }],
      }),
    );
    expect(script).toContain("SendInput");
    expect(script).toContain("KEYEVENTF_SCANCODE");
    expect(script).toContain("KEYEVENTF_UNICODE");
    expect(script).toContain("KEYEVENTF_EXTENDEDKEY");
    expect(script).toContain("GetAsyncKeyState");
    expect(script).toContain("MOUSEEVENTF_WHEEL");
    // Session evidence for the helper-execution-path contract.
    expect(script).toContain("sessionId");
  });

  it("distinguishes the unicode (IME-bypass) channel in the payload", () => {
    const script = windowsInputSendScript(
      encodeWindowsInputSendEvents({
        events: [
          { type: "key", action: "down", unicode: "あ" },
          { type: "key", action: "up", unicode: "あ" },
        ],
      }),
    );
    const events = decodeEvents(script);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ t: "key", u: "あ".charCodeAt(0), vk: 0 });
    expect(events[1]).toMatchObject({ a: 0 });
  });

  it("rejects malformed event batches before producing a script", () => {
    expect(() =>
      encodeWindowsInputSendEvents({ events: [] }),
    ).toThrow(TypeError);
    expect(() =>
      encodeWindowsInputSendEvents({
        events: [{ type: "key", action: "down", vk: 0x41, unicode: "x" }],
      }),
    ).toThrow(/exactly one of vk, scan or unicode/);
    expect(() =>
      encodeWindowsInputSendEvents({
        events: [{ type: "key", action: "down" }],
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      encodeWindowsInputSendEvents({
        events: [{ type: "key", action: "down", vk: 300 }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      encodeWindowsInputSendEvents({
        events: [{ type: "key", action: "down", unicode: "ab" }],
      }),
    ).toThrow(/one UTF-16 code unit/);
    expect(() =>
      encodeWindowsInputSendEvents({
        events: [{ type: "mouse", action: "down", button: "left" }],
      }),
    ).toThrow(/requires x and y/);
    expect(() =>
      encodeWindowsInputSendEvents({
        events: [{ type: "mouse", action: "down", x: 1, y: 2 }],
      }),
    ).toThrow(/requires a button/);
    expect(() =>
      encodeWindowsInputSendEvents({
        events: [{ type: "bogus" } as unknown as WindowsInputSendEvent],
      }),
    ).toThrow(/unknown input event type/);
  });

  it("caps the batch size so a runaway plan cannot build a huge script", () => {
    const events: WindowsInputSendEvent[] = Array.from({ length: 4097 }, () => ({
      type: "key",
      action: "down" as const,
      vk: 0x41,
    }));
    expect(() => encodeWindowsInputSendEvents({ events })).toThrow(/cap/);
  });
});

// -------------------------------------------------------- clipboard script

describe("windowsClipboardScript", () => {
  it("reads via Win32 clipboard P/Invoke and reports formats", () => {
    const script = windowsClipboardScript({ mode: "read" });
    expect(script).toContain("OpenClipboard");
    expect(script).toContain("EnumClipboardFormats");
    expect(script).toContain("CF_UNICODETEXT");
    expect(script).not.toContain("payloadB64 = '");
  });

  it("writes CF_UNICODETEXT with the payload base64-encoded", () => {
    const nasty = "it's a \"test\"\nwith 'quotes' and 日本語";
    const script = windowsClipboardScript({ mode: "write", text: nasty });
    expect(script).toContain("SetClipboardData");
    expect(script).toContain("EmptyClipboard");
    // The payload must never appear as script text.
    expect(script).not.toContain(nasty);
    const payload = JSON.parse(
      Buffer.from(embeddedB64(script, "payloadB64"), "base64").toString("utf8"),
    ) as { text: string };
    expect(payload.text).toBe(nasty);
    // Honest scope note: only the text flavor is written back.
    expect(script).toContain("CF_UNICODETEXT");
  });

  it("rejects non-string and oversized write payloads", () => {
    expect(() =>
      windowsClipboardScript({ mode: "write", text: 42 as unknown as string }),
    ).toThrow(TypeError);
    expect(() =>
      windowsClipboardScript({ mode: "write", text: "x".repeat(4 * 1024 * 1024 + 1) }),
    ).toThrow(/4 MiB/);
    expect(encodeWindowsClipboardCommand({ mode: "read" })).toEqual({
      mode: "read",
      payloadB64: null,
    });
  });
});

// ---------------------------------------------------------------- ime script

describe("windowsImeScript", () => {
  it("queries via ITfInputProcessorProfileMgr with SDK-correct GUIDs", () => {
    const script = windowsImeScript({ mode: "query" });
    expect(script).toContain("ITfInputProcessorProfileMgr");
    expect(script).toContain("33c53a50-f456-4884-b049-85fd643ecfed");
    // GUID casing differs between the SDK headers and the C# literals.
    expect(script.toLowerCase()).toContain("71c6e74c-0f28-11d8-a82a-00065b84435c");
    expect(script).toContain("34745c63-b2f0-4784-8b67-5e12c8701a31");
    expect(script).toContain("GetActiveProfile");
    expect(script).toContain("TF_IPPMF_FORPROCESS");
  });

  it("activates with FORPROCESS|FORSESSION only — never ENABLEPROFILE", () => {
    const script = windowsImeScript({
      mode: "activate",
      langid: 0x0411,
      clsid: CLSID,
      guidProfile: PROFILE_GUID,
    });
    expect(script).toContain("ActivateProfile");
    expect(script).toContain(`$script:clsid = '${CLSID}'`);
    expect(script).toContain("$flags = [uint32]3");
    // Registry-persistent enablement is out of this helper's contract:
    // the flag constant is never referenced and flags stay at 3
    // (FORPROCESS | FORSESSION). The word may appear in comments.
    expect(script).not.toContain("TF_IPPMF_ENABLEPROFILE");
  });

  it("supports list and deactivate modes", () => {
    expect(windowsImeScript({ mode: "list", langid: 0x0411 })).toContain("EnumProfiles");
    expect(windowsImeScript({ mode: "deactivate" })).toContain("DeactivateProfile");
  });

  it("rejects malformed langid and GUIDs before producing a script", () => {
    expect(() => windowsImeScript({ mode: "list", langid: 0x1_0000 })).toThrow(TypeError);
    expect(() => windowsImeScript({ mode: "list", langid: -1 })).toThrow(TypeError);
    expect(() =>
      windowsImeScript({ mode: "activate", langid: 0x411, clsid: "nope", guidProfile: PROFILE_GUID }),
    ).toThrow(/clsid GUID/);
    expect(() =>
      windowsImeScript({
        mode: "activate",
        langid: 0x411,
        clsid: CLSID,
        guidProfile: "not-a-guid",
      }),
    ).toThrow(/guidProfile GUID/);
  });
});

// --------------------------------------------------------------- focus

describe("windowsFocusScript", () => {
  it("reads GetGUIThreadInfo + UIA FocusedElement with session honesty", () => {
    const script = windowsFocusScript({ mode: "read" });
    expect(script).toContain("GetGUIThreadInfo");
    expect(script).toContain("GUITHREADINFO");
    expect(script).toContain("FocusedElement");
    expect(script).toContain("sessionMatch");
    expect(script).toContain("SetForegroundWindow");
  });

  it("set mode carries pid and an escaped automationId hint", () => {
    const script = windowsFocusScript({
      mode: "set",
      pid: 4321,
      automationId: "it's-an-id",
    });
    expect(script).toContain("$script:targetPid = 4321");
    expect(script).toContain("$script:wantedAutomationId = 'it''s-an-id'");
    expect(script).toContain("FocusPattern");
    expect(script).toContain("FOREGROUND_ONLY");
  });

  it("rejects invalid pids and oversized automationIds", () => {
    expect(() => windowsFocusScript({ mode: "set", pid: 0 })).toThrow(TypeError);
    expect(() => windowsFocusScript({ mode: "set", pid: 1.5 })).toThrow(TypeError);
    expect(() =>
      windowsFocusScript({ mode: "set", pid: 1, automationId: "x".repeat(513) }),
    ).toThrow(/512/);
  });
});

// ------------------------------------------------------------- the poster

describe("WindowsInputHelpers", () => {
  it("refuses to construct off win32 — there is no session stream", () => {
    expect(
      () => new WindowsInputHelpers({ platform: "darwin", channel: () => ok("") }),
    ).toThrow(/require win32/);
  });

  it("posts keyDown as modifier-down + key-down in one batch", () => {
    const { helpers, scripts } = makeHelpers();
    helpers.keyDown("a", ["ctrl"]);
    expect(scripts).toHaveLength(1);
    const events = decodeEvents(scripts[0]!);
    expect(events).toEqual([
      { t: "key", a: 1, vk: 0x11, scan: -1, u: 0, ext: 0 },
      { t: "key", a: 1, vk: 0x41, scan: -1, u: 0, ext: 0 },
    ]);
  });

  it("posts keyUp as key-up then modifiers in reverse order", () => {
    const { helpers, scripts } = makeHelpers();
    helpers.keyUp("a", ["ctrl", "shift"]);
    const events = decodeEvents(scripts[0]!);
    expect(events.map((e) => e.vk)).toEqual([0x41, 0x10, 0x11]);
    expect(events.map((e) => e.a)).toEqual([0, 0, 0]);
  });

  it("marks extended keys (arrows) with the extended flag", () => {
    const { helpers, scripts } = makeHelpers();
    helpers.keyDown("right");
    const events = decodeEvents(scripts[0]!);
    expect(events[0]).toMatchObject({ vk: 0x27, ext: 1 });
  });

  it("rejects unknown keys and modifiers before posting", () => {
    const { helpers, scripts } = makeHelpers();
    expect(() => helpers.keyDown("not-a-key")).toThrow(TypeError);
    expect(() => helpers.keyDown("a", ["hyper"])).toThrow(TypeError);
    expect(scripts).toHaveLength(0);
  });

  it("typeSequential maps ASCII to per-char VK down/up pairs", () => {
    const { helpers, scripts } = makeHelpers();
    helpers.typeSequential("ab");
    const events = decodeEvents(scripts[0]!);
    expect(events.map((e) => [e.vk, e.a])).toEqual([
      [0x41, 1], [0x41, 0], [0x42, 1], [0x42, 0],
    ]);
  });

  it("typeSequential refuses characters with no VK mapping — never silently unicode", () => {
    const { helpers, scripts } = makeHelpers();
    expect(() => helpers.typeSequential("あ")).toThrow(/type-direct/);
    expect(() => helpers.typeSequential("")).toThrow(TypeError);
    expect(scripts).toHaveLength(0);
  });

  it("postText uses the KEYEVENTF_UNICODE channel per UTF-16 unit", () => {
    const { helpers, scripts } = makeHelpers();
    helpers.postText("A");
    const events = decodeEvents(scripts[0]!);
    expect(events).toEqual([
      { t: "key", a: 1, vk: 0, scan: -1, u: 0x41, ext: 0 },
      { t: "key", a: 0, vk: 0, scan: -1, u: 0x41, ext: 0 },
    ]);
  });

  it("translates mouse events into move/down/up batches", () => {
    const { helpers, scripts } = makeHelpers();
    helpers.mouse({ type: "click", x: 10, y: 20, button: "right" });
    const events = decodeEvents(scripts[0]!);
    expect(events.map((e) => [e.t, e.a, e.b])).toEqual([
      ["mouse", "move", ""],
      ["mouse", "down", "right"],
      ["mouse", "up", "right"],
    ]);
  });

  it("refuses horizontal scroll rather than dropping dx", () => {
    const { helpers, scripts } = makeHelpers();
    expect(() => helpers.mouse({ type: "scroll", x: 0, y: 0, dx: 3, dy: 0 })).toThrow(
      /horizontal scroll/,
    );
    expect(scripts).toHaveLength(0);
  });

  it("throws when the helper reports PARTIAL or FAILED posting", () => {
    const partial = makeHelpers(() =>
      ok(
        `{"type":"meta","sessionId":1}\n` +
          `{"type":"result","status":"PARTIAL","sent":1,"expected":2}\n`,
      ),
    );
    expect(() => partial.helpers.keyDown("a")).toThrow(/part of the batch/);
    const failed = makeHelpers(() =>
      ok(
        `{"type":"result","status":"FAILED","sent":0,"expected":1,"detail":"uipi"}\n`,
      ),
    );
    expect(() => failed.helpers.keyDown("a")).toThrow(/did not post: uipi/);
    const silent = makeHelpers(() => ok("not json\n"));
    expect(() => silent.helpers.keyDown("a")).toThrow(/no result record/);
  });

  it("throws when the channel exits non-zero", () => {
    const { helpers } = makeHelpers(() => ({
      stdout: "",
      stderr: "powershell exploded",
      exitCode: 1,
    }));
    expect(() => helpers.keyDown("a")).toThrow(/exited 1: powershell exploded/);
  });

  // ---------------------------------------------------------- clipboard

  it("snapshot captures flavors+digest and restore round-trips the held text", () => {
    const readRecord =
      `{"type":"meta","sessionId":1}\n` +
      `{"type":"clipboard","ok":true,"empty":false,` +
      `"formats":[{"id":13,"name":"CF_UNICODETEXT"}],` +
      `"text":"prior text","textBytes":22}\n`;
    const { helpers, scripts } = makeHelpers((script) => {
      if (script.includes("$script:mode = 'read'")) return ok(readRecord);
      if (script.includes("$script:mode = 'write'")) {
        return ok(`{"type":"result","status":"WRITTEN","formats":["CF_UNICODETEXT"]}\n`);
      }
      return ok(postedResult());
    });
    const snap = helpers.snapshot();
    expect(snap.flavors).toEqual(["CF_UNICODETEXT"]);
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
    helpers.restore(snap);
    // The restore must have issued a write carrying the prior text.
    const writeScript = scripts.find((s) => s.includes("$script:mode = 'write'"));
    expect(writeScript).toBeDefined();
    const payload = JSON.parse(
      Buffer.from(embeddedB64(writeScript!, "payloadB64"), "base64").toString("utf8"),
    ) as { text: string };
    expect(payload.text).toBe("prior text");
  });

  it("restore of a snapshot this process did not create fails honestly", () => {
    const { helpers } = makeHelpers();
    const foreign: ClipboardSnapshot = {
      flavors: ["CF_UNICODETEXT"],
      sha256: "0".repeat(64),
      bytes: 4,
    };
    expect(() => helpers.restore(foreign)).toThrow(/not held by this process/);
  });

  it("clipboardWrite surfaces a non-WRITTEN result as failure", () => {
    const { helpers } = makeHelpers((script) => {
      if (script.includes("$script:mode = 'write'")) {
        return ok(`{"type":"result","status":"FAILED","detail":"busy"}\n`);
      }
      return ok(postedResult());
    });
    expect(() => helpers.clipboardWrite("x")).toThrow(/not confirmed: busy/);
  });

  // ------------------------------------------------------------------ IME

  it("imeSelect parses the mode string and posts an activate command", () => {
    const { helpers, scripts } = makeHelpers((script) => {
      if (script.includes("$script:mode = 'activate'")) {
        return ok(`{"type":"result","status":"ACTIVATED","hr":"0x00000000"}\n`);
      }
      return ok(postedResult());
    });
    helpers.imeSelect(IME_MODE);
    const script = scripts[0]!;
    expect(script).toContain(`$script:clsid = '${CLSID}'`);
    expect(script).toContain(`$script:guidProfile = '${PROFILE_GUID}'`);
    expect(script).toContain("$script:langid = 1041");
  });

  it("imeSelect rejects malformed modes and non-ACTIVATED results", () => {
    const { helpers, scripts } = makeHelpers(() =>
      ok(`{"type":"result","status":"ACTIVATE_FAILED","detail":"hr=0x80004005"}\n`),
    );
    expect(() => helpers.imeSelect("not-a-mode")).toThrow(/langid.*clsid.*guidProfile/);
    expect(() => helpers.imeSelect(IME_MODE)).toThrow(/was not activated/);
    expect(scripts).toHaveLength(1); // the rejected mode never reached the channel
  });

  it("imeCurrentMode maps ime-active records to the mode string", () => {
    const { helpers } = makeHelpers((script) => {
      if (script.includes("$script:mode = 'query'")) {
        return ok(
          `{"type":"meta","sessionId":1}\n` +
            `{"type":"ime-active","found":true,"langid":"0x0411",` +
            `"clsid":"${CLSID}","guidProfile":"${PROFILE_GUID}","hkl":"0x4110411"}\n`,
        );
      }
      return ok(postedResult());
    });
    expect(helpers.imeCurrentMode()).toEqual({ mode: IME_MODE });
  });

  it("imeCurrentMode reports null when TSF has no active profile", () => {
    const { helpers } = makeHelpers((script) => {
      if (script.includes("$script:mode = 'query'")) {
        return ok(`{"type":"ime-active","found":false}\n`);
      }
      return ok(postedResult());
    });
    expect(helpers.imeCurrentMode()).toEqual({ mode: null });
  });

  it("imeRestore(null) deactivates; imeRestore(mode) re-activates", () => {
    const scripts: string[] = [];
    const channel: WindowsInputChannel = (script) => {
      scripts.push(script);
      if (script.includes("$script:mode = 'deactivate'")) {
        return ok(`{"type":"result","status":"DEACTIVATED"}\n`);
      }
      if (script.includes("$script:mode = 'activate'")) {
        return ok(`{"type":"result","status":"ACTIVATED"}\n`);
      }
      return ok(postedResult());
    };
    const helpers = new WindowsInputHelpers({ platform: "win32", channel });
    helpers.restore(null);
    expect(scripts[0]).toContain("$script:mode = 'deactivate'");
    helpers.restore(IME_MODE);
    expect(scripts[1]).toContain("$script:mode = 'activate'");
  });

  it("imeListProfiles parses enumerated profiles and validates langid", () => {
    const { helpers } = makeHelpers((script) => {
      if (script.includes("$script:mode = 'list'")) {
        return ok(
          `{"type":"meta","sessionId":1}\n` +
            `{"type":"ime-profile","dwProfileType":1,"langid":"0x0411",` +
            `"clsid":"${CLSID}","guidProfile":"${PROFILE_GUID}","hkl":"0x4110411"}\n` +
            `{"type":"result","status":"LISTED","count":1}\n`,
        );
      }
      return ok(postedResult());
    });
    const profiles = helpers.imeListProfiles(0x0411);
    expect(profiles).toEqual([
      { langid: "0x0411", clsid: CLSID, guidProfile: PROFILE_GUID, dwProfileType: 1 },
    ]);
    expect(() => helpers.imeListProfiles(0x1_0000)).toThrow(TypeError);
  });

  // ---------------------------------------------------------------- focus

  it("readFocusHolder maps the focus record to a FocusHolder", () => {
    const { helpers } = makeHelpers((script) => {
      if (script.includes("$script:mode = 'read'")) {
        return ok(
          `{"type":"meta","sessionId":1}\n` +
            `{"type":"focus","ok":true,"pid":777,"app":"AfterFX",` +
            `"uiaAutomationId":"searchBox","sessionMatch":true}\n`,
        );
      }
      return ok(postedResult());
    });
    expect(helpers.readFocusHolder()).toEqual({
      pid: 777,
      element: "searchBox",
      app: "AfterFX",
      observedAt: expect.any(String),
    });
  });

  it("readFocusHolder returns null on session mismatch or missing focus", () => {
    const foreign = makeHelpers((script) => {
      if (script.includes("$script:mode = 'read'")) {
        return ok(`{"type":"focus","ok":true,"pid":777,"sessionMatch":false}\n`);
      }
      return ok(postedResult());
    });
    expect(foreign.helpers.readFocusHolder()).toBeNull();
    const none = makeHelpers((script) => {
      if (script.includes("$script:mode = 'read'")) {
        return ok(`{"type":"focus","ok":false,"error":"no desktop"}\n`);
      }
      return ok(postedResult());
    });
    expect(none.helpers.readFocusHolder()).toBeNull();
  });

  it("requestFocus throws on NOT_FOUND/UNVERIFIED and passes on FOREGROUND_ONLY", () => {
    const notFound = makeHelpers((script) => {
      if (script.includes("$script:mode = 'set'")) {
        return ok(
          `{"type":"result","status":"NOT_FOUND","detail":"no window"}\n` +
            `{"type":"focus","ok":true,"pid":1,"sessionMatch":true}\n`,
        );
      }
      return ok(postedResult());
    });
    expect(() => notFound.helpers.requestFocus({ pid: 9, element: null })).toThrow(/not confirmed/);
    const foreground = makeHelpers((script) => {
      if (script.includes("$script:mode = 'set'")) {
        return ok(
          `{"type":"result","status":"FOREGROUND_ONLY","detail":"window-level"}\n` +
            `{"type":"focus","ok":true,"pid":9,"sessionMatch":true}\n`,
        );
      }
      return ok(postedResult());
    });
    expect(() =>
      foreground.helpers.requestFocus({ pid: 9, element: null }),
    ).not.toThrow();
  });
});

// ------------------------------------------- optional PowerShell parse check

function findPwsh(): string | null {
  for (const candidate of ["pwsh", "powershell"]) {
    try {
      execFileSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

const PWSH = findPwsh();

function psParseErrors(shell: string, scriptPath: string): number {
  const out = execFileSync(
    shell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$t=$null;$e=$null;" +
        `[void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}',[ref]$t,[ref]$e);` +
        "$e.Count",
    ],
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] },
  );
  return Number.parseInt(out.trim(), 10);
}

describe.skipIf(PWSH === null)("PowerShell parse check (requires pwsh/powershell)", () => {
  const scripts: Record<string, string> = {
    send: windowsInputSendScript(
      encodeWindowsInputSendEvents({
        events: [
          { type: "key", action: "down", vk: 0x41 },
          { type: "mouse", action: "wheel", wheelDelta: -1 },
        ],
      }),
    ),
    clipboardRead: windowsClipboardScript({ mode: "read" }),
    clipboardWrite: windowsClipboardScript({ mode: "write", text: "payload" }),
    imeQuery: windowsImeScript({ mode: "query" }),
    imeList: windowsImeScript({ mode: "list", langid: 0x0411 }),
    imeActivate: windowsImeScript({
      mode: "activate",
      langid: 0x0411,
      clsid: CLSID,
      guidProfile: PROFILE_GUID,
    }),
    imeDeactivate: windowsImeScript({ mode: "deactivate" }),
    focusRead: windowsFocusScript({ mode: "read" }),
    focusSet: windowsFocusScript({ mode: "set", pid: 1234, automationId: "x" }),
  };

  it("every generated script parses without errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "ae-a8n-psparse-"));
    try {
      for (const [name, script] of Object.entries(scripts)) {
        const path = join(dir, `${name}.ps1`);
        writeFileSync(path, script, "utf8");
        expect(psParseErrors(PWSH!, path), `${name} parse errors`).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
