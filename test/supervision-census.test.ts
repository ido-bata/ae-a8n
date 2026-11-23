import { describe, expect, it } from "vitest";
import {
  attributeAeByCensus,
  type CensusAttribution,
} from "../src/driver/supervision-session.js";
import type { MacAppInstance, MacSession } from "../src/driver/mac-session.js";

// Fixed uid: the census contract compares the session uid against the
// process uid, which tests inject explicitly so the suite runs identically
// on hosts where `process.getuid` does not exist (Windows).
const UID = 501;
const ASID = 4242;

function session(overrides: Partial<MacSession> = {}): MacSession {
  return { uid: UID, username: "tester", asid: ASID, kind: "Aqua", ...overrides };
}

function app(overrides: Partial<MacAppInstance> = {}): MacAppInstance {
  return {
    name: "Adobe After Effects 2026",
    pid: 1234,
    uid: UID,
    asid: ASID,
    ...overrides,
  };
}

function lister(apps: MacAppInstance[]) {
  return () => apps;
}

function attribute(
  list: () => MacAppInstance[],
  sess: MacSession = session(),
): CensusAttribution | null {
  return attributeAeByCensus(list, sess, UID);
}

describe("attributeAeByCensus (#294)", () => {
  it("attributes the sole AE app instance in the caller's Aqua session", () => {
    const result = attribute(
      lister([app(), app({ name: "Safari", pid: 99 })]),
    );
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
    expect(result!.session.asid).toBe(ASID);
    expect(result!.verifyPid(1234)).toBe(true);
    expect(result!.verifyPid(9999)).toBe(false);
  });

  it("returns null when no AE instance exists", () => {
    expect(attribute(lister([app({ name: "Safari" })]))).toBeNull();
    expect(attribute(lister([]))).toBeNull();
  });

  it("fails closed on multiple AE instances — never guesses", () => {
    const result = attribute(
      lister([
        app({ pid: 1111, name: "Adobe After Effects 2026" }),
        app({ pid: 2222, name: "Adobe After Effects 2027" }),
      ]),
    );
    expect(result).toBeNull();
  });

  it("ignores AE instances owned by other users or other sessions", () => {
    const result = attribute(
      lister([app({ uid: UID + 1 }), app({ pid: 2222, asid: ASID + 1 })]),
    );
    expect(result).toBeNull();
  });

  it("requires an Aqua session with a proven session id", () => {
    const apps = lister([app()]);
    expect(attribute(apps, session({ kind: "Background" }))).toBeNull();
    expect(attribute(apps, session({ asid: null }))).toBeNull();
    expect(attribute(apps, session({ uid: UID + 1 }))).toBeNull();
  });

  it("verifyPid stops verifying when the pid is recycled by a non-AE app", () => {
    let apps: MacAppInstance[] = [app()];
    const result: CensusAttribution = attribute(() => apps)!;
    expect(result.verifyPid(1234)).toBe(true);
    // AE exited and the pid now belongs to a different application.
    apps = [app({ name: "TextEdit", pid: 1234 })];
    expect(result.verifyPid(1234)).toBe(false);
  });

  it("verifyPid stops verifying when the AE instance moves sessions", () => {
    let apps: MacAppInstance[] = [app()];
    const result = attribute(() => apps)!;
    apps = [app({ asid: ASID + 9 })];
    expect(result.verifyPid(1234)).toBe(false);
  });

  it("matches the app name loosely enough for versioned names only", () => {
    const result = attribute(lister([app({ name: "After Effects" })]));
    expect(result).not.toBeNull();
    expect(
      attribute(lister([app({ name: "Adobe Photoshop 2026" })])),
    ).toBeNull();
  });

  it("does not count helpers that merely mention After Effects in their name", () => {
    // Real-host observation: Safari autofill helpers are named
    // "自動入力（After Effects）" and would previously inflate the
    // candidate count into a false ambiguity — or worse, be attributed.
    const result = attribute(
      lister([
        app({ name: "After Effects", bundleId: "com.adobe.AfterEffects.application" }),
        app({
          name: "自動入力（After Effects）",
          pid: 64632,
          bundleId: "com.apple.SafariPlatformSupport.Helper",
        }),
        app({
          name: "Adobe TeamProjectsLocalHub 2027",
          pid: 64613,
          bundleId: "com.adobe.TeamProjectsLocalHub.application",
        }),
      ]),
    );
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(1234);
  });

  it("a non-AE bundle id disqualifies even an AE-looking name", () => {
    const result = attribute(
      lister([app({ name: "After Effects", bundleId: "com.example.Impostor" })]),
    );
    expect(result).toBeNull();
  });
});
