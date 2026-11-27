/**
 * The public automation API.
 *
 * The one thing this layer guarantees: a caller never sees a method name, an
 * envelope, a host script, or a file path used for IPC. Everything below is
 * `ae-a8n`'s business.
 *
 * ```ts
 * const ae = await AfterEffects.launch();
 * const project = await ae.openProject("fixture.aep");
 * const comp = await project.comp("Main");
 * const layer = await comp.layer("Solid 1");
 * const effect = await layer.effects.apply("Example Plugin");
 * await effect.parameter("Amount").set(50);
 * const frame = await comp.renderFrame(0);
 * await ae.close();
 * ```
 */

import { join, resolve } from "node:path";

import { consoleSessionUid, type MacSession } from "../driver/mac-session.js";
import {
  readLaunchProvenance,
  type LaunchProvenance,
} from "../driver/launch-provenance.js";
import { errorMessage } from "../errors.js";
import type { TraceEvent } from "../trace/trace.js";
import {
  buildCapabilityHandshake,
  newCapabilityHostNonce,
  type HandshakeResponse,
} from "./capabilities.js";
import { guiStateReport } from "./gui-state.js";
import {
  type Panel,
  panelCapabilities,
  panelForTarget,
  type PanelCapabilities,
  type PanelLocator,
} from "./panels.js";
import {
  type MenuBar,
  menuBarForTarget,
  menuCapabilities,
  type MenuCapabilities,
} from "./menus.js";
import {
  type DockedPane,
  dockedPaneForTarget,
  type DockedPaneLocator,
} from "./docked-pane.js";
import {
  type Timeline,
  timelineCapabilities,
  timelineForTarget,
  type TimelineCapabilities,
} from "./timeline.js";
import { supervisionReport, type SupervisionReport } from "../supervision/index.js";
import type { StillEvidenceContext } from "../evidence/stills.js";
import type {
  EvidenceIndexSession,
  EvidenceSessionKind,
} from "../evidence/types.js";
import {
  AfterEffectsError,
  EntityNotFoundError,
  ExtensionMethodNotFoundError,
  HostError,
  contextualise,
} from "./errors.js";
import type { StopResult } from "../driver/driver.js";
import type { HostOwnership } from "../driver/transport.js";
import { activateDispatcherForSession } from "./dispatcher-activation.js";
import { attachAfterEffects } from "./attach.js";
import { openAfterEffects } from "./launch.js";
import { openRebuiltSession } from "./rebuild.js";
import { terminateSessionHost } from "./terminate.js";
import {
  grantedScopes,
  requireAuthorized,
  type Session,
} from "./session.js";

/** What `AfterEffects.close` did. */
export type CloseResult = StopResult;
export type { HostOwnership };
import type { ExpectedModalSpec } from "../driver/expected-modals.js";
import type {
  ActivateDispatcherOptions,
  ApplicationInfo,
  AttachOptions,
  CommandExecution,
  CompInfo,
  DiagnosticsOptions,
  DispatcherActivation,
  GuiStateReport,
  LaunchOptions,
  OpenProjectOptions,
  OperationOptions,
  RebuildOptions,
  ResumeOptions,
  TerminateOptions,
  TerminateReport,
  ProjectInfo,
  SessionDiagnostics,
} from "./types.js";

export * from "./errors.js";
export type * from "./types.js";
export type {
  ExpectedModalResolution,
  ExpectedModalSpec,
  ExpectedModalWindow,
} from "../driver/expected-modals.js";
export { grantedScopes } from "./session.js";
export { TERMINATE_PERMIT } from "./types.js";
import {
  Comp,
  Effect,
  Effects,
  Layer,
  MenuCommand,
  Parameter,
  Project,
  requireString,
} from "./entities.js";
export { Comp, Effect, Effects, Layer, MenuCommand, Parameter, Project };
export {
  Panel,
  panelCapabilities,
  PanelError,
  type PanelCapabilities,
  type PanelCapture,
  type PanelLocator,
  type PanelMeasurement,
  type PanelTarget,
} from "./panels.js";
export {
  MenuBar,
  MenuError,
  menuBarForTarget,
  menuCapabilities,
  type MenuBarItemInfo,
  type MenuBarSnapshot,
  type MenuCapabilities,
  type MenuCapability,
  type MenuCheckReading,
  type MenuCheckState,
  type MenuErrorCode,
  type MenuInvokeResult,
  type MenuItemLocator,
  type MenuItemNode,
  type ResolvedMenuItem,
} from "./menus.js";
export {
  DockedPane,
  DockedPaneObserver,
  dockedPaneForTarget,
  type DockedPaneBounds,
  type DockedPaneLocator,
  type DockedPaneOps,
  type DockedPaneResolution,
  type DockedPaneRow,
  type DockedPaneSeams,
  type DockedPaneTree,
} from "./docked-pane.js";
export {
  Timeline,
  TimelineError,
  timelineCapabilities,
  timelineForTarget,
  type NavigateKeyframeRequest,
  type NavigateKeyframeResult,
  type ScrubRequest,
  type ScrubResult,
  type SelectRowRequest,
  type SelectRowResult,
  type TimelineCapabilities,
  type TimelineCapability,
  type TimelineErrorCode,
  type TimelineKeyTarget,
  type TimelineKeyframeVia,
  type TimelineMouseOps,
  type TimelineOpRecord,
  type TimelinePoint,
  type TimelinePostcondition,
  type TimelineRulerGeometry,
  type TimelineRowLocator,
  type TimelineRowVerify,
  type TimelineSeams,
  type TimelineVerdict,
} from "./timeline.js";
// The capability-handshake surface is exported once, from the package
// entry point (src/index.ts → ./api/capabilities.js); re-exporting it here
// too would duplicate the list and leak test-only symbols twice.

/**
 * Whether a path is absolute in the host's terms, decided from the text
 * alone so it does not depend on the caller's OS (a transport may run After
 * Effects on another machine). Absolute: POSIX `/…`; Windows `C:\…` or
 * `C:/…`; UNC `\\server\share\…` (and `\\?\…`). Everything else is
 * resolved by After Effects against *its own* working directory, which is
 * not the caller's: `copy.aep`, `./x`, `../x`, `~/x`, drive-relative `C:x`,
 * and rooted-without-drive `\x`.
 */
export function isAbsoluteProjectPath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

/** Rejects a relative project path before anything is sent; never resolves it. */
function requireAbsoluteProjectPath(value: unknown): string {
  const path = requireString(value, "path");
  if (!isAbsoluteProjectPath(path)) {
    throw new TypeError(
      `project path must be absolute, got ${JSON.stringify(path)}: After Effects would resolve it against its own ` +
        `working directory, not yours. Resolve it first, e.g. path.resolve(${JSON.stringify(path)}).`,
    );
  }
  return path;
}

/** Edit › Undo and Edit › Redo, as AE 26.5x89 numbers them. */
export const UNDO_COMMAND_ID = 16;
export const REDO_COMMAND_ID = 2035;

export class AfterEffects {
  readonly #session: Session;
  readonly #probe: ApplicationInfo;
  /** Names the loaded host script declares; empty for the built-in host. */
  readonly #extensionMethods: readonly string[];
  /** Fallback `hostId` when the transport cannot attest a process identity. */
  readonly #hostNonce = newCapabilityHostNonce();
  #closed = false;

  constructor(session: Session, probe: ApplicationInfo, extensionMethods: readonly string[] = []) {
    this.#session = session;
    this.#probe = probe;
    // Copied and frozen: `extensionMethods()` and the `declared` list on
    // ExtensionMethodNotFoundError hand this array to callers, and a
    // mutated list would let an undeclared name pass the pre-dispatch check.
    this.#extensionMethods = Object.freeze([...extensionMethods]);
  }

  /**
   * Launches After Effects, or attaches to a running instance, and waits until
   * it answers a readiness probe.
   *
   * On a cold start this is not instant: AE has to become scriptable before the
   * probe succeeds. A failure here means AE did not become usable, and the
   * error names the operation rather than surfacing a raw bridge message.
   */
  static async launch(options: LaunchOptions = {}): Promise<AfterEffects> {
    const opened = await openAfterEffects(options, null, "session.launch");
    return new AfterEffects(opened.session, opened.probe, opened.extensionMethods);
  }

  /**
   * Connects to an After Effects that is already running — and only that.
   *
   * Unlike `launch()`, which detects a running instance but falls back to
   * starting one, `attach()` has no launch path at all: the default
   * script transport is built attach-only, so its `launch()` selects a
   * census target and the spawn branches are unreachable. On Windows the
   * script lane cannot attach (every script delivery there is an
   * `AfterFX.exe -r` spawn), so attach goes through
   * `transport: "in-ae-dispatcher"` or a caller-supplied transport.
   *
   * Target selection is fail-closed. With no `target`, exactly one
   * in-scope instance of the selected install must be running; `target.pid`
   * pins one process. No candidate, several candidates, a pid in another
   * login session, an unreadable process list, or a target that never
   * answers the probe all reject with `AttachTargetError` — and nothing is
   * resent or retried afterwards.
   *
   * The returned session's ownership is `attached` (or `unknown` when the
   * target stops being provable), so `close()` never quits the host.
   */
  static async attach(options: AttachOptions = {}): Promise<AfterEffects> {
    const opened = await attachAfterEffects(options);
    return new AfterEffects(opened.session, opened.probe, opened.extensionMethods);
  }

  /**
   * Rebinds to the After Effects an earlier `launch()` in the same
   * `sessionRoot` started and proved it owned — for example after the
   * calling process restarted.
   *
   * The launch-provenance record is checked against the live process list:
   * the recorded pid must still be the same process (pid, start time, and
   * the Windows creation identity), running the same install's executable,
   * and the only instance of that install in scope. The readiness probe
   * must then answer before ownership is claimed. Anything less refuses —
   * resume never starts a replacement host and never quits what it cannot
   * prove.
   *
   * A caller-supplied `transport` is used as-is: adoption is then the
   * transport's own contract (the fake host, a remote worker), and the
   * provenance record is not consulted.
   */
  static async resume(options: ResumeOptions): Promise<AfterEffects> {
    const sessionRoot = resolve(options.sessionRoot);
    let provenance: LaunchProvenance | null;
    try {
      provenance = readLaunchProvenance(sessionRoot);
    } catch (error) {
      throw new AfterEffectsError(
        errorMessage(error),
        "session.resume",
      );
    }
    if (provenance === null) {
      throw new AfterEffectsError(
        `no launch provenance in ${sessionRoot}: nothing this tooling owned was recorded there, ` +
          "so there is no host to resume. Use launch() for a new session.",
        "session.resume",
      );
    }
    const opened = await openAfterEffects({ ...options, sessionRoot }, provenance, "session.resume");
    return new AfterEffects(opened.session, opened.probe, opened.extensionMethods);
  }

  /**
   * Rebuilds the session `options.sessionRoot` names after its owned
   * After Effects process is proven gone (#286,
   * `specs/gui-supervision/spec.md` US5).
   *
   * Unlike `resume` — which rebinds to a host that is still running —
   * `rebuild` relaunches After Effects through the ordinary launch path,
   * and only after every proof holds:
   *
   *   - the durable supervision document shows `blocked` with host
   *     `process-gone` (a quarantined or needs-human session refuses);
   *   - no live monitor still observes the dead pid;
   *   - launch provenance proves an earlier session *owned* the host —
   *     attached and unknown sessions have none and are never restarted;
   *   - a fresh process census proves the recorded pid+start identity is
   *     gone and that no other instance of the install is running;
   *   - on macOS the target uid still has an Aqua login session.
   *
   * The launch itself re-proves pid identity, single instance, readiness
   * and provenance, and ownership is verified *again* afterwards: anything
   * short of `owned` fails closed — the instance is left running
   * untouched, never quit, because it may hold someone else's unsaved
   * work. Pending requests the crashed session left behind are reconciled
   * against their recorded results and otherwise stay `unknown`; nothing
   * is ever resent.
   *
   * The supervision document records the whole recovery
   * (`recovering` → `resumed`, or the phase a live monitor already moved
   * it to), and the returned session's `supervisionState()` is the same
   * durable report every other client reads.
   */
  static async rebuild(options: RebuildOptions): Promise<AfterEffects> {
    const rebuilt = await openRebuiltSession(options);
    return new AfterEffects(rebuilt.session, rebuilt.probe, rebuilt.extensionMethods);
  }

  /**
   * Terminates the owned After Effects `options.sessionRoot` names — the
   * *separate* authorized path for a live host that will not answer
   * (#340). Rebuild never signals a process; this path never launches one.
   *
   * Every gate must hold or nothing is signalled: explicit
   * `permit: "terminate-owned-host"` consent, launch provenance proving an
   * earlier session owned the host (attached and unknown sessions refuse),
   * and a fresh census re-proving the recorded pid+start identity with no
   * sibling instance in scope. Graceful-first — the OS's polite request
   * (AE `quit` Apple Event on macOS, `taskkill` on Windows) — and the
   * force kill only under explicit `force: true`. Disappearance must be
   * *proven* by census; `survived`/`unproven` are honest outcomes.
   *
   * Once proven, the durable supervision record moves to
   * `blocked`/`process-gone` under the monitor lease — the state
   * `AfterEffects.rebuild` requires — so the sequence
   * `terminate → rebuild` continues a session on a new generation.
   * Pending requests stay `unknown` and are never resent; quarantined and
   * needs-human phases are never downgraded.
   */
  static async terminate(options: TerminateOptions): Promise<TerminateReport> {
    return terminateSessionHost(options);
  }

  /**
   * Host version and build, as reported by the launch readiness probe. Free:
   * no round trip, because launch already had to ask.
   */
  info(): ApplicationInfo {
    return this.#probe;
  }

  /**
   * Calls an extension method declared by the loaded host script
   * (`ae-a8n extension build`).
   *
   * The name is checked against what the script declares before anything is
   * sent, so an unknown name is refused here rather than becoming an After
   * Effects error. The call runs inside the session's ownership, timeout and
   * trace, exactly like a built-in method.
   */
  async call<T = unknown>(
    name: string,
    params: Record<string, unknown> = {},
    options: OperationOptions = {},
  ): Promise<T> {
    requireString(name, "name");
    // The params object crosses the bridge verbatim; anything but a plain
    // object would reach the host as a value the extension contract never
    // promised (or fail deep inside serialization).
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new TypeError("params must be an object");
    }
    requireAuthorized(this.#session, "extension.call", "extensionMethods", name);
    if (!this.#extensionMethods.includes(name)) {
      throw new ExtensionMethodNotFoundError("extension.call", name, this.#extensionMethods);
    }
    return this.#session.call<T>("extension.call", name, params, options);
  }

  /** The extension method names the loaded host script declares. */
  extensionMethods(): readonly string[] {
    return this.#extensionMethods;
  }

  /** Re-reads the host version, for a caller that wants a live value. */
  async version(): Promise<string> {
    const info = await this.#session.call<ApplicationInfo>("app.info", "app.info");
    return info.version;
  }

  /**
   * What this session can attest about the After Effects it is connected
   * to, in the ae-devtools `ae-devtools.capability-handshake/v1` shape
   * (#102).
   *
   * Read-only discovery: it reports the launch probe's AE version/build,
   * the transport's ownership/platform/execution-mode evidence, and the
   * capabilities ae-a8n can back with evidence — built-in dispatch-table
   * methods as `ae.operation.*` references and declared extension methods
   * as `ae.tool.*`. It dispatches nothing.
   *
   * A compatible advertisement is not authorization to run anything: pair
   * it with `negotiateCapabilities` (version/capability preflight) and
   * `assertDispatchAllowed` (per-dispatch gate) before dispatching by
   * capability ID. The existing typed API and `ae.call` keep their own
   * contracts and are not gated by this handshake.
   */
  capabilities(): Promise<HandshakeResponse> {
    const driver = this.#session.driver;
    // "Monitoring" is proven, not assumed (#287): an in-process monitor on
    // this session, or durable state whose evaluated health is still `ok`
    // (a detached supervisor keeps writing after this process would have
    // stopped mattering). Anything less reports false — honest absence.
    const durable = supervisionReport(driver.sessionRoot);
    const monitoring =
      this.#session.supervision !== null ||
      (durable.status === "observed" && durable.health === "ok");
    return Promise.resolve(
      buildCapabilityHandshake({
        ae: this.#probe,
        transportKind: driver.transportKind,
        attestation: driver.hostAttestation(),
        ownership: driver.ownership(),
        extensionMethods: this.#extensionMethods,
        grantedOperations: grantedScopes(this.#session),
        supervisionMonitoring: monitoring,
        hostNonce: this.#hostNonce,
        generatedAt: new Date().toISOString(),
      }),
    );
  }

  /**
   * Registers an expected modal for this session (#342) and returns its
   * unregister function.
   *
   * Use this when the test itself raises a dialog it intends to resolve —
   * an unsaved-changes prompt, a script-error sheet — so the standard
   * recovery path classifies it as expected instead of quarantining it as
   * unknown. `resolve` may press one declared button through the same
   * audited GUI path a measured class uses, or `wait` (the default) to
   * leave the modal for its owner while the original request keeps its
   * bounded wait. Nothing is pressed for windows that match no
   * registration, and Adobe account/licence windows are never pressable
   * through an expectation.
   *
   * Throws when the session has no GUI recovery path (a non-script
   * transport, or `session.recover: false`).
   */
  expectModal(spec: ExpectedModalSpec): () => void {
    return this.#session.expectModal(spec);
  }

  /**
   * Shows a native modal dialog in After Effects and waits for it to be
   * closed.
   *
   * The dialog is the one thing an ExtendScript call cannot get out of on its
   * own: the script stays blocked until the dialog is closed, so the call
   * times out while the host is perfectly alive.
   *
   * With a session that has `recover` enabled, the timed-out call is
   * followed by the GUI fallback, which closes the dialog *inside that
   * session* and lets the original call finish. The request is never sent
   * again — it is still running inside After Effects.
   *
   * The dialog's text always begins `ae-a8n:` (the host adds it when
   * `message` does not), because that marker is how the fallback recognises
   * the one dialog class it may press. A dialog without it would be
   * classified unknown and left for a human.
   */
  async showModalDialog(message: string, options: OperationOptions = {}): Promise<void> {
    // Validated here like every other public method: a JavaScript caller
    // passing a non-string would otherwise be coerced by the host's
    // `String(...)`, or fail deep inside After Effects.
    const text = requireString(message, "message");
    await this.#session.call("ui.alert", "ui.alert", { message: text }, options);
  }

  /**
   * Opens a project, replacing the open one. Refuses with
   * UnsavedChangesError if that would discard unsaved changes, unless
   * `unsavedChanges` is "discard". `timeoutMs` overrides the session budget
   * for this call only.
   *
   * If this times out, After Effects usually still finishes the open; get a
   * handle with `project()` instead of opening again.
   */
  async openProject(path: string, options: OpenProjectOptions = {}): Promise<Project> {
    const projectPath = requireAbsoluteProjectPath(path);
    await this.#session.call(
      "project.open",
      "project.open",
      { path: projectPath, discardUnsavedChanges: options.unsavedChanges === "discard" },
      options,
    );
    return new Project(this.#session);
  }

  /**
   * A handle to the project open in After Effects now, without opening
   * anything. Asks the host first, so it waits for a script still running
   * from a timed-out call (an `openProject`, say) and fails if no project is
   * reachable. Check `info().file` to see which project it is.
   */
  async project(options: OperationOptions = {}): Promise<Project> {
    await this.#session.call<ProjectInfo>("project.info", "project.info", {}, options);
    return new Project(this.#session);
  }

  /**
   * Whether this session owns the After Effects process: "owned" when it
   * started it and it is still that process. Only an owned host is quit by
   * `close`.
   */
  ownership(): HostOwnership {
    return this.#session.driver.ownership();
  }

  /**
   * Collects host-side evidence for this session — OS crash reports for the
   * After Effects binaries, host logs touched while the session ran, and
   * the session trace — into `<artifactsDir>/diagnostics/` and returns the
   * report with the paths.
   *
   * This is how "AE stopped answering" becomes "AE crashed at 11:10 with
   * SIGTERM from bash" instead of a guess: the report says what was found,
   * and `notes` says what could not be collected. It never moves or deletes
   * the user's files, and nothing is sent anywhere. Callable after a failed
   * `close` too — the evidence is still there.
   *
   * `options` overrides where evidence is looked for: pass a fake `homeDir`
   * or `sources` and collection never touches the real user directories.
   */
  diagnostics(options?: DiagnosticsOptions): SessionDiagnostics {
    return this.#session.driver.diagnostics(options);
  }

  /**
   * The owned After Effects process this session controls, for recovery
   * authorization (ae-devtools #55). Returns the pid and the GUI session
   * the process was verified to belong to — the identity a run marker must
   * record before any GUI mutation is authorized.
   *
   * Returns null unless ownership is "owned" AND the transport can name
   * its target. Callers must treat null as "no attested target", never
   * substitute a pid found by other means: an unattested pid is exactly
   * what recovery authorization exists to refuse.
   */
  recoveryTarget(): { pid: number; session: MacSession } | null {
    if (this.#closed || this.ownership().kind !== "owned") {
      return null;
    }
    return this.#session.driver.recoveryTarget();
  }

  /**
   * Activates the in-AE dispatcher inside the After Effects this session
   * owns, so other sessions can `AfterEffects.attach` to it through the
   * dispatcher channel (issue #276).
   *
   * Windows only: the delivery mechanism is `AfterFX.exe -r`, which hands
   * the generated `activate.jsx` to the running instance. That launcher
   * cannot name a pid, so the call is gated twice before anything is
   * spawned — the session's ownership must be "owned" (the same live
   * re-check `close()` uses: same process, and the only in-scope
   * instance), and the file delivered must be the activation script this
   * package generated, never arbitrary JSX.
   *
   * This does not weaken the human-activation boundary for foreign After
   * Effects: an owned session already has full script control over that
   * instance, so activating its dispatcher grants it nothing new. An
   * attached or unknown session is refused outright — activation of an
   * AE this session does not own stays a human action (Run Script File,
   * or Startup install on a dedicated profile).
   *
   * Success is bound to *this* delivery, not to "a dispatcher answers the
   * channel": the staged script carries a per-call nonce that the
   * dispatcher records in its heartbeat, and the call only resolves once
   * a fresh heartbeat reports that exact nonce — observed *after* the
   * `-r` spawn. A dispatcher that was already answering (on this or any
   * other After Effects sharing the channel) cannot satisfy it, and
   * ownership is re-verified after the nonce appears, so a second
   * in-scope instance appearing mid-delivery fails closed rather than
   * attributing the activation to the owned AE. What remains unproven —
   * honestly — is which OS process the `-r` hand-off reached in the
   * instant between the pre-spawn census and AE reading the script; the
   * nonce proves the script ran on *an* AE answering this channel, and
   * the post-delivery census is what ties that to the owned instance.
   *
   * Resolves once that proof is observed. A timeout means the script may
   * not have run — After Effects can show a script-trust or consent
   * dialog that only a human can answer — and the error says so instead
   * of reporting success.
   */
  async activateDispatcher(
    options: ActivateDispatcherOptions = {},
  ): Promise<DispatcherActivation> {
    const op = "session.dispatcherActivate";
    if (this.#closed) {
      throw new AfterEffectsError("the session is closed", op);
    }
    // The delivery core is shared with the verified rebuild's transport
    // re-staging (#313): same ownership gate, same nonce proof, same
    // provenance record — never a second, weaker copy.
    return activateDispatcherForSession(this.#session, options, op);
  }

  /**
   * What the owned After Effects instance's screen currently shows
   * (ae-a8n #109): its windows, each classified against the measured
   * recovery policy, and the aggregate verdict — without pressing anything.
   *
   * Read-only: the observation is audited but never takes the GUI mutation
   * lease, and no button is ever pressed. It runs inside the session that
   * owns the AE instance; when that session cannot be entered the report is
   * `unavailable` with the reason, never an empty window list.
   *
   * `status: "unavailable"` is also the answer when no owned target is
   * attested — an attached or unknown host has no proven pid/session, so
   * there is no honest window list to report.
   *
   * On macOS the first observation in a session may raise the standard
   * Accessibility consent prompt; that is the OS asking a human, not this
   * API bypassing it.
   */
  guiState(): Promise<GuiStateReport> {
    // The observation itself is synchronous (one Accessibility query inside
    // the target session); `.then` keeps even a synchronous failure a
    // rejection rather than a throw from a Promise-typed method.
    return Promise.resolve().then(() => guiStateReport(this.recoveryTarget()));
  }

  /**
   * What this build can do with After Effects panels on this platform
   * (#343, `specs/panel-interaction/spec.md`): per-capability support,
   * verification level and gate status. Unsupported combinations are
   * explicit answers — macOS-only in this slice, and `resize` reports
   * `unavailable` while the mutate-gui gate is pending A-SAFETY review.
   */
  panelCapabilities(): PanelCapabilities {
    return panelCapabilities(process.platform);
  }

  /**
   * A handle to one panel surface of the owned After Effects instance
   * (#343): `identify`/`measure`/`capture` are observe-class;
   * `resize`/`restore` are mutate-gui and gated — see
   * `panelCapabilities()` for what is currently allowed.
   *
   * `locator` names the surface by title/role/subrole or OS window
   * number; resolution re-proves pid attribution through the window
   * census on every operation, so a stale or foreign surface is refused,
   * never guessed. Throws `PanelError` when no owned target is attested
   * or the platform is unsupported.
   */
  panel(locator: PanelLocator): Panel {
    const target = this.recoveryTarget();
    return panelForTarget(
      target,
      locator,
      this.artifactsDir,
      {},
      target === null ? undefined : this.#stillEvidenceContext(target),
    );
  }

  /**
   * The evidence-index context `panel().capture()` binds stills into
   * (#380, spec §5.5). Every field is proven or honestly null: the host
   * start identity comes from launch provenance when it exists, and the
   * session kind is derived from the console-owner check — a target in
   * the console user's session is `"console"`, a GUI session of another
   * user is `"isolated"` (the dedicated automation lane), and anything
   * unprovable stays `"unknown"` rather than being upgraded.
   */
  #stillEvidenceContext(target: {
    pid: number;
    session: MacSession;
  }): StillEvidenceContext {
    const driver = this.#session.driver;
    let processStartIdentity: string | null = null;
    try {
      const provenance = readLaunchProvenance(driver.sessionRoot);
      processStartIdentity =
        provenance?.host.identity ??
        (provenance?.host.startedAt != null
          ? `startedAt=${provenance.host.startedAt}`
          : null);
    } catch {
      processStartIdentity = null;
    }
    // `consoleSessionUid()` answers -1 when unreadable — never throws.
    const consoleUid = consoleSessionUid();
    let sessionKind: EvidenceSessionKind = "unknown";
    if (consoleUid >= 0 && target.session.uid === consoleUid) {
      sessionKind = "console";
    } else if (target.session.kind === "Aqua") {
      sessionKind = "isolated";
    }
    const session: EvidenceIndexSession = {
      sessionRoot: driver.sessionRoot,
      adapter: driver.transportKind,
      pid: target.pid,
      processStartIdentity,
      sessionId: driver.sessionId,
      sessionKind,
    };
    return {
      artifactsDir: driver.artifactsDir,
      session,
      trace: this.#session.trace,
    };
  }

  /**
   * What this build can do with the macOS menu-bar surface on this
   * platform (#360, `specs/workspace-editing/spec.md`): per-capability
   * support, verification level and gate status. `enumerate` and
   * `checkState` are observe-class; `invoke` is mutate-gui and reports
   * `unavailable` while the A-SAFETY gate keeps it refused.
   */
  menuBarCapabilities(): MenuCapabilities {
    return menuCapabilities(process.platform);
  }

  /**
   * A handle to the owned After Effects instance's menu bar (#360):
   * `list`/`find`/`checkState` are observe-class; `invoke` is
   * mutate-gui and gated — see `menuBarCapabilities()` for what is
   * currently allowed.
   *
   * Items are addressed by `(menuPath, itemTitle)` — the localized
   * titles AE shows, resolved against a fresh Accessibility observation
   * on every call. An absent expected path refuses `unsupported-locale`;
   * there is no coordinate fallback. Throws `MenuError` when no owned
   * target is attested or the platform is unsupported.
   */
  menuBar(): MenuBar {
    return menuBarForTarget(this.recoveryTarget());
  }

  /**
   * A handle to one docked-region pane of the owned After Effects
   * instance (#361, `specs/workspace-editing/spec.md` §6/§7): the Timeline,
   * Comp or Render Queue area inside the main window's AX tree — a surface
   * with no window of its own, resolved through a bounded, depth/node/
   * time-limited subtree walk.
   *
   * `identify`/`tree`/`rows` are observe-class: they re-run the AX listing,
   * the window census and the bounded walk on every call, and re-resolve
   * the pane each time. A recorded `axPath` that drifted is refused as
   * `stale-locator` — never remapped by guesswork, and there is no
   * coordinate fallback. Real-host AX fidelity of docked panes is
   * unverified; see `panelCapabilities().dockedRegion`.
   *
   * Throws `PanelError` when no owned target is attested, the platform is
   * unsupported, or the pane cannot be resolved.
   */
  dockedPane(locator: DockedPaneLocator): DockedPane {
    return dockedPaneForTarget(this.recoveryTarget(), locator);
  }

  /**
   * What this build can do with the Timeline pane on this platform
   * (#364, `specs/workspace-editing/spec.md` §3 W2): per-op support,
   * verification level and gate status. `rows` is observe-class;
   * `scrub`/`selectRow`/`navigateKeyframe` are mutate-gui and report
   * `unavailable` while the A-SAFETY gate keeps them refused — see
   * `timelineCapabilities()`.
   */
  timelineCapabilities(): TimelineCapabilities {
    return timelineCapabilities(process.platform);
  }

  /**
   * A handle to the Timeline docked pane of the owned After Effects
   * instance (#364): `rows` is observe-class; `scrub`, `selectRow` and
   * `navigateToKeyframe` are mutate-gui — GUI act + DOM readback oracle,
   * gated and bounded (no resend). Throws `TimelineError` when no owned
   * target is attested or the platform is unsupported.
   *
   * `locator` names the pane inside the main window's AX tree — the same
   * `DockedPaneLocator` `ae.dockedPane()` takes. Real-host fidelity of
   * timeline rows, the current-time indicator and keyframe diamonds is
   * unverified (spec §11); see `timelineCapabilities()`.
   */
  timeline(locator: DockedPaneLocator): Timeline {
    return timelineForTarget(this.recoveryTarget(), this.#session, locator);
  }

  /**
   * The session's durable supervision report (#287,
   * `specs/gui-supervision/spec.md`): the phase the monitor last proved
   * (`running`/`blocked`/`recovering`/`needs-human`/`quarantined`/`resumed`),
   * the blocking windows and host-level state behind it, the in-flight
   * request, and — separately — whether observation itself is healthy.
   *
   * This is a read of shared state, not a live probe: it answers even while
   * After Effects is not answering scripts, which is exactly when callers
   * need it. `status: "unavailable"` means no trustworthy state exists —
   * supervision never ran, the state is corrupt, or the monitor's heartbeat
   * is stale — and is never reported as a clean screen.
   *
   * CLI, MCP and VSCode consumers should read this rather than growing
   * their own GUI checks; ae-devtools maps it to user-facing state.
   */
  supervisionState(): SupervisionReport {
    return supervisionReport(this.#session.driver.sessionRoot);
  }

  /**
   * A menu command, looked up by its menu text (as AE shows it, so
   * localised for built-in commands; a plugin's own name for one an AEGP
   * plugin registered) or taken by id. A name AE does not know rejects with
   * EntityNotFoundError (`kind: "menu-command"`). Only an id crosses to
   * After Effects: no script text is ever sent.
   */
  async menuCommand(nameOrId: string | number): Promise<MenuCommand> {
    if (typeof nameOrId === "number") {
      if (!Number.isInteger(nameOrId) || nameOrId <= 0) {
        throw new TypeError("menu command id must be a positive integer");
      }
      return new MenuCommand(this.#session, nameOrId);
    }
    const name = requireString(nameOrId, "menu command name");
    try {
      const found = await this.#session.call<{ id: number }>("menu.find", "menu.find", { name });
      return new MenuCommand(this.#session, found.id, name);
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NotFoundError") {
        throw new EntityNotFoundError("menu-command", name, "menu.find");
      }
      throw error;
    }
  }

  /** Edit › Undo: one step of AE's undo history. Owned sessions only. */
  async undo(options: OperationOptions = {}): Promise<CommandExecution> {
    return new MenuCommand(this.#session, UNDO_COMMAND_ID, "Undo").execute(options);
  }

  /** Edit › Redo. Owned sessions only. */
  async redo(options: OperationOptions = {}): Promise<CommandExecution> {
    return new MenuCommand(this.#session, REDO_COMMAND_ID, "Redo").execute(options);
  }

  /** Compositions in the currently open project. */
  async comps(): Promise<CompInfo[]> {
    return this.#session.call<CompInfo[]>("project.comps", "project.comps");
  }

  /** Absolute path of the machine-readable operation history for this session. */
  get tracePath(): string {
    return this.#session.trace.file ?? join(this.#session.driver.sessionRoot, "trace.jsonl");
  }

  /** Live operation history, in order. */
  get traceEvents(): readonly TraceEvent[] {
    return this.#session.events;
  }

  /** Directory renders and other artifacts are written to. */
  get artifactsDir(): string {
    return this.#session.driver.artifactsDir;
  }

  /**
   * Closes the open project and quits After Effects. Safe to call twice.
   */
  /**
   * Ends the session.
   *
   * After Effects is quit only if this session started it and it is still
   * that process; a host that was already running, or whose identity cannot
   * be confirmed, is left running and the result says why. Quitting refuses
   * with UnsavedChangesError rather than discard unsaved changes, unless
   * `unsavedChanges` is "discard" — and the session stays open for the retry.
   */
  async close(options: { unsavedChanges?: "refuse" | "discard" } = {}): Promise<CloseResult> {
    if (this.#closed) {
      return { quit: false, ownership: this.ownership(), reason: "already closed" };
    }
    try {
      const result = await this.#session.driver.stop(options);
      this.#closed = true;
      // The monitor outlives the quit attempt on purpose: `app.quit` can
      // raise the unsaved-changes dialog supervision exists to see. It is
      // released only once the session is actually closed.
      this.#session.supervision?.stop();
      return result;
    } catch (error) {
      if (!(error instanceof HostError && error.name === "UnsavedChangesError")) {
        this.#closed = true;
        this.#session.supervision?.stop();
      }
      contextualise("session.close", error);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
