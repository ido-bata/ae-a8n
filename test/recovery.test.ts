/**
 * What the driver does when an operation times out and a recovery unblocks
 * the host.
 *
 * The rule under test: the operation that timed out is **not** sent again.
 * A timeout says the answer did not arrive in time, not that the work was
 * abandoned — the request may still be running inside After Effects, and
 * sending it twice would run it twice.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AeDriver, TimeoutError } from "../src/driver/driver.js";
import type { GuiWindowInfo } from "../src/driver/gui-recovery.js";
import {
  KNOWN_DIALOG_CLASSES,
  chooseRecoveryWindow,
  classifyDialog,
  type HostRecovery,
} from "../src/driver/recovery.js";
import type { HostOwnership, HostTransport, InvokeOptions } from "../src/driver/transport.js";
import { TraceRecorder } from "../src/trace/trace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-recovery-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A host that never answers by itself: the request is accepted and the
 * result appears only when the test says so.
 */
class BlockedTransport implements HostTransport {
  readonly kind = "blocked";
  invocations = 0;
  /** The id of the request that is waiting. */
  pendingId: string | null = null;

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async launch(): Promise<void> {
    // Nothing to start.
  }

  invoke(_entryScriptPath: string, _options?: InvokeOptions): Promise<void> {
    this.invocations += 1;
    // The request file holds the id the driver will wait for.
    const inbox = join(root, "inbox");
    const file = readdirSync(inbox).find((name) => name.endsWith(".request.json"));
    this.pendingId = file === undefined ? null : file.replace(".request.json", "");
    // The result is never written here: the host is blocked.
    return Promise.resolve();
  }

  ownership(): HostOwnership {
    return { kind: "owned", evidence: "blocked test host" };
  }

  /** The blocked host finishes the request it already has. */
  finish(result: unknown): void {
    this.#write({ v: 1, id: this.#pending(), ok: true, durationMs: 1, result });
  }

  /** The blocked host finishes the request with an error of its own. */
  finishError(message: string): void {
    this.#write({
      v: 1,
      id: this.#pending(),
      ok: false,
      durationMs: 1,
      error: { name: "Error", message },
    });
  }

  /** The blocked host leaves a result file that is never whole. */
  finishUnparseable(): void {
    const id = this.#pending();
    writeFileSync(join(root, "outbox", `${id}.result.json`), '{"v":1,"id":"');
  }

  #pending(): string {
    if (this.pendingId === null) {
      throw new Error("no request is pending");
    }
    return this.pendingId;
  }

  #write(envelope: unknown): void {
    const id = this.#pending();
    writeFileSync(join(root, "outbox", `${id}.result.json`), JSON.stringify(envelope));
  }

  close(): Promise<void> {
    // Nothing to close.
    return Promise.resolve();
  }
}

function startDriver(transport: HostTransport, recovery?: HostRecovery): AeDriver {
  const trace = new TraceRecorder({ file: join(root, "trace.jsonl") });
  const driver = new AeDriver({
    transport,
    sessionRoot: root,
    trace,
    defaultTimeoutMs: 200,
    ...(recovery === undefined ? {} : { recovery, recoveryGraceMs: 800 }),
  });
  return driver;
}

describe("a timeout followed by a recovery", () => {
  it("waits for the original request instead of sending it again", async () => {
    const transport = new BlockedTransport();
    let attempts = 0;
    const recovery: HostRecovery = {
      attempt: () => {
        attempts += 1;
        // Closing the dialog lets the host finish the request it already has.
        transport.finish({ version: "26.5x89" });
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    const info = await driver.call<{ version: string }>("app.info", {});
    expect(info.version).toBe("26.5x89");
    expect(attempts).toBe(1);
    // One request, one invocation: the operation was not repeated.
    expect(transport.invocations).toBe(1);
  });

  it("reports the timeout when the recovery does not help", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => Promise.resolve({ recovered: false, evidence: "no dialog was found" }),
    };
    const driver = startDriver(transport, recovery);
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    expect(transport.invocations).toBe(1);
  });

  it("reports a quarantined state instead of a timeout", async () => {
    // A licence, sign-in or permission dialog is a human's decision. The run
    // must stop and say so; reporting a timeout invites the caller to retry
    // the one state the policy refuses to press through.
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({
          recovered: false,
          outcome: "quarantined",
          code: "A8N-SEC-001",
          evidence: "a licence dialog is open; nothing was pressed",
        }),
    };
    const driver = startDriver(transport, recovery);
    const error = (await driver.call("app.info", {}).catch((reason: unknown) => reason)) as {
      name?: string;
      code?: string;
      message: string;
    };
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect(error.code).toBe("A8N-SEC-001");
    expect(error.message).toContain("licence dialog");
    // The operation was not sent again.
    expect(transport.invocations).toBe(1);
  });

  it("does not repeat the operation when the recovery only half worked", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () =>
        Promise.resolve({ recovered: true, evidence: "pressed OK, but the host stayed quiet" }),
    };
    const driver = startDriver(transport, recovery);
    await expect(driver.call("app.info", {})).rejects.toBeInstanceOf(TimeoutError);
    // The request was sent once; the recovery waited for its result and gave up.
    expect(transport.invocations).toBe(1);
  });

  it("reports the host's own error, not a timeout, when the host answers after the recovery", async () => {
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => {
        // The dialog was the only thing blocking the host; once it is closed
        // the request finishes, and it fails on its own terms.
        transport.finishError("the project was not open");
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    const error = await driver.call("app.info", {}).catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toMatch(/the project was not open/);
    // Still one request: the answer belongs to it, it was not sent again.
    expect(transport.invocations).toBe(1);
  });

  it("keeps the timeout when the result file is never readable", async () => {
    // An unreadable result is a publication problem, not the host's answer.
    // Reporting ProtocolError here would replace the timeout with a less
    // useful error; the host never answered.
    const transport = new BlockedTransport();
    const recovery: HostRecovery = {
      attempt: () => {
        transport.finishUnparseable();
        return Promise.resolve({ recovered: true, evidence: "closed the dialog" });
      },
    };
    const driver = startDriver(transport, recovery);
    const error = await driver.call("app.info", {}).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(transport.invocations).toBe(1);
  });
});

describe("which window a recovery may act on", () => {
  const dialog = (title: string, text = ""): GuiWindowInfo => ({
    title,
    role: "AXWindow",
    subrole: "AXDialog",
    buttons: [{ title: "OK", description: "", position: null, size: null }],
    texts: text.length === 0 ? [] : [text],
  });

  /**
   * The one class measured on a real host (docs/offstage-macos.md §10.14):
   * `ui.alert` is an AXDialog with an empty title and the run's own
   * `ae-a8n:` message among its static texts.
   */
  const measuredAlert = (message = "ae-a8n: close me"): GuiWindowInfo => dialog("", message);

  it("does nothing when no window is blocking the host", () => {
    const windows: GuiWindowInfo[] = [
      { title: "Project", role: "AXWindow", subrole: "AXStandardWindow", buttons: [], texts: [] },
    ];
    expect(chooseRecoveryWindow(windows)).toEqual({ kind: "none" });
  });

  it("acts only on the measured ae-a8n alert", () => {
    expect(KNOWN_DIALOG_CLASSES.length).toBeGreaterThan(0);
    expect(classifyDialog(measuredAlert())?.name).toBe("ae-a8n ui.alert");
    // An ordinary-looking AE dialog has not been measured, whatever its title.
    expect(classifyDialog(dialog("Script"))).toBeNull();
    expect(classifyDialog(dialog("警告"))).toBeNull();
  });

  it("addresses the measured alert by its listing index", () => {
    const windows: GuiWindowInfo[] = [
      { title: "Project", role: "AXWindow", subrole: "AXStandardWindow", buttons: [], texts: [] },
      measuredAlert(),
    ];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("known");
    if (choice.kind !== "known") return;
    // 1-based: the standard window above it must be skipped.
    expect(choice.index).toBe(2);
    expect(choice.window.title).toBe("");
    expect(choice.blockingCount).toBe(1);
    expect(choice.dialogClass).toBe("ae-a8n ui.alert");
  });

  it("quarantines an unclassified blocking window and reports A8N-SEC-001", () => {
    // "警告" is AE's start-up modal. Its AX title is empty too, but what it
    // says is a sign-in, licence or script-permission decision. Pressing OK
    // would decide it for the human; an allow list must not contain it.
    const windows: GuiWindowInfo[] = [dialog("警告", "スクリプトを実行するには許可が必要です")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("quarantine");
    if (choice.kind !== "quarantine") return;
    expect(choice.index).toBe(1);
    expect(choice.code).toBe("A8N-SEC-001");
  });

  it("presses nothing when a measured dialog is followed by an unclassified one", () => {
    // Acting on the first window would still leave the unknown state behind
    // the press, and the next press could land on it.
    const windows: GuiWindowInfo[] = [measuredAlert(), dialog("Script")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("quarantine");
    if (choice.kind !== "quarantine") return;
    expect(choice.index).toBe(2);
  });

  it("presses nothing anywhere when a sign-in window is among the blockers", () => {
    // The Japanese wording is what the session shows; an English-only match
    // would have pressed OK on the visible dialog while the licence prompt
    // stayed underneath it.
    const windows: GuiWindowInfo[] = [dialog("警告", "Creative Cloud にサインインしてください"), dialog("Script")];
    const choice = chooseRecoveryWindow(windows);
    expect(choice.kind).toBe("human-only");
    if (choice.kind !== "human-only") return;
    expect(choice.index).toBe(1);
  });

  it("refuses when a licence window comes after an ordinary dialog", () => {
    const windows: GuiWindowInfo[] = [dialog("Script"), dialog("ライセンスの確認")];
    expect(chooseRecoveryWindow(windows).kind).toBe("human-only");
  });

  it("does not let the measured prefix hide an account prompt", () => {
    // Both rules apply: the window is unclassified for a human decision even
    // if its agent-supplied text starts with the prefix.
    const windows: GuiWindowInfo[] = [measuredAlert("ae-a8n: sign in to Adobe ID")];
    expect(chooseRecoveryWindow(windows).kind).toBe("human-only");
  });
});
