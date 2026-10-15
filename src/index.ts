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

export { AfterEffects, Comp, Effects, Effect, Layer, Parameter, Project } from "./api/index.js";

export {
  AfterEffectsError,
  EntityNotFoundError,
  HostError,
  HostUnavailableError,
  ProtocolError,
  TimeoutError,
  UnsavedChangesError,
} from "./api/errors.js";
export type { CloseResult } from "./api/index.js";

export type {
  ApplicationInfo,
  CompInfo,
  EffectInfo,
  LaunchOptions,
  LayerInfo,
  ProjectInfo,
  PropertyInfo,
  RenderOptions,
  RenderedFrame,
} from "./api/types.js";

export { TraceRecorder } from "./trace/trace.js";
export type { TraceEvent, TraceStatus } from "./trace/trace.js";

export { AeDriver } from "./driver/driver.js";
export type { DriverOptions, StopOptions, StopResult } from "./driver/driver.js";
export type { HostOwnership, HostTransport, InvokeOptions } from "./driver/transport.js";
export { ScriptInvocationTransport } from "./driver/script-invocation.js";
export {
  AfterEffectsNotInstalledError,
  resolveInstall,
  type AfterEffectsInstall,
} from "./driver/install-path.js";

export const A8N_VERSION = "0.1.0-alpha.0";
