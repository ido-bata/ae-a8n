// RC-436 consumer extension fixture: methods that raise real AE dialogs
// and exercise GUI surfaces through the public hostScript/ae.call path.
export default {
  name: "rc436-acceptance",
  version: "1.0.0",
  methods: [
    {
      // Dirty the project, then ask AE to close it WITH the native
      // save prompt — the human-required unsaved-changes dialog (RC-S4).
      name: "rc436.promptSave",
      source: `function (params) {
        try {
          var comp = app.project.items.addComp("RC436 Dirty", 320, 240, 1, 2, 30);
          app.project.close(2); // CloseOptions.PROMPT_TO_SAVE_CHANGES
          return { prompted: true, comp: String(comp.name) };
        } catch (e) {
          return { prompted: false, error: String(e) };
        }
      }`,
    },
    {
      // A ScriptUI-style alert WITHOUT the ae-a8n marker: an unmeasured
      // dialog class for the unknown/quarantine path (RC-S5).
      name: "rc436.unmarkedAlert",
      source: `function (params) {
        var w = new Window("dialog", "RC436 Probe");
        w.text = "rc436 unmarked probe dialog";
        w.okButton();
        w.show();
        return { shown: true };
      }`,
    },
    {
      // Show a ScriptUI palette window for panel scenarios (Plan B).
      name: "rc436.panelShow",
      source: `function (params) {
        var w = new Window("palette", "RC436 Panel");
        w.orientation = "column";
        w.add("statictext", undefined, "rc436 panel body");
        w.layout.layout(true);
        w.bounds = { x: 100, y: 100, width: 320, height: 200 };
        w.show();
        $.global["__rc436panel"] = w;
        return { shown: true, name: "RC436 Panel" };
      }`,
    },
    {
      name: "rc436.panelInfo",
      source: `function (params) {
        var w = $.global["__rc436panel"];
        if (w === undefined || w === null) return { present: false };
        try { w.layout.layout(true); } catch (e) {}
        return { present: true, bounds: w.bounds, size: w.size };
      }`,
    },
    {
      name: "rc436.panelClose",
      source: `function (params) {
        var w = $.global["__rc436panel"];
        if (w !== undefined && w !== null) { try { w.close(); } catch (e) {} }
        $.global["__rc436panel"] = null;
        return { closed: true };
      }`,
    },
    {
      // Long-running op for timeout/UNKNOWN scenarios (RC-S7/S10).
      name: "rc436.slowOp",
      source: `function (params) {
        var ms = params && params.ms ? params.ms : 20000;
        var end = $.getenv("__never") ? 0 : new Date().getTime() + ms;
        while (new Date().getTime() < end) { /* busy wait inside AE */ }
        return { slept: ms };
      }`,
    },
    {
      // Report what AE thinks is dirty / open, for state assertions.
      name: "rc436.projectState",
      source: `function (params) {
        return {
          file: app.project.file === null ? null : String(app.project.file.fsName),
          dirty: app.project.dirty === true,
          itemCount: app.project.numItems
        };
      }`,
    },
  ],
};
