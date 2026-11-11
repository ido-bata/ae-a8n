// Verification-only diagnostic for the failed acceptance run of 2026-11-10.
//
// The launch probe answered `unknown method: app.info` although the staged host
// script registers `methods["app.info"]` at line 376 and throws that message
// only from `dispatch` (line 976). This asks the running After Effects what its
// engine actually sees.
//
// Shape matters: the generated entry declares `var __a8n` at the TOP LEVEL of
// the script AE runs, and the host's `main()` reads `this.__a8n`. An earlier
// version of this diagnostic wrapped everything in an IIFE; `this` there was not
// the engine global, the host refused with "a8n host invoked without a __a8n
// context", and the probe measured its own bug. This version keeps the same
// top-level shape as production.
//
// ES3. It opens no project, creates no AE content, launches nothing, quits
// nothing and touches no dialog. Findings are plain text:
//   diag-1-engine.txt        engine and file facts
//   diag-2-reproduce.txt     the unmodified staged host script, evaluated again
//   diag-3-instrumented.txt  the same script with dispatch instrumented
//   dispatch.txt             the method table as the engine sees it

var __a8n = null;

var DIR = "C:/Users/rebui/AppData/Local/Temp/a8n-diag-20261110T2345Z";
var STAGED = "C:/Users/rebui/AppData/Local/Temp/ae-a8n-EeELvA/staging/a8n-host.js";
var diagLines = [];

function diagDescribe(error) {
  try {
    if (error === null || error === undefined) { return String(error); }
    if (error.message !== undefined) { return String(error.message); }
    return String(error);
  } catch (ignored) {
    return "<unprintable>";
  }
}

function diagSay(key, value) {
  diagLines.push(key + " = " + value);
}

function diagSafe(key, fn) {
  try {
    diagSay(key, fn());
  } catch (error) {
    diagSay(key, "threw: " + diagDescribe(error));
  }
}

function diagWrite(path, text) {
  var file = new File(path);
  file.encoding = "UTF-8";
  if (!file.open("w")) { return false; }
  file.write(text);
  file.close();
  return true;
}

function diagRead(path) {
  var file = new File(path);
  file.encoding = "UTF-8";
  if (!file.exists || !file.open("r")) { return null; }
  var text = file.read();
  file.close();
  return text;
}

function diagFlat(text) {
  return text === null ? "<absent>" : text.replace(/[\r\n]+/g, " | ");
}

function diagFlush(name) {
  diagWrite(DIR + "/" + name, diagLines.join("\n") + "\n");
}

// --------------------------------------------------------------- engine ---
diagSafe("app.version", function () { return String(app.version); });
diagSafe("app.buildNumber", function () { return String(app.buildNumber); });
diagSafe("$.engineName", function () { return String($.engineName); });
diagSafe("$.version", function () { return String($.version); });
diagSafe("$.fileName", function () { return String($.fileName); });
diagSafe("typeof __a8n (top-level var)", function () { return typeof __a8n; });
diagSafe("this.__a8n seen from a function", function () { return typeof this.__a8n; });
diagSafe("staged file", function () {
  var file = new File(STAGED);
  return "exists=" + String(file.exists) + " length=" + String(file.length);
});
diagSafe("staged head", function () { return diagFlat(diagRead(STAGED)).substring(0, 80); });
diagFlush("diag-1-engine.txt");

// ------------------------------------------------------------ reproduce ---
var requestPath = DIR + "/request-a.json";
var resultPath = DIR + "/result-a.json";
diagWrite(requestPath, '{"v":1,"id":"diag-a","method":"app.info","params":{},"session":{"id":"diag","adopt":true}}');
__a8n = { request: requestPath, result: resultPath, extensions: {} };
diagSafe("this.__a8n after assignment", function () { return typeof this.__a8n; });
try {
  var returned = $.evalFile(new File(STAGED));
  diagSay("evalFile(staged) returned", typeof returned);
} catch (error) {
  diagSay("evalFile(staged) threw", diagDescribe(error));
}
diagSafe("result-a", function () { return diagFlat(diagRead(resultPath)); });
diagFlush("diag-2-reproduce.txt");

// --------------------------------------------------------- instrumented ---
var source = diagRead(STAGED);
var marker = "  function dispatch(request) {";
var at = source === null ? -1 : source.indexOf(marker);
diagSay("dispatch marker at", String(at));
if (at >= 0) {
  var probe =
    "    try { var __d = new File(\"" + DIR + "/dispatch.txt\"); __d.encoding = \"UTF-8\";" +
    " if (__d.open(\"w\")) { var __k = \"\"; var __n = 0; var __i;" +
    " for (__i in methods) { if (Object.prototype.hasOwnProperty.call(methods, __i)) { __n++; __k += __i + \"\\n\"; } }" +
    " __d.write(\"request.method = [\" + String(request.method) + \"]\\n\" +" +
    " \"own = \" + String(Object.prototype.hasOwnProperty.call(methods, request.method)) + \"\\n\" +" +
    " \"count = \" + String(__n) + \"\\n\" + __k); __d.close(); } } catch (__e) { }\n";
  var patched = source.substring(0, at + marker.length) + "\n" + probe + source.substring(at + marker.length);
  var patchedPath = DIR + "/a8n-host-instrumented.js";
  diagWrite(patchedPath, patched);
  diagSay("instrumented written", String(new File(patchedPath).length) + " bytes");

  var requestPath2 = DIR + "/request-b.json";
  var resultPath2 = DIR + "/result-b.json";
  diagWrite(requestPath2, '{"v":1,"id":"diag-b","method":"app.info","params":{},"session":{"id":"diag","adopt":true}}');
  __a8n = { request: requestPath2, result: resultPath2, extensions: {} };
  try {
    $.evalFile(new File(patchedPath));
  } catch (error2) {
    diagSay("evalFile(instrumented) threw", diagDescribe(error2));
  }
  diagSafe("dispatch.txt", function () { return diagFlat(diagRead(DIR + "/dispatch.txt")); });
  diagSafe("result-b", function () { return diagFlat(diagRead(resultPath2)); });
}
diagFlush("diag-3-instrumented.txt");

diagSay("finished", String(new Date().getTime()));
diagFlush("diag-4-done.txt");
