/**
 * The public automation API.
 *
 * The one thing this layer guarantees: a caller never sees a method name, an
 * envelope, a host script, or a file path used for IPC. Everything below is
 * `ae-a8n`'s business.
 *
 * ```ts
 * const ae = await AfterEffects.launch();
 * const project = await ae.openProject("fixture.aep");
 * const comp = await project.comp("Main");
 * const layer = await comp.layer("Solid 1");
 * const effect = await layer.effects.apply("Example Plugin");
 * await effect.parameter("Amount").set(50);
 * const frame = await comp.renderFrame(0);
 * await ae.close();
 * ```
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AeDriver } from "../driver/driver.js";
import { ScriptInvocationTransport } from "../driver/script-invocation.js";
import { TraceRecorder, type TraceEvent } from "../trace/trace.js";
import {
  AfterEffectsError,
  EntityNotFoundError,
  HostError,
  HostNotOwnedError,
  ParameterValueError,
  PropertyHasNoValueError,
  contextualise,
} from "./errors.js";
import type { StopResult } from "../driver/driver.js";
import type { HostOwnership } from "../driver/transport.js";

/** What `AfterEffects.close` did. */
export type CloseResult = StopResult;
export type { HostOwnership };
import type {
  ApplicationInfo,
  CommandExecution,
  CompInfo,
  CreateCompOptions,
  LayerTransform,
  SceneSnapshot,
  ShapePath,
  TextLayerInfo,
  TextLayerOptions,
  EffectInfo,
  LaunchOptions,
  LayerInfo,
  OpenProjectOptions,
  OperationOptions,
  ParameterValue,
  ProjectInfo,
  PropertyInfo,
  PropertyKind,
  RenderOptions,
  RenderedFrame,
} from "./types.js";

export * from "./errors.js";
export type * from "./types.js";

/** Internal call surface; not exported so callers cannot bypass the API. */
class Session {
  readonly driver: AeDriver;
  readonly trace: TraceRecorder;
  readonly events: TraceEvent[] = [];

  constructor(driver: AeDriver, trace: TraceRecorder) {
    this.driver = driver;
    this.trace = trace;
    trace.subscribe((event) => {
      this.events.push(event);
    });
  }

  async call<T>(
    op: string,
    method: string,
    params: Record<string, unknown> = {},
    options: OperationOptions = {},
  ): Promise<T> {
    const timeoutMs = optionalTimeout(options.timeoutMs);
    try {
      return (await this.driver.call(method, params, {
        opName: op,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }));
    } catch (error) {
      contextualise(op, error);
    }
  }
}

function optionalTimeout(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  return value;
}

/** A finite number, or an array of finite numbers; the host checks the shape. */
function requireParameterValue(value: unknown): asserts value is ParameterValue {
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!(finite(value) || (Array.isArray(value) && value.every(finite)))) {
    throw new TypeError("parameter value must be a finite number or an array of finite numbers");
  }
}

function isNoValueKind(kind: unknown): kind is Exclude<PropertyKind, "value"> {
  return kind === "no-value" || kind === "custom-value" || kind === "group";
}

/**
 * Whether a path is absolute in the host's terms, decided from the text
 * alone so it does not depend on the caller's OS (a transport may run After
 * Effects on another machine). Absolute: POSIX `/…`; Windows `C:\…` or
 * `C:/…`; UNC `\\server\share\…` (and `\\?\…`). Everything else is
 * resolved by After Effects against *its own* working directory, which is
 * not the caller's: `copy.aep`, `./x`, `../x`, `~/x`, drive-relative `C:x`,
 * and rooted-without-drive `\x`.
 */
export function isAbsoluteProjectPath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path);
}

/** Rejects a relative project path before anything is sent; never resolves it. */
function requireAbsoluteProjectPath(value: unknown): string {
  const path = requireString(value, "path");
  if (!isAbsoluteProjectPath(path)) {
    throw new TypeError(
      `project path must be absolute, got ${JSON.stringify(path)}: After Effects would resolve it against its own ` +
        `working directory, not yours. Resolve it first, e.g. path.resolve(${JSON.stringify(path)}).`,
    );
  }
  return path;
}

/** Edit › Undo and Edit › Redo, as AE 26.5x89 numbers them. */
export const UNDO_COMMAND_ID = 16;
export const REDO_COMMAND_ID = 2035;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireEnvironment(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("hostEnvironment must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new TypeError(`hostEnvironment name is not a portable variable name: ${JSON.stringify(name)}`);
    }
    if (typeof entry !== "string") {
      throw new TypeError(`hostEnvironment.${name} must be a string`);
    }
    out[name] = entry;
  }
  return out;
}

function requirePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive number`);
  }
  return value;
}

/** Refuses an operation that only the session that started AE may perform. */
function requireOwned(session: Session, op: string): void {
  const ownership = session.driver.ownership();
  if (ownership.kind !== "owned") {
    throw new HostNotOwnedError(op, ownership.kind, ownership.evidence);
  }
}

/** Layers in `after` and not in `before`, compared by id. */
function layerDifference(
  from: SceneSnapshot["layers"],
  to: SceneSnapshot["layers"],
): SceneSnapshot["layers"] {
  const ids = new Set(from.map((layer) => layer.id));
  return to.filter((layer) => !ids.has(layer.id));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

export class AfterEffects {
  readonly #session: Session;
  readonly #probe: ApplicationInfo;
  #closed = false;

  constructor(session: Session, probe: ApplicationInfo) {
    this.#session = session;
    this.#probe = probe;
  }

  /**
   * Launches After Effects, or attaches to a running instance, and waits until
   * it answers a readiness probe.
   *
   * On a cold start this is not instant: AE has to become scriptable before the
   * probe succeeds. A failure here means AE did not become usable, and the
   * error names the operation rather than surfacing a raw bridge message.
   */
  static async launch(options: LaunchOptions = {}): Promise<AfterEffects> {
    const sessionRoot = options.sessionRoot ?? mkdtempSync(join(tmpdir(), "ae-a8n-"));
    const trace = new TraceRecorder({ file: join(sessionRoot, "trace.jsonl") });
    const transport =
      options.transport ??
      new ScriptInvocationTransport(
        options.installDir === undefined ? {} : { installDir: options.installDir },
      );

    const driver = new AeDriver({
      transport,
      sessionRoot,
      trace,
      ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
    });

    // The session subscribes before the probe runs, so the live view and the
    // trace file record the same operations. Subscribing afterwards would make
    // `traceEvents` quietly disagree with `tracePath`.
    const session = new Session(driver, trace);
    const environment =
      options.hostEnvironment === undefined ? undefined : requireEnvironment(options.hostEnvironment);
    let probe: ApplicationInfo;
    try {
      probe = await driver.start();
    } catch (error) {
      contextualise("session.launch", error);
    }
    if (environment !== undefined) {
      // Never change the environment of an AE someone else is running.
      requireOwned(session, "session.hostEnvironment");
      await session.call("session.hostEnvironment", "app.setEnvironment", { variables: environment });
    }
    return new AfterEffects(session, probe);
  }

  /**
   * Host version and build, as reported by the launch readiness probe. Free:
   * no round trip, because launch already had to ask.
   */
  info(): ApplicationInfo {
    return this.#probe;
  }

  /** Re-reads the host version, for a caller that wants a live value. */
  async version(): Promise<string> {
    const info = await this.#session.call<ApplicationInfo>("app.info", "app.info");
    return info.version;
  }

  /**
   * Opens a project, replacing the open one. Refuses with
   * UnsavedChangesError if that would discard unsaved changes, unless
   * `unsavedChanges` is "discard". `timeoutMs` overrides the session budget
   * for this call only.
   *
   * If this times out, After Effects usually still finishes the open; get a
   * handle with `project()` instead of opening again.
   */
  async openProject(path: string, options: OpenProjectOptions = {}): Promise<Project> {
    const projectPath = requireAbsoluteProjectPath(path);
    await this.#session.call(
      "project.open",
      "project.open",
      { path: projectPath, discardUnsavedChanges: options.unsavedChanges === "discard" },
      options,
    );
    return new Project(this.#session);
  }

  /**
   * A handle to the project open in After Effects now, without opening
   * anything. Asks the host first, so it waits for a script still running
   * from a timed-out call (an `openProject`, say) and fails if no project is
   * reachable. Check `info().file` to see which project it is.
   */
  async project(options: OperationOptions = {}): Promise<Project> {
    await this.#session.call<ProjectInfo>("project.info", "project.info", {}, options);
    return new Project(this.#session);
  }

  /**
   * Whether this session owns the After Effects process: "owned" when it
   * started it and it is still that process. Only an owned host is quit by
   * `close`.
   */
  ownership(): HostOwnership {
    return this.#session.driver.ownership();
  }

  /**
   * A menu command, looked up by its menu text (as AE shows it, so
   * localised for built-in commands; a plugin's own name for one an AEGP
   * plugin registered) or taken by id. A name AE does not know rejects with
   * EntityNotFoundError (`kind: "menu-command"`). Only an id crosses to
   * After Effects: no script text is ever sent.
   */
  async menuCommand(nameOrId: string | number): Promise<MenuCommand> {
    if (typeof nameOrId === "number") {
      if (!Number.isInteger(nameOrId) || nameOrId <= 0) {
        throw new TypeError("menu command id must be a positive integer");
      }
      return new MenuCommand(this.#session, nameOrId);
    }
    const name = requireString(nameOrId, "menu command name");
    try {
      const found = await this.#session.call<{ id: number }>("menu.find", "menu.find", { name });
      return new MenuCommand(this.#session, found.id, name);
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NotFoundError") {
        throw new EntityNotFoundError("menu-command", name, "menu.find");
      }
      throw error;
    }
  }

  /** Edit › Undo: one step of AE's undo history. Owned sessions only. */
  async undo(options: OperationOptions = {}): Promise<CommandExecution> {
    return new MenuCommand(this.#session, UNDO_COMMAND_ID, "Undo").execute(options);
  }

  /** Edit › Redo. Owned sessions only. */
  async redo(options: OperationOptions = {}): Promise<CommandExecution> {
    return new MenuCommand(this.#session, REDO_COMMAND_ID, "Redo").execute(options);
  }

  /** Compositions in the currently open project. */
  async comps(): Promise<CompInfo[]> {
    return this.#session.call<CompInfo[]>("project.comps", "project.comps");
  }

  /** Absolute path of the machine-readable operation history for this session. */
  get tracePath(): string {
    return this.#session.trace.file ?? join(this.#session.driver.sessionRoot, "trace.jsonl");
  }

  /** Live operation history, in order. */
  get traceEvents(): readonly TraceEvent[] {
    return this.#session.events;
  }

  /** Directory renders and other artifacts are written to. */
  get artifactsDir(): string {
    return this.#session.driver.artifactsDir;
  }

  /**
   * Closes the open project and quits After Effects. Safe to call twice.
   */
  /**
   * Ends the session.
   *
   * After Effects is quit only if this session started it and it is still
   * that process; a host that was already running, or whose identity cannot
   * be confirmed, is left running and the result says why. Quitting refuses
   * with UnsavedChangesError rather than discard unsaved changes, unless
   * `unsavedChanges` is "discard" — and the session stays open for the retry.
   */
  async close(options: { unsavedChanges?: "refuse" | "discard" } = {}): Promise<CloseResult> {
    if (this.#closed) {
      return { quit: false, ownership: this.ownership(), reason: "already closed" };
    }
    try {
      const result = await this.#session.driver.stop(options);
      this.#closed = true;
      return result;
    } catch (error) {
      if (!(error instanceof HostError && error.name === "UnsavedChangesError")) {
        this.#closed = true;
      }
      contextualise("session.close", error);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export class Project {
  readonly #session: Session;

  constructor(session: Session) {
    this.#session = session;
  }

  async info(): Promise<ProjectInfo> {
    return this.#session.call<ProjectInfo>("project.info", "project.info");
  }

  async comps(): Promise<CompInfo[]> {
    return this.#session.call<CompInfo[]>("project.comps", "project.comps");
  }

  /**
   * Creates a composition. Comps are addressed by name, so a name any
   * project item already has is refused.
   */
  async createComp(options: CreateCompOptions): Promise<Comp> {
    const params = {
      name: requireString(options.name, "comp name"),
      width: requirePositive(options.width, "width"),
      height: requirePositive(options.height, "height"),
      duration: requirePositive(options.duration, "duration"),
      frameRate: requirePositive(options.frameRate, "frameRate"),
      pixelAspect: requirePositive(options.pixelAspect ?? 1, "pixelAspect"),
    };
    const info = await this.#session.call<CompInfo>("project.createComp", "project.createComp", params);
    return new Comp(this.#session, info.name);
  }

  /**
   * Resolves a composition by name, verifying it exists.
   *
   * Only the host's own "not found" becomes EntityNotFoundError. Translating
   * every failure into "not found" once hid that the host called an API a
   * real AE does not have.
   */
  async comp(name: string): Promise<Comp> {
    const compName = requireString(name, "comp name");
    try {
      await this.#session.call<CompInfo>("comp.info", "comp.info", { name: compName });
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NotFoundError") {
        throw new EntityNotFoundError("composition", compName, "project.comp");
      }
      throw error;
    }
    return new Comp(this.#session, compName);
  }
}

export class Comp {
  readonly #session: Session;
  readonly name: string;

  constructor(session: Session, name: string) {
    this.#session = session;
    this.name = name;
  }

  async info(): Promise<CompInfo> {
    return this.#session.call<CompInfo>("comp.info", "comp.info", { name: this.name });
  }

  async layers(): Promise<LayerInfo[]> {
    return this.#session.call<LayerInfo[]>("comp.layers", "comp.layers", { name: this.name });
  }

  /** Resolves a layer by name, verifying it exists in this composition. */
  async layer(name: string): Promise<Layer> {
    const layerName = requireString(name, "layer name");
    const layers = await this.layers();
    if (!layers.some((layer) => layer.name === layerName)) {
      throw new EntityNotFoundError("layer", `${layerName} (in "${this.name}")`, "comp.layer");
    }
    return new Layer(this.#session, this.name, layerName);
  }

  /**
   * Opens the composition in a viewer, which makes it the active item: what
   * menu commands that act on "the active composition" act on.
   */
  async openInViewer(): Promise<void> {
    const result = await this.#session.call<{ active: boolean }>("comp.openInViewer", "comp.openInViewer", {
      name: this.name,
    });
    if (!result.active) {
      throw new AfterEffectsError(`"${this.name}" was opened but is not the active item`, "comp.openInViewer");
    }
  }

  /** Adds a text layer on top of the stack and returns it with what AE applied. */
  async addTextLayer(options: TextLayerOptions): Promise<{ layer: Layer; info: TextLayerInfo }> {
    const params: Record<string, unknown> = { comp: this.name, text: requireString(options.text, "text") };
    if (options.name !== undefined) params["name"] = requireString(options.name, "layer name");
    if (options.font !== undefined) params["font"] = requireString(options.font, "font");
    if (options.fontSize !== undefined) params["fontSize"] = requirePositive(options.fontSize, "fontSize");
    if (options.fillColor !== undefined) params["fillColor"] = [...options.fillColor];
    if (options.position !== undefined) params["position"] = [...options.position];
    const info = await this.#session.call<TextLayerInfo>("comp.addTextLayer", "comp.addText", params);
    return { layer: new Layer(this.#session, this.name, info.name), info };
  }

  /**
   * Selects exactly the named layers (and deselects the rest); returns the
   * names now selected, top first.
   */
  async selectLayers(names: readonly string[]): Promise<string[]> {
    const layers = names.map((name) => requireString(name, "layer name"));
    const result = await this.#session.call<{ selected: string[] }>("comp.selectLayers", "comp.selectLayers", {
      comp: this.name,
      layers,
    });
    return result.selected;
  }

  /**
   * Renders a single frame to PNG and returns where it landed.
   *
   * Output goes under the session's artifact directory so a caller can collect
   * everything from one place.
   */
  async renderFrame(frame: number, options: RenderOptions = {}): Promise<RenderedFrame> {
    if (!Number.isInteger(frame) || frame < 0) {
      throw new TypeError("frame must be a non-negative integer");
    }
    const base = this.#session.driver.artifactsDir;
    const outputDir =
      options.subdirectory === undefined ? base : join(base, options.subdirectory);
    return this.#session.call<RenderedFrame>(
      "comp.renderFrame",
      "comp.renderFrame",
      {
        comp: this.name,
        frame,
        outputDir,
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      },
      options,
    );
  }
}

export class Layer {
  readonly #session: Session;
  readonly compName: string;
  readonly name: string;
  readonly effects: Effects;

  constructor(session: Session, compName: string, name: string) {
    this.#session = session;
    this.compName = compName;
    this.name = name;
    this.effects = new Effects(session, compName, name);
  }

  async info(): Promise<LayerInfo> {
    return this.#session.call<LayerInfo>("comp.layer", "comp.layer", {
      comp: this.compName,
      layer: this.name,
    });
  }

  /** Turns the layer's video switch on or off; returns the layer afterwards. */
  async setEnabled(enabled: boolean): Promise<LayerInfo> {
    if (typeof enabled !== "boolean") {
      throw new TypeError("enabled must be a boolean");
    }
    return this.#session.call<LayerInfo>("layer.setEnabled", "layer.setEnabled", {
      comp: this.compName,
      layer: this.name,
      enabled,
    });
  }

  async transform(): Promise<LayerTransform> {
    return this.#session.call<LayerTransform>("layer.transform", "layer.transform", {
      comp: this.compName,
      layer: this.name,
    });
  }

  /** Every path of a shape layer, in layer space; rejects for any other layer. */
  async shapePaths(): Promise<ShapePath[]> {
    return this.#session.call<ShapePath[]>("layer.shapePaths", "layer.shapePaths", {
      comp: this.compName,
      layer: this.name,
    });
  }
}

/**
 * A menu command of the running After Effects, by id. Running one is an edit
 * like any other — it can change or discard the user's work — so it is only
 * allowed on a host this session started (`ownership().kind === "owned"`).
 */
export class MenuCommand {
  readonly #session: Session;
  readonly id: number;
  readonly name: string | undefined;

  constructor(session: Session, id: number, name?: string) {
    this.#session = session;
    this.id = id;
    this.name = name;
  }

  /**
   * Runs the command and reports the active composition's layers before and
   * after. Synchronous in AE: when this resolves, the command has finished,
   * including a plugin's command hook. A command that opens a modal dialog
   * blocks AE until a person dismisses it, and this then times out.
   */
  async execute(options: OperationOptions = {}): Promise<CommandExecution> {
    requireOwned(this.#session, "menu.execute");
    const raw = await this.#session.call<Omit<CommandExecution, "added" | "removed" | "name">>(
      "menu.execute",
      "menu.execute",
      { id: this.id },
      options,
    );
    const execution: CommandExecution = {
      ...raw,
      ...(this.name === undefined ? {} : { name: this.name }),
      added: layerDifference(raw.before.layers, raw.after.layers),
      removed: layerDifference(raw.after.layers, raw.before.layers),
    };
    // The call's own record summarises the result to its top level; the
    // scene change is what a reader of the trace needs, so record it too.
    this.#session.trace.record("menu.execute.scene", "ok", 0, {
      args: { id: this.id, ...(this.name === undefined ? {} : { name: this.name }) },
      result: {
        comp: execution.after.comp,
        itemsBefore: execution.before.itemCount,
        itemsAfter: execution.after.itemCount,
        layersBefore: execution.before.layers.map((layer) => `${layer.id} ${layer.name}`),
        layersAfter: execution.after.layers.map((layer) => `${layer.id} ${layer.name}`),
        added: execution.added.map((layer) => layer.id),
        removed: execution.removed.map((layer) => layer.id),
      },
    });
    return execution;
  }
}

export class Effects {
  readonly #session: Session;
  readonly #comp: string;
  readonly #layer: string;

  constructor(session: Session, comp: string, layer: string) {
    this.#session = session;
    this.#comp = comp;
    this.#layer = layer;
  }

  async all(): Promise<EffectInfo[]> {
    return this.#session.call<EffectInfo[]>("layer.effects", "layer.effects", {
      comp: this.#comp,
      layer: this.#layer,
    });
  }

  /**
   * Applies a plugin effect, or returns the existing one when it is already
   * on the layer. `identifier` is a match name or a display name; match name
   * is tried first because it is locale-independent.
   */
  async apply(identifier: string): Promise<Effect> {
    const effectId = requireString(identifier, "effect identifier");
    const info = await this.#session.call<{ name: string; matchName: string; created: boolean }>(
      "layer.applyEffect",
      "layer.applyEffect",
      { comp: this.#comp, layer: this.#layer, effect: effectId },
    );
    return new Effect(this.#session, this.#comp, this.#layer, info.name);
  }

  /** Looks up an effect already on the layer. */
  async get(identifier: string): Promise<Effect> {
    const effectId = requireString(identifier, "effect identifier");
    const all = await this.all();
    const match = all.find(
      (effect) =>
        effect.name === effectId ||
        (effect.matchName !== undefined && effect.matchName === effectId),
    );
    if (match === undefined) {
      throw new EntityNotFoundError(
        "effect",
        `${effectId} (on layer "${this.#layer}")`,
        "layer.effects.get",
      );
    }
    return new Effect(this.#session, this.#comp, this.#layer, match.name);
  }
}

export class Effect {
  readonly #session: Session;
  readonly #comp: string;
  readonly #layer: string;
  readonly name: string;

  constructor(session: Session, comp: string, layer: string, name: string) {
    this.#session = session;
    this.#comp = comp;
    this.#layer = layer;
    this.name = name;
  }

  async parameters(): Promise<PropertyInfo[]> {
    return this.#session.call<PropertyInfo[]>("effect.parameters", "effect.parameters", {
      comp: this.#comp,
      layer: this.#layer,
      effect: this.name,
    });
  }

  /**
   * A handle to one parameter. Deliberately lazy: reading a parameter the
   * effect does not have is only a problem at `get`/`set`, and making every
   * access round-trip would cost a request per chain link.
   */
  parameter(name: string): Parameter {
    return new Parameter(this.#session, this.#comp, this.#layer, this.name, requireString(name, "parameter name"));
  }
}

export class Parameter {
  readonly #session: Session;
  readonly #comp: string;
  readonly #layer: string;
  readonly #effect: string;
  readonly name: string;

  constructor(
    session: Session,
    comp: string,
    layer: string,
    effect: string,
    name: string,
  ) {
    this.#session = session;
    this.#comp = comp;
    this.#layer = layer;
    this.#effect = effect;
    this.name = name;
  }

  /**
   * Reads the value: a number, or an array of numbers for points and colours
   * (see `ValueProperty`). A property without one (`kind` other than
   * `"value"`) rejects with `PropertyHasNoValueError`; use `info()` to
   * describe any property without failing.
   */
  async get(): Promise<ParameterValue> {
    const info = await this.info();
    if (info.kind !== "value") {
      throw new PropertyHasNoValueError(info.kind, this.name, "effect.getParameter");
    }
    return info.value;
  }

  /**
   * Writes the value and returns what the host reports back afterwards
   * (After Effects stores floats in single precision and may fill in a
   * missing z or alpha). The shape must fit the property's `valueType`, or it
   * rejects with `ParameterValueError`; a property without a value rejects
   * with `PropertyHasNoValueError`. Either way the host refuses before
   * writing.
   */
  async set(value: ParameterValue): Promise<ParameterValue> {
    requireParameterValue(value);
    const info = await this.info(value);
    if (info.kind !== "value") {
      throw new PropertyHasNoValueError(info.kind, this.name, "effect.setParameter");
    }
    return info.value;
  }

  /**
   * Describes the property (`kind`, `valueType`, and `value` when it has
   * one). With a `value`, writes it first, as `set` does.
   */
  async info(value?: ParameterValue): Promise<PropertyInfo> {
    const params = {
      comp: this.#comp,
      layer: this.#layer,
      effect: this.#effect,
      parameter: this.name,
      ...(value === undefined ? {} : { value }),
    };
    if (value === undefined) {
      return this.#session.call<PropertyInfo>("effect.getParameter", "effect.getParameter", params);
    }
    requireParameterValue(value);
    try {
      return await this.#session.call<PropertyInfo>("effect.setParameter", "effect.setParameter", params);
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NoValueError" && isNoValueKind(cause.kind)) {
        throw new PropertyHasNoValueError(cause.kind, this.name, "effect.setParameter", { cause });
      }
      if (cause instanceof HostError && cause.name === "ValueShapeError") {
        throw new ParameterValueError(cause.kind ?? "unknown", this.name, "effect.setParameter", cause.message, {
          cause,
        });
      }
      throw error;
    }
  }
}
