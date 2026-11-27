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
  CompView,
  CompViewError,
  compViewCapabilities,
  ContextMenu,
  DockedPane,
  EffectControls,
  EffectControlsError,
  effectControlsCapabilities,
  Effects,
  Effect,
  Layer,
  MenuCommand,
  Panel,
  Parameter,
  Project,
  ProjectDialog,
  REDO_COMMAND_ID,
  Timeline,
  TimelineError,
  timelineCapabilities,
  UNDO_COMMAND_ID,
  WindowOps,
  Workspace,
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
 * OS-level input surface (#374, specs/ime-input/spec.md §5–§6, parent
 * #344 / program #337): `ae.input(locator)` plus the per-OS/session-kind
 * capability report. Every mutation routes through `runInputPlan` —
 * PanelTarget re-resolution, owned attribution, GUI lease, global-input
 * authorization, `inputMutationGate()` (closed today), the three-step
 * focus proof and the §5.5 cleanup contract. Mutations return the
 * `InputAuditRecord`; nothing posts without the full gate chain.
 * Verification level: `automated test` — real delivery unverified.
 */
export {
  Input,
  inputCapabilities,
  inputForTarget,
  inputSessionKind,
} from "./api/input.js";
export {
  INPUT_OPERATION_GATES,
  INPUT_OPERATION_KINDS,
  InputError,
} from "./input/types.js";
export type {
  ClipboardSnapshot,
  ExpectedFocus,
  FocusHolder,
  GlobalInputAuthorization,
  ImeModeSnapshot,
  InputAuditRecord,
  InputAuthorizationRequest,
  InputAuthorizationVerdict,
  InputCapability,
  InputCapabilities,
  InputCleanupAction,
  InputCleanupReport,
  InputCleanupResult,
  InputErrorCode,
  InputFocusEvidence,
  InputGateState,
  InputMouseEvent,
  InputOperationClass,
  InputOperationGate,
  InputOperationKind,
  InputOperationScope,
  InputOps,
  InputOpsContext,
  InputOpsFactory,
  InputPlan,
  InputPlatform,
  InputPoster,
  InputSeams,
  InputSessionKind,
  InputStep,
  InputStepKind,
  InputStepRecord,
  InputSurfaceOps,
  InputVerification,
  InputVerdict,
} from "./api/index.js";

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
 * Context-menu surface (#368, specs/workspace-editing/spec.md §3 W4+):
 * `ae.contextMenu()` — gated right-click inside a re-verified frame
 * (CGEvent right-button via `input-mouse` on macOS), bounded new-window
 * classification like a dialog, gated item invoke. Whether the
 * right-button post and the context-menu AX surface work on a real AE
 * is unverified; see `contextMenuCapabilities()`.
 */
export {
  ContextMenuError,
  contextMenuCapabilities,
  contextMenuForTarget,
  contextMenuItems,
  contextMenuMutationGate,
  contextMenuWindowKey,
  contextMenuExposedTitles,
  matchContextMenu,
} from "./api/index.js";
export type {
  ContextMenuActResult,
  ContextMenuCapabilities,
  ContextMenuCapability,
  ContextMenuControllerOptions,
  ContextMenuErrorCode,
  ContextMenuItem,
  ContextMenuMatch,
  ContextMenuMutationGate,
  ContextMenuMutationOp,
  ContextMenuOps,
  ContextMenuPostVerdict,
  ContextMenuResolution,
  ContextMenuSurface,
  ContextMenuTargetLocator,
  ContextMenuTitles,
  OpenContextMenuOptions,
} from "./api/index.js";

/*
 * Project Open/Save dialog round-trip (#368, specs/workspace-editing/
 * spec.md §3 W4+): `ae.projectDialog()` — File > Open / Save through
 * the real menu and native picker with bounded waits and recorded
 * oracles (`project.info` for open, read-only file stat for save).
 * Every leg is mutate-gui and gate-pending; filename entry additionally
 * awaits the B-IME OS text-input posters (#372/#373).
 */
export {
  ProjectDialogError,
  projectDialogCapabilities,
  projectDialogForTarget,
  projectDialogMutationGate,
} from "./api/index.js";
export type {
  CancelProjectDialogRequest,
  OpenProjectDialogRequest,
  ProjectDialogCapabilities,
  ProjectDialogCapability,
  ProjectDialogChannel,
  ProjectDialogControllerOptions,
  ProjectDialogErrorCode,
  ProjectDialogEvidence,
  ProjectDialogFileStat,
  ProjectDialogLegResult,
  ProjectDialogMutationGate,
  ProjectDialogMutationOp,
  ProjectDialogOps,
  ProjectDialogProjectInfo,
  ProjectDialogRoundTripResult,
  SaveProjectDialogRequest,
} from "./api/index.js";

/*
 * GUI evidence recording surface (#381, specs/gui-evidence/spec.md §5.4):
 * `ae.record.start/stop` plus the `ScreenRecorder` seam OS backends
 * (#382/#384) implement. The lifecycle is platform-neutral; with no
 * backend registered starts refuse honestly.
 */
export {
  RECORDING_DEFAULT_MAX_DURATION_MS,
  RECORDING_MAX_DURATION_MS_CAP,
  RecordingController,
  RecordingError,
  recordingAttributionRefusal,
  recordingRequiresAuthorization,
} from "./evidence/recording.js";
export type {
  RecorderFileProbe,
  RecorderHandle,
  RecorderStartRequest,
  RecorderStartResult,
  RecorderStopResult,
  RecordStartOptions,
  RecordingApiSeams,
  RecordingAuthorizer,
  RecordingAuthorizationRequest,
  RecordingControllerOptions,
  RecordingErrorCode,
  RecordingLease,
  RecordingSession,
  RecordingStopResult,
  RecordingApi,
  ScreenRecorder,
} from "./api/record.js";
export type {
  CaptureScope,
  EvidenceArtifact,
  EvidenceExclusion,
  EvidenceIndexSession,
  EvidenceSegment,
  GuiEvidenceIndexDocument,
} from "./evidence/types.js";

/*
 * Timeline editing surface (#364, specs/workspace-editing/spec.md §3 W2):
 * `ae.timeline(locator)` — timeline scrub, layer/property row selection
 * and keyframe navigation. Every act is mutate-gui (GUI input + DOM
 * readback oracle), gated pending A-SAFETY clearance; `rows` is
 * observe-class. Real-host fidelity is unverified; see
 * `timelineCapabilities()`.
 */
export type {
  NavigateKeyframeRequest,
  NavigateKeyframeResult,
  ScrubRequest,
  ScrubResult,
  SelectRowRequest,
  SelectRowResult,
  TimelineCapabilities,
  TimelineCapability,
  TimelineErrorCode,
  TimelineKeyTarget,
  TimelineKeyframeVia,
  TimelineMouseOps,
  TimelineOpRecord,
  TimelinePoint,
  TimelinePostcondition,
  TimelineRulerGeometry,
  TimelineRowLocator,
  TimelineRowVerify,
  TimelineSeams,
  TimelineVerdict,
} from "./api/index.js";

/*
 * Workspace editing surface (#363, W1 of specs/workspace-editing/spec.md;
 * parent #345 / program #337): `ae.workspace()` plus the capability
 * report and the read-only workspace-XML reader (#362). Observe-class
 * operations run on owned targets; switch/arrange are mutate-gui and
 * gate-pending, and arrange additionally awaits the B-IME drag vehicle.
 */
export {
  workspaceCapabilities,
  workspaceForTarget,
  WorkspaceError,
  assessFrameMonitors,
  classifyTopology,
  displaysForFrame,
  monitorEvidence,
  toMonitorDisplay,
  DISPLAY_CENSUS_SCRIPT,
  displayCensus,
  parseDisplayCensus,
} from "./api/index.js";
export type {
  WorkspaceArrangeDestination,
  WorkspaceArrangeExpectation,
  WorkspaceArrangeRequest,
  WorkspaceArrangeResult,
  WorkspaceCapability,
  WorkspaceCapabilities,
  WorkspaceDragRequest,
  WorkspaceDragVerdict,
  WorkspaceErrorCode,
  WorkspaceIdentity,
  WorkspaceMenuEntry,
  WorkspaceMenuPath,
  WorkspaceMonitorReport,
  WorkspaceObservation,
  WorkspaceObservationFailure,
  WorkspacePanelFrame,
  WorkspacePollOptions,
  WorkspaceRestoreReport,
  WorkspaceSeams,
  WorkspaceSurfaceOps,
  WorkspaceSwitchResult,
  WorkspaceTarget,
  WorkspaceXmlComparison,
  WorkspaceXmlEvidence,
  FrameMonitorInfo,
  MonitorCensus,
  MonitorDisplay,
  MonitorEvidence,
  MonitorTopology,
  DisplayCensus,
  DisplayInfo,
} from "./api/index.js";
export {
  DEFAULT_WORKSPACE_MENU_PATH,
  compareWorkspaceFrames,
  workspaceFramesMatch,
} from "./api/index.js";
export {
  WorkspaceXmlError,
  discoverWorkspaceXml,
  inspectWorkspaceXml,
  resolveWorkspacePreferencesDir,
  snapshotWorkspaceStore,
  workspaceXmlRef,
  extractWorkspaceNames,
  compareVersionDirNames,
  WORKSPACE_STORE_NAMES,
} from "./api/index.js";
export type {
  DiscoverOptions,
  InspectedWorkspaceXml,
  MissingWorkspaceStore,
  ResolvePreferencesOptions,
  WorkspaceDiscovery,
  WorkspaceLayout,
  WorkspaceStoreKind,
  WorkspaceStoreSnapshot,
  WorkspaceXmlErrorCode,
  WorkspaceXmlFile,
  WorkspaceXmlInspection,
  WorkspaceXmlRef,
} from "./api/index.js";

/*
 * Window ops surface (#366, W4+ of specs/workspace-editing/spec.md §9;
 * parent #345 / program #337): `ae.windowOps(locator)` — observe-class
 * `state` plus gated mutate-gui `move`/`resize`/`minimize`/`restore`/
 * `maximize`/`focus`. Every act re-resolves the window, refuses
 * non-"owned" attribution, never resends, and reports `indeterminate`
 * on an unproven postcondition. Real-host AX fidelity is unverified;
 * see `windowOpsCapabilities()`.
 */
export {
  windowOpsCapabilities,
  windowOpsForTarget,
  WindowOpsError,
  windowOpsFramesMatch,
  windowOpsMutationGate,
  DEFAULT_WINDOW_OPS_POLL,
} from "./api/index.js";
export type {
  WindowOpsActRequest,
  WindowOpsActResult,
  WindowOpsActVerdict,
  WindowOpsCapabilities,
  WindowOpsCapability,
  WindowOpsCensusView,
  WindowOpsErrorCode,
  WindowOpsListing,
  WindowOpsMutationGate,
  WindowOpsOp,
  WindowOpsOpsContext,
  WindowOpsOpsFactory,
  WindowOpsPollOptions,
  WindowOpsSeams,
  WindowOpsState,
  WindowOpsSurfaceOps,
  WindowOpsWindowInfo,
  WindowOpResult,
} from "./api/index.js";

/*
 * Comp-view pan/zoom + Effect Controls surface (#367, W4+ of
 * specs/workspace-editing/spec.md; parent #345 / program #337):
 * `ae.compView(locator)` and `ae.effectControls(locator)`. Every act is
 * mutate-gui (GUI input + capture-diff/geometry or DOM readback
 * oracle), gated pending A-SAFETY clearance; value entry additionally
 * requires session-stream authorization. Real-host fidelity is
 * unverified; see `compViewCapabilities()`/`effectControlsCapabilities()`.
 */
export type {
  CompViewAxLocator,
  CompViewCapabilities,
  CompViewCapability,
  CompViewCapture,
  CompViewCaptureDelta,
  CompViewErrorCode,
  CompViewMouseOps,
  CompViewOpRecord,
  CompViewPanRequest,
  CompViewSeams,
  CompViewVerdict,
  CompViewZoomRequest,
  EffectControlsCapabilities,
  EffectControlsCapability,
  EffectControlsErrorCode,
  EffectControlsMouseOps,
  EffectControlsOpRecord,
  EffectControlsReadback,
  EffectControlsRowLocator,
  EffectControlsSeams,
  EffectControlsVerdict,
  PanResult,
  SetFoldedRequest,
  SetFoldedResult,
  SetParameterRequest,
  SetParameterResult,
  ZoomResult,
} from "./api/index.js";
export {
  formatParameterValue,
  parameterValueMatches,
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
