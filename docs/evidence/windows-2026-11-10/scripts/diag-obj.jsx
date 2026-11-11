// Verification-only: how does this ExtendScript engine treat
// bracket access with a property name that contains a dot?
//
// The instrumented dispatcher reported `own = true` and `count = 26` for the
// table, then returned undefined from `methods["app.info"]`. This isolates the
// operator from the host script. ES3, read-only, starts nothing, quits nothing.

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

function diagTry(label, fn) {
  try {
    diagSay(label, diagFlat(fn()));
  } catch (error) {
    diagSay(label, "threw: " + diagFlat(error && error.message !== undefined ? error.message : error));
  }
}

var o = {};
o["a.b"] = 7;
diagTry('o["a.b"] after assign', function () { return o["a.b"]; });
diagTry('hasOwnProperty(o, "a.b")', function () { return Object.prototype.hasOwnProperty.call(o, "a.b"); });
diagTry("for-in own keys", function () {
  var keys = [];
  var key;
  for (key in o) {
    if (Object.prototype.hasOwnProperty.call(o, key)) { keys.push(key); }
  }
  return keys.join(",");
});
diagTry("o[k] with k a variable", function () { var k = "a.b"; return o[k]; });
diagTry('o["a" + "." + "b"] computed', function () { return o["a" + "." + "b"]; });
diagTry("o.a.b after o.a = {b:9}", function () {
  var nested = {};
  nested.a = { b: 9 };
  return nested["a.b"];
});

var fns = {};
fns["x.y"] = function () { return "fn-ran"; };
diagTry('typeof fns["x.y"] literal', function () { return typeof fns["x.y"]; });
diagTry("typeof fns[k] variable", function () { var k = "x.y"; return typeof fns[k]; });
diagTry('fns["x.y"]() call', function () { return fns["x.y"](); });

var plain = {};
plain["noDots"] = function () { return "ok"; };
diagTry('plain["noDots"]()', function () { return plain["noDots"](); });

var file = new File(DIR + "/obj-done.txt");
file.encoding = "UTF-8";
if (file.open("w")) {
  file.write(out.join("\n") + "\n");
  file.close();
}
