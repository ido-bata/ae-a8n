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
    // Prefer the engine's own JSON when it exists (future AE versions may add
    // one); fall back to the bundled ES3 implementation otherwise.
    if (typeof JSON !== "undefined" && JSON !== null && typeof JSON.parse === "function") {
      return JSON;
    }
    var self = this;
    $.evalFile(new File($.fileName).parent.fsName + "/a8n-json.js");
    return self.A8NJson;
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

  function requireParam(params, name) {
    if (params === null || params === undefined || params[name] === undefined) {
      throw new Error("missing required parameter: " + name);
    }
    return params[name];
  }

  function optionalParam(params, name, fallback) {
    if (params === null || params === undefined || params[name] === undefined) {
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
    var project = getProject();
    var item = project.itemByName(name);
    if (item === null || item === undefined) {
      throw new Error("composition not found: " + name);
    }
    if (!(item instanceof CompItem)) {
      throw new Error("item is not a composition: " + name);
    }
    return item;
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

  methods["app.quit"] = function () {
    var project = app.project;
    if (project !== null && project !== undefined && project.file !== null) {
      project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
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
    var opened = app.open(file);
    return { file: String(opened.fsName || opened.name) };
  };

  methods["project.close"] = function (params) {
    var save = optionalParam(params, "save", false);
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
    var frame = requireParam(params, "frame");
    var outputDir = String(requireParam(params, "outputDir"));
    var namePrefix = String(optionalParam(params, "prefix", comp.name));
    var width = Number(optionalParam(params, "width", 0));
    var height = Number(optionalParam(params, "height", 0));

    var folder = new Folder(outputDir);
    if (!folder.exists) {
      folder.create();
    }

    var project = getProject();
    var queue = project.renderQueue;
    queue.purge();

    // PNG Sequence writes one file per frame; the frame number is appended, so
    // the caller needs the concrete name rather than a directory.
    var target = new File(folder.fsName + "/" + namePrefix + "." + zeroPad(frame, 5) + ".png");
    var settings = new OutputModule(target).module("PNG Sequence");
    settings.file = new Folder(folder.fsName + "/");
    settings.colorDepth = 16;
    settings.colorMode = settings.colorMode || 0;

    var item = queue.add(new RenderQueueItem(comp, new OutputModule(target)));
    item.outputModule.applySettings(settings);

    var renderSettings = item.outputModule.renderSettings;
    if (width > 0 && height > 0) {
      renderSettings.changeComp(comp, true);
    }
    // Compositing over a fixed matte keeps the render deterministic and
    // independent of the user's project background colour.
    renderSettings.useSolidColor = true;
    renderSettings.solidColor = [0, 0, 0];

    item.startTime = frame;
    item.endTime = frame;
    item.render();

    var rendered = findRenderedFile(folder, namePrefix, frame);
    queue.purge();

    return {
      path: rendered === null ? String(target.fsName) : rendered,
      frame: frame,
      width: comp.width,
      height: comp.height
    };
  };

  /**
   * Locate the file AE actually wrote.
   *
   * PNG Sequence naming is Adobe's to decide, and it has varied between
   * versions and locales; reconstructing it from the requested name is a
   * guess. Reading the directory back is not.
   */
  function findRenderedFile(folder, prefix, frame) {
    var entries = folder.getFiles();
    var frameText = zeroPad(frame, 5);
    var best = null;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry instanceof File) {
        var name = entry.name;
        if (name.length > 4 && name.substring(name.length - 4).toLowerCase() === ".png") {
          var stem = name.substring(0, name.length - 4);
          if (stem.indexOf(prefix) === 0 && stem.indexOf(frameText) !== -1) {
            if (best === null || entry.modified > best.modified) {
              best = entry;
            }
          }
        }
      }
    }
    return best === null ? null : String(best.fsName);
  }

  // ----------------------------------------------------------- dispatch ---

  function dispatch(request) {
    if (request === null || typeof request !== "object") {
      throw new Error("request envelope is not an object");
    }
    var method = methods[request.method];
    if (method === undefined) {
      throw new Error("unknown method: " + String(request.method));
    }
    return method(request.params);
  }

  function main() {
    var codec = loadJson.call(this);
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
