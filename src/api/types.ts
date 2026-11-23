/**
 * Value types crossing the public API boundary.
 *
 * These are the shapes the host returns, narrowed. Anything not modelled here
 * is not part of the contract, so the host can grow without silently changing
 * what callers see.
 */

import type { DiagnosticCode } from "../doctor/diagnostics.js";
import type { GuiAppState } from "../driver/gui-recovery.js";
import type { HostTransport, SessionAuthorization } from "../driver/transport.js";

export type { SessionAuthorization } from "../driver/transport.js";

/**
 * The opt-in in-AE dispatcher transport (#127), selected by name. It is
 * never chosen implicitly: `"script-invocation"` remains the default and
 * there is no automatic fallback between transports.
 */
export type DispatcherTransportSelection = {
  readonly kind: "in-ae-dispatcher";
  /** Channel directory; defaults to `~/.ae-a8n/dispatcher`. */
  readonly channelDir?: string;
  /**
   * Pin the session to one dispatcher instance (#145): the `instance` id a
   * previous session reported through `ae.capabilities()` or
   * `ae-a8n dispatcher status`. `launch()` refuses when the answering
   * dispatcher is a different After Effects — a reconnect can prove it
   * reached the same engine, and a different one is never operated.
   */
  readonly instance?: string;
  /**
   * Pin the session to one AE install (#155 follow-up): `launch()` refuses
   * when the answering dispatcher's heartbeat `aeVersion` disagrees with
   * this install's version on any component the heartbeat reports — a
   * patch-level difference is refused whenever `app.version` carries one.
   * The version is derived from the app bundle on macOS; on other
   * platforms pass `aeVersion` instead. This is a version-level check, not
   * executable identity — the heartbeat carries no pid or install path, so
   * same-version installs are indistinguishable.
   */
  readonly installDir?: string;
  /**
   * Pin the session to one AE version explicitly (e.g. "26.5" or
   * "26.5.3"), compared at the precision the heartbeat reports. Use this
   * where `installDir` cannot derive a version (non-macOS), or to pin a
   * version without naming an install.
   */
  readonly aeVersion?: string;
};

/** What `LaunchOptions.transport` accepts: a transport instance, or the named opt-in selection. */
export type TransportSelection =
  | HostTransport
  | "in-ae-dispatcher"
  | DispatcherTransportSelection;

export type { DiagnosticsOptions, SessionDiagnostics } from "../driver/session-diagnostics.js";

export type ApplicationInfo = {
  readonly version: string;
  readonly build?: string;
};

export type ProjectInfo = {
  readonly file: string | null;
  readonly name: string | null;
  readonly itemCount: number;
};

export type CompInfo = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly frameRate: number;
  readonly layerCount: number;
};

/** `TextLayer`, `ShapeLayer`, any other `AVLayer`, or a camera/light. */
export type LayerType = "text" | "shape" | "av" | "other";

export type LayerInfo = {
  /** `Layer.id`: stable for the layer's life, unlike `index` or `name`. */
  readonly id: number;
  readonly name: string;
  /** Position in the stack, 1 at the top; changes when layers are added. */
  readonly index: number;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly type: LayerType;
};

export type CreateCompOptions = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Seconds. */
  readonly duration: number;
  readonly frameRate: number;
  /** Defaults to 1 (square pixels). */
  readonly pixelAspect?: number;
};

export type TextLayerOptions = {
  readonly text: string;
  /** Layer name; defaults to what AE names it (the text). */
  readonly name?: string;
  /** PostScript name, e.g. `"ArialMT"`. AE falls back silently if it has no such font. */
  readonly font?: string;
  readonly fontSize?: number;
  /** `[r, g, b]`, each 0–1. */
  readonly fillColor?: readonly [number, number, number];
  /** `[x, y]` in comp pixels; AE centres a new text layer by default. */
  readonly position?: readonly [number, number];
};

/** A new text layer, with the font AE actually applied. */
export type TextLayerInfo = LayerInfo & {
  readonly font: string;
  readonly fontSize: number;
};

/** Layer transform values as AE reports them (`[x, y, z]` for 2D layers too). */
export type LayerTransform = {
  readonly anchorPoint: readonly number[];
  readonly position: readonly number[];
  readonly scale: readonly number[];
  readonly rotation: number;
  readonly opacity: number;
};

/**
 * One path of a shape layer, in layer space: `[x, y]` vertices and the
 * tangents relative to them. Group transforms are not applied; `groups`
 * names the groups the path sits in, outermost first.
 */
export type ShapePath = {
  readonly groups: readonly string[];
  readonly name: string;
  readonly closed: boolean;
  readonly vertices: ReadonlyArray<readonly [number, number]>;
  readonly inTangents: ReadonlyArray<readonly [number, number]>;
  readonly outTangents: ReadonlyArray<readonly [number, number]>;
};

/** The project and active composition at one moment, as a menu command saw them. */
export type SceneSnapshot = {
  readonly itemCount: number;
  /** Name of the active composition, or null when none is active. */
  readonly comp: string | null;
  /** Layers of the active composition, top first; empty when none is active. */
  readonly layers: readonly LayerInfo[];
};

/**
 * What running a menu command did. `added` and `removed` compare layer ids
 * of the active composition before and after; when the active composition
 * itself changed, they compare the two compositions' layers.
 */
export type CommandExecution = {
  readonly id: number;
  /** The name it was looked up by, when it was. */
  readonly name?: string;
  readonly durationMs: number;
  readonly before: SceneSnapshot;
  readonly after: SceneSnapshot;
  readonly added: readonly LayerInfo[];
  readonly removed: readonly LayerInfo[];
};

export type EffectInfo = {
  readonly name: string;
  readonly matchName?: string;
};

/**
 * What a property holds, as far as scripting can tell without reading it.
 *
 * - `value`: a value a script can read and write; `value` is present, shaped
 *   by `valueType`.
 * - `no-value`: `PropertyValueType.NO_VALUE`, nothing to read or write
 *   (e.g. Tint's `ADBE Tint-0004`, Gradient Ramp's `ADBE Ramp-0008`).
 * - `custom-value`: a value this API does not carry: `CUSTOM_VALUE` (Levels'
 *   histogram, Curves), which After Effects does not expose to scripts, and
 *   `MARKER`, `SHAPE`, `TEXT_DOCUMENT`.
 * - `group`: a property group, such as every effect's Compositing Options
 *   (`ADBE Effect Built In Params`).
 */
export type PropertyKind = "value" | "no-value" | "custom-value" | "group";

/**
 * The `PropertyValueType` of a property this API reads and writes, by its
 * After Effects enum name.
 */
export type ValueType =
  | "OneD"
  | "TwoD"
  | "TwoD_SPATIAL"
  | "ThreeD"
  | "ThreeD_SPATIAL"
  | "COLOR"
  | "LAYER_INDEX"
  | "MASK_INDEX";

/** A value as read or written: a number, or an array of numbers. */
export type ParameterValue = number | readonly number[];

/**
 * A readable property's `valueType` and the `value` it reads as, observed on
 * AE 26.5x89. Writes take the same shape, except that `ThreeD*` also takes 2
 * numbers (z becomes 0) and `COLOR` 3 (alpha becomes 1).
 */
export type ValueProperty =
  | { readonly kind: "value"; readonly valueType: "OneD" | "LAYER_INDEX" | "MASK_INDEX"; readonly value: number }
  | { readonly kind: "value"; readonly valueType: "TwoD" | "TwoD_SPATIAL"; readonly value: readonly [number, number] }
  | {
      readonly kind: "value";
      readonly valueType: "ThreeD" | "ThreeD_SPATIAL";
      readonly value: readonly [number, number, number];
    }
  | {
      readonly kind: "value";
      readonly valueType: "COLOR";
      /** `[r, g, b, a]`, each normally 0–1. */
      readonly value: readonly [number, number, number, number];
    };

/**
 * One property of an effect. `value` is present exactly when `kind` is
 * `"value"`; narrow on `kind`, then on `valueType`, to read it.
 */
export type PropertyInfo = {
  readonly name: string;
  readonly matchName?: string;
} & (
  | ValueProperty
  | { readonly kind: "no-value"; readonly valueType: "NO_VALUE"; readonly value?: undefined }
  | {
      readonly kind: "custom-value";
      /** `CUSTOM_VALUE`, `MARKER`, `SHAPE` or `TEXT_DOCUMENT`. */
      readonly valueType: string;
      readonly value?: undefined;
    }
  | { readonly kind: "group"; readonly valueType?: undefined; readonly value?: undefined }
);

export type RenderedFrame = {
  /** Absolute path to the written PNG. */
  readonly path: string;
  readonly frame: number;
  readonly width: number;
  readonly height: number;
};

/**
 * A budget for one operation, overriding the session's `timeoutMs` for that
 * call only. As with the session budget, it ends the wait, not the work: a
 * script that is still running in After Effects at the deadline runs to
 * completion, and the next call waits for it.
 */
export type OperationOptions = {
  readonly timeoutMs?: number;
};

export type OpenProjectOptions = OperationOptions & {
  /** `"discard"` drops the open project's unsaved changes; default refuses. */
  readonly unsavedChanges?: "refuse" | "discard";
};

export type RenderOptions = OperationOptions & {
  /** Subdirectory of the session's artifact directory. Defaults to the root. */
  readonly subdirectory?: string;
  /** Filename stem. Defaults to the composition name. */
  readonly prefix?: string;
};

export type LaunchOptions = {
  /**
   * A host script that declares extension methods, built by
   * `ae-a8n extension build`. Omitted, the shipped `host/a8n-host.js` runs.
   *
   * The file is read once at launch: the same bytes are what After Effects
   * runs, so a file edited between launch and a call cannot change what the
   * session does.
   */
  readonly hostScript?: string;
  /**
   * Where request files, results, artifacts, and the trace live. Defaults to a
   * fresh directory under the OS temp dir.
   */
  readonly sessionRoot?: string;
  /** Explicit After Effects install directory; skips discovery. */
  readonly installDir?: string;
  /** Per-operation timeout, excluding the readiness probe. */
  readonly timeoutMs?: number;
  /**
   * How long the readiness probe may wait for After Effects to become
   * scriptable, in milliseconds. Default 180 000.
   *
   * A cold start can exceed the default: first-run dialogs, plugin scans and
   * a busy machine all delay the moment AE answers `app.info`. This budget
   * covers that wait only; it does not extend `timeoutMs`.
   */
  readonly readinessTimeoutMs?: number;
  /**
   * Supply a transport to bypass process invocation entirely. This is how the
   * fake host is injected, and how `ae-farm` runs against a remote worker.
   *
   * The named selection `"in-ae-dispatcher"` (or
   * `{ kind: "in-ae-dispatcher", channelDir? }`) opts into the in-AE
   * dispatcher transport (#127): requests go through a private file channel
   * to a dispatcher a human activated inside After Effects, with no per-call
   * Apple Events. It is explicit opt-in only — there is no fallback to the
   * script transport, and the default is unchanged.
   */
  readonly transport?: TransportSelection;
  /**
   * Environment variables to set inside the After Effects process once it
   * is ready, before anything else runs (`$.setenv`). Native plugins read
   * them with `getenv`. They live in that process only: nothing is written
   * to preferences, and they are gone when AE exits. Needed on macOS, where
   * AE started through LaunchServices does not inherit the caller's
   * environment. Applied only to a host this session owns; otherwise launch
   * rejects with `HostNotOwnedError` and leaves the running AE untouched.
   */
  readonly hostEnvironment?: Readonly<Record<string, string>>;
  /**
   * Explicit authorization for operations that only an owned session may
   * otherwise perform (#145). Ownership and authorization are separate
   * authorities: a session that started its After Effects needs no grant;
   * a session attached to a running one needs the grant for each
   * privileged operation class it intends to use (`extensionMethods`,
   * `hostEnvironment`, `menuCommands`). A session whose ownership is
   * `unknown` — target identity unproven — is never authorized by a grant;
   * it must establish `attached`/`owned` first.
   *
   * The grant is the caller's recorded consent and a caller-side gate: the
   * AE host does not authenticate or independently authorize it (the
   * channel token remains the only host-side check). It never changes
   * ownership and never permits quitting the host: `close()` still quits
   * only a proven-owned instance. It is snapshotted at launch, recorded in
   * the trace and `ae.capabilities()`, and it ends with the session — a
   * reconnect or a different target instance must be authorized again.
   */
  readonly authorization?: SessionAuthorization;
  /**
   * The macOS login session the After Effects lives in.
   *
   * The default is the session this process runs in. A test that runs inside
   * an isolated OS user's session names that user here: the Apple Event is
   * then delivered inside that user's session, the process list is scoped to
   * it, and the console user's After Effects is neither addressed nor quit.
   *
   * With `recover`, a timed-out call is followed by a GUI fallback that
   * closes what is blocking the host — *inside that session only*. The
   * operation that timed out is never sent again.
   */
  readonly session?: {
    /** The OS user whose login session owns the After Effects. */
    readonly uid: number;
    /**
     * Whether a modal dialog may be closed by GUI automation when it blocks
     * the host. Off by default: a dialog that asks for a decision belongs to
     * a human.
     */
    readonly recover?: boolean;
  };
  /**
   * How long a recovered call may then wait for the answer to the request it
   * already sent, in milliseconds. Default 60 000; 0 stops waiting at once.
   *
   * Only meaningful with `session.recover`. It is *additional* time, on top of
   * `timeoutMs`: `timeoutMs` ends the first wait, then the GUI fallback runs
   * (which can take a while — it observes windows, takes a screenshot and
   * presses the dialog), and only then does this grace start. Set it when the
   * caller needs a total budget rather than a first-wait budget.
   */
  readonly recoveryGraceMs?: number;
};

/**
 * Options for `AfterEffects.attach` (#269): the same session shape as
 * `launch`, plus an optional target pin. Attach never starts a process —
 * it connects to an After Effects that is already running, or fails with
 * `AttachTargetError`. There is no launch fallback and no resend after an
 * unknown outcome.
 */
export type AttachOptions = Omit<LaunchOptions, "sessionRoot"> & {
  /** Same meaning as `LaunchOptions.sessionRoot`. */
  readonly sessionRoot?: string;
  /**
   * Which running After Effects to attach to. With no `target`, the
   * transport attaches only when the census finds exactly one in-scope
   * instance of the selected install; several candidates are refused as
   * `ambiguous`. `target.pid` pins one process — it must still name a
   * single in-scope After Effects, and a pid that belongs to another
   * login session's AE is refused as `wrong-session`. On macOS the pin is
   * honoured only while its target is the single in-scope instance:
   * delivery addresses the app bundle rather than a pid, so a sibling
   * could receive the probe. The pin is enforced only by the built-in
   * script lane; a supplied transport keeps its own selection, and a pin
   * it cannot enforce is refused.
   */
  readonly target?: {
    readonly pid?: number;
  };
};

/**
 * Options for `AfterEffects.activateDispatcher` (#276): deliver the
 * generated in-AE dispatcher activation script to the After Effects this
 * session owns. Windows only — the delivery mechanism is `AfterFX.exe -r`.
 */
export type ActivateDispatcherOptions = {
  /**
   * The dispatcher channel directory to activate. Defaults to the
   * per-user channel (`defaultDispatcherChannelDir()`); the directory is
   * prepared first, exactly as `ae-a8n dispatcher prepare` does.
   */
  readonly channelDir?: string;
  /**
   * How long to wait for the dispatcher's heartbeat after the `-r`
   * delivery. Default 15 s. A timeout is not proof of failure — After
   * Effects may be showing a script-trust or consent dialog — so the
   * error says so and names the manual activation path.
   */
  readonly timeoutMs?: number;
};

/** What `AfterEffects.activateDispatcher` reports once the heartbeat is fresh. */
export type DispatcherActivation = {
  /** The channel directory the dispatcher is answering on. */
  readonly channelDir: string;
  /** The dispatcher instance id from its heartbeat. */
  readonly instance: string;
  /** The After Effects version the dispatcher reports. */
  readonly aeVersion: string;
};

/**
 * Options for `AfterEffects.resume`: the same session shape as `launch`,
 * except `sessionRoot` is required — it is the directory the original
 * `launch()` used, which holds the launch-provenance record resume checks.
 */
export type ResumeOptions = Omit<LaunchOptions, "sessionRoot"> & {
  readonly sessionRoot: string;
};

/**
 * Options for `AfterEffects.rebuild` (#286): the same session shape as
 * `resume` — `sessionRoot` is required and names the directory the crashed
 * session used, which holds both the supervision state that proved
 * `process-gone` and the launch-provenance record that proved ownership.
 * Rebuild relaunches After Effects through the ordinary launch path; it
 * never attaches to, kills, or mutates a process it cannot prove was the
 * owned one.
 */
export type RebuildOptions = ResumeOptions;

/**
 * What `AfterEffects.rebuild` did, for the caller and the trace. The
 * returned `AfterEffects` session is the authority on the new host; this
 * report is the audit of the transition itself.
 */
export type SessionRebuildReport = {
  /** The pid the launch-provenance record named before the crash. */
  readonly previousPid: number;
  /** The pid the rebuilt session proved it owns, when one was proven. */
  readonly pid: number | null;
  /**
   * The supervision phase after the rebuild was recorded — `resumed` when
   * the machine accepted recovery success, or whatever the monitor had
   * already moved the session to (e.g. `blocked` behind a crash-repair
   * dialog the rebuilt AE is showing).
   */
  readonly phase: string | null;
  /** Pending requests whose recorded result proved an outcome. */
  readonly pendingResolved: number;
  /** Pending requests left `unknown` — never resent. */
  readonly pendingUnknown: number;
};

/*
 * Read-only GUI observation (#109).
 *
 * `ae.guiState()` reports what the owned After Effects session's screen
 * currently shows — windows, their classification against the same dialog
 * policy `session.recover` uses, and the aggregate verdict — without
 * pressing anything. "unavailable" is a first-class answer: when no owned
 * target is attested or the session cannot be entered, the report says so
 * instead of guessing.
 */

/** How one observed window stands against the recovery policy. */
export type GuiWindowClassification =
  /** The window does not hold the host at a modal state. */
  | { readonly kind: "not-blocking" }
  /**
   * A measured dialog class whose safe button `session.recover` may press.
   */
  | { readonly kind: "pressable"; readonly dialogClass: string }
  /**
   * A recognised dialog class that may never be pressed (crash repair,
   * startup warning, recovery project, scripting permission). `reason`
   * says why it is a human's decision.
   */
  | {
      readonly kind: "unpressable";
      readonly dialogClass: string;
      readonly reason: string;
    }
  /** A sign-in, licence or account window: always a human's decision. */
  | { readonly kind: "human-only"; readonly dialogClass: string | null }
  /** Blocking, but not a class the project has measured: quarantine. */
  | { readonly kind: "unknown"; readonly code: "A8N-SEC-001" };

export type GuiWindowReport = {
  /** 1-based position in the Accessibility listing, as `listWindows` sees it. */
  readonly index: number;
  readonly title: string;
  readonly role: string;
  readonly subrole: string | null;
  readonly texts: readonly string[];
  readonly buttons: readonly string[];
  readonly blocking: boolean;
  readonly classification: GuiWindowClassification;
};

/**
 * The verdict `session.recover` would reach over the same windows, from
 * `chooseRecoveryWindow` — the same classifier the press path uses, so the
 * report never disagrees with what a recovery would do.
 */
export type GuiAssessment = {
  readonly action: "none" | "human-only" | "unpressable" | "known" | "quarantine";
  /** Present only for `quarantine`: the diagnostic the run would report. */
  readonly code: DiagnosticCode | null;
  /** What was seen and what it means, for a human. */
  readonly detail: string;
  /** `describeWindow` of the window the verdict is about, when there is one. */
  readonly window: string | null;
};

export type GuiSessionInfo = {
  readonly uid: number;
  readonly username: string;
  readonly asid: number | null;
  readonly kind: string;
};

export type GuiStateObservation = {
  readonly pid: number;
  readonly session: GuiSessionInfo;
  /** Whether the AE process is the frontmost app of its session. */
  readonly frontmost: boolean;
  readonly windows: readonly GuiWindowReport[];
  /**
   * The WindowServer census for this pid. When unavailable the AX listing
   * alone was used and `windows` may under-report what is on screen.
   */
  readonly windowServer: GuiAppState["windowServer"];
  /**
   * True when AX reported zero windows but the WindowServer lists some:
   * the AX tree is unserviceable and `windows` is not evidence of a clean
   * screen.
   */
  readonly axSuspect: boolean;
  readonly assessment: GuiAssessment;
  readonly observedAt: string;
};

export type GuiStateReport =
  | ({ readonly status: "observed" } & GuiStateObservation)
  | {
      readonly status: "unavailable";
      /** Why nothing could be observed; never a silent empty report. */
      readonly reason: string;
      readonly observedAt: string;
    };
