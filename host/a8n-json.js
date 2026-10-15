/*!
 * a8n-json.js — JSON codec for ExtendScript (ES3).
 *
 * After Effects' ExtendScript engine has no built-in `JSON`. Rather than
 * assume, the host feature-detects a native one and falls back to this.
 *
 * The implementation is deliberately small: it covers exactly the subset the
 * protocol uses (objects, arrays, strings, finite numbers, booleans, null).
 * `test/fake-host.test.ts` differential-tests it against Node's JSON so the
 * two encoders cannot drift apart unnoticed.
 *
 * ES3 only. No const/let, no arrow functions, no ES5 built-ins.
 */

var A8NJson = (function () {
  var ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t"
  };

  function quoteChar(ch) {
    var escaped = ESCAPES[ch];
    if (escaped !== undefined) {
      return escaped;
    }
    var code = ch.charCodeAt(0);
    if (code < 0x20) {
      var hex = code.toString(16);
      while (hex.length < 4) {
        hex = "0" + hex;
      }
      return "\\u" + hex;
    }
    return ch;
  }

  function stringifyString(value) {
    var out = '"';
    for (var i = 0; i < value.length; i++) {
      out += quoteChar(value.charAt(i));
    }
    return out + '"';
  }

  function isArray(value) {
    // Not `instanceof Array`: values that crossed into this engine from a host
    // (or another realm) fail an instanceof check against a local Array.
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function stringify(value) {
    if (value === null) {
      return "null";
    }
    var type = typeof value;
    if (type === "boolean") {
      return value ? "true" : "false";
    }
    if (type === "number") {
      if (!isFinite(value)) {
        // Matches JSON.stringify: non-finite numbers become null.
        return "null";
      }
      return String(value);
    }
    if (type === "string") {
      return stringifyString(value);
    }
    if (isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var element = stringify(value[i]);
        // undefined and functions serialise as null inside arrays.
        parts.push(element === undefined ? "null" : element);
      }
      return "[" + parts.join(",") + "]";
    }
    if (type === "object") {
      if (typeof value.toJSON === "function") {
        return stringify(value.toJSON());
      }
      var keys = [];
      for (var key in value) {
        if (value.hasOwnProperty(key)) {
          var serialised = stringify(value[key]);
          if (serialised !== undefined) {
            keys.push(stringifyString(key) + ":" + serialised);
          }
        }
      }
      return "{" + keys.join(",") + "}";
    }
    return undefined;
  }

  function ParseError(message, line, column) {
    this.name = "A8NJsonParseError";
    this.message = message;
    this.line = line;
    this.column = column;
  }
  ParseError.prototype = new Error();

  function parse(text) {
    var pos = 0;

    function fail(message) {
      var consumed = text.substring(0, pos);
      var line = 1;
      var lastNewline = -1;
      for (var i = 0; i < consumed.length; i++) {
        if (charAt(consumed, i) === "\n") {
          line += 1;
          lastNewline = i;
        }
      }
      throw new ParseError(message, line, pos - lastNewline);
    }

    function charAt(source, index) {
      return source.charAt(index);
    }

    function whitespace() {
      while (pos < text.length) {
        var ch = text.charAt(pos);
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
          pos += 1;
        } else {
          break;
        }
      }
    }

    function expect(ch) {
      if (text.charAt(pos) !== ch) {
        fail("expected '" + ch + "'");
      }
      pos += 1;
    }

    function parseString() {
      // Caller has already checked the opening quote.
      pos += 1;
      var out = "";
      while (pos < text.length) {
        var ch = text.charAt(pos);
        if (ch === '"') {
          pos += 1;
          return out;
        }
        if (ch === "\\") {
          pos += 1;
          var esc = text.charAt(pos);
          if (esc === "u") {
            var hex = text.substring(pos + 1, pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              fail("invalid unicode escape");
            }
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 5;
            continue;
          }
          var simple = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t"
          };
          if (!simple.hasOwnProperty(esc)) {
            fail("invalid escape \\" + esc);
          }
          out += simple[esc];
          pos += 1;
          continue;
        }
        out += ch;
        pos += 1;
      }
      fail("unterminated string");
    }

    function parseNumber() {
      var match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(
        text.substring(pos)
      );
      if (match === null) {
        fail("invalid number");
      }
      pos += match[0].length;
      return parseFloat(match[0]);
    }

    function parseArray() {
      pos += 1; // [
      var items = [];
      whitespace();
      if (text.charAt(pos) === "]") {
        pos += 1;
        return items;
      }
      for (;;) {
        whitespace();
        items.push(parseValue());
        whitespace();
        var ch = text.charAt(pos);
        if (ch === ",") {
          pos += 1;
          continue;
        }
        if (ch === "]") {
          pos += 1;
          return items;
        }
        fail("expected ',' or ']'");
      }
    }

    function parseObject() {
      pos += 1; // {
      var out = {};
      whitespace();
      if (text.charAt(pos) === "}") {
        pos += 1;
        return out;
      }
      for (;;) {
        whitespace();
        if (text.charAt(pos) !== '"') {
          fail("expected object key");
        }
        var key = parseString();
        whitespace();
        expect(":");
        whitespace();
        out[key] = parseValue();
        whitespace();
        var ch = text.charAt(pos);
        if (ch === ",") {
          pos += 1;
          continue;
        }
        if (ch === "}") {
          pos += 1;
          return out;
        }
        fail("expected ',' or '}'");
      }
    }

    function parseValue() {
      var ch = text.charAt(pos);
      if (ch === "{") {
        return parseObject();
      }
      if (ch === "[") {
        return parseArray();
      }
      if (ch === '"') {
        return parseString();
      }
      if (text.substr(pos, 4) === "true") {
        pos += 4;
        return true;
      }
      if (text.substr(pos, 5) === "false") {
        pos += 5;
        return false;
      }
      if (text.substr(pos, 4) === "null") {
        pos += 4;
        return null;
      }
      if (ch === "-" || (ch >= "0" && ch <= "9")) {
        return parseNumber();
      }
      fail("unexpected token");
    }

    whitespace();
    var value = parseValue();
    whitespace();
    if (pos !== text.length) {
      fail("trailing content");
    }
    return value;
  }

  return { stringify: stringify, parse: parse };
})();

// The completion value, so `$.evalFile` returns the codec. A real AE scopes an
// included file's `var`s to the calling function, so the caller cannot look
// `A8NJson` up on the global object.
A8NJson;
