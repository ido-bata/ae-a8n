import { describe, expect, it } from "vitest";
import {
  attributeAeByCensus,
  type CensusAttribution,
} from "../src/driver/supervision-session.js";
import type { MacAppInstance, MacSession } from "../src/driver/mac-session.js";

const uid = typeof process.getuid === "function" ? process.getuid() : 501;
const ASID = 4242;

function session(overrides: Partial<MacSession> = {}): MacSession {
  return { uid, username: "tester", asid: ASID, kind: "Aqua", ...overrides };
}

function app(overrides: Partial<MacAppInstance> = {}): MacAppInstance {
  return {
    name: "Adobe After Effects 2026",
    pid: 1234,
    uid,
    asid: ASID,
    ...overrides,
  };
}

function lister(apps: MacAppInstance[]) {
  return () => apps;
}

describe("attributeAeByCensus (#294)", () => {
  it("attributes the sole AE app instance in the caller's Aqua session", () => {
    const result = attributeAeByCensus(
      lister([app(), app({ name: "Safari", pid: 99 })]),
      session(),
    );
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.session.asid).toBe(ASID);
    expect(result!.verifyPid(1234)).toBe(true);
    expect(result!.verifyPid(9999)).toBe(false);
  });

  it("returns null when no AE instance exists", () => {
    expect(
      attributeAeByCensus(lister([app({ name: "Safari" })]), session()),
    ).toBeNull();
    expect(attributeAeByCensus(lister([]), session())).toBeNull();
  });

  it("fails closed on multiple AE instances — never guesses", () => {
    const result = attributeAeByCensus(
      lister([
        app({ pid: 1111, name: "Adobe After Effects 2026" }),
        app({ pid: 2222, name: "Adobe After Effects 2027" }),
      ]),
      session(),
    );
    expect(result).toBeNull();
  });

  it("ignores AE instances owned by other users or other sessions", () => {
    const result = attributeAeByCensus(
      lister([
        app({ uid: uid + 1 }),
        app({ pid: 2222, asid: ASID + 1 }),
      ]),
      session(),
    );
    expect(result).toBeNull();
  });

  it("requires an Aqua session with a proven session id", () => {
    const apps = lister([app()]);
    expect(
      attributeAeByCensus(apps, session({ kind: "Background" })),
    ).toBeNull();
    expect(attributeAeByCensus(apps, session({ asid: null }))).toBeNull();
    expect(
      attributeAeByCensus(apps, session({ uid: uid + 1 })),
    ).toBeNull();
  });

  it("verifyPid stops verifying when the pid is recycled by a non-AE app", () => {
    let apps: MacAppInstance[] = [app()];
    const mutable = () => apps;
    const result: CensusAttribution = attributeAeByCensus(mutable, session())!;
    expect(result.verifyPid(1234)).toBe(true);
    // AE exited and the pid now belongs to a different application.
    apps = [app({ name: "TextEdit", pid: 1234 })];
    expect(result.verifyPid(1234)).toBe(false);
  });

  it("verifyPid stops verifying when the AE instance moves sessions", () => {
    let apps: MacAppInstance[] = [app()];
    const result = attributeAeByCensus(() => apps, session())!;
    apps = [app({ asid: ASID + 9 })];
    expect(result.verifyPid(1234)).toBe(false);
  });

  it("matches the app name loosely enough for versioned names only", () => {
    const result = attributeAeByCensus(
      lister([app({ name: "After Effects" })]),
      session(),
    );
    expect(result).not.toBeNull();
    expect(
      attributeAeByCensus(lister([app({ name: "Adobe Photoshop 2026" })]), session()),
    ).toBeNull();
  });
});
