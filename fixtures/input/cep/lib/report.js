/*
 * ae-a8n IME input fixture — result bridge (specs/ime-input/spec.md §4.1
 * channel 1: fixture self-report through the extension's own Node side).
 *
 * Loaded by index.html before lib/panel.js. Two sinks, in order:
 *
 *   1. Node `fs` append to a JSONL file — the primary bridge. Requires the
 *      CEP extension to run with --enable-nodejs (see CSXS/manifest.xml).
 *      The path defaults to <os.tmpdir()>/ae-a8n-ime-input/report.jsonl and
 *      can be overridden by setting window.__A8N_INPUT_FIXTURE_RESULT__
 *      (a string path) before this script runs.
 *   2. In-memory buffer on window.A8nInputFixtureReport.buffered() — the
 *      fallback when no Node context exists. This is the receiver for the
 *      CDP observation channel (spec §4.1 channel 2, feasibility
 *      unverified); nothing here pretends the file sink exists when it
 *      does not.
 *
 * Fixture code only — `implemented`, unverified on a real host.
 */
(function (root) {
  "use strict";

  var bufferedLines = [];
  var fs = null;
  var path = null;
  var os = null;

  try {
    if (typeof require === "function") {
      fs = require("fs");
      path = require("path");
      os = require("os");
    }
  } catch (error) {
    // No Node context: the memory sink stays active and `sink` reports it.
    fs = null;
    path = null;
    os = null;
  }

  var resultPath = null;
  if (root !== undefined && root !== null &&
      typeof root.__A8N_INPUT_FIXTURE_RESULT__ === "string" &&
      root.__A8N_INPUT_FIXTURE_RESULT__ !== "") {
    resultPath = root.__A8N_INPUT_FIXTURE_RESULT__;
  } else if (os !== null && path !== null) {
    resultPath = path.join(os.tmpdir(), "ae-a8n-ime-input", "report.jsonl");
  }

  function emit(record) {
    var line;
    try {
      line = JSON.stringify(record);
    } catch (error) {
      line = JSON.stringify({
        v: 1,
        fixture: "ae-a8n-ime-input",
        kind: "report-error",
        channel: "none",
        provesOsIme: false,
        detail: String(error)
      });
    }
    bufferedLines.push(line);
    if (fs !== null && path !== null && resultPath !== null) {
      try {
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.appendFileSync(resultPath, line + "\n", "utf8");
      } catch (error) {
        // The in-memory copy remains; a later reader can still see the
        // record. Sink failure is not hidden: `sink` stays "node-fs" but
        // `lastError` records the failure for diagnostics.
        api.lastError = String(error);
      }
    }
    return line;
  }

  var api = {
    emit: emit,
    /** Which sink is active: "node-fs" or "memory". */
    sink: fs !== null && resultPath !== null ? "node-fs" : "memory",
    /** The JSONL path when the node-fs sink is active, else null. */
    path: function () { return resultPath; },
    /** All records emitted so far, as JSONL lines (for the CDP channel). */
    buffered: function () { return bufferedLines.slice(); },
    /** Last sink write failure, or null. Diagnostics only. */
    lastError: null
  };

  if (root !== undefined && root !== null) {
    root.A8nInputFixtureReport = api;
  }
})(typeof window !== "undefined" ? window : this);
