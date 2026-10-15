/**
 * `@ido-bata/ae-a8n/testing` — the fake After Effects host.
 *
 * Published so that `ae-test` and anyone else building on `ae-a8n` can verify
 * their own layers without a real After Effects installation. It is a testing
 * surface, not part of the automation API: the automation API is `.`.
 */

export { FakeAfterEffectsTransport } from "./fake-transport.js";
export type { FakeTransportOptions } from "./fake-transport.js";

export {
  FAKE_EFFECTS,
  FakeApplication,
  FakeComp,
  FakeLayer,
  FakePendingFrame,
  FakeProject,
  FakeProperty,
  FakePropertyGroup,
  createDefaultComp,
  createFakeGlobals,
} from "./fake-ae/object-model.js";
export type { FakeEffectSpec, RenderCall } from "./fake-ae/object-model.js";

export {
  CloseOptions,
  FakeFile,
  FakeFolder,
  failNextRenames,
  renamesFailed,
  resetRenameFaults,
  runHostScript,
} from "./fake-ae/es3-runtime.js";
export type { HostGlobals } from "./fake-ae/es3-runtime.js";

export { encodePng } from "./fake-ae/png.js";
export type { Rgb } from "./fake-ae/png.js";
