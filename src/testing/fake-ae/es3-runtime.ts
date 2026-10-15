/**
 * The ES3 surface After Effects hands a host script.
 *
 * `host/a8n-host.js` is written against these globals and nothing else. The
 * real peer supplies Adobe's implementations; this module supplies ones with
 * the same observable behaviour, so the host script runs unmodified in tests.
 *
 * Host scripts are evaluated in a `node:vm` context rather than this module's
 * own scope, so that top-level `var` declarations land on a fresh global the
 * way they do in ExtendScript. Two consequences are deliberate:
 *
 * - The context's native `JSON` is removed by default. Real ExtendScript has
 *   no `JSON`, so keeping it would make every test exercise a code path that
 *   never runs in production. The bundled ES3 codec is the path under test.
 * - Objects crossing the boundary are compared structurally, never by identity
 *   against outer-realm constructors.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join as joinPath } from "node:path";
import vm from "node:vm";

/** Adobe's `CloseOptions` enum, which the host script references. */
export const CloseOptions = {
  DO_NOT_SAVE_CHANGES: 0,
  SAVE_CHANGES: 1,
} as const;

export class FakeFolder {
  readonly fsName: string;

  constructor(fsName: string) {
    this.fsName = fsName;
  }

  get exists(): boolean {
    return existsSync(this.fsName);
  }

  get parent(): FakeFolder {
    return new FakeFolder(dirname(this.fsName));
  }

  get isDirectory(): boolean {
    try {
      return statSync(this.fsName).isDirectory();
    } catch {
      return false;
    }
  }

  get modified(): Date {
    try {
      return statSync(this.fsName).mtime;
    } catch {
      return new Date(0);
    }
  }

  getFiles(): FakeFile[] {
    if (!this.exists) {
      return [];
    }
    return readdirSync(this.fsName)
      .filter((name) => !name.startsWith("."))
      .map((name) => new FakeFile(joinPath(this.fsName, name)))
      .filter((file) => file.exists && !file.isDirectory);
  }

  create(): boolean {
    if (this.exists) {
      return true;
    }
    mkdirSync(this.fsName, { recursive: true });
    return true;
  }
}

export class FakeFile {
  readonly fsName: string;
  encoding = "UTF-8";
  #handle: "r" | "w" | null = null;

  constructor(fsName: string) {
    this.fsName = fsName;
  }

  get exists(): boolean {
    return existsSync(this.fsName);
  }

  get name(): string {
    return basename(this.fsName);
  }

  get parent(): FakeFolder {
    return new FakeFolder(dirname(this.fsName));
  }

  get isDirectory(): boolean {
    try {
      return statSync(this.fsName).isDirectory();
    } catch {
      return false;
    }
  }

  get modified(): Date {
    try {
      return statSync(this.fsName).mtime;
    } catch {
      return new Date(0);
    }
  }

  open(mode: "r" | "w"): boolean {
    if (mode === "w") {
      // Truncate on open, matching ExtendScript's write mode.
      writeFileSync(this.fsName, "");
    } else if (!this.exists) {
      return false;
    }
    this.#handle = mode;
    return true;
  }

  read(): string {
    if (this.#handle !== "r") {
      throw new Error("file is not open for reading: " + this.fsName);
    }
    return readFileSync(this.fsName, "utf-8");
  }

  write(text: string): void {
    if (this.#handle !== "w") {
      throw new Error("file is not open for writing: " + this.fsName);
    }
    writeFileSync(this.fsName, text, "utf-8");
  }

  close(): void {
    this.#handle = null;
  }

  remove(): boolean {
    rmSync(this.fsName, { force: true });
    return true;
  }

  /**
   * Matches ExtendScript: the argument is a new *name*, and the file stays in
   * its directory. A path is refused with `false` — that is what real AE does
   * (observed on 26.5x89), and accepting one here is what let a host that
   * passed full paths look atomic under test while never being so on a host.
   */
  rename(newName: string): boolean {
    if (renameFailuresRemaining > 0) {
      renameFailuresRemaining -= 1;
      return false;
    }
    if (newName.length === 0 || /[\\/]/.test(newName)) {
      return false;
    }
    try {
      renameSync(this.fsName, joinPath(dirname(this.fsName), newName));
      renameSuccesses += 1;
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Fault injection for the host's publication step.
 *
 * The host publishes its result by rename and falls back to a direct write
 * when that fails. That fallback is the one path where a reader can observe a
 * half-written file, so it needs to be *executed* in tests rather than argued
 * about. This makes `File.rename` fail on demand, which is the only way to
 * reach it from outside the host script.
 */
let renameFailuresRemaining = 0;
let renameSuccesses = 0;

/** Make the next `count` `File.rename` calls return false. */
export function failNextRenames(count: number): void {
  renameFailuresRemaining = count;
}

export function resetRenameFaults(): void {
  renameFailuresRemaining = 0;
  renameSuccesses = 0;
}

/**
 * `File.rename` calls that succeeded since the last reset. A publication that
 * fell back to a direct write leaves this unchanged, so a test can tell the
 * atomic path from the fallback even though both leave no `.part` behind.
 */
export function renamesSucceeded(): number {
  return renameSuccesses;
}

export function renamesFailed(): number {
  return renameFailuresRemaining;
}

export type HostGlobals = Record<string, unknown> & {
  File: typeof FakeFile;
  Folder: typeof FakeFolder;
};

export type RunHostOptions = {
  /**
   * Leave the context's built-in `JSON` in place. Off by default: the host
   * must be tested on the codec it will actually use inside After Effects.
   */
  readonly nativeJson?: boolean;
  /**
   * Install this as the global `JSON` instead. A real AE engine can carry one
   * that some other extension put there (observed: a Babel-built polyfill,
   * present only after startup), so the host must not depend on it.
   */
  readonly foreignJson?: unknown;
};

export type RunHostResult =
  | { success: true; globals: Record<string, unknown> }
  | { success: false; error: Error; globals: Record<string, unknown> };

/**
 * Evaluates a host script the way ExtendScript evaluates a JSX file: its
 * top-level `var`s become globals.
 *
 * `$.evalFile` follows what a real AE does (observed on 26.5x89): called from
 * the top level of a script, the included file's `var`s land on the global
 * object; called from inside a function, they stay in that function's scope
 * and never reach the global. Either way the call returns the included
 * file's completion value. The fake approximates "inside a function" as "from
 * inside a file that was itself included", which is where the host calls it.
 */
export function runHostScript(
  scriptPath: string,
  globals: HostGlobals,
  options: RunHostOptions = {},
): RunHostResult {
  const sandbox: Record<string, unknown> = { ...globals };
  const context = vm.createContext(sandbox);
  let includeDepth = 0;

  const removeJson = (target: vm.Context): void => {
    if (options.nativeJson !== true) {
      // Run inside the context so the reference is taken in that realm.
      vm.runInContext("var JSON = undefined;", target);
    }
  };

  const isolatedContext = (): vm.Context => {
    const isolated = vm.createContext({ ...sandbox });
    removeJson(isolated);
    return isolated;
  };

  // ExtendScript's `$.evalFile` takes a path string or a File, and `$.fileName`
  // tracks whichever file is currently executing — so a script that resolves a
  // sibling include sees its own directory, not the caller's. Both behaviours
  // are load-bearing for the host script.
  const dollar: {
    evalFile: (target: string | FakeFile) => unknown;
    fileName: string;
    sleep: (ms: number) => void;
  } = {
    evalFile: (target: string | FakeFile): unknown => {
      const path = typeof target === "string" ? target : target.fsName;
      const included = readFileSync(path, "utf-8");
      const previous = dollar.fileName;
      dollar.fileName = path;
      includeDepth += 1;
      try {
        // Nested: evaluate against a copy of the globals, so its `var`s are
        // invisible to the caller's global object, as on a real host.
        const target = includeDepth > 1 ? isolatedContext() : context;
        return vm.runInContext(included, target, { filename: path });
      } finally {
        includeDepth -= 1;
        dollar.fileName = previous;
      }
    },
    fileName: scriptPath,
    // ExtendScript's blocking sleep. The host uses it between rename attempts;
    // a real one is instant here, which is fine — the retry *count* is what the
    // tests assert on, not the wall clock.
    sleep: (ms: number): void => {
      if (ms > 0) {
        // Atomics.wait is the only genuinely blocking sleep in Node, which is
        // what ExtendScript's `$.sleep` is.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      }
    },
  };

  sandbox["$"] = dollar;
  sandbox["File"] = FakeFile;
  sandbox["Folder"] = FakeFolder;

  removeJson(context);
  if (options.foreignJson !== undefined) {
    sandbox["JSON"] = options.foreignJson;
  }

  try {
    const source = readFileSync(scriptPath, "utf-8");
    vm.runInContext(source, context, { filename: scriptPath });
    return { success: true, globals: sandbox };
  } catch (caught) {
    return {
      success: false,
      error: caught instanceof Error ? caught : new Error(String(caught)),
      globals: sandbox,
    };
  }
}
