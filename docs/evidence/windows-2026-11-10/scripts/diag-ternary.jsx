// Verification-only: how does this engine evaluate the nested conditional the
// host's `dispatch` uses?
//
// Measured on a real After Effects 26.5x89:
//   - `methods` owns 26 keys including `app.info` (for-in and hasOwnProperty)
//   - the JSON codec returns a primitive string "app.info"
//   - `table[request.method]` reaches a function, in a plain script
//   - the host's own dispatch still throws "unknown method: app.info"
//
// The one construct every working probe avoided is this expression:
//
//   var method = has(methods, name)
//     ? methods[name]
//     : has(extensions, name)
//       ? extensions[name]
//       : undefined;
//
// If the engine associates it left instead of right, a hit in `methods` leaves
// `extensions[name]` (undefined) as the result. ES3, read-only, starts nothing.

var DIR = "C:/Users/rebui/AppData/Local/Temp/a8n-diag-20261110T2345Z";
var out = [];

function diagFlat(value) {
  try {
    if (value === null) { return "null"; }
    if (value === undefined) { return "undefined"; }
    return String(value);
  } catch (ignored) {
    return "<unprintable>";
  }
}

function diagSay(label, value) {
  out.push(label + " = " + value);
}

function diagHas(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

var methods = {};
methods["app.info"] = function () { return "hit"; };

var extensions = {};
var name = "app.info";

// The exact shape the host uses.
var nested = diagHas(methods, name)
  ? methods[name]
  : diagHas(extensions, name)
    ? extensions[name]
    : undefined;
diagSay("typeof nested ternary result", diagFlat(typeof nested));
diagSay("typeof nested ternary call", (function () {
  try {
    return nested === undefined ? "<undefined, not callable>" : diagFlat(nested());
  } catch (error) {
    return "threw: " + diagFlat(error && error.message !== undefined ? error.message : error);
  }
})());

// The same, grouped explicitly.
var grouped = diagHas(methods, name)
  ? methods[name]
  : (diagHas(extensions, name)
    ? extensions[name]
    : undefined);
diagSay("typeof grouped ternary result", diagFlat(typeof grouped));

// The same, written once on one line.
var inline = diagHas(methods, name) ? methods[name] : diagHas(extensions, name) ? extensions[name] : undefined;
diagSay("typeof inline ternary result", diagFlat(typeof inline));

// The same, as statements.
var statements;
if (diagHas(methods, name)) {
  statements = methods[name];
} else if (diagHas(extensions, name)) {
  statements = extensions[name];
} else {
  statements = undefined;
}
diagSay("typeof if/else result", diagFlat(typeof statements));

// And the single-level conditional the previous release used.
var single = diagHas(methods, name) ? methods[name] : undefined;
diagSay("typeof single ternary result", diagFlat(typeof single));

var file = new File(DIR + "/ternary-done.txt");
file.encoding = "UTF-8";
if (file.open("w")) {
  file.write(out.join("\n") + "\n");
  file.close();
}
