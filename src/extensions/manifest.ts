/**
 * Extension methods: a consumer's own host operations, declared statically.
 *
 * See `specs/isolated-ae/contracts/extensions.md`. The rules this file
 * enforces are the ones that keep the feature from becoming a way to run
 * arbitrary script text:
 *
 *   - a method is a name plus an ES3 function expression, both fixed before a
 *     session starts;
 *   - a name may not collide with a built-in host method or another extension;
 *   - the generated host file carries the list of methods it declares, so the
 *     Node side can refuse an unknown name without sending anything;
 *   - nothing here evaluates the source. It is concatenated into a file that
 *     After Effects runs, which is where a host script always ran.
 */

import { createHash } from "node:crypto";

export const EXTENSION_CONTRACT_VERSION = 1;

export type ExtensionMethod = {
  readonly name: string;
  /** ES3 function expression: `function (params) { … }`. */
  readonly source: string;
};

export type HostExtension = {
  readonly name: string;
  readonly version: string;
  readonly methods: readonly ExtensionMethod[];
};

export type ExtensionRejection = {
  readonly ok: false;
  readonly detail: string;
};

export type ExtensionAcceptance = {
  readonly ok: true;
  readonly methods: readonly { readonly name: string; readonly source: string }[];
};

/**
 * `aulymo.buildScene`: a lower-case namespace, then camelCase segments.
 *
 * The contract wrote `[a-z0-9]+` per segment, which would refuse its own
 * example `aulymo.buildScene`. The example is what consumers mean, so a
 * segment starts lower-case and may continue in camelCase.
 */
export const EXTENSION_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/u;

export type ValidateOptions = {
  /** The host's built-in method names; a collision is refused. */
  readonly builtins: readonly string[];
  /** Parses ES3, throwing on anything newer. Injected so tests need no parser. */
  readonly parseEs3: (source: string) => void;
};

function describeValue(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/**
 * Validate one extension and flatten it to `name → source`.
 *
 * Every refusal names the method it is about: the consumer has to be able to
 * find the offending declaration without reading this code.
 */
export function validateExtension(
  extension: HostExtension,
  options: ValidateOptions,
): ExtensionAcceptance | ExtensionRejection {
  if (typeof extension.name !== "string" || extension.name === "") {
    return { ok: false, detail: "an extension has no name" };
  }
  if (typeof extension.version !== "string" || extension.version === "") {
    return { ok: false, detail: `extension "${extension.name}" has no version` };
  }
  if (!Array.isArray(extension.methods) || extension.methods.length === 0) {
    return { ok: false, detail: `extension "${extension.name}" declares no methods` };
  }
  const seen = new Set<string>();
  const builtins = new Set(options.builtins);
  const methods: { name: string; source: string }[] = [];
  for (const entry of extension.methods as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, detail: `extension "${extension.name}" has a method that is not an object` };
    }
    const method = entry as { readonly name?: unknown; readonly source?: unknown };
    const name = method.name;
    if (typeof name !== "string" || !EXTENSION_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        detail:
          `extension "${extension.name}" has a method named ${describeValue(name)}; ` +
          "a name is lower-case and dot-separated, like \"aulymo.buildScene\"",
      };
    }
    if (builtins.has(name)) {
      return { ok: false, detail: `the method "${name}" would replace a built-in host method` };
    }
    if (seen.has(name)) {
      return { ok: false, detail: `the method "${name}" is declared more than once` };
    }
    seen.add(name);
    if (typeof method.source !== "string" || method.source.trim() === "") {
      return { ok: false, detail: `the method "${name}" has no source` };
    }
    const source = method.source.trim();
    try {
      options.parseEs3(`(${source});`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        detail: `the method "${name}" is not ES3: ${message.split("\n")[0] ?? message}`,
      };
    }
    methods.push({ name, source });
  }
  return { ok: true, methods };
}

export type BuildResult =
  | {
      readonly ok: true;
      readonly source: string;
      readonly sha256: string;
      readonly methods: readonly string[];
    }
  | ExtensionRejection;

/** The comment that carries the contract version and the declared names. */
export function extensionHeader(methods: readonly string[]): string {
  const manifest = JSON.stringify({
    contract: EXTENSION_CONTRACT_VERSION,
    methods,
  });
  return `/* ae-a8n-extensions ${manifest} */\n`;
}

/**
 * Read the declared names back out of a generated file. No evaluation: the
 * header is a JSON document between a fixed prefix and `*\/`.
 */
export function readExtensionHeader(source: string): string[] | null {
  const match = /^\/\* ae-a8n-extensions (\{.*\}) \*\/$/mu.exec(source.split("\n", 1)[0] ?? "");
  if (match === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { contract, methods } = parsed as { contract?: unknown; methods?: unknown };
    if (contract !== EXTENSION_CONTRACT_VERSION || !Array.isArray(methods)) {
      return null;
    }
    return methods.filter((name): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

/**
 * Concatenate the registration prelude with the shipped host script.
 *
 * The prelude comes first because `a8n-host.js` runs `main()` as it loads, and
 * `main()` reads the table. The host file itself is not modified: the same
 * bytes run against a real After Effects and the in-repo fake host.
 */
export function buildHostScript(
  hostSource: string,
  methods: readonly { readonly name: string; readonly source: string }[],
): (BuildResult & { ok: true }) | ExtensionRejection {
  const names = methods.map((method) => method.name);
  const lines = [extensionHeader(names).trimEnd()];
  if (methods.length > 0) {
    lines.push("(function () {");
    lines.push("  var context = this.__a8n;");
    lines.push("  if (context === undefined || context === null) {");
    lines.push('    throw new Error("extensions were declared without an __a8n host context");');
    lines.push("  }");
    lines.push("  context.extensions = context.extensions || {};");
    for (const method of methods) {
      // The name is a checked identifier (dot-separated lower-case), so it is
      // safe in an ES3 string literal, and the source is a parsed function
      // expression, not a statement.
      lines.push(`  context.extensions[${JSON.stringify(method.name)}] = (${method.source});`);
    }
    lines.push("}());");
  }
  const source = `${lines.join("\n")}\n${hostSource}`;
  return {
    ok: true,
    source,
    sha256: createHash("sha256").update(source, "utf-8").digest("hex"),
    methods: names,
  };
}
