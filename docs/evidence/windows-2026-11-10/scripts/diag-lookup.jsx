// Verification-only: the host's own table lookup, with the host script removed
// from the picture.
//
// Facts so far, from a real After Effects 26.5x89:
//   1. `methods` has 26 own keys, `app.info` among them (for-in and
//      hasOwnProperty both say so).
//   2. `dispatch` still throws "unknown method: app.info".
//   3. In a plain script, `o["a.b"] = 7` then `o["a.b"]` reads back 7, and a
//      function stored at a dotted key is callable — so the bracket operator
//      itself is not the problem.
//
// That leaves the value produced by the bundled JSON codec. This parses the
// real request file with the same codec the host uses and looks the name up in
// a table built in front of the engine. ES3, read-only, starts nothing.

var DIR = "C:/Users/rebui/AppData/Local/Temp/a8n-diag-20261110T2345Z";
var CODEC = "C:/Users/rebui/AppData/Local/Temp/ae-a8n-EeELvA/staging/a8n-json.js";
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

function diagRead(path) {
  var file = new File(path);
  file.encoding = "UTF-8";
  if (!file.exists || !file.open("r")) { return null; }
  var text = file.read();
  file.close();
  return text;
}

var codec = $.evalFile(new File(CODEC));
diagSay("codec", typeof codec);

var requestText = diagRead(DIR + "/request-a.json");
diagSay("request text", diagFlat(requestText));

var request = codec.parse(String(requestText));
diagTry("typeof request.method", function () { return typeof request.method; });
diagTry("request.method printed", function () { return "[" + String(request.method) + "]"; });
diagTry("String(request.method).length", function () { return String(request.method).length; });
diagTry("request.method === \"app.info\"", function () { return request.method === "app.info"; });
diagTry("charCodeAt(3)", function () { return request.method.charCodeAt(3); });

var table = {};
table["app.info"] = function () { return "hit"; };
diagTry('typeof table["app.info"] literal', function () { return typeof table["app.info"]; });
diagTry("typeof table[request.method]", function () { return typeof table[request.method]; });
diagTry("typeof table[String(request.method)]", function () {
  return typeof table[String(request.method)];
});
diagTry("typeof table[request.method + \"\"]", function () {
  return typeof table[request.method + ""];
});
diagTry("hasOwnProperty(table, request.method)", function () {
  return Object.prototype.hasOwnProperty.call(table, request.method);
});
diagTry("table[request.method]()", function () { return table[request.method](); });

// The same lookup the host does, with its own expression shape.
diagTry("ternary lookup of request.method", function () {
  var found = Object.prototype.hasOwnProperty.call(table, request.method)
    ? table[request.method]
    : undefined;
  return typeof found;
});

// And with a primitive name, for contrast.
diagTry("typeof table[\"app.info\"] via variable", function () {
  var name = "app.info";
  return typeof table[name];
});

var file = new File(DIR + "/lookup-done.txt");
file.encoding = "UTF-8";
if (file.open("w")) {
  file.write(out.join("\n") + "\n");
  file.close();
}
