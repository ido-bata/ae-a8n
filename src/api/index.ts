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
import { AfterEffectsError, EntityNotFoundError, HostError, contextualise } from "./errors.js";
import type { StopResult } from "../driver/driver.js";
import type { HostOwnership } from "../driver/transport.js";

/** What `AfterEffects.close` did. */
export type CloseResult = StopResult;
export type { HostOwnership };
import type {
  ApplicationInfo,
  CompInfo,
  EffectInfo,
  LaunchOptions,
  LayerInfo,
  ProjectInfo,
  PropertyInfo,
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

  async call<T>(op: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await this.driver.call(method, params, { opName: op }));
    } catch (error) {
      contextualise(op, error);
    }
  }
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
    let probe: ApplicationInfo;
    try {
      probe = await driver.start();
    } catch (error) {
      contextualise("session.launch", error);
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
   * `unsavedChanges` is "discard".
   */
  async openProject(path: string, options: { unsavedChanges?: "refuse" | "discard" } = {}): Promise<Project> {
    const projectPath = requireString(path, "path");
    await this.#session.call("project.open", "project.open", {
      path: projectPath,
      discardUnsavedChanges: options.unsavedChanges === "discard",
    });
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
    return this.#session.call<RenderedFrame>("comp.renderFrame", "comp.renderFrame", {
      comp: this.name,
      frame,
      outputDir,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    });
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

  async get(): Promise<number> {
    const info = await this.info();
    return info.value;
  }

  /** Sets the value and returns what the host reports back afterwards. */
  async set(value: number): Promise<number> {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("parameter value must be a finite number");
    }
    const info = await this.info(value);
    return info.value;
  }

  async info(value?: number): Promise<PropertyInfo> {
    const params = {
      comp: this.#comp,
      layer: this.#layer,
      effect: this.#effect,
      parameter: this.name,
      ...(value === undefined ? {} : { value }),
    };
    return value === undefined
      ? this.#session.call<PropertyInfo>("effect.getParameter", "effect.getParameter", params)
      : this.#session.call<PropertyInfo>("effect.setParameter", "effect.setParameter", params);
  }
}
