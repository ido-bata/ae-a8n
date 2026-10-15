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
    file.write(text);
    file.close();
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

  function describeProperty(property) {
    var out = { name: property.name };
    if (property.matchName !== undefined && property.matchName !== null) {
      out.matchName = property.matchName;
    }
    if (property.value !== undefined) {
      out.value = property.value;
    }
    return out;
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
    return { file: String(opened.fsName || opened.name) };
  };

  methods["project.close"] = function (params) {
    var save = optionalParam(params, "save", false);
    if (save !== true) {
      guardUnsavedChanges(params, "closing without saving");
    }
    getProject().close(
      save ? CloseOptions.SAVE_CHANGES : CloseOptions.DO_NOT_SAVE_CHANGES
    );
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
    var comp = findComp(String(requireParam(params, "name")));
    return {
      name: comp.name,
      width: comp.width,
      height: comp.height,
      duration: comp.duration,
      frameRate: comp.frameRate,
      layerCount: comp.numLayers
    };
  };

  methods["comp.layers"] = function (params) {
    var comp = findComp(String(requireParam(params, "name")));
    var out = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      out.push({ name: comp.layer(i).name, index: comp.layer(i).index });
    }
    return out;
  };

  methods["comp.layer"] = function (params) {
    var comp = findComp(String(requireParam(params, "comp")));
    var layer = findLayer(comp, String(requireParam(params, "layer")));
    return { name: layer.name, index: layer.index, enabled: layer.enabled };
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
    property.setValue(requireParam(params, "value"));
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
      throw new Error("parameter not found on effect '" + effect.name + "': " + identifier);
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

  // ----------------------------------------------------------- dispatch ---

  function dispatch(request) {
    if (request === null || typeof request !== "object") {
      throw new Error("request envelope is not an object");
    }
    var method = has(methods, request.method) ? methods[request.method] : undefined;
    if (method === undefined) {
      throw new Error("unknown method: " + String(request.method));
    }
    return method(request.params);
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
    writeTextFile(resultPath, text);
    var leftover = new File(staging);
    if (leftover.exists) {
      leftover.remove();
    }
    return "direct";
  }

  main();
})();
