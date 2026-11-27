/**
 * ae-a8n IME input fixture — ScriptUI surface (specs/ime-input/spec.md
 * §4.3 Tier-2, §8 "Fixture code"; issue #375, parent #344 / program #337).
 *
 * A consumer-style `HostExtension` module (same contract as
 * `examples/extension-consumer.ts`): build it with
 * `ae-a8n extension build --extension fixtures/input/scriptui/extension.ts`
 * and the methods become callable through `ae.call(...)`.
 *
 * The fixture is a ScriptUI `palette` window holding a retained `edittext`
 * control — the panel spec §5 oracle pattern: the control reference is
 * kept in `$.global` and the committed value is read back through
 * ExtendScript (`a8nInputFixture.scriptuiReadback`). Readback is
 * read-only; there is deliberately no method that writes the control —
 * a direct value set is never IME evidence (spec §4.2).
 *
 * Every returned record follows `fixtures/input/README.md`: `tier: "2"`,
 * `channel: "extendscript-readback"`, `provesOsIme: false`,
 * `verification: "implemented"` — fixture code is not verified on a real
 * host.
 *
 * Method sources are ES3 function expressions: no closures over Node
 * state, no ES5+ syntax — they run inside After Effects.
 */
import type { HostExtension } from "../../../src/extensions/manifest.js";

const STATE_KEY = "__a8nInputFixtureScriptui";

const OPEN_SOURCE = `function (params) {
  var prior = $.global.${STATE_KEY};
  if (prior !== undefined && prior !== null) {
    try { prior.window.close(); } catch (closeError) {}
  }
  var title = "ae-a8n input fixture";
  if (params !== undefined && params !== null &&
      typeof params.title === "string" && params.title !== "") {
    title = params.title;
  }
  var win = new Window("palette", title, undefined, { resizeable: false });
  var edit = win.add("edittext", [10, 10, 340, 24], "");
  try { win.layout.layout(true); } catch (layoutError) {}
  win.show();
  $.global.${STATE_KEY} = {
    window: win,
    edittext: edit,
    openedAt: new Date().toString()
  };
  return {
    ok: true,
    fixture: "ae-a8n-ime-input",
    surface: "scriptui-edittext",
    tier: "2",
    channel: "extendscript-readback",
    retainedControl: "edittext",
    provesOsIme: false,
    verification: "implemented"
  };
}`;

const READBACK_SOURCE = `function () {
  var state = $.global.${STATE_KEY};
  if (state === undefined || state === null ||
      state.edittext === undefined || state.edittext === null) {
    return {
      ok: false,
      fixture: "ae-a8n-ime-input",
      surface: "scriptui-edittext",
      tier: "2",
      channel: "extendscript-readback",
      error: "fixture window is not open",
      provesOsIme: false,
      verification: "implemented"
    };
  }
  var value = null;
  try { value = String(state.edittext.text); } catch (readError) {}
  return {
    ok: true,
    fixture: "ae-a8n-ime-input",
    surface: "scriptui-edittext",
    tier: "2",
    channel: "extendscript-readback",
    committedValue: value,
    provesOsIme: false,
    verification: "implemented",
    observedAt: new Date().toString()
  };
}`;

const CLOSE_SOURCE = `function () {
  var state = $.global.${STATE_KEY};
  var wasOpen = state !== undefined && state !== null;
  var finalValue = null;
  if (wasOpen && state.edittext !== undefined && state.edittext !== null) {
    try { finalValue = String(state.edittext.text); } catch (readError) {}
    try { state.window.close(); } catch (closeError) {}
  }
  $.global.${STATE_KEY} = null;
  return {
    ok: true,
    fixture: "ae-a8n-ime-input",
    surface: "scriptui-edittext",
    tier: "2",
    channel: "extendscript-readback",
    closed: wasOpen,
    finalValue: finalValue,
    provesOsIme: false,
    verification: "implemented"
  };
}`;

const extension: HostExtension = {
  name: "a8n-ime-input-fixture",
  version: "1.0.0",
  methods: [
    { name: "a8nInputFixture.scriptuiOpen", source: OPEN_SOURCE },
    { name: "a8nInputFixture.scriptuiReadback", source: READBACK_SOURCE },
    { name: "a8nInputFixture.scriptuiClose", source: CLOSE_SOURCE },
  ],
};

export default extension;
