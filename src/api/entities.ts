/**
 * The entity facades behind `AfterEffects`: `Project`, `Comp`, `Layer`,
 * `MenuCommand`, `Effects`, `Effect` and `Parameter`. Each is a thin,
 * typed view over `session.call` — the session, ownership, authorization,
 * timeout and trace envelope all live in `./session.js` and `./launch.js`,
 * not here. Extracted from `index.ts` (#183); the public surface is
 * unchanged and re-exported there.
 */

import { join } from "node:path";

import {
  AfterEffectsError,
  EntityNotFoundError,
  HostError,
  ParameterValueError,
  PropertyHasNoValueError,
} from "./errors.js";
import { requireAuthorized, requirePositive, type Session } from "./session.js";
import type {
  CommandExecution,
  CompInfo,
  CreateCompOptions,
  EffectInfo,
  LayerInfo,
  LayerTransform,
  OperationOptions,
  ParameterValue,
  ProjectInfo,
  PropertyInfo,
  PropertyKind,
  RenderOptions,
  RenderedFrame,
  SceneSnapshot,
  ShapePath,
  TextLayerInfo,
  TextLayerOptions,
} from "./types.js";

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
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

function layerDifference(
  from: SceneSnapshot["layers"],
  to: SceneSnapshot["layers"],
): SceneSnapshot["layers"] {
  const ids = new Set(from.map((layer) => layer.id));
  return to.filter((layer) => !ids.has(layer.id));
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
    requireAuthorized(this.#session, "menu.execute", "menuCommands");
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
    const op = value === undefined ? "effect.getParameter" : "effect.setParameter";
    try {
      if (value === undefined) {
        return await this.#session.call<PropertyInfo>(op, "effect.getParameter", params);
      }
      requireParameterValue(value);
      return await this.#session.call<PropertyInfo>(op, "effect.setParameter", params);
    } catch (error) {
      const cause = error instanceof AfterEffectsError ? error.cause : undefined;
      if (cause instanceof HostError && cause.name === "NotFoundError" && cause.kind === "parameter") {
        throw new EntityNotFoundError(
          "parameter",
          `${this.name} (on "${this.#effect}" of layer "${this.#layer}")`,
          op,
        );
      }
      if (value === undefined) {
        throw error;
      }
      if (cause instanceof HostError && cause.name === "NoValueError" && isNoValueKind(cause.kind)) {
        throw new PropertyHasNoValueError(cause.kind, this.name, op, { cause });
      }
      if (cause instanceof HostError && cause.name === "ValueShapeError") {
        throw new ParameterValueError(cause.kind ?? "unknown", this.name, op, cause.message, {
          cause,
        });
      }
      throw error;
    }
  }
}
