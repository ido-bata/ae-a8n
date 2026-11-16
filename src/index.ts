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

export { A8N_VERSION } from "./version.js";
