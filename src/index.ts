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
  DockedPane,
  Effects,
  Effect,
  Layer,
  MenuCommand,
  Panel,
  Parameter,
  Project,
  REDO_COMMAND_ID,
  UNDO_COMMAND_ID,
} from "./api/index.js";

export {
  AfterEffectsError,
  AttachTargetError,
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
export type { AttachFailureReason } from "./api/errors.js";

/*
 * Panel interaction surface (#343, specs/panel-interaction/spec.md):
 * `ae.panel(locator)` plus the capability report. Mutation (resize /
 * restore) is gate-pending; observe operations run on owned targets.
 */
export { panelCapabilities, PanelError } from "./api/panels.js";
export type {
  PanelCapabilities,
  PanelCapability,
  PanelCapture,
  PanelErrorCode,
  PanelFrame,
  PanelLocator,
  PanelMeasurement,
  PanelSize,
  PanelSurface,
  PanelTarget,
} from "./panels/types.js";

/*
 * Menu-bar surface (#360, specs/workspace-editing/spec.md): `ae.menuBar()`
 * plus the capability report. Enumerate and checkmark readback are
 * observe-class; invoke is mutate-gui and gate-pending.
 */
export {
  MenuBar,
  MenuError,
  menuBarForTarget,
  menuCapabilities,
} from "./api/menus.js";
export type {
  MenuBarItemInfo,
  MenuBarSnapshot,
  MenuCapabilities,
  MenuCapability,
  MenuCheckReading,
  MenuCheckState,
  MenuErrorCode,
  MenuInvokeResult,
  MenuItemLocator,
  MenuItemNode,
  ResolvedMenuItem,
} from "./menus/types.js";

/*
 * Docked-region pane surface (#361, specs/workspace-editing/spec.md §6/§7):
 * `ae.dockedPane(locator)` — observe-class bounded AX walk of a pane inside
 * the main window. Real-host AX fidelity is unverified; see
 * `panelCapabilities().dockedRegion`.
 */
export type {
  DockedPaneBounds,
  DockedPaneLocator,
  DockedPaneOps,
  DockedPaneResolution,
  DockedPaneRow,
  DockedPaneSeams,
  DockedPaneTree,
} from "./api/index.js";

/*
 * Render Queue + native file-dialog surface (#365,
 * specs/workspace-editing/spec.md §3 W3): `ae.renderQueue(locator)` —
 * observe-class AX rows (`oracle: "limited"`, no DOM readback exists)
 * plus gated menu-driven add; `ae.fileDialog()` — bounded wait for the
 * declared picker class, gated confirm/cancel, and filename entry that
 * stays `unsupported` until the B-IME OS input posters land (#372/#373).
 */
export {
  FileDialog,
  FileDialogError,
  fileDialogCapabilities,
  fileDialogForTarget,
  matchFileDialog,
  RenderQueue,
  RenderQueueError,
  renderQueueCapabilities,
  renderQueueForTarget,
  RENDER_QUEUE_ORACLE,
} from "./api/index.js";
export type {
  AddToRenderQueueOptions,
  AwaitFileDialogOptions,
  FileDialogActResult,
  FileDialogCapabilities,
  FileDialogCapability,
  FileDialogErrorCode,
  FileDialogMatch,
  FileDialogMutationGate,
  FileDialogOps,
  FileDialogResolution,
  FileDialogTitles,
  FilenameEntryVerdict,
  RenderQueueAddResult,
  RenderQueueCapabilities,
  RenderQueueCapability,
  RenderQueueErrorCode,
  RenderQueueItem,
  RenderQueueOracle,
  RenderQueueSnapshot,
  RenderQueueWalkInfo,
} from "./api/index.js";

/*
 * Capability handshake surface (#102): `ae.capabilities()` plus the
 * negotiation and dispatch-authorization helpers, structurally conforming
 * to ae-devtools `ae-devtools.capability-handshake/v1`.
 */
export {
  assertDispatchAllowed,
  CAPABILITY_CONTRACT_SCHEMA,
  CAPABILITY_CONTRACT_VERSION,
  CAPABILITY_ID_SNAPSHOT,
  negotiateCapabilities,
  PERMISSION_VALUES,
  type CapabilityAdvertisement,
  type CapabilityKind,
  type Compatibility,
  type ContractVersion,
  type DispatchCheck,
  type DispatchResult,
  type ExecutionClass,
  type ExecutionDescriptor,
  type ExecutionGuarantees,
  type ExecutionModeStability,
  type HandshakeDiagnostic,
  type HandshakeResponse,
  type HandshakeTarget,
  type HostSessionEvidence,
  type ImplementationAxis,
  type NegotiationRequest,
  type NegotiationResult,
  type NonInterferenceEvidence,
  type OwnershipEvidence,
  type Permission,
  type ProofLevel,
  type RefusalReason,
  type RowPersistence,
  type SupervisionAdvertisement,
  type VerificationAxis,
} from "./api/capabilities.js";

export type {
  ApplicationInfo,
  AttachOptions,
  CommandExecution,
  CompInfo,
  CreateCompOptions,
  DiagnosticsOptions,
  DispatcherTransportSelection,
  EffectInfo,
  GuiAssessment,
  GuiSessionInfo,
  GuiStateObservation,
  GuiStateReport,
  GuiWindowClassification,
  GuiWindowReport,
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
  RebuildOptions,
  ResumeOptions,
  SessionRebuildReport,
  TerminateOptions,
  TerminateReport,
  TransportRestage,
  ParameterValue,
  ProjectInfo,
  PropertyInfo,
  PropertyKind,
  ValueProperty,
  ValueType,
  RenderOptions,
  RenderedFrame,
  SessionDiagnostics,
  TransportSelection,
} from "./api/types.js";

export { TraceRecorder } from "./trace/trace.js";
export { TERMINATE_PERMIT } from "./api/types.js";
export type { TraceEvent, TraceStatus } from "./trace/trace.js";
export type { DiagnosticCode } from "./doctor/diagnostics.js";

export { AeDriver } from "./driver/driver.js";
export type { DriverOptions, HostCondition, StopOptions, StopResult } from "./driver/driver.js";
export type {
  HostAttestation,
  HostOwnership,
  HostState,
  HostTransport,
  InvokeOptions,
  OwnedProcess,
} from "./driver/transport.js";
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
  DispatcherTransport,
  DISPATCHER_TRANSPORT_KIND,
  defaultDispatcherChannelDir,
  dispatcherStartupDir,
  type DispatcherChannelStatus,
  type DispatcherHeartbeat,
  type DispatcherTransportOptions,
} from "./driver/dispatcher-transport.js";
export {
  NATIVE_REQUIRES_CONSENT_OPERATIONS,
  nativeOperationRequiresConsent,
} from "./driver/native-consent.js";
export {
  NATIVE_CHANNEL_META,
  NATIVE_CHANNEL_STATE,
  NATIVE_CLAIMED_SUFFIX,
  NATIVE_DISPATCH_OUTCOMES,
  NATIVE_DISPATCH_SCHEMA,
  NATIVE_REQUEST_ID_RE,
  NATIVE_REQUEST_SUFFIX,
  NATIVE_RESULT_SUFFIX,
  NATIVE_TIMEOUT_MAX_MS,
  NativeChannelTimeoutError,
  awaitNativeResult,
  claimedRequestPath,
  defaultNativeChannelDir,
  hasClaimedRequest,
  prepareNativeChannel,
  publishNativeRequest,
  readNativeChannelState,
  reconcileItemComment,
  updateNativeChannelAuthorization,
  type AwaitNativeResultOptions,
  type NativeChannelState,
  type NativeCommentReconciliation,
  type NativeDispatchOutcome,
  type NativeDispatchResult,
  type NativeHostAttestation,
  type NativeMutationAuthorization,
  type NativeMutationGrant,
  type NativeRequestInput,
  type NativeResultDelivery,
  type PrepareNativeChannelOptions,
  type PreparedNativeChannel,
  type ReconcileItemCommentOptions,
} from "./driver/native-channel.js";
export {
  launchProvenancePath,
  readLaunchProvenance,
} from "./driver/launch-provenance.js";
export type { LaunchProvenance } from "./driver/launch-provenance.js";
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
  GuiAttributionError,
  GuiMutationError,
  GuiRecoveryError,
  isBlockingWindow,
  isPidAttributedWindow,
  MacGuiRecovery,
  parseUiListing,
  screenshotLooksReal,
  type AxWindowAttribution,
  type GuiAppState,
  type GuiButtonInfo,
  type GuiFrame,
  type GuiLeaseController,
  type GuiRecoveryOptions,
  type GuiWindowInfo,
} from "./driver/gui-recovery.js";
export {
  DIALOG_TAXONOMY,
  describeDialogEvidence,
  dialogClassByName,
  extractDialogContent,
  matchDialogClass,
  type DialogClassSpec,
  type DialogEvidence,
  type DialogEvidenceLevel,
  type RegisteredDialogTier,
  type StructuredDialogContent,
} from "./platform/dialog-taxonomy.js";
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
  createHostRecovery,
  type CreateHostRecoveryOptions,
  type HostRecoveryTarget,
} from "./driver/host-recovery.js";
export {
  WindowsHostRecovery,
  type WindowsHostRecoveryOptions,
} from "./driver/windows-host-recovery.js";
export type { WindowsGuiSession } from "./driver/windows-gui-recovery.js";
export {
  listAppInstances,
  MacSessionError,
  parseLsappinfo,
  readGuiSession,
  readGuiSessionFailure,
  readUsername,
  type MacAppInstance,
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

/*
 * GUI supervision contract (#278–#288, specs/gui-supervision/spec.md).
 *
 * `ae.supervisionState()` reads the live session's report; the standalone
 * functions serve consumers that only know the session directory — a CLI
 * or MCP client reconnecting to state a monitor wrote earlier. Everything
 * here is platform-neutral; the OS probes live behind it.
 */
export {
  supervisionReport,
  supervisionStatePath,
  waitForSupervisionPhase,
  type WaitForPhaseOptions,
  type WaitOutcome,
} from "./supervision/index.js";
export {
  startDetachedSupervisor,
  type DetachedSupervisor,
  type DetachedSupervisorOptions,
} from "./supervision/detached.js";
export {
  NEXT_ACTION_REASON_CODES,
  nextAction,
  supervisionNextActions,
  type NextAction,
  type NextActionInput,
  type NextActionReason,
  type NextActionReasonCode,
} from "./supervision/index.js";
export type {
  BlockingInfo,
  DialogTier,
  HostLevelState,
  MonitorRecord,
  ObservationHealth,
  PendingRequest,
  SupervisionPhase,
  SupervisionReport,
  SupervisionReportFacts,
  SupervisionStateDoc,
  SupervisionTransition,
  SupervisionWindow,
} from "./supervision/types.js";

export { A8N_VERSION } from "./version.js";
