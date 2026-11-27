/**
 * Structural tests for the IME input fixtures (#375,
 * `fixtures/input/`, spec `specs/ime-input/spec.md` §4・§8).
 *
 * These tests pin the fixture *contract* — file layout, required
 * listeners, the result-record evidence boundary, and ES3 validity of the
 * ScriptUI extension methods — at `implemented` level. They do not (and
 * must not) launch After Effects: real-host verification is a separate,
 * needs-human ticket.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import * as acorn from "acorn";

import { buildHostScript, validateExtension } from "../src/extensions/manifest.js";
import { builtinMethodNames } from "../src/cli/extension.js";

import fixtureExtension from "../fixtures/input/scriptui/extension.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "input");
const HOST_SCRIPT = join(HERE, "..", "host", "a8n-host.js");

function readFixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), "utf-8");
}

describe("scriptui extension fixture", () => {
  it("validates as a HostExtension with ES3 method sources", () => {
    const accepted = validateExtension(fixtureExtension, {
      builtins: builtinMethodNames(readFileSync(HOST_SCRIPT, "utf-8")),
      parseEs3: (source) => {
        acorn.parse(source, { ecmaVersion: 3 });
      },
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.methods.map((m) => m.name)).toEqual([
        "a8nInputFixture.scriptuiOpen",
        "a8nInputFixture.scriptuiReadback",
        "a8nInputFixture.scriptuiClose",
      ]);
    }
  });

  it("builds into the shipped host script as valid ES3", () => {
    const built = buildHostScript(
      readFileSync(HOST_SCRIPT, "utf-8"),
      fixtureExtension.methods,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      // The whole generated file must parse as ES3 — the same constraint
      // After Effects enforces (a8n-host.js itself is ES3).
      expect(() => acorn.parse(built.source, { ecmaVersion: 3 })).not.toThrow();
    }
  });

  it("readback is read-only: no method writes the control value", () => {
    for (const method of fixtureExtension.methods) {
      // A direct-set path (`edittext.text = …`, `.value = …`) would be IME
      // evidence fraud (spec §4.2); the fixture must not contain one.
      expect(method.source).not.toMatch(/\.(text|value)\s*=(?!=)/u);
    }
  });
});

describe("cep fixture extension", () => {
  const manifest = readFixture("cep", "CSXS", "manifest.xml");
  const html = readFixture("cep", "index.html");
  const panelJs = readFixture("cep", "lib", "panel.js");
  const reportJs = readFixture("cep", "lib", "report.js");

  it("manifest declares an AEFT panel extension with nodejs enabled", () => {
    expect(manifest).toContain('Host Name="AEFT"');
    expect(manifest).toContain("<Type>Panel</Type>");
    expect(manifest).toContain("--enable-nodejs");
    expect(manifest).toContain("./index.html");
  });

  it("panel installs the Tier-1a composition listeners", () => {
    for (const type of [
      "compositionstart",
      "compositionupdate",
      "compositionend",
      "input",
    ]) {
      expect(panelJs).toContain(`"${type}"`);
    }
    expect(panelJs).toContain("composition-field");
  });

  it("panel reports DOM value in a separate field from events", () => {
    // spec §4.1 / issue AC: composition events and DOM value are reported
    // separately — `domValue` must appear as its own record field.
    expect(panelJs).toContain("domValue");
  });

  it("custom-drawn surface observes keys and drawn state, honestly unsupported", () => {
    expect(panelJs).toContain("cep-custom-drawn");
    expect(panelJs).toContain("keydown");
    expect(panelJs).toContain("keyup");
    expect(panelJs).toContain("draw-state");
    expect(panelJs).toContain('compositionObserve: "unsupported"');
    expect(panelJs).toContain('valueReadback: "unsupported"');
  });

  it("every record carries the no-OS-IME-evidence boundary", () => {
    // spec §4.2: fixture records must never claim a Tier-1b pass.
    expect(panelJs).toContain("provesOsIme: false");
    // And no direct-set path may exist in the panel code.
    expect(panelJs).not.toMatch(/\.value\s*=(?!=)/u);
    expect(panelJs).not.toMatch(/\.textContent\s*=(?!=)/u);
    expect(panelJs).not.toMatch(/\.innerHTML\s*=(?!=)/u);
  });

  it("report bridge exposes node-fs and memory sinks", () => {
    expect(reportJs).toContain("A8nInputFixtureReport");
    expect(reportJs).toContain("appendFileSync");
    expect(reportJs).toContain("buffered");
    expect(html).toContain("lib/report.js");
    expect(html).toContain("lib/panel.js");
  });
});
