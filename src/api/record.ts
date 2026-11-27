/**
 * Public recording API — `ae.record` (#381, `specs/gui-evidence/spec.md`
 * §5.4/§5.6, E2a of #346).
 *
 * `ae.record.start(scope, options)` / `ae.record.stop(id)` drive the
 * platform-neutral `RecordingController`: bounded segments
 * (`seg-001`, `seg-002`, …), `finally` finalize on `ae.close()`,
 * container-probe honesty, `coversOperations` accounting, recorder
 * residue reporting and orphan marking — all persisted into the
 * session's `ae-a8n.gui-evidence/v1` index under `artifacts/`.
 *
 * Honesty rules:
 *
 *   - The OS recording backends plug in per platform: win32 registers
 *     the WGC helper (#384, with the declared ffmpeg fallback);
 *     platforms without a backend resolve to `null` and every start
 *     refuses — the gates still run first, so an unauthorized scope is
 *     refused for the *right* reason and the refusal lands in the index
 *     gaps.
 *   - `display`/`session` scopes, and every scope on a session whose
 *     kind is not proven `"isolated"`, require recording authorization
 *     (spec §5.6). No authorization mechanism exists yet, so those
 *     starts refuse; the gate itself is what this slice ships.
 *   - `window`/`region` scopes need an `"owned"` `PanelTarget`
 *     (from `panel.identify()`) and serialize on the session's GUI
 *     lease for the segment's duration.
 */

import { defaultLeaseController } from "../driver/gui-recovery.js";
import { defaultGuiLeaseRoot } from "../platform/darwin/gui-lease.js";
import { windowsScreenRecorderResolver } from "../platform/windows/recording.js";
import { consoleSessionUid } from "../driver/mac-session.js";
import type { Session } from "./session.js";
import {
  RecordingController,
  type RecorderResolver,
  type RecordingAuthorizer,
  type RecordingControllerOptions,
  type RecordingLease,
  type RecordingSession,
  type RecordingStopResult,
  type ScreenRecorder,
} from "../evidence/recording.js";
import type { EvidenceTraceRow } from "../evidence/correlate.js";
import type {
  CaptureScope,
  EvidenceIndexSession,
  EvidenceSessionKind,
} from "../evidence/types.js";
import type { RecordStartOptions } from "../evidence/recording.js";

export type {
  RecordStartOptions,
  RecorderFileProbe,
  RecorderHandle,
  RecorderStartRequest,
  RecorderStartResult,
  RecorderStopResult,
  RecordingAuthorizer,
  RecordingAuthorizationRequest,
  RecordingControllerOptions,
  RecordingErrorCode,
  RecordingLease,
  RecordingSession,
  RecordingStopResult,
  ScreenRecorder,
} from "../evidence/recording.js";
export { RecordingController, RecordingError } from "../evidence/recording.js";
export {
  RECORDING_DEFAULT_MAX_DURATION_MS,
  RECORDING_MAX_DURATION_MS_CAP,
  recordingAttributionRefusal,
  recordingRequiresAuthorization,
} from "../evidence/recording.js";

/** Seams tests (and future backend tickets) can inject. */
export type RecordingApiSeams = {
  readonly recorder?: ScreenRecorder | RecorderResolver;
  readonly acquireLease?: RecordingControllerOptions["acquireLease"];
  readonly authorizeRecording?: RecordingAuthorizer;
  readonly listTraceRows?: () => readonly EvidenceTraceRow[];
  readonly hashFile?: RecordingControllerOptions["hashFile"];
};

/** The `ae.record` surface. */
export type RecordingApi = {
  /**
   * Start a bounded recording segment. `scope` is a `CaptureScope` —
   * for `window`/`region` pass the `PanelTarget` from
   * `panel(locator).identify()` so attribution is provable.
   */
  start(scope: CaptureScope, options?: RecordStartOptions): Promise<RecordingSession>;
  /** Stop a segment and finalize it into the evidence index. */
  stop(id: string): Promise<RecordingStopResult>;
  /** Ids of segments currently recording. */
  active(): readonly string[];
};

/**
 * The session kind the evidence index records (spec §5.2/§5.6):
 * `"isolated"` only when the transport attests `isolated-user`
 * execution; `"console"` when the target's session is the console
 * user's; `"attached"` for any other proven target; `"unknown"` when no
 * target is attested — never upgraded.
 */
export function evidenceSessionKindFor(
  session: Pick<Session, "driver">,
  platform: NodeJS.Platform = process.platform,
): EvidenceSessionKind {
  const attestation = session.driver.hostAttestation();
  if (attestation.executionMode === "isolated-user") {
    return "isolated";
  }
  const target = session.driver.recoveryTarget();
  if (target === null) {
    return "unknown";
  }
  if (platform === "darwin") {
    try {
      if (target.session.uid === consoleSessionUid()) {
        return "console";
      }
    } catch {
      return "unknown";
    }
  }
  return "attached";
}

/** The requestId a trace row carries, when the driver recorded one. */
export function traceRowRequestId(event: {
  readonly args?: Readonly<Record<string, unknown>>;
}): string | undefined {
  const value = event.args?.requestId;
  return typeof value === "string" ? value : undefined;
}

function sessionIdentity(session: Session): EvidenceIndexSession {
  const driver = session.driver;
  const attestation = driver.hostAttestation();
  const target = driver.recoveryTarget();
  const pid = attestation.pid ?? target?.pid ?? null;
  const owned = attestation.ownedProcess;
  return {
    pid,
    processStartIdentity:
      owned === null
        ? null
        : `pid-start:${owned.startedAt}${owned.identity === undefined ? "" : `:${owned.identity}`}`,
    sessionId: attestation.sessionAsid === null ? null : String(attestation.sessionAsid),
    sessionKind: evidenceSessionKindFor(session),
    sessionRoot: driver.sessionRoot,
    adapter: driver.transportKind,
  };
}

function defaultTraceRows(session: Session): readonly EvidenceTraceRow[] {
  return session.events.map((event) => {
    const requestId = traceRowRequestId(event);
    return {
      seq: event.seq,
      ts: event.ts,
      op: event.op,
      ...(requestId === undefined ? {} : { requestId }),
    };
  });
}

/**
 * The production lease seam (macOS): the same file lease every GUI
 * mutation takes, scoped to the target's `{uid, asid}` session, held
 * for the segment's duration (spec §5.6 lease-per-segment). Returns
 * `undefined` where no GUI session can be named — the controller then
 * refuses window/region starts rather than record unserialized.
 */
function defaultAcquireLease(session: Session) {
  return (segmentId: string, _scope: CaptureScope): RecordingLease | undefined => {
    if (process.platform !== "darwin") {
      return undefined;
    }
    const target = session.driver.recoveryTarget();
    if (target === null) {
      return undefined;
    }
    const leaseSession = { uid: target.session.uid, asid: target.session.asid };
    const controller = defaultLeaseController({
      stateRoot: defaultGuiLeaseRoot(),
      session: leaseSession,
      ownerId: `ae-a8n-gui-evidence:${process.pid}`,
    });
    const lease = controller.acquire(`record:${segmentId}`);
    return { release: () => lease.release() };
  };
}

/**
 * Builds the session's recording controller. `seams.recorder` is the
 * backend slot platform tickets (#382 darwin / #384 win32) fill; absent
 * on a platform with no backend, every start refuses `unsupported`
 * after the safety gates have run.
 */
export function createRecordingController(
  session: Session,
  seams: RecordingApiSeams = {},
): RecordingController {
  const recorder: ScreenRecorder | RecorderResolver =
    seams.recorder ??
    // Platform backends: win32 registers the WGC helper (#384) with the
    // declared-ffmpeg fallback gated on AE_A8N_FFMPEG_FALLBACK=1; other
    // platforms resolve to null so starts refuse honestly.
    (process.platform === "win32"
      ? windowsScreenRecorderResolver({
          ffmpegFallback: process.env.AE_A8N_FFMPEG_FALLBACK === "1",
        })
      : () => null);
  return new RecordingController({
    artifactsDir: session.driver.artifactsDir,
    session: sessionIdentity(session),
    recorder,
    trace: session.trace,
    listTraceRows: seams.listTraceRows ?? (() => defaultTraceRows(session)),
    acquireLease: seams.acquireLease ?? defaultAcquireLease(session),
    // No recording-authorization mechanism exists yet (later ticket):
    // the gate refuses with the reason recorded, never silently allows.
    authorizeRecording:
      seams.authorizeRecording ??
      (({ scope, sessionKind }) =>
        `recording authorization for ${scope.kind} scope on a ` +
        `"${sessionKind}" session is not implemented yet; the start is refused`),
    ...(seams.hashFile === undefined ? {} : { hashFile: seams.hashFile }),
  });
}

/** The `ae.record` API bound to one session. */
export function recordingApiFor(
  session: Session,
  seams: RecordingApiSeams = {},
): RecordingApi {
  return recordingApiForController(createRecordingController(session, seams));
}

/** The `ae.record` API bound to an existing controller (kept for `close`). */
export function recordingApiForController(controller: RecordingController): RecordingApi {
  return {
    start: (scope, options) => controller.start(scope, options),
    stop: (id) => controller.stop(id),
    active: () => controller.activeSegmentIds,
  };
}
