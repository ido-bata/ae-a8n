/**
 * Menu-bar surface contract tests (#360,
 * `specs/workspace-editing/spec.md` §5–§7).
 *
 * Everything here runs against scripted listing text and
 * `MenuSurfaceOps` fakes — the "scripted AX listing" the issue's AC
 * names. This proves the contract — enumeration, checkmark readback,
 * localized-title resolution and refusal, the mutate-gui gate and the
 * invoke verdict mapping — at `automated test` level. It does NOT prove
 * After Effects exposes its menu bar faithfully through System Events;
 * that stays unverified until a real-host run records it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MenuController, type MenuSurfaceOps } from "../src/menus/controller.js";
import { menuInvokeGate } from "../src/menus/gate.js";
import { parseMenuBarListing } from "../src/menus/parse.js";
import { resolveMenuItem } from "../src/menus/resolve.js";
import { INVOKE_MENU_ITEM_SCRIPT, LIST_MENU_BAR_SCRIPT } from "../src/menus/script.js";
import { MacMenuSurface } from "../src/menus/darwin.js";
import {
  MenuError,
  type MenuBarSnapshot,
} from "../src/menus/types.js";
import { menuBarForTarget, menuCapabilities } from "../src/api/menus.js";
import {
  GuiRecoveryError,
  type GuiLeaseController,
} from "../src/driver/gui-recovery.js";
import type { GuiLease } from "../src/platform/darwin/gui-lease.js";
import type { MacSession, SessionCommandResult } from "../src/driver/mac-session.js";

const PID = 4242;
const OBSERVED_AT = "2026-11-30T00:00:00.000Z";
const SESSION: MacSession = { uid: 502, username: "ae-test", asid: 100022, kind: "Aqua" };

/**
 * A scripted listing in the `LIST_MENU_BAR_SCRIPT` protocol: an app
 * menu, a File menu with a checked item, and a Window menu whose
 * Workspace submenu holds two workspace entries — the W1 shape.
 *
 * Record fields: `I|path|title|role|enabled|checked|mark|shortcut|kind`.
 */
const SCRIPTED_LISTING = [
  "MB|1|AE-A8N|AXMenuBarItem|1",
  "I|1,1|About AE-A8N|AXMenuItem|1|0|||item",
  "I|1,2||AXMenuItem|-|-|||separator",
  "MB|2|File|AXMenuBarItem|1",
  "I|2,1|New|AXMenuItem|1|0|||item",
  "I|2,2|Save|AXMenuItem|1|1|✓|s:1048576|item",
  "I|2,3|Import|AXMenuItem|1|0|||item",
  "MB|3|Window|AXMenuBarItem|1",
  "I|3,1|Minimize|AXMenuItem|1|-|||item",
  "I|3,2|Workspace|AXMenuItem|1|-|||submenu",
  "I|3,2,1|Standard|AXMenuItem|1|1|✓||item",
  "I|3,2,2|Motion|AXMenuItem|1|0|||item",
  "I|3,3|Bring All to Front|AXMenuItem|1|0|||item",
].join("\n");

function listing(overrides: Partial<MenuBarSnapshot> = {}): MenuBarSnapshot {
  return {
    ...parseMenuBarListing(SCRIPTED_LISTING, PID, OBSERVED_AT),
    ...overrides,
  };
}

function opsWith(
  snapshot: MenuBarSnapshot,
  invoke?: MenuSurfaceOps["invokeMenuItem"],
): MenuSurfaceOps {
  return {
    observeMenuBar: () => snapshot,
    invokeMenuItem: invoke ?? (() => "clicked" as const),
  };
}

/** Run `fn`, return the MenuError it threw (fails the test if none). */
function menuErrorOf(fn: () => unknown): MenuError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MenuError);
    return error as MenuError;
  }
  throw new Error("expected a MenuError, none was thrown");
}

async function menuErrorOfAsync(fn: () => Promise<unknown>): Promise<MenuError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MenuError);
    return error as MenuError;
  }
  throw new Error("expected a MenuError, none was thrown");
}

describe("parseMenuBarListing", () => {
  it("builds the menu-bar tree with checkmarks, shortcuts and submenus", () => {
    const snap = listing();
    expect(snap.available).toBe(true);
    expect(snap.menuBarItems.map((m) => m.title)).toEqual(["AE-A8N", "File", "Window"]);

    const file = snap.menuBarItems[1];
    expect(file?.items).toHaveLength(3);
    const save = file?.items[1];
    expect(save?.title).toBe("Save");
    expect(save?.check).toBe("checked");
    expect(save?.markChar).toBe("✓");
    expect(save?.shortcut).toBe("s:1048576");
    expect(save?.path).toEqual([2, 2]);
    expect(save?.kind).toBe("item");

    // The unnamed record is a separator.
    const app = snap.menuBarItems[0];
    expect(app?.items[1]?.kind).toBe("separator");
    expect(app?.items[1]?.title).toBe("");

    // Submenu children hang off the submenu node with extended paths.
    const window = snap.menuBarItems[2];
    const workspace = window?.items[1];
    expect(workspace?.kind).toBe("submenu");
    expect(workspace?.children.map((c) => c.title)).toEqual(["Standard", "Motion"]);
    expect(workspace?.children[0]?.path).toEqual([3, 2, 1]);
    expect(workspace?.children[0]?.check).toBe("checked");
    expect(workspace?.children[1]?.check).toBe("unchecked");
  });

  it("reports unreadable mark attributes as unknown, never guessed unchecked", () => {
    const snap = listing();
    const minimize = snap.menuBarItems[2]?.items[0];
    // "I|3,1|Minimize|...|1|-|..." — the "-" check field.
    expect(minimize?.check).toBe("unknown");
    expect(minimize?.markChar).toBeNull();
  });

  it("marks truncated listings honestly", () => {
    const snap = parseMenuBarListing(`${SCRIPTED_LISTING}\nTRUNCATED|1`, PID, OBSERVED_AT);
    expect(snap.truncated).toBe(true);
  });

  it("drops records whose parent never arrived", () => {
    const snap = parseMenuBarListing(
      "MB|1|File|AXMenuBarItem|1\n" +
        "I|1,1|Open|AXMenuItem|1|0|||item\n" +
        "I|9,9,1|Orphan|AXMenuItem|1|0|||item",
      PID,
      OBSERVED_AT,
    );
    const file = snap.menuBarItems[0];
    expect(file?.items).toHaveLength(1);
    expect(file?.items[0]?.title).toBe("Open");
  });
});

describe("resolveMenuItem", () => {
  it("resolves a direct item with its observed titles", () => {
    const resolved = resolveMenuItem(listing(), {
      menuPath: ["File"],
      itemTitle: "Save",
    });
    expect(resolved.node.path).toEqual([2, 2]);
    expect(resolved.titles).toEqual(["File", "Save"]);
    expect(resolved.node.check).toBe("checked");
  });

  it("resolves a nested submenu item", () => {
    const resolved = resolveMenuItem(listing(), {
      menuPath: ["Window", "Workspace"],
      itemTitle: "Standard",
    });
    expect(resolved.node.path).toEqual([3, 2, 1]);
    expect(resolved.titles).toEqual(["Window", "Workspace", "Standard"]);
  });

  it("refuses unsupported-locale when the menu path is absent", () => {
    // A Japanese AE shows 「ウィンドウ」, not "Window" — the expected path
    // is absent and the refusal names what was actually observed. There
    // is deliberately no coordinate fallback (spec §6).
    const error = menuErrorOf(() =>
      resolveMenuItem(listing(), { menuPath: ["表示"], itemTitle: "Minimize" }),
    );
    expect(error.code).toBe("unsupported-locale");
    expect(error.message).toContain("Window");
  });

  it("refuses unsupported-locale when a submenu in the path is absent", () => {
    const error = menuErrorOf(() =>
      resolveMenuItem(listing(), {
        menuPath: ["Window", "Layouts"],
        itemTitle: "Standard",
      }),
    );
    expect(error.code).toBe("unsupported-locale");
  });

  it("refuses unsupported-locale when the leaf title is absent", () => {
    const error = menuErrorOf(() =>
      resolveMenuItem(listing(), {
        menuPath: ["Window", "Workspace"],
        itemTitle: "Broadcast",
      }),
    );
    expect(error.code).toBe("unsupported-locale");
  });

  it("refuses ambiguous-target when two items share the title", () => {
    const dup = parseMenuBarListing(
      "MB|1|File|AXMenuBarItem|1\n" +
        "I|1,1|Save|AXMenuItem|1|0|||item\n" +
        "I|1,2|Save|AXMenuItem|1|0|||item",
      PID,
      OBSERVED_AT,
    );
    const error = menuErrorOf(() =>
      resolveMenuItem(dup, { menuPath: ["File"], itemTitle: "Save" }),
    );
    expect(error.code).toBe("ambiguous-target");
    expect(error.candidates.length).toBe(2);
  });

  it("refuses invalid-locator on an empty path or title", () => {
    expect(
      menuErrorOf(() => resolveMenuItem(listing(), { menuPath: [], itemTitle: "Save" }))
        .code,
    ).toBe("invalid-locator");
    expect(
      menuErrorOf(() => resolveMenuItem(listing(), { menuPath: ["File"], itemTitle: "" }))
        .code,
    ).toBe("invalid-locator");
  });

  it("does not resolve separators or submenu parents as leaves", () => {
    // "Workspace" is a submenu, not an invocable item.
    const error = menuErrorOf(() =>
      resolveMenuItem(listing(), { menuPath: ["Window"], itemTitle: "Workspace" }),
    );
    expect(error.code).toBe("unsupported-locale");
  });
});

describe("MenuController", () => {
  it("lists and resolves through one observation each", () => {
    const controller = new MenuController({ pid: PID, ops: opsWith(listing()) });
    const snap = controller.listMenuBar();
    expect(snap.menuBarItems).toHaveLength(3);
    const found = controller.findMenuItem({ menuPath: ["File"], itemTitle: "Import" });
    expect(found.node.path).toEqual([2, 3]);
    expect(found.observedAt).toBe(OBSERVED_AT);
  });

  it("readCheckState reports the observed mark verbatim", () => {
    const controller = new MenuController({ pid: PID, ops: opsWith(listing()) });
    const reading = controller.readCheckState({
      menuPath: ["Window", "Workspace"],
      itemTitle: "Standard",
    });
    expect(reading.check).toBe("checked");
    expect(reading.markChar).toBe("✓");
    expect(reading.resolved.titles).toEqual(["Window", "Workspace", "Standard"]);
  });

  it("invoke is refused by the fail-closed default when no gate is wired", async () => {
    const controller = new MenuController({ pid: PID, ops: opsWith(listing()) });
    const error = await menuErrorOfAsync(() =>
      controller.invoke({ menuPath: ["File"], itemTitle: "Save" }),
    );
    expect(error.code).toBe("refused");
  });

  it("the production gate refuses every invoke today", async () => {
    const controller = new MenuController({
      pid: PID,
      ops: opsWith(listing()),
      authorizeMutation: menuInvokeGate(),
    });
    const error = await menuErrorOfAsync(() =>
      controller.invoke({ menuPath: ["File"], itemTitle: "Save" }),
    );
    expect(error.code).toBe("refused");
    expect(error.message).toContain("A-SAFETY");
  });

  it("invoke re-resolves immediately before acting and passes path + observed titles", async () => {
    const seen: { path: readonly number[]; titles: readonly string[] }[] = [];
    const controller = new MenuController({
      pid: PID,
      ops: opsWith(listing(), (target) => {
        seen.push(target);
        return "clicked";
      }),
      authorizeMutation: () => ({ allowed: true }),
    });
    const result = await controller.invoke({
      menuPath: ["Window", "Workspace"],
      itemTitle: "Motion",
    });
    expect(result.resolved.node.path).toEqual([3, 2, 2]);
    expect(seen).toEqual([{ path: [3, 2, 2], titles: ["Window", "Workspace", "Motion"] }]);
  });

  it("maps a stale verdict to stale-locator — nothing was clicked", async () => {
    const controller = new MenuController({
      pid: PID,
      ops: opsWith(listing(), () => "changed"),
      authorizeMutation: () => ({ allowed: true }),
    });
    const error = await menuErrorOfAsync(() =>
      controller.invoke({ menuPath: ["File"], itemTitle: "Save" }),
    );
    expect(error.code).toBe("stale-locator");
  });

  it("maps a failed press to indeterminate — outcome unknown, no resend", async () => {
    const controller = new MenuController({
      pid: PID,
      ops: opsWith(listing(), () => "failed"),
      authorizeMutation: () => ({ allowed: true }),
    });
    const error = await menuErrorOfAsync(() =>
      controller.invoke({ menuPath: ["File"], itemTitle: "Save" }),
    );
    expect(error.code).toBe("indeterminate");
  });

  it("maps a thrown mutation error to indeterminate", async () => {
    const controller = new MenuController({
      pid: PID,
      ops: opsWith(listing(), () => {
        throw new Error("session command exploded");
      }),
      authorizeMutation: () => ({ allowed: true }),
    });
    const error = await menuErrorOfAsync(() =>
      controller.invoke({ menuPath: ["File"], itemTitle: "Save" }),
    );
    expect(error.code).toBe("indeterminate");
  });
});

describe("MacMenuSurface transport", () => {
  function fakeLease(): GuiLeaseController & { events: string[] } {
    const events: string[] = [];
    return {
      events,
      acquire(op: string) {
        events.push(`acquire:${op}`);
        return {
          release: () => events.push("release"),
        } as unknown as GuiLease;
      },
      audit(event) {
        events.push(`audit:${event.kind}:${event.op ?? ""}:${event.outcome ?? ""}`);
      },
    };
  }

  type SurfaceOptions = ConstructorParameters<typeof MacMenuSurface>[0];

  function surfaceWith(
    stdout: string,
    status = 0,
    extra: Partial<SurfaceOptions> = {},
  ): { surface: MacMenuSurface; lease: ReturnType<typeof fakeLease> } {
    const lease = fakeLease();
    const surface = new MacMenuSurface({
      session: SESSION,
      pid: PID,
      lease,
      // Read-only observer posture for transport tests: the session under
      // test is not the console, and the console owner is stubbed away.
      allowConsoleSession: true,
      consoleUid: () => -1,
      readTargetSession: () => SESSION,
      runSession: (): SessionCommandResult => ({
        status,
        stdout,
        stderr: status === 0 ? "" : "boom",
        timedOut: false,
      }),
      ...extra,
    });
    return { surface, lease };
  }

  it("lists the menu bar through osascript argv, audited as observe", () => {
    const { surface, lease } = surfaceWith(`${SCRIPTED_LISTING}\n`);
    const snap = surface.listMenuBar();
    expect(snap.available).toBe(true);
    expect(snap.menuBarItems.map((m) => m.title)).toEqual(["AE-A8N", "File", "Window"]);
    expect(lease.events).toContain("audit:observe:listMenuBar:");
  });

  it("passes the pid as argv, never spliced into script source", () => {
    let seenArgs: readonly string[] = [];
    const lease = fakeLease();
    const surface = new MacMenuSurface({
      session: SESSION,
      pid: PID,
      lease,
      allowConsoleSession: true,
      consoleUid: () => -1,
      readTargetSession: () => SESSION,
      runSession: (_s, _program, args): SessionCommandResult => {
        seenArgs = args;
        return { status: 0, stdout: "MISSING\n", stderr: "", timedOut: false };
      },
    });
    surface.listMenuBar();
    expect(seenArgs).toContain(String(PID));
    // The script lines themselves are `-e` arguments; the pid appears
    // only as a trailing argv element.
    expect(seenArgs[seenArgs.length - 1]).toBe(String(PID));
  });

  it("reports MISSING/NOMENUBAR as unavailable snapshots, not throws", () => {
    for (const word of ["MISSING", "NOMENUBAR"]) {
      const { surface } = surfaceWith(`${word}\n`);
      const snap = surface.listMenuBar();
      expect(snap.available).toBe(false);
      expect(snap.reason).toContain(word === "MISSING" ? "not visible" : "no menu bar");
    }
  });

  it("invokeMenuItem runs under the lease and audits performed only on CLICKED", () => {
    const { surface, lease } = surfaceWith("CLICKED\n");
    const verdict = surface.invokeMenuItem({
      path: [3, 2, 2],
      titles: ["Window", "Workspace", "Motion"],
    });
    expect(verdict).toBe("clicked");
    expect(lease.events).toContain("acquire:invokeMenuItem");
    expect(lease.events).toContain("audit:mutate:invokeMenuItem:performed");
    expect(lease.events).toContain("release");
  });

  it("passes the index path and observed titles as argv to the invoke script", () => {
    let seenArgs: readonly string[] = [];
    const surface = new MacMenuSurface({
      session: SESSION,
      pid: PID,
      lease: fakeLease(),
      allowConsoleSession: true,
      consoleUid: () => -1,
      readTargetSession: () => SESSION,
      runSession: (_s, _program, args): SessionCommandResult => {
        seenArgs = args;
        return { status: 0, stdout: "CLICKED\n", stderr: "", timedOut: false };
      },
    });
    surface.invokeMenuItem({ path: [3, 2, 2], titles: ["Window", "Workspace", "Motion"] });
    expect(seenArgs.slice(-3)).toEqual([
      String(PID),
      "3,2,2",
      "Window|Workspace|Motion",
    ]);
  });

  it("audits a CHANGED verdict as not-performed", () => {
    const { surface, lease } = surfaceWith("CHANGED\n");
    expect(surface.invokeMenuItem({ path: [2, 2], titles: ["File", "Save"] })).toBe(
      "changed",
    );
    expect(lease.events).toContain("audit:mutate:invokeMenuItem:not-performed");
  });

  it("maps FAILED to GuiMutationError — the outcome is unknown", () => {
    const { surface } = surfaceWith("FAILED\n");
    expect(() =>
      surface.invokeMenuItem({ path: [2, 2], titles: ["File", "Save"] }),
    ).toThrowError(/unknown/);
  });

  it("maps an unrecognized verdict to GuiMutationError, never a clean refusal", () => {
    const { surface } = surfaceWith("SOMETHING_ELSE\n");
    expect(() =>
      surface.invokeMenuItem({ path: [2, 2], titles: ["File", "Save"] }),
    ).toThrowError(/unrecognized verdict/);
  });

  it("refuses when the pid identity cannot be proven", () => {
    const { surface } = surfaceWith("CLICKED\n", 0, { verifyProcess: () => false });
    expect(() => surface.listMenuBar()).toThrowError(GuiRecoveryError);
    expect(() =>
      surface.invokeMenuItem({ path: [2, 2], titles: ["File", "Save"] }),
    ).toThrowError(GuiRecoveryError);
  });

  it("refuses the console session unless explicitly allowed", () => {
    const lease = fakeLease();
    expect(
      () =>
        new MacMenuSurface({
          session: SESSION,
          pid: PID,
          lease,
          consoleUid: () => SESSION.uid,
        }),
    ).toThrowError(/console session/);
  });
});

describe("api surface", () => {
  it("menuCapabilities reports Windows as unsupported, honestly", () => {
    const caps = menuCapabilities("win32");
    expect(caps.platform).toBe("win32");
    expect(caps.enumerate.support).toBe("unsupported");
    expect(caps.checkState.support).toBe("unsupported");
    expect(caps.invoke.support).toBe("unsupported");
  });

  it("menuCapabilities reports invoke as gate-pending on macOS", () => {
    const caps = menuCapabilities("darwin");
    expect(caps.enumerate.support).toBe("implemented");
    expect(caps.checkState.support).toBe("implemented");
    expect(caps.invoke.support).toBe("unavailable");
    expect(caps.invoke.reason).toContain("A-SAFETY");
  });

  it("menuBarForTarget refuses without an attested target", () => {
    const error = menuErrorOf(() => menuBarForTarget(null));
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("no owned After Effects");
  });
});

describe("script hygiene", () => {
  it("never splices caller data into AppleScript source", () => {
    // Every value the scripts need arrives through argv; the sources
    // contain no interpolation points.
    for (const script of [LIST_MENU_BAR_SCRIPT, INVOKE_MENU_ITEM_SCRIPT]) {
      const text = script.join("\n");
      expect(text).not.toContain("${");
      expect(text).toContain("item 1 of argv");
    }
  });

  it.runIf(process.platform === "darwin")(
    "compiles both menu scripts (osacompile proves syntax without touching AE)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "a8n-menu-osa-"));
      try {
        for (const [name, script] of Object.entries({
          "list-menu-bar": LIST_MENU_BAR_SCRIPT,
          "invoke-menu-item": INVOKE_MENU_ITEM_SCRIPT,
        })) {
          const source = join(dir, `${name}.applescript`);
          writeFileSync(source, `${script.join("\n")}\n`);
          expect(
            () =>
              execFileSync("osacompile", ["-o", join(dir, `${name}.scpt`), source], {
                stdio: "pipe",
              }),
            `${name} does not compile`,
          ).not.toThrow();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
