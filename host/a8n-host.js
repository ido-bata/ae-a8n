/*!
 * a8n-host.js — the part of ae-a8n that actually runs inside After Effects.
 *
 * Contract with the driver: the generated bootstrap sets a global `__a8n`
 * with the request and result paths, then evals this file. This script reads
 * the request, dispatches to a method, and publishes the result by rename.
 *
 * The identical file is evaluated against the in-repo fake host during tests —
 * only the peer supplying `app` differs. Keep it that way: any logic that
 * needs to differ per-peer belongs in the peer, not here.
 *
 * ES3 only. ExtendScript has no `let`/`const`, no arrow functions, no `JSON`,
 * no `String.prototype.trim`, and no `Error.captureStackTrace`.
 */

(function () {
  // ---------------------------------------------------------------- codec --

  function loadJson() {
    // Always the bundled codec. AE's engine has no `JSON` of its own; one that
    // is present was put there by another extension (observed on 26.5x89: a
    // Babel-built polyfill, present once startup finished and absent on a cold
    // start), so preferring it made the host behave differently cold and warm.
    //
    // The codec comes back as `$.evalFile`'s completion value. Looking it up
    // on the global object does not work: called from inside a function, a
    // real AE keeps the included file's `var`s in that function's scope.
    var codec = $.evalFile(new File($.fileName).parent.fsName + "/a8n-json.js");
    if (
      codec === undefined ||
      codec === null ||
      typeof codec.parse !== "function" ||
      typeof codec.stringify !== "function"
    ) {
      throw new Error("a8n-json.js did not produce a JSON codec");
    }
    return codec;
  }

  // ------------------------------------------------------------------ fs ---

  function readTextFile(path) {
    var file = new File(path);
    file.encoding = "UTF-8";
    if (!file.exists) {
      throw new Error("request file not found: " + path);
    }
    if (!file.open("r")) {
      throw new Error("cannot open request file: " + path);
    }
    var text = file.read();
    file.close();
    return text;
  }

  function writeTextFile(path, text) {
    var file = new File(path);
    file.encoding = "UTF-8";
    // ExtendScript cannot create intermediate directories, and the driver
    // already created them. Opening for write truncates.
    if (!file.open("w")) {
      throw new Error("cannot open result file for writing: " + path);
    }
    // ExtendScript can report an I/O failure with false instead of throwing.
    // Never rename a staging file unless both the write and the close succeed.
    var wrote = false;
    var closed = false;
    try {
      wrote = file.write(text) !== false;
    } finally {
      closed = file.close() !== false;
    }
    if (!wrote || !closed) {
      throw new Error("cannot finish writing result file: " + path);
    }
  }

  function parentOf(path) {
    var file = new File(path);
    return file.parent.fsName;
  }

  // -------------------------------------------------------------- errors ---

  function toErrorPayload(error) {
    var payload = {
      name: "Error",
      message: "unknown host error"
    };
    if (error === null || typeof error !== "object") {
      payload.message = String(error);
      return payload;
    }
    if (error.name !== undefined && error.name !== null) {
      payload.name = String(error.name);
    }
    if (error.message !== undefined && error.message !== null) {
      payload.message = String(error.message);
    } else {
      payload.message = String(error);
    }
    if (error.line !== undefined && typeof error.line === "number") {
      payload.line = error.line;
    }
    // AE raises errors carrying `errorNumber` (e.g. 5023 for a missing effect).
    if (error.errorNumber !== undefined && typeof error.errorNumber === "number") {
      payload.aeError = error.errorNumber;
    }
    // Set by the host's own typed errors (NoValueError) for the API to branch on.
    if (typeof error.kind === "string") {
      payload.kind = error.kind;
    }
    if (error.matchName !== undefined && error.matchName !== null) {
      payload.message = payload.message + " (matchName: " + String(error.matchName) + ")";
    }
    return payload;
  }

  // ------------------------------------------------------------- helpers ---

  // ExtendScript's Object.prototype has members a plain `object[key]` finds
  // (functions named "+", "-", "*", "/", `toSource`, `watch`, ... observed on
  // AE 26.5x89), so a key that came from a request is looked up as own only.
  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function requireParam(params, name) {
    if (params === null || params === undefined || !has(params, name) || params[name] === undefined) {
      throw new Error("missing required parameter: " + name);
    }
    return params[name];
  }

  function optionalParam(params, name, fallback) {
    if (params === null || params === undefined || !has(params, name) || params[name] === undefined) {
      return fallback;
    }
    return params[name];
  }

  function getProject() {
    if (app.project === null || app.project === undefined) {
      throw new Error("no project is open");
    }
    return app.project;
  }

  function findComp(name) {
    // A real Project has no lookup by name (`itemByName` is undefined on AE
    // 26.5x89), so walk the items. Names are not unique in AE; the first
    // composition with the name wins, and a non-composition item that shares
    // it is skipped.
    var project = getProject();
    var sawOther = false;
    for (var i = 1; i <= project.numItems; i++) {
      var item = project.item(i);
      if (item.name === name) {
        if (item instanceof CompItem) {
          return item;
        }
        sawOther = true;
      }
    }
    if (sawOther) {
      throw new Error("item is not a composition: " + name);
    }
    var missing = new Error("composition not found: " + name);
    // The API turns exactly this into EntityNotFoundError; anything else a
    // lookup raises is reported as itself.
    missing.name = "NotFoundError";
    throw missing;
  }

  function findLayer(comp, name) {
    var layer = comp.layer(name);
    if (layer === null || layer === undefined) {
      throw new Error("layer not found in '" + comp.name + "': " + name);
    }
    return layer;
  }

  function effectParade(layer) {
    var parade = layer.property("ADBE Effect Parade");
    if (parade === null || parade === undefined) {
      throw new Error("layer has no effect parade: " + layer.name);
    }
    return parade;
  }

  /**
   * Effects are addressed by match name internally, but callers know display
   * names. Try the given identifier as a match name first (the documented,
   * locale-independent path), then fall back to scanning by display name.
   */
  function findEffect(layer, identifier) {
    var parade = effectParade(layer);
    var byName = parade.property(identifier);
    if (byName !== null && byName !== undefined) {
      return byName;
    }
    var count = parade.numProperties;
    for (var i = 1; i <= count; i++) {
      var candidate = parade.property(i);
      if (candidate.name === identifier || candidate.matchName === identifier) {
        return candidate;
      }
    }
    return null;
  }

  function applyEffect(layer, identifier) {
    var parade = effectParade(layer);
    var existing = findEffect(layer, identifier);
    if (existing !== null && existing !== undefined) {
      return { effect: existing, created: false };
    }
    try {
      // Match-name form: the deterministic path for third-party plugins.
      var created = parade.addProperty(identifier);
      if (created === null || created === undefined) {
        throw new Error("addProperty returned nothing for: " + identifier);
      }
      return { effect: created, created: true };
    } catch (matchNameError) {
      // Display-name form: some plugins register under their menu label.
      var byLabel = parade.addProperty(identifier);
      if (byLabel === null || byLabel === undefined) {
        throw matchNameError;
      }
      return { effect: byLabel, created: true };
    }
  }

  function findParameter(effect, identifier) {
    var byName = effect.property(identifier);
    if (byName !== null && byName !== undefined) {
      return byName;
    }
    var count = effect.numProperties;
    for (var i = 1; i <= count; i++) {
      var candidate = effect.property(i);
      if (candidate.name === identifier || candidate.matchName === identifier) {
        return candidate;
      }
    }
    return null;
  }

  // PropertyValueType member names, in Adobe's order. Looked up on the live
  // enum, so the numbers come from the host, not from here.
  var VALUE_TYPE_NAMES = [
    "NO_VALUE", "ThreeD_SPATIAL", "ThreeD", "TwoD_SPATIAL", "TwoD", "OneD",
    "COLOR", "CUSTOM_VALUE", "MARKER", "LAYER_INDEX", "MASK_INDEX", "SHAPE",
    "TEXT_DOCUMENT"
  ];

  function valueTypeName(property) {
    var type = property.propertyValueType;
    for (var i = 0; i < VALUE_TYPE_NAMES.length; i++) {
      // Constant keys, not request data: a plain lookup is safe here, and
      // AE's enums are host objects that need not report own properties.
      var member = PropertyValueType[VALUE_TYPE_NAMES[i]];
      if (member !== undefined && member === type) {
        return VALUE_TYPE_NAMES[i];
      }
    }
    return String(type);
  }

  /**
   * The value shapes this API carries, by value type: `min`/`max` array
   * lengths that `setValue` accepts on AE 26.5x89, or 0/0 for a single
   * number. ThreeD takes 2 (z becomes 0) and COLOR 3 (alpha becomes 1).
   * Anything else (MARKER, SHAPE, TEXT_DOCUMENT) is not carried.
   */
  function valueShape(name) {
    if (name === "OneD" || name === "LAYER_INDEX" || name === "MASK_INDEX") {
      return { min: 0, max: 0, text: "a number" };
    }
    if (name === "TwoD" || name === "TwoD_SPATIAL") {
      return { min: 2, max: 2, text: "an array of 2 numbers" };
    }
    if (name === "ThreeD" || name === "ThreeD_SPATIAL") {
      return { min: 2, max: 3, text: "an array of 2 or 3 numbers" };
    }
    if (name === "COLOR") {
      return { min: 3, max: 4, text: "an array of 3 or 4 numbers" };
    }
    return null;
  }

  /**
   * Whether a script can read this property's value, without reading it.
   * On AE 26.5x89 reading `value` throws for PropertyValueType.NO_VALUE
   * (e.g. ADBE Tint-0004, ADBE Ramp-0008) and CUSTOM_VALUE (Levels'
   * histogram, Curves), and a group (Compositing Options) has no value.
   * Value types this API does not carry count as "custom-value".
   */
  function propertyKind(property) {
    if (property.propertyType !== PropertyType.PROPERTY) {
      return "group";
    }
    var name = valueTypeName(property);
    if (name === "NO_VALUE") {
      return "no-value";
    }
    return valueShape(name) === null ? "custom-value" : "value";
  }

  function describeProperty(property) {
    var kind = propertyKind(property);
    var out = { name: property.name, kind: kind };
    if (property.matchName !== undefined && property.matchName !== null) {
      out.matchName = property.matchName;
    }
    if (kind !== "group") {
      out.valueType = valueTypeName(property);
    }
    if (kind === "value") {
      out.value = property.value;
    }
    return out;
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  // Not `instanceof Array`: request values come from the codec, which may run
  // in another realm (as a8n-json.js notes for its own check).
  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  /**
   * Refuses, before touching the property, a write it cannot take: a
   * property without a value (NoValueError), or a value of the wrong shape
   * for its type (ValueShapeError). AE itself would coerce some of these
   * (observed: `[]` written to a OneD property becomes 0).
   */
  function requireWritableValue(property, value) {
    var kind = propertyKind(property);
    var error;
    if (kind !== "value") {
      error = new Error(
        "property has no value to write (" + kind + "): " + property.matchName
      );
      error.name = "NoValueError";
      error.kind = kind;
      throw error;
    }
    var name = valueTypeName(property);
    var shape = valueShape(name);
    var fits;
    if (shape.max === 0) {
      fits = isFiniteNumber(value);
    } else {
      fits = isArray(value) && value.length >= shape.min && value.length <= shape.max;
      for (var i = 0; fits && i < value.length; i++) {
        fits = isFiniteNumber(value[i]);
      }
    }
    if (!fits) {
      error = new Error(
        property.matchName + " (" + name + ") takes " + shape.text
      );
      error.name = "ValueShapeError";
      error.kind = name;
      throw error;
    }
  }

  function zeroPad(value, width) {
    var text = String(value);
    while (text.length < width) {
      text = "0" + text;
    }
    return text;
  }

  // ------------------------------------------------------------- methods ---

  var methods = {};

  methods["app.info"] = function () {
    var info = { version: String(app.version) };
    // AE exposes the build as `app.buildNumber`; `app.build` is undefined on a
    // real host (observed on 26.5x89). An absent value is left out rather than
    // reported as the string "undefined".
    try {
      var build = app.buildNumber;
      if (build !== undefined && build !== null && String(build) !== "") {
        info.build = String(build);
      }
    } catch (e) {
      // build is not guaranteed; version alone is enough for a readiness probe.
    }
    return info;
  };

  /**
   * Refuses when the open project has unsaved changes, unless the caller
   * explicitly allowed discarding them. Named, so the driver can tell a
   * decision the caller must make from a failure.
   */
  function guardUnsavedChanges(params, action) {
    var project = app.project;
    if (project === null || project === undefined || !project.dirty) {
      return false;
    }
    if (optionalParam(params, "discardUnsavedChanges", false) !== true) {
      var refused = new Error("the open project has unsaved changes; " + action + " would discard them");
      refused.name = "UnsavedChangesError";
      throw refused;
    }
    return true;
  }

  /**
   * Shows a modal dialog in After Effects and waits until it is closed.
   *
   * The dialog is native, not scripted: it is the one case an ExtendScript
   * call cannot get out of on its own. It exists so the GUI fallback — the
   * path that closes a dialog for a host that stopped answering — can be
   * exercised against a dialog whose appearance and dismissal are known.
   *
   * `alert` blocks the script, so the result is written only after the
   * dialog has been closed. A caller that gave up on the call must not send
   * it again; the request is still running inside After Effects.
   */
  methods["ui.alert"] = function (params) {
    var message = String(requireParam(params, "message"));
    // The GUI fallback may only press a window it has measured. Its one known
    // class requires a static text beginning "ae-a8n:", so the marker is put
    // on here, whatever the caller passed: a dialog this method raises has to
    // be closable by the fallback it exists for.
    var text = /^\s*ae-a8n:/.test(message) ? message : "ae-a8n: " + message;
    alert(text);
    return { dismissed: true, message: text };
  };

  methods["app.quit"] = function (params) {
    if (guardUnsavedChanges(params, "quitting")) {
      // Closed first, untitled or not: a dirty project would otherwise put a
      // save prompt in front of the quit.
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    }
    app.quit();
    return { quitting: true };
  };

  methods["project.open"] = function (params) {
    var path = String(requireParam(params, "path"));
    var file = new File(path);
    if (!file.exists) {
      throw new Error("project file not found: " + path);
    }
    // Opening replaces the open project; with unsaved changes AE would put a
    // save prompt in front of the script, and the changes may be someone
    // else's work.
    if (guardUnsavedChanges(params, "opening another project")) {
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    }
    var opened = app.open(file);
    // app.open answers with the Project it opened; the path is on
    // project.file. An absent file (an untitled project) reports null.
    var openedFile = opened === null || opened === undefined ? null : opened.file;
    var openedPath = openedFile === null || openedFile === undefined
      ? null
      : openedFile.fsName || openedFile.name;
    return { file: openedPath === null || openedPath === undefined ? null : String(openedPath) };
  };

  methods["project.close"] = function (params) {
    var save = optionalParam(params, "save", false);
    if (save !== true) {
      guardUnsavedChanges(params, "closing without saving");
    }
    var closed = getProject().close(
      save ? CloseOptions.SAVE_CHANGES : CloseOptions.DO_NOT_SAVE_CHANGES
    );
    if (closed === false) {
      var cancelled = new Error("project close was cancelled");
      cancelled.name = "ProjectCloseCancelled";
      throw cancelled;
    }
    return { closed: true };
  };

  methods["project.info"] = function () {
    var project = getProject();
    return {
      file: project.file === null ? null : String(project.file.fsName),
      name: project.file === null ? null : String(project.file.name),
      itemCount: project.numItems
    };
  };

  methods["project.comps"] = function () {
    var project = getProject();
    var out = [];
    for (var i = 1; i <= project.numItems; i++) {
      var item = project.item(i);
      if (item instanceof CompItem) {
        out.push({
          name: item.name,
          width: item.width,
          height: item.height,
          duration: item.duration,
          frameRate: item.frameRate,
          layerCount: item.numLayers
        });
      }
    }
    return out;
  };

  methods["comp.info"] = function (params) {
    return compInfo(findComp(String(requireParam(params, "name"))));
  };

  methods["comp.layers"] = function (params) {
    var comp = findComp(String(requireParam(params, "name")));
    var out = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      out.push(layerInfo(comp.layer(i)));
    }
    return out;
  };

  methods["comp.layer"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    return layerInfo(layer);
  };

  methods["layer.effects"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    var parade = effectParade(layer);
    var out = [];
    for (var i = 1; i <= parade.numProperties; i++) {
      out.push({ name: parade.property(i).name, matchName: parade.property(i).matchName });
    }
    return out;
  };

  methods["layer.applyEffect"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    var identifier = String(requireParam(params, "effect"));
    var result = applyEffect(layer, identifier);
    return {
      name: result.effect.name,
      matchName: result.effect.matchName,
      created: result.created
    };
  };

  methods["effect.parameters"] = function (params) {
    var effect = resolveEffect(params);
    var out = [];
    for (var i = 1; i <= effect.numProperties; i++) {
      out.push(describeProperty(effect.property(i)));
    }
    return out;
  };

  methods["effect.getParameter"] = function (params) {
    var effect = resolveEffect(params);
    var property = requireProperty(effect, String(requireParam(params, "parameter")));
    return describeProperty(property);
  };

  methods["effect.setParameter"] = function (params) {
    var effect = resolveEffect(params);
    var property = requireProperty(effect, String(requireParam(params, "parameter")));
    var value = requireParam(params, "value");
    requireWritableValue(property, value);
    property.setValue(value);
    return describeProperty(property);
  };

  function resolveEffect(params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    var effect = findEffect(layer, String(requireParam(params, "effect")));
    if (effect === null || effect === undefined) {
      throw new Error("effect not found on layer '" + layer.name + "': " + params.effect);
    }
    return effect;
  }

  function requireProperty(effect, identifier) {
    var property = findParameter(effect, identifier);
    if (property === null || property === undefined) {
      var missing = new Error("parameter not found on effect '" + effect.name + "': " + identifier);
      // Named and kinded like findComp's NotFoundError, so the API turns
      // exactly this into EntityNotFoundError(kind: "parameter"); the kind
      // keeps a missing composition inside the same call distinct.
      missing.name = "NotFoundError";
      missing.kind = "parameter";
      throw missing;
    }
    return property;
  }

  methods["comp.renderFrame"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var frame = Number(requireParam(params, "frame"));
    var outputDir = String(requireParam(params, "outputDir"));
    var namePrefix = String(optionalParam(params, "prefix", comp.name));

    var folder = new Folder(outputDir);
    if (!folder.exists && !folder.create()) {
      throw new Error("cannot create output directory: " + outputDir);
    }
    var target = new File(folder.fsName + "/" + namePrefix + "." + zeroPad(frame, 5) + ".png");
    if (target.exists) {
      target.remove();
    }

    // `saveFrameToPng`, not the render queue: a localised AE has no output
    // module template named "PNG Sequence" (ja 26.5x89 lists none) and an
    // output module's "Format" is read-only to setSettings, so the queue
    // cannot be told to write PNG. `saveFrameToPng` renders at the viewer's
    // resolution, so full resolution is forced for the frame and restored.
    var previousResolution = comp.resolutionFactor;
    comp.resolutionFactor = [1, 1];
    try {
      var pending = comp.saveFrameToPng(frame * comp.frameDuration, target);
      // It returns before the file is written (observed: 0 bytes at first);
      // `wait()` blocks until it is, and throws if it failed.
      try {
        pending.wait();
      } catch (waitError) {
        var cause = pending._exception !== undefined && pending._exception !== null
          ? String(pending._exception)
          : String(waitError.message);
        throw new Error("frame " + frame + " of '" + comp.name + "' was not rendered: " + cause);
      }
    } finally {
      comp.resolutionFactor = previousResolution;
    }

    var size = readPngSize(target);
    return {
      path: String(target.fsName),
      frame: frame,
      width: size.width,
      height: size.height
    };
  };

  /** Width and height from a PNG's IHDR: what was written, not what was asked for. */
  function readPngSize(file) {
    if (!file.exists) {
      throw new Error("rendered frame is missing: " + file.fsName);
    }
    file.encoding = "BINARY";
    if (!file.open("r")) {
      throw new Error("cannot open rendered frame: " + file.fsName);
    }
    var head = file.read(24);
    file.close();
    if (head.length < 24 || head.substring(12, 16) !== "IHDR") {
      throw new Error("rendered frame is not a PNG: " + file.fsName);
    }
    function u32(offset) {
      return head.charCodeAt(offset) * 16777216 +
        head.charCodeAt(offset + 1) * 65536 +
        head.charCodeAt(offset + 2) * 256 +
        head.charCodeAt(offset + 3);
    }
    return { width: u32(16), height: u32(20) };
  }


  // -------------------------------------------------- scene construction ---

  function layerType(layer) {
    // Most specific first: a ShapeLayer and a TextLayer are also AVLayers.
    if (typeof TextLayer !== "undefined" && layer instanceof TextLayer) {
      return "text";
    }
    if (typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer) {
      return "shape";
    }
    if (typeof AVLayer !== "undefined" && layer instanceof AVLayer) {
      return "av";
    }
    return "other";
  }

  function layerInfo(layer) {
    return {
      id: layer.id,
      name: layer.name,
      index: layer.index,
      enabled: layer.enabled,
      selected: layer.selected,
      type: layerType(layer)
    };
  }

  function compInfo(comp) {
    return {
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameRate: comp.frameRate,
      layerCount: comp.numLayers
    };
  }

  function requireNumber(params, name, min) {
    var value = requireParam(params, name);
    if (!isFiniteNumber(value) || value < min) {
      throw new Error(name + " must be a number >= " + min);
    }
    return value;
  }

  function requireNumbers(value, name, length) {
    if (!isArray(value) || value.length !== length) {
      throw new Error(name + " must be an array of " + length + " numbers");
    }
    for (var i = 0; i < value.length; i++) {
      if (!isFiniteNumber(value[i])) {
        throw new Error(name + " must be an array of " + length + " numbers");
      }
    }
    return value;
  }

  methods["project.createComp"] = function (params) {
    var project = getProject();
    var name = String(requireParam(params, "name"));
    // Comps are addressed by name, so a second comp with the name could never
    // be reached; refuse instead of creating it.
    for (var i = 1; i <= project.numItems; i++) {
      if (project.item(i).name === name) {
        throw new Error("an item named '" + name + "' already exists");
      }
    }
    var comp = project.items.addComp(
      name,
      requireNumber(params, "width", 4),
      requireNumber(params, "height", 4),
      optionalParam(params, "pixelAspect", 1),
      requireNumber(params, "duration", 0.001),
      requireNumber(params, "frameRate", 1)
    );
    return compInfo(comp);
  };

  methods["comp.openInViewer"] = function (params) {
    var comp = findComp(String(requireParam(params, "name")));
    comp.openInViewer();
    return { name: comp.name, active: app.project.activeItem === comp };
  };

  methods["comp.addText"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var text = String(requireParam(params, "text"));
    // Reject every invalid optional value before creating a layer: a failed
    // request must not leave an orphan text layer in the user's project.
    var name = optionalParam(params, "name", null);
    var font = optionalParam(params, "font", null);
    var fontSize = optionalParam(params, "fontSize", null);
    var fillColor = optionalParam(params, "fillColor", null);
    var position = optionalParam(params, "position", null);
    if (fontSize !== null) {
      fontSize = requireNumber(params, "fontSize", 1);
    }
    if (fillColor !== null) {
      fillColor = requireNumbers(fillColor, "fillColor", 3);
    }
    if (position !== null) {
      position = requireNumbers(position, "position", 2);
    }

    var layer = comp.layers.addText(text);
    if (name !== null) {
      layer.name = String(name);
    }
    var source = layer.property("ADBE Text Properties").property("ADBE Text Document");
    var doc = source.value;
    if (font !== null) {
      doc.font = String(font);
    }
    if (fontSize !== null) {
      doc.fontSize = fontSize;
    }
    if (fillColor !== null) {
      doc.applyFill = true;
      doc.fillColor = fillColor;
    }
    doc.applyStroke = false;
    source.setValue(doc);
    if (position !== null) {
      layer.property("ADBE Transform Group").property("ADBE Position")
        .setValue(position);
    }
    var applied = source.value;
    var info = layerInfo(layer);
    // What AE settled on, not what was asked for: an unknown font falls back.
    info.font = String(applied.font);
    info.fontSize = applied.fontSize;
    return info;
  };

  methods["comp.selectLayers"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var names = requireParam(params, "layers");
    if (!isArray(names)) {
      throw new Error("layers must be an array of layer names");
    }
    var wanted = [];
    for (var i = 0; i < names.length; i++) {
      wanted.push(findLayer(comp, String(names[i])));
    }
    // Exactly the named layers: deselect everything else first.
    for (var j = 1; j <= comp.numLayers; j++) {
      comp.layer(j).selected = false;
    }
    for (var k = 0; k < wanted.length; k++) {
      wanted[k].selected = true;
    }
    var selected = [];
    for (var n = 1; n <= comp.numLayers; n++) {
      if (comp.layer(n).selected) {
        selected.push(comp.layer(n).name);
      }
    }
    return { selected: selected };
  };

  methods["layer.setEnabled"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    var enabled = requireParam(params, "enabled");
    if (enabled !== true && enabled !== false) {
      throw new Error("enabled must be a boolean");
    }
    layer.enabled = enabled;
    return layerInfo(layer);
  };

  methods["layer.transform"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    var group = layer.property("ADBE Transform Group");
    return {
      anchorPoint: group.property("ADBE Anchor Point").value,
      position: group.property("ADBE Position").value,
      scale: group.property("ADBE Scale").value,
      rotation: group.property("ADBE Rotate Z").value,
      opacity: group.property("ADBE Opacity").value
    };
  };

  function collectShapePaths(group, groups, out) {
    for (var i = 1; i <= group.numProperties; i++) {
      var child = group.property(i);
      if (child.matchName === "ADBE Vector Group") {
        var nested = groups.slice(0);
        nested.push(child.name);
        collectShapePaths(child.property("ADBE Vectors Group"), nested, out);
      } else if (child.matchName === "ADBE Vector Shape - Group") {
        var shape = child.property("ADBE Vector Shape").value;
        out.push({
          groups: groups,
          name: child.name,
          closed: shape.closed,
          vertices: shape.vertices,
          inTangents: shape.inTangents,
          outTangents: shape.outTangents
        });
      }
    }
  }

  methods["layer.shapePaths"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    if (layerType(layer) !== "shape") {
      throw new Error("not a shape layer: " + layer.name);
    }
    var out = [];
    collectShapePaths(layer.property("ADBE Root Vectors Group"), [], out);
    return out;
  };

  // ------------------------------------------------------- menu commands ---

  methods["app.setEnvironment"] = function (params) {
    var variables = requireParam(params, "variables");
    var names = [];
    for (var key in variables) {
      if (has(variables, key)) {
        // Process-scoped: the variable lives in this AE process only and is
        // gone when it exits. Nothing is persisted to preferences.
        $.setenv(key, String(variables[key]));
        names.push(key);
      }
    }
    return { names: names };
  };

  methods["menu.find"] = function (params) {
    var name = String(requireParam(params, "name"));
    var id = app.findMenuCommandId(name);
    if (!isFiniteNumber(id) || id <= 0) {
      var missing = new Error("menu command not found: " + name);
      missing.name = "NotFoundError";
      throw missing;
    }
    return { id: id, name: name };
  };

  function sceneSnapshot() {
    var project = app.project;
    var active = project === null || project === undefined ? null : project.activeItem;
    var snapshot = {
      itemCount: project === null || project === undefined ? 0 : project.numItems,
      comp: null,
      layers: []
    };
    if (active !== null && active !== undefined && active instanceof CompItem) {
      snapshot.comp = active.name;
      for (var i = 1; i <= active.numLayers; i++) {
        snapshot.layers.push(layerInfo(active.layer(i)));
      }
    }
    return snapshot;
  }

  methods["menu.execute"] = function (params) {
    var id = requireParam(params, "id");
    if (!isFiniteNumber(id) || id <= 0 || Math.floor(id) !== id) {
      throw new Error("menu command id must be a positive integer");
    }
    var before = sceneSnapshot();
    var started = new Date().getTime();
    // Synchronous on AE 26.5x89, including commands an AEGP plugin registers:
    // the plugin's command hook has returned when this does.
    app.executeCommand(id);
    var durationMs = new Date().getTime() - started;
    return {
      id: id,
      durationMs: durationMs,
      before: before,
      after: sceneSnapshot()
    };
  };

  // ----------------------------------------------------------- dispatch ---

  /**
   * Which sessions this engine has answered, by id. A plain object of booleans:
   * the engine outlives every script, so nothing from After Effects (no item,
   * comp or layer) may be kept here, or a later project switch invalidates it.
   */
  function sessionStore() {
    var store = $.global.__a8nSessions;
    if (store === undefined || store === null) {
      store = {};
      $.global.__a8nSessions = store;
    }
    return store;
  }

  /** Refuses before doing anything when the request requires a session this engine never answered. */
  function checkSession(request) {
    var session = request.session;
    if (session === undefined || session === null || session.require !== true) {
      return;
    }
    if (sessionStore()[String(session.id)] !== true) {
      var mismatch = new Error(
        "this After Effects instance did not answer the probe of this session, so " + String(request.method) + " was not run"
      );
      mismatch.name = "SessionMismatch";
      throw mismatch;
    }
  }

  function rememberSession(request) {
    var session = request.session;
    if (session !== undefined && session !== null && session.adopt === true) {
      sessionStore()[String(session.id)] = true;
    }
  }

  function extensionTable() {
    var context = this.__a8n;
    if (context === undefined || context === null || context.extensions === undefined) {
      return {};
    }
    return context.extensions;
  }

  /**
   * The extension method names actually registered in this After Effects,
   * sorted. Read once at dispatcher activation: the table does not grow
   * afterwards, so the heartbeat reports a fixed set (#146).
   */
  function registeredExtensionNames() {
    var table = extensionTable();
    var names = [];
    for (var key in table) {
      if (has(table, key) && typeof table[key] === "function") {
        names.push(key);
      }
    }
    names.sort();
    return names;
  }

  /**
   * A shallow copy of the registered extension functions, taken once at
   * dispatcher activation. Dispatch resolves against this snapshot so the
   * set the heartbeat reports is the set that actually answers (#146).
   */
  function snapshotExtensionFunctions() {
    var table = extensionTable();
    var copy = {};
    for (var key in table) {
      if (has(table, key) && typeof table[key] === "function") {
        copy[key] = table[key];
      }
    }
    return copy;
  }

  /**
   * The registration fingerprint the build prelude left on `__a8n`, or null
   * when the running script was not built by `ae-a8n extension build`. It is
   * copied into the heartbeat verbatim — the host never recomputes it.
   */
  function extensionRegistration() {
    var context = this.__a8n;
    if (context === undefined || context === null) {
      return null;
    }
    var value = context.extensionsRegistration;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function dispatch(request, extensionOverride) {
    if (request === null || typeof request !== "object") {
      throw new Error("request envelope is not an object");
    }
    // Extension methods are registered before this file loads and live in
    // their own table: a built-in name always wins, because the build refuses
    // a collision but the table must still not be able to replace one.
    //
    // Statements, not one nested conditional: measured on AE 26.5x89,
    // ExtendScript evaluates `a ? x : b ? y : undefined` with the second test
    // deciding the whole expression, so a name found in `methods` returned
    // `extensions[name]` — undefined — and every call failed with "unknown
    // method". An explicitly grouped conditional and plain `if` both evaluate
    // correctly; this form is also correct in Node, so the fake host agrees.
    // `extensionOverride` is the dispatcher path's activation-time snapshot
    // (#146): the heartbeat reports that fixed set, so dispatch must resolve
    // against the same fixed set — a later mutation of `__a8n.extensions`
    // cannot widen what the dispatcher answers for.
    var extensions = extensionOverride === undefined ? extensionTable() : extensionOverride;
    var method;
    if (has(methods, request.method)) {
      method = methods[request.method];
    } else if (has(extensions, request.method)) {
      method = extensions[request.method];
    } else {
      method = undefined;
    }
    if (method === undefined) {
      throw new Error("unknown method: " + String(request.method));
    }
    if (typeof method !== "function") {
      throw new Error("the method " + String(request.method) + " is not a function");
    }
    checkSession(request);
    var result = method(request.params);
    rememberSession(request);
    return result;
  }

  function main() {
    var codec = loadJson();
    var context = this.__a8n;
    if (context === undefined || context === null) {
      throw new Error("a8n host invoked without a __a8n context");
    }

    var started = new Date().getTime();
    var request;
    var envelope;

    try {
      request = codec.parse(readTextFile(context.request));
      var result = dispatch(request);
      envelope = {
        v: request.v,
        id: request.id,
        ok: true,
        durationMs: new Date().getTime() - started,
        result: result === undefined ? null : result
      };
    } catch (error) {
      var id = "unknown";
      if (request !== undefined && request !== null && request.id !== undefined) {
        id = String(request.id);
      }
      envelope = {
        v: 1,
        id: id,
        ok: false,
        durationMs: new Date().getTime() - started,
        error: toErrorPayload(error)
      };
    }

    // Publish by rename so the driver never reads a partial envelope. A
    // rename on the same directory is atomic; a direct write is not, and the
    // driver can only tell the difference by refusing to read a half-written
    // file. So the atomic path is worth retrying before giving it up — on
    // Windows a transient handle (antivirus, AE itself) is the usual cause.
    publishResult(String(context.result), codec.stringify(envelope));
  }

  var PUBLISH_ATTEMPTS = 3;
  var PUBLISH_RETRY_MS = 50;

  /** The last path segment, taken from the string so nothing is URI-encoded. */
  function fileNameOf(path) {
    var slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return slash < 0 ? path : path.substring(slash + 1);
  }

  /**
   * Publishes `text` at `resultPath` and says how: "rename" or "direct".
   *
   * "rename": the result appeared whole, by renaming a fully written staging
   * file in the same directory. A reader can never observe part of it.
   *
   * "direct": every rename failed and the result was written in place. A
   * reader *can* observe a partial file; the driver re-reads until the
   * envelope parses, so this costs latency, not correctness.
   *
   * Either way no staging file is left behind.
   */
  function publishResult(resultPath, text) {
    var staging = resultPath + ".part";
    writeTextFile(staging, text);
    var finalFile = new File(resultPath);
    // ExtendScript's `File.rename` takes a new *name* and keeps the file in
    // its directory; given a full path it returns false (observed on AE
    // 26.5x89). Passing a path would make every publication non-atomic.
    var finalName = fileNameOf(resultPath);

    for (var attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      var stagingFile = new File(staging);
      // ExtendScript's rename refuses an existing destination.
      if (finalFile.exists) {
        finalFile.remove();
      }
      if (stagingFile.rename(finalName)) {
        return "rename";
      }
      if (attempt + 1 < PUBLISH_ATTEMPTS) {
        $.sleep(PUBLISH_RETRY_MS);
      }
    }

    // Every atomic attempt failed. Write anyway rather than lose a computed
    // result, then drop the staging copy so it does not accumulate.
    var leftover = new File(staging);
    try {
      writeTextFile(resultPath, text);
    } catch (directWriteError) {
      // A write that reported failure must not leave a readable envelope
      // behind: the driver accepts any parseable result at resultPath, so a
      // complete ok:true left by a failed close would be read as success.
      var partial = new File(resultPath);
      if (partial.exists) {
        partial.remove();
      }
      if (leftover.exists) {
        leftover.remove();
      }
      throw directWriteError;
    }
    if (leftover.exists) {
      leftover.remove();
    }
    return "direct";
  }

  // -------------------------------------------------------- dispatcher ---
  //
  // Opt-in in-AE transport (#127). Instead of answering one request file per
  // script run, this mode keeps an `app.scheduleTask` polling a private
  // channel directory and answers the *same* named operations from the same
  // `methods` table — there is no second dispatch table and no eval of
  // caller-supplied code.
  //
  // Activation is deliberate and human: File > Scripts > Run Script File on
  // the generated `activate.jsx`, or a per-user `Scripts/Startup` entry the
  // user installed. This file never installs itself, never opens a socket,
  // and never quits After Effects.
  //
  // Channel contract (mirrors the one-shot path):
  //   <root>/inbox/<id>.request.json   claimed by rename before it runs
  //   <root>/outbox/<id>.result.json   published by rename
  //   <root>/state.json                heartbeat the Node side reads
  // A request that cannot be answered still gets a failure envelope when it
  // can be published; when it cannot, the caller reports UNKNOWN and never
  // resends — a claimed request is never replayed.

  var DISPATCHER_POLL_MS = 250;
  var DISPATCHER_MIN_POLL_MS = 50;
  var DISPATCHER_MAX_POLL_MS = 5000;
  /** Heartbeat refresh cadence, in ticks. */
  var DISPATCHER_STATE_EVERY = 8;
  /** Outbox results older than this are deleted; they are deliveries nobody read. */
  var DISPATCHER_RESULT_MAX_AGE_MS = 60 * 60 * 1000;

  function dispatcherRefusal(reason) {
    var error = new Error("request refused: " + reason);
    error.name = "RequestRefusedError";
    return error;
  }

  function dispatcherPaths(root) {
    var base = String(root);
    while (base.length > 1 && base.substring(base.length - 1) === "/") {
      base = base.substring(0, base.length - 1);
    }
    return {
      root: base,
      inbox: base + "/inbox",
      outbox: base + "/outbox",
      state: base + "/state.json"
    };
  }

  /**
   * Validates a claimed request and runs it through the same `dispatch` the
   * one-shot path uses. Throws — the caller turns that into a failure
   * envelope — for anything that is not a live, authorized, named operation.
   */
  function runDispatcherRequest(state, claimed, id) {
    var started = new Date().getTime();
    var request;
    try {
      request = state.codec.parse(readTextFile(claimed.fsName));
    } catch (parseFailure) {
      throw dispatcherRefusal("the request is not valid JSON");
    }
    if (request === null || typeof request !== "object" || request.v !== 1) {
      throw dispatcherRefusal("unsupported request envelope");
    }
    if (String(request.id) !== id) {
      // The id in the envelope must be the id in the file name: a mismatch
      // means the file was not addressed to this request slot.
      throw dispatcherRefusal("request id does not match its file name");
    }
    if (request.token !== state.token) {
      throw dispatcherRefusal("request token does not match this channel");
    }
    // Defence in depth for the pre-claim filter in dispatcherTick: a request
    // that names a different dispatcher instance must never run here, even
    // if it was claimed before the filter could see it.
    if (typeof request.target === "string" && request.target !== state.instance) {
      throw dispatcherRefusal("request targets a different dispatcher instance");
    }
    if (typeof request.method !== "string" || request.method.length === 0) {
      throw dispatcherRefusal("request names no method");
    }
    if (typeof request.timeoutMs !== "number" || !isFinite(request.timeoutMs)) {
      throw dispatcherRefusal("request carries no usable deadline");
    }
    var now = new Date().getTime();
    if (now > claimed.modified.getTime() + request.timeoutMs) {
      // The caller's deadline already passed while the request waited
      // unclaimed (AE busy, dispatcher not yet active). Refuse it: running
      // it now would execute work nobody is still waiting for.
      var stale = new Error("request expired before the dispatcher claimed it");
      stale.name = "StaleRequestError";
      throw stale;
    }
    var result = dispatch(request, state.extensionFunctions);
    return {
      v: request.v,
      id: id,
      ok: true,
      durationMs: new Date().getTime() - started,
      result: result === undefined ? null : result
    };
  }

  function writeDispatcherState(state) {
    var report = {
      v: 1,
      token: state.token,
      instance: state.instance,
      aeVersion: String(app.version),
      activatedAt: state.activatedAt,
      lastTick: new Date().getTime(),
      pollMs: state.pollMs,
      // The per-delivery nonce a `ae.activateDispatcher()` script carried
      // (#276). Null for a human activation; the Node side requires it to
      // match its own delivery before reporting activation success.
      activationNonce: state.activationNonce === undefined ? null : state.activationNonce,
      // The extension set this dispatcher actually registered (#146).
      // Captured once at activation into `state`; the table cannot change
      // afterwards, so the heartbeat keeps reporting the fixed set — not a
      // claim that the staged file matches.
      extensionMethods: state.extensionMethods,
      extensionsRegistration: state.extensionsRegistration
    };
    try {
      publishResult(state.paths.state, state.codec.stringify(report));
    } catch (stateError) {
      // A heartbeat that cannot be written is not worth a modal dialog; the
      // Node side reads a stale file as "not answering" and says so.
    }
  }

  /** Removes outbox results too old for any caller to still be waiting on. */
  function sweepDispatcherOutbox(state) {
    var outbox = new Folder(state.paths.outbox);
    if (!outbox.exists) {
      return;
    }
    var horizon = new Date().getTime() - DISPATCHER_RESULT_MAX_AGE_MS;
    var files = outbox.getFiles("*.result.json");
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (file instanceof File && file.modified.getTime() < horizon) {
        file.remove();
      }
    }
  }

  function dispatcherTick(state) {
    try {
      var inbox = new Folder(state.paths.inbox);
      if (!inbox.exists) {
        return;
      }
      var files = inbox.getFiles("*.request.json");
      files.sort(function (a, b) {
        if (a.name < b.name) {
          return -1;
        }
        if (a.name > b.name) {
          return 1;
        }
        return 0;
      });
      // One request per tick: the channel contract is strictly serial, so a
      // long operation can never overlap the next claim. Files that are not
      // dispatcher requests (other writers, stale names) are skipped, never
      // allowed to stall the queue.
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (!(file instanceof File)) {
          continue;
        }
        var match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.request\.json$/.exec(file.name);
        if (match === null) {
          continue;
        }
        var id = match[1];
        // Target binding (#145): a request that names a dispatcher instance
        // is claimed only by that instance. Two After Effects can share one
        // channel; without this check the first poller would run — or refuse
        // — work addressed to the other. The file is left in place for the
        // dispatcher it names; an unreadable file falls through to the
        // claim path, which reports it as a refusal.
        try {
          var peek = state.codec.parse(readTextFile(file.fsName));
          if (
            peek !== null &&
            typeof peek === "object" &&
            typeof peek.target === "string" &&
            peek.target !== state.instance
          ) {
            continue;
          }
        } catch (peekError) {
          // Malformed JSON is the claim path's refusal to report, not ours.
        }
        // Claim before running: a host restart cannot replay a claimed
        // operation, and a second dispatcher cannot take the same file.
        if (!file.rename(id + ".claimed")) {
          continue;
        }
        var claimed = new File(inbox.fsName + "/" + id + ".claimed");
        var began = new Date().getTime();
        var reply;
        try {
          reply = runDispatcherRequest(state, claimed, id);
        } catch (failure) {
          reply = {
            v: 1,
            id: id,
            ok: false,
            durationMs: new Date().getTime() - began,
            error: toErrorPayload(failure)
          };
        }
        try {
          publishResult(
            state.paths.outbox + "/" + id + ".result.json",
            state.codec.stringify(reply)
          );
        } catch (publishError) {
          // The caller times out UNKNOWN; do not retry a claimed request.
        }
        claimed.remove();
        break;
      }
      state.ticks += 1;
      if (state.ticks % DISPATCHER_STATE_EVERY === 0) {
        writeDispatcherState(state);
        sweepDispatcherOutbox(state);
      }
    } catch (tickError) {
      // A scheduled task must never raise a modal dialog while the user
      // works. With no state update the Node side reports UNKNOWN.
    }
  }

  function startDispatcher(config) {
    var runningState = $.global.__a8nDispatcherState;
    if ($.global.__a8nDispatcherTask !== undefined) {
      // A dispatcher is already running in this After Effects. A freshly
      // generated activation script carries a new per-delivery nonce:
      // recording it re-proves that THIS delivery reached this instance,
      // without starting a second dispatcher. Re-running the identical
      // script (same nonce) or a human activate.jsx (no nonce) is still
      // refused, exactly as before.
      var deliveredNonce =
        config !== null &&
        typeof config === "object" &&
        typeof config.nonce === "string" &&
        /^[a-f0-9]{32}$/.test(config.nonce)
          ? config.nonce
          : null;
      if (
        runningState !== undefined &&
        runningState !== null &&
        deliveredNonce !== null &&
        deliveredNonce !== runningState.activationNonce
      ) {
        runningState.activationNonce = deliveredNonce;
        writeDispatcherState(runningState);
        return;
      }
      throw new Error(
        "ae-a8n dispatcher is already active in this After Effects; " +
          "refusing a second dispatcher"
      );
    }
    var codec = loadJson();
    var root = new Folder(String(config.root));
    // ExtendScript's Folder has no `isDirectory` (observed on AE 26.5 — the
    // fake Folder models one, which is why only the real host tripped this).
    // `exists` plus the inbox/outbox checks below are the real contract: a
    // plain file at the root fails there with a clearer error anyway.
    if (!root.exists) {
      throw new Error("ae-a8n dispatcher: channel root is not a directory: " + String(config.root));
    }
    var paths = dispatcherPaths(root.fsName);
    var inbox = new Folder(paths.inbox);
    var outbox = new Folder(paths.outbox);
    if (!inbox.exists || !outbox.exists) {
      throw new Error("ae-a8n dispatcher: channel folders are missing; prepare the channel first");
    }
    var token = String(config.token);
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new Error("ae-a8n dispatcher: channel token is malformed");
    }
    var pollMs = config.pollMs;
    if (typeof pollMs !== "number" || !isFinite(pollMs)) {
      pollMs = DISPATCHER_POLL_MS;
    }
    if (pollMs < DISPATCHER_MIN_POLL_MS) {
      pollMs = DISPATCHER_MIN_POLL_MS;
    }
    if (pollMs > DISPATCHER_MAX_POLL_MS) {
      pollMs = DISPATCHER_MAX_POLL_MS;
    }
    if (typeof app.scheduleTask !== "function") {
      throw new Error("ae-a8n dispatcher: this After Effects has no app.scheduleTask");
    }
    var state = {
      codec: codec,
      paths: paths,
      token: token,
      pollMs: pollMs,
      instance:
        "i" +
        new Date().getTime().toString(16) +
        Math.floor(Math.random() * 0xffffff).toString(16),
      activatedAt: new Date().getTime(),
      ticks: 0,
      // Fixed here, once: whatever `__a8n.extensions` holds right now is
      // what this dispatcher will answer for its whole life. A host script
      // built without the extension prelude leaves both empty/null.
      extensionMethods: registeredExtensionNames(),
      extensionsRegistration: extensionRegistration(),
      // The function snapshot dispatch actually resolves against (#146):
      // the heartbeat's names and this table are captured together, so a
      // later mutation of `__a8n.extensions` cannot widen the answer set.
      extensionFunctions: snapshotExtensionFunctions(),
      // The nonce this activation script carried, if any (#276). A later
      // re-delivery with a fresh nonce replaces it (see the guard above),
      // which is how `ae.activateDispatcher()` proves each call reached
      // this instance.
      activationNonce:
        typeof config.nonce === "string" && /^[a-f0-9]{32}$/.test(config.nonce)
          ? config.nonce
          : null
    };
    // Kept on the global so a re-delivered activation script can re-prove
    // delivery against the running dispatcher instead of starting a
    // second one.
    $.global.__a8nDispatcherState = state;
    var tick = function () {
      dispatcherTick(state);
    };
    // The scheduled string names the global, so the function must be there
    // before the first fire — pollMs later at the earliest.
    $.global.__a8nDispatcherTick = tick;
    $.global.__a8nDispatcherTask = app.scheduleTask(
      "$.global.__a8nDispatcherTick()",
      pollMs,
      true
    );
    writeDispatcherState(state);
  }

  // The branch check must run inside a named function called plainly, not
  // at the IIFE's top level: on real ExtendScript `this` inside
  // `(function(){})()` is the function itself, not the global object
  // (observed on AE 26.5/27.0 — the fake vm runtime cannot reproduce this).
  // Inside a named function `this` is the global object, the same contract
  // `main()` and the extension prelude already rely on. Evaluating
  // `this.__a8n` here would always miss and silently fall into `main()`.
  function boot() {
    var __a8nEntry = this.__a8n;
    if (
      __a8nEntry !== undefined &&
      __a8nEntry !== null &&
      __a8nEntry.dispatcher !== undefined &&
      __a8nEntry.dispatcher !== null
    ) {
      startDispatcher(__a8nEntry.dispatcher);
    } else {
      main();
    }
  }
  boot();
})();
