/*
 * ae-a8n IME input fixture — surface listeners (specs/ime-input/spec.md
 * §4.1, §4.3, §8). Loaded by index.html after lib/report.js.
 *
 * Two surfaces, one result stream (window.A8nInputFixtureReport):
 *
 *   cep-composition (Tier-1a, spec §4.1 channel 1 — primary):
 *     DOM compositionstart/compositionupdate/compositionend/input events
 *     on a real <input>, each reported with the DOM value in a SEPARATE
 *     field (`domValue`). A composition event and a value readback are
 *     never merged into one claim.
 *
 *   cep-custom-drawn (Tier-2, spec §4.3):
 *     a <canvas> that receives real key events and draws the committed
 *     text itself. There is no DOM value and no composition event on a
 *     canvas, so the surface declares valueReadback/compositionObserve
 *     "unsupported" up front and reports key events + drawn state; the
 *     remaining oracle is screen change (capture diff, panel spec §5).
 *
 * Evidence boundary (spec §4.2): this file contains NO direct-set path —
 * nothing assigns input.value, textContent, or any property and reports
 * it as input evidence. Every record carries provesOsIme:false; the
 * Tier-1b OS-IME verdict belongs to the input runner's audit record,
 * not to this fixture.
 *
 * Fixture code only — `implemented`, unverified on a real host.
 */
(function () {
  "use strict";

  var report = window.A8nInputFixtureReport;
  if (report === undefined || report === null || typeof report.emit !== "function") {
    // Without the bridge there is nowhere honest to report; say so on the
    // console rather than pretend a sink exists.
    if (typeof console !== "undefined" && console.error) {
      console.error("ae-a8n input fixture: report bridge missing (lib/report.js)");
    }
    return;
  }

  function emit(surface, tier, kind, channel, data, extra) {
    var record = {
      v: 1,
      fixture: "ae-a8n-ime-input",
      surface: surface,
      ts: new Date().toISOString(),
      kind: kind,
      channel: channel,
      tier: tier,
      provesOsIme: false,
      verification: "implemented",
      data: data === undefined ? null : data
    };
    if (extra !== undefined && extra !== null) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) {
          record[key] = extra[key];
        }
      }
    }
    report.emit(record);
  }

  /* ---------------- cep-composition (Tier-1a) ---------------- */

  var compositionField = document.getElementById("composition-field");

  emit("cep-composition", "1a", "surface-ready", "composition-event", {
    compositionObserve: "supported",
    valueReadback: "dom-value",
    note: "primary Tier-1a channel: fixture self-report (spec §4.1 channel 1)"
  });

  if (compositionField !== null) {
    ["compositionstart", "compositionupdate", "compositionend"].forEach(function (type) {
      compositionField.addEventListener(type, function (event) {
        emit("cep-composition", "1a", type, "composition-event", {
          data: typeof event.data === "string" ? event.data : null
        }, {
          // DOM value is a separate field — never merged into the event
          // payload (spec §4.1, issue AC).
          domValue: compositionField.value
        });
      });
    });

    compositionField.addEventListener("input", function (event) {
      emit("cep-composition", "1a", "input", "dom-value", {
        inputType: event.inputType || null,
        isComposing: event.isComposing === true
      }, {
        domValue: compositionField.value
      });
    });
  }

  /* ---------------- cep-custom-drawn (Tier-2) ---------------- */

  var canvas = document.getElementById("draw-surface");
  var drawState = { text: "" };

  emit("cep-custom-drawn", "2", "surface-ready", "draw-state", {
    compositionObserve: "unsupported",
    valueReadback: "unsupported",
    observation: ["key-events", "draw-state", "capture-diff"],
    note: "canvas has no DOM value and no composition events; the " +
          "committed-result oracle is the drawn state plus screen change"
  });

  function drawCanvas() {
    if (canvas === null) {
      return;
    }
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.font = "16px sans-serif";
    ctx.fillText(drawState.text === "" ? "(empty)" : drawState.text, 8, 32);
  }

  function reportDrawState() {
    emit("cep-custom-drawn", "2", "draw-state", "draw-state", {
      length: drawState.text.length
    }, {
      drawnText: drawState.text
    });
  }

  if (canvas !== null) {
    canvas.addEventListener("keydown", function (event) {
      var key = typeof event.key === "string" ? event.key : "";
      emit("cep-custom-drawn", "2", "keydown", "key-event", {
        key: key,
        code: event.code || null,
        isComposing: event.isComposing === true
      }, {
        drawnText: drawState.text
      });
      // Real keys only: Backspace deletes, single-char keys append.
      // Composing keys are recorded but never committed by this handler —
      // a canvas cannot receive an IME commit, which is exactly the
      // honest limitation the surface-ready record declares.
      if (!event.isComposing) {
        if (key === "Backspace") {
          drawState.text = drawState.text.slice(0, -1);
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          drawState.text += key;
        }
        drawCanvas();
        reportDrawState();
      }
    });

    canvas.addEventListener("keyup", function (event) {
      emit("cep-custom-drawn", "2", "keyup", "key-event", {
        key: typeof event.key === "string" ? event.key : null,
        code: event.code || null
      }, {
        drawnText: drawState.text
      });
    });

    drawCanvas();
  }

  /* ---------------- diagnostics ---------------- */

  var pathLine = document.getElementById("report-path");
  if (pathLine !== null && typeof report.path === "function") {
    var p = report.path();
    // appendChild/text node rather than textContent assignment: this file
    // deliberately contains no *.value/textContent/innerHTML assignment
    // anywhere, and test/input-fixtures.test.ts enforces that boundary.
    pathLine.appendChild(document.createTextNode(
      report.sink === "node-fs" && p !== null
        ? "report: " + p
        : "report: memory sink (node context unavailable)"
    ));
  }
})();
