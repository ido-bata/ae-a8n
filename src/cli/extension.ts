/**
 * `ae-a8n extension build`: concatenate a consumer's extension methods into a
 * host script.
 *
 * Run by the consumer, before a session starts — never at session start. The
 * output is a file; `launch({ hostScript })` points at it. Nothing here runs
 * After Effects, and nothing here evaluates the consumer's source: it is
 * parsed (ES3), concatenated, and hashed.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as acorn from "acorn";

import {
  buildHostScript,
  readExtensionHeader,
  validateExtension,
  type HostExtension,
} from "../extensions/manifest.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The host's built-in methods, read from the shipped script at build time. */
export function builtinMethodNames(hostSource: string): string[] {
  const names = new Set<string>();
  for (const match of hostSource.matchAll(/methods\["([^"]+)"\]\s*=/gu)) {
    names.add(match[1] ?? "");
  }
  return [...names].sort();
}

export type ExtensionBuildOptions = {
  /** The module exporting a `HostExtension` (default export or `extension`). */
  readonly extension: string;
  /** Where to write the generated host script. */
  readonly out: string;
  /** The base host script; defaults to the shipped one. */
  readonly base?: string;
};

export type ExtensionBuildResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly sha256: string;
      readonly methods: readonly string[];
      readonly es3Validated: true;
    }
  | { readonly ok: false; readonly detail: string };

function isHostExtension(value: unknown): value is HostExtension {
  return typeof value === "object" && value !== null && "methods" in value;
}

/** The extension the module exports, whichever of the two shapes it uses. */
export async function loadExtensionModule(path: string): Promise<HostExtension | string> {
  let module_: unknown;
  try {
    module_ = await import(pathToFileURL(path).href);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
      return (
        `${path} is not importable by this Node (${process.version}); ` +
        "point --extension at a compiled .mjs/.js module, or run Node 24"
      );
    }
    return `${path} could not be imported: ${error instanceof Error ? error.message : String(error)}`;
  }
  const exported = module_ as { default?: unknown; extension?: unknown };
  const candidate = exported.default ?? exported.extension;
  if (!isHostExtension(candidate)) {
    return `${path} must export a HostExtension as its default export`;
  }
  return candidate;
}

export async function buildExtensionHost(
  options: ExtensionBuildOptions,
): Promise<ExtensionBuildResult> {
  const extensionPath = resolve(options.extension);
  const loaded = await loadExtensionModule(extensionPath);
  if (typeof loaded === "string") {
    return { ok: false, detail: loaded };
  }
  const basePath = options.base === undefined ? resolve(PACKAGE_ROOT, "host", "a8n-host.js") : resolve(options.base);
  const hostSource = readFileSync(basePath, "utf-8");
  const accepted = validateExtension(loaded, {
    builtins: builtinMethodNames(hostSource),
    parseEs3: (source) => {
      acorn.parse(source, { ecmaVersion: 3 });
    },
  });
  if (!accepted.ok) {
    return accepted;
  }
  const built = buildHostScript(hostSource, accepted.methods);
  if (!built.ok) {
    return built;
  }
  // Validate the whole file too: the prelude is ours, but a host script that
  // is not ES3 would fail in After Effects with a modal alert, not an error.
  try {
    acorn.parse(built.source, { ecmaVersion: 3 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `the generated host script is not ES3: ${message.split("\n")[0] ?? message}` };
  }
  const declared = readExtensionHeader(built.source);
  if (declared === null || declared.join(",") !== built.methods.join(",")) {
    return { ok: false, detail: "the generated host script does not carry the methods it declares" };
  }
  const out = resolve(options.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, built.source, "utf-8");
  return {
    ok: true,
    path: out,
    sha256: built.sha256,
    methods: built.methods,
    es3Validated: true,
  };
}

export const EXTENSION_HELP = [
  "Usage: ae-a8n extension build --extension <module> --out <file>",
  "",
  "Builds a host script that declares the consumer's extension methods.",
  "The module must export a HostExtension as its default export:",
  "",
  "  export default {",
  '    name: "aulymo",',
  '    version: "1.0.0",',
  '    methods: [{ name: "aulymo.buildScene", source: "function (params) { … }" }],',
  "  };",
  "",
  "Every method is parsed as ES3 and refused if it is not; a name that would",
  "replace a built-in host method is refused as well. Prints one JSON document",
  "on stdout: { path, sha256, methods, es3Validated }.",
].join("\n");

export type ExtensionCommandResult = { readonly exitCode: number };

function valueOf(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

export async function runExtensionCommand(
  argv: readonly string[],
  deps: { readonly writeOut?: (text: string) => void; readonly writeErr?: (text: string) => void } = {},
): Promise<ExtensionCommandResult> {
  const writeOut =
    deps.writeOut ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const writeErr =
    deps.writeErr ??
    ((text: string) => {
      process.stderr.write(text);
    });

  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    writeOut(`${EXTENSION_HELP}\n`);
    return { exitCode: 0 };
  }
  if (argv[0] !== "build") {
    writeErr(`ae-a8n extension: unknown subcommand ${String(argv[0])}; run "ae-a8n extension --help"\n`);
    return { exitCode: 2 };
  }
  const extension = valueOf(argv, "--extension");
  const out = valueOf(argv, "--out");
  if (extension === null || out === null) {
    writeErr('ae-a8n extension build needs --extension <module> and --out <file>\n');
    return { exitCode: 2 };
  }
  const result = await buildExtensionHost({ extension, out });
  if (!result.ok) {
    writeErr(`ae-a8n extension build: ${result.detail}\n`);
    return { exitCode: 1 };
  }
  writeOut(
    `${JSON.stringify(
      { path: result.path, sha256: result.sha256, methods: result.methods, es3Validated: true },
      null,
      2,
    )}\n`,
  );
  return { exitCode: 0 };
}

/** Kept for tests that build against a fixture host script. */
export function readHostSource(path: string): string {
  return readFileSync(path, "utf-8");
}
