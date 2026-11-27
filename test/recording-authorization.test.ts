/**
 * Recording authorization grant + privacy scope (#383, spec
 * `specs/gui-evidence/spec.md` §5.6/§5.7/§7, E2c). Drives
 * `RecordingController` with the DEFAULT authorizer (no
 * `authorizeRecording` seam) — the §5.7 grant mechanism — plus a fake
 * `ScreenRecorder`.
 *
 * Level: automated test / fake only — temp-dir file I/O and injected
 * seams; no OS calls, no After Effects, nothing here has run against a
 * real host. The grant is caller-side consent, never authentication
 * (ADR-0007).
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GuiEvidenceIndex } from "../src/evidence/index.js";
import {
  RecordingController,
  recordingAuthorizationCovers,
  recordingScopeAuthorizer,
  parseRecordingAuthorization,
  type RecorderHandle,
  type RecorderStartRequest,
  type ScreenRecorder,
} from "../src/evidence/recording.js";
import type {
  CaptureScope,
  EvidenceIndexSession,
  RecordingAuthorization,
} from "../src/evidence/types.js";
import type { PanelTarget } from "../src/panels/types.js";

let root: string;
let artifactsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a8n-rec-auth-"));
  artifactsDir = join(root, "artifacts");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function session(overrides: Partial<EvidenceIndexSession> = {}): EvidenceIndexSession {
  return {
    pid: 4242,
    processStartIdentity: "pid-start:1700000000000",
    sessionId: "42",
    sessionKind: "isolated",
    sessionRoot: root,
    adapter: "fake",
    ...overrides,
  };
}

const DISPLAY_SCOPE: CaptureScope = { kind: "display", displayId: "1" };
const SESSION_SCOPE: CaptureScope = { kind: "session", sessionKind: "isolated" };

const PANEL: PanelTarget = {
  pid: 4242,
  resolvedAt: "2026-01-01T00:00:00.000Z",
  surface: {
    kind: "window",
    windowIndex: 1,
    windowNumber: 77,
    locator: { windowNumber: 77 },
    frame: { x: 10, y: 20, width: 300, height: 200 },
    state: { onScreen: true, occluded: "unknown" },
    attribution: "owned",
  },
};
const WINDOW_SCOPE: CaptureScope = { kind: "window", window: PANEL };

const GRANT_DISPLAY_ISOLATED: RecordingAuthorization = {
  scopes: ["display"],
  sessionKinds: ["isolated"],
  grantedBy: "test-policy",
};

class FakeRecorder implements ScreenRecorder {
  readonly tool = "fake-recorder";
  readonly fileExtension = ".mov";
  readonly requests: RecorderStartRequest[] = [];
  /** When set, `start` reports this actualScope (requested ≠ delivered). */
  actualScope: CaptureScope | undefined;
  unhonored: string[] = [];

  start(request: RecorderStartRequest) {
    this.requests.push(request);
    writeFileSync(request.filePath, `fake-video:${request.segmentId}`);
    const handle: RecorderHandle = { pid: null, filePath: request.filePath };
    return Promise.resolve({
      handle,
      ...(this.actualScope === undefined ? {} : { actualScope: this.actualScope }),
      ...(this.unhonored.length === 0
        ? {}
        : { unhonoredExclusions: [...this.unhonored] }),
    });
  }

  stop(): Promise<{ exited: boolean; exitCode: number | null }> {
    return Promise.resolve({ exited: true, exitCode: 0 });
  }

  probe(filePath: string) {
    return Promise.resolve(
      existsSync(filePath)
        ? { exists: true, bytes: 23, playable: true }
        : { exists: false, bytes: null, playable: false },
    );
  }
}

function controller(
  recorder: ScreenRecorder | null,
  overrides: Partial<ConstructorParameters<typeof RecordingController>[0]> = {},
): RecordingController {
  return new RecordingController({
    artifactsDir,
    session: session(),
    recorder: recorder ?? (() => null),
    ...overrides,
  });
}

function loadIndex(): GuiEvidenceIndex {
  const loaded = GuiEvidenceIndex.load(artifactsDir);
  expect(loaded).not.toBeNull();
  return loaded!;
}

describe("§5.7 grant parsing and coverage", () => {
  it("parses a well-formed grant and snapshots its arrays", () => {
    const scopes = ["display" as const];
    const sessionKinds = ["isolated" as const];
    const grant = parseRecordingAuthorization({
      scopes,
      sessionKinds,
      grantedBy: "policy-x",
    });
    expect(grant).toEqual({
      scopes: ["display"],
      sessionKinds: ["isolated"],
      grantedBy: "policy-x",
    });
    // Snapshot: mutating the caller's arrays cannot widen the grant.
    scopes.push("session" as never);
    sessionKinds.push("console" as never);
    expect(grant?.scopes).toEqual(["display"]);
    expect(grant?.sessionKinds).toEqual(["isolated"]);
  });

  it("rejects malformed grants", () => {
    expect(parseRecordingAuthorization(null)).toBeNull();
    expect(parseRecordingAuthorization("display")).toBeNull();
    expect(parseRecordingAuthorization({ scopes: "display", sessionKinds: [] })).toBeNull();
    expect(
      parseRecordingAuthorization({ scopes: ["everything"], sessionKinds: ["isolated"] }),
    ).toBeNull();
    expect(
      parseRecordingAuthorization({ scopes: ["display"], sessionKinds: ["root"] }),
    ).toBeNull();
    expect(
      parseRecordingAuthorization({
        scopes: ["display"],
        sessionKinds: ["isolated"],
        grantedBy: 42,
      }),
    ).toBeNull();
  });

  it("coverage is conjunctive over scope kind AND session kind", () => {
    const grant = GRANT_DISPLAY_ISOLATED;
    expect(recordingAuthorizationCovers(grant, "display", "isolated")).toBe(true);
    expect(recordingAuthorizationCovers(grant, "display", "console")).toBe(false);
    expect(recordingAuthorizationCovers(grant, "session", "isolated")).toBe(false);
    expect(recordingAuthorizationCovers(grant, "window", "isolated")).toBe(false);
    // "unknown" must be named explicitly.
    const unknownGrant: RecordingAuthorization = {
      scopes: ["window"],
      sessionKinds: ["unknown"],
    };
    expect(recordingAuthorizationCovers(unknownGrant, "window", "unknown")).toBe(true);
    expect(recordingAuthorizationCovers(unknownGrant, "window", "attached")).toBe(false);
  });

  it("the default authorizer refuses absent/malformed/non-covering grants", () => {
    expect(
      recordingScopeAuthorizer({ scope: DISPLAY_SCOPE, sessionKind: "isolated" }),
    ).toContain("authorization grant");
    expect(
      recordingScopeAuthorizer({
        scope: DISPLAY_SCOPE,
        sessionKind: "isolated",
        grant: { scopes: ["session"], sessionKinds: ["isolated"] },
      }),
    ).toContain("does not cover");
    expect(
      recordingScopeAuthorizer({
        scope: DISPLAY_SCOPE,
        sessionKind: "isolated",
        grant: { scopes: ["display"], sessionKinds: ["console"] },
      }),
    ).toContain("does not cover");
    expect(
      recordingScopeAuthorizer({
        scope: DISPLAY_SCOPE,
        sessionKind: "isolated",
        // @ts-expect-error — JS callers can pass garbage; the authorizer must refuse
        grant: { scopes: "display" },
      }),
    ).toContain("malformed");
    expect(
      recordingScopeAuthorizer({
        scope: DISPLAY_SCOPE,
        sessionKind: "isolated",
        grant: GRANT_DISPLAY_ISOLATED,
      }),
    ).toBeNull();
  });
});

describe("authorization gate on record.start", () => {
  it("refuses display scope without a grant and records the gap", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder); // default authorizer, no seam
    await expect(ctl.start(DISPLAY_SCOPE)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(recorder.requests).toHaveLength(0);
    const doc = loadIndex().document;
    expect(doc.gaps.unrecorded.some((g) => g.includes("authorization grant"))).toBe(true);
    expect(doc.segments).toHaveLength(0);
  });

  it("refuses session scope without a grant even on an isolated session", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder);
    await expect(ctl.start(SESSION_SCOPE)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(recorder.requests).toHaveLength(0);
  });

  it("starts display scope with a covering grant; grant + leakage are recorded", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder);
    const rec = await ctl.start(DISPLAY_SCOPE, {
      authorization: GRANT_DISPLAY_ISOLATED,
    });
    expect(rec.id).toBe("seg-001");
    expect(recorder.requests).toHaveLength(1);

    const result = await ctl.stop(rec.id);
    const segment = result.segment;
    expect(segment.authorization).toEqual(GRANT_DISPLAY_ISOLATED);

    const doc = loadIndex().document;
    const artifact = doc.artifacts.find((a) => a.id === "seg-001");
    expect(artifact?.leakage).toBe("full-display");
    expect(artifact?.scope?.kind).toBe("display");
  });

  it("starts session scope with a covering grant; artifact leakage is full-session", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder);
    const rec = await ctl.start(SESSION_SCOPE, {
      authorization: {
        scopes: ["session"],
        sessionKinds: ["isolated"],
        grantedBy: "session-recording-policy",
      },
    });
    await ctl.stop(rec.id);
    const artifact = loadIndex().document.artifacts.find((a) => a.id === "seg-001");
    expect(artifact?.leakage).toBe("full-session");
  });

  it("refuses when the grant covers the scope but not the session kind", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      session: session({ sessionKind: "console" }),
    });
    await expect(
      ctl.start(DISPLAY_SCOPE, { authorization: GRANT_DISPLAY_ISOLATED }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(recorder.requests).toHaveLength(0);
    const doc = loadIndex().document;
    expect(doc.gaps.unrecorded.some((g) => g.includes("does not cover"))).toBe(true);
  });

  it("refuses a non-covering grant on a shared session even for window scope", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      session: session({ sessionKind: "attached" }),
      acquireLease: () => ({ release: () => {} }),
    });
    // Grant names window but only "isolated" — attached is not covered.
    await expect(
      ctl.start(WINDOW_SCOPE, {
        authorization: { scopes: ["window"], sessionKinds: ["isolated"] },
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(recorder.requests).toHaveLength(0);
  });

  it("window scope on a shared session starts with a conjunctive grant + lease", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      session: session({ sessionKind: "console" }),
      acquireLease: () => ({ release: () => {} }),
    });
    const rec = await ctl.start(WINDOW_SCOPE, {
      authorization: {
        scopes: ["window", "display"],
        sessionKinds: ["console"],
        grantedBy: "console-recording-policy",
      },
    });
    await ctl.stop(rec.id);
    const segment = loadIndex().document.segments.find((s) => s.id === rec.id);
    expect(segment?.authorization?.sessionKinds).toEqual(["console"]);
    expect(recorder.requests).toHaveLength(1);
  });

  it("isolated window/region scopes relax — no grant needed", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      acquireLease: () => ({ release: () => {} }),
    });
    const rec = await ctl.start(WINDOW_SCOPE);
    await ctl.stop(rec.id);
    const segment = loadIndex().document.segments.find((s) => s.id === rec.id);
    expect(segment?.authorization).toBeUndefined();
  });

  it("a grant supplied for a non-gated scope is not recorded as authorization", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder, {
      acquireLease: () => ({ release: () => {} }),
    });
    const rec = await ctl.start(WINDOW_SCOPE, {
      authorization: GRANT_DISPLAY_ISOLATED, // irrelevant but harmless
    });
    await ctl.stop(rec.id);
    const segment = loadIndex().document.segments.find((s) => s.id === rec.id);
    expect(segment?.authorization).toBeUndefined();
  });

  it("the recorded grant is a snapshot — later caller mutation cannot widen it", async () => {
    const recorder = new FakeRecorder();
    const ctl = controller(recorder);
    const mutable: RecordingAuthorization = {
      scopes: ["display"],
      sessionKinds: ["isolated"],
    };
    const rec = await ctl.start(DISPLAY_SCOPE, { authorization: mutable });
    // Caller widens the grant after start — the segment must not follow.
    (mutable.scopes as string[]).push("session");
    (mutable.sessionKinds as string[]).push("console");
    await ctl.stop(rec.id);
    const segment = loadIndex().document.segments.find((s) => s.id === rec.id);
    expect(segment?.authorization?.scopes).toEqual(["display"]);
    expect(segment?.authorization?.sessionKinds).toEqual(["isolated"]);
  });
});

describe("exclusions and delivered-scope honesty", () => {
  it("unhonored exclusions land on the segment AND the index gaps", async () => {
    const recorder = new FakeRecorder();
    recorder.unhonored = ["window exclusion (com.example.Secret) cannot be honored"];
    const ctl = controller(recorder, {
      acquireLease: () => ({ release: () => {} }),
    });
    const rec = await ctl.start(WINDOW_SCOPE, {
      exclude: [{ kind: "window", predicate: "com.example.Secret" }],
    });
    await ctl.stop(rec.id);

    const doc = loadIndex().document;
    const segment = doc.segments.find((s) => s.id === rec.id);
    expect(segment?.exclude).toEqual([
      { kind: "window", predicate: "com.example.Secret" },
    ]);
    expect(segment?.unhonoredExclusions).toEqual(recorder.unhonored);
    expect(
      doc.gaps.uncapturable.some((g) => g.includes("exclusion not honored")),
    ).toBe(true);
  });

  it("requested window → delivered display records actualScope and full-display leakage", async () => {
    // The screencapture -V fallback shape: whole-display delivery for a
    // window ask. requested ≠ delivered must be explicit (spec §5.2).
    const recorder = new FakeRecorder();
    recorder.actualScope = { kind: "display" };
    const ctl = controller(recorder, {
      acquireLease: () => ({ release: () => {} }),
    });
    const rec = await ctl.start(WINDOW_SCOPE);
    expect(rec.actualScope).toEqual({ kind: "display" });
    await ctl.stop(rec.id);

    const doc = loadIndex().document;
    const segment = doc.segments.find((s) => s.id === rec.id);
    expect(segment?.scope.kind).toBe("window");
    expect(segment?.actualScope).toEqual({ kind: "display" });
    const artifact = doc.artifacts.find((a) => a.id === rec.id);
    expect(artifact?.actualScope).toEqual({ kind: "display" });
    expect(artifact?.leakage).toBe("full-display");
  });
});
