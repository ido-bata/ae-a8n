/**
 * `@ido-bata/ae-a8n` — programmatic automation runtime and API for Adobe
 * After Effects.
 *
 * The public surface is the API in `./api`. Callers never see the bridge
 * protocol, the ExtendScript host script, or the file-based result channel.
 *
 * The fake After Effects host lives at `@ido-bata/ae-a8n/testing` and is a
 * separate entry point on purpose: it is a test surface, not automation.
 */

export {
  AfterEffects,
  Comp,
  Effects,
  Effect,
  Layer,
  MenuCommand,
  Parameter,
  Project,
  REDO_COMMAND_ID,
  UNDO_COMMAND_ID,
} from "./api/index.js";

export {
  AfterEffectsError,
  EntityNotFoundError,
  HostError,
  HostLeftRunningError,
  HostNotOwnedError,
  HostQuarantinedError,
  HostUnavailableError,
  ParameterValueError,
  PropertyHasNoValueError,
  ProtocolError,
  ScriptNotSentError,
  TimeoutError,
  UnsavedChangesError,
} from "./api/errors.js";
export type { CloseResult } from "./api/index.js";

export type {
  ApplicationInfo,
  CommandExecution,
  CompInfo,
  CreateCompOptions,
  DiagnosticsOptions,
  EffectInfo,
  LaunchOptions,
  LayerInfo,
  LayerTransform,
  LayerType,
  SceneSnapshot,
  ShapePath,
  TextLayerInfo,
  TextLayerOptions,
  OpenProjectOptions,
  OperationOptions,
  ParameterValue,
  ProjectInfo,
  PropertyInfo,
  PropertyKind,
  ValueProperty,
  ValueType,
  RenderOptions,
  RenderedFrame,
  SessionDiagnostics,
} from "./api/types.js";

export { TraceRecorder } from "./trace/trace.js";
export type { TraceEvent, TraceStatus } from "./trace/trace.js";

export { AeDriver } from "./driver/driver.js";
export type { DriverOptions, HostCondition, StopOptions, StopResult } from "./driver/driver.js";
export type { HostOwnership, HostState, HostTransport, InvokeOptions } from "./driver/transport.js";
export {
  darwinDiagnosticSources,
  diagnosticSourcesFor,
  unsupportedDiagnosticSources,
} from "./driver/session-diagnostics.js";
export type {
  CrashReportEntry,
  DiagnosticSources,
  DiagnosticsFile,
  EvidenceAttribution,
} from "./driver/session-diagnostics.js";
export { ScriptInvocationTransport } from "./driver/script-invocation.js";
export {
  AfterEffectsNotInstalledError,
  resolveInstall,
  type AfterEffectsInstall,
} from "./driver/install-path.js";

/*
 * macOS GUI observation and recovery surface (#109, #111).
 *
 * These are the building blocks a recovery orchestrator (ae-devtools #55)
 * consumes: fail-closed session checks, AX + WindowServer observation,
 * dialog classification, and lease-serialized mutation. Everything here is
 * darwin-only in practice — non-Aqua sessions and non-darwin hosts refuse
 * rather than guess.
 */
export {
  assessGuiObservation,
  censusRunnerInSession,
  defaultLeaseController,
  GuiMutationError,
  GuiRecoveryError,
  isBlockingWindow,
  MacGuiRecovery,
  parseUiListing,
  screenshotLooksReal,
  type GuiAppState,
  type GuiButtonInfo,
  type GuiLeaseController,
  type GuiRecoveryOptions,
  type GuiWindowInfo,
} from "./driver/gui-recovery.js";
export {
  chooseRecoveryWindow,
  classifyDialog,
  classifyUnpressable,
  describeWindow,
  isHumanOnlyWindow,
  KNOWN_DIALOG_CLASSES,
  MacHostRecovery,
  RECOVERY_BUTTONS,
  UNPRESSABLE_DIALOG_CLASSES,
  type HostRecovery,
  type MacHostRecoveryOptions,
  type RecoveryContext,
  type RecoveryOutcome,
  type RecoveryWindowChoice,
} from "./driver/recovery.js";
export {
  MacSessionError,
  readGuiSession,
  readGuiSessionFailure,
  readUsername,
  type MacSession,
  type MacSessionKind,
} from "./driver/mac-session.js";
export {
  acquireGuiLease,
  auditGuiEvent,
  defaultGuiLeaseRoot,
  defaultPidAlive,
  defaultPidStartedAt,
  guiLeasePaths,
  guiSessionKey,
  inspectGuiLease,
  reapGuiLease,
  type GuiAuditEvent,
  type GuiLease,
  type GuiLeaseOptions,
  type GuiLeaseOutcome,
  type GuiLeaseSession,
  type PidAliveProbe,
  type PidStartProbe,
} from "./platform/darwin/gui-lease.js";
export {
  censusForPid,
  execFileCensusRunner,
  parseWindowCensus,
  windowServerCensus,
  WINDOW_CENSUS_PYTHON,
  WINDOW_CENSUS_SCRIPT,
  type CensusRunner,
  type WindowCensus,
  type WindowServerWindow,
} from "./platform/darwin/window-census.js";

export { A8N_VERSION } from "./version.js";
