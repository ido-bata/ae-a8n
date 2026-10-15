/**
 * A fake After Effects application, exposing the subset of the scripting
 * object model that `host/a8n-host.js` touches.
 *
 * It exists so the whole path — bridge protocol, host script, driver, render,
 * trace — can be exercised without After Effects installed. The host script
 * that runs against this is byte-identical to the one that runs in AE.
 *
 * What it is NOT: a claim that real After Effects behaves this way. Render
 * output in particular is a deterministic stand-in, chosen so that a parameter
 * write is *observable* in the produced pixels.
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { CloseOptions, FakeFile, FakeFolder, type HostGlobals } from "./es3-runtime.js";
import { encodePng } from "./png.js";

/** AE raises host errors with a numeric `errorNumber`. Mirrored for fidelity. */
function aeError(errorNumber: number, message: string): Error {
  const error = new Error(message);
  (error as Error & { errorNumber: number }).errorNumber = errorNumber;
  return error;
}

/**
 * Adobe's `PropertyType` and `PropertyValueType` enums, with the numeric
 * values AE 26.5x89 reports. Only the members the host script compares
 * against, plus the ones the fake's parameters use.
 */
export const PropertyType = {
  PROPERTY: 6212,
  NAMED_GROUP: 6213,
  INDEXED_GROUP: 6214,
} as const;

export const PropertyValueType = {
  NO_VALUE: 6412,
  TwoD_SPATIAL: 6415,
  OneD: 6417,
  COLOR: 6418,
  CUSTOM_VALUE: 6419,
} as const;

/** Value types the fake models: numbers, and the two AE cannot script. */
export type FakeValueType = "OneD" | "NO_VALUE" | "CUSTOM_VALUE";

export type FakeEffectSpec = {
  readonly matchName: string;
  readonly displayName: string;
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly matchName: string;
    readonly defaultValue: number;
    /** Defaults to `OneD`. */
    readonly valueType?: FakeValueType;
  }>;
};

/**
 * Stand-ins for real plugins. Match names follow Adobe's convention so the
 * host script's match-name-first lookup is exercised the way it will be
 * against genuine third-party effects.
 */
export const FAKE_EFFECTS: readonly FakeEffectSpec[] = [
  {
    matchName: "ADBE Fake Gaussian Blur",
    displayName: "AE Fake Gaussian Blur",
    parameters: [
      { name: "Amount", matchName: "ADBE Fake Gaussian Blur-0001", defaultValue: 0 },
    ],
  },
  {
    matchName: "ADBE Fake Glow",
    displayName: "AE Fake Glow",
    parameters: [
      { name: "Radius", matchName: "ADBE Fake Glow-0001", defaultValue: 0 },
      { name: "Intensity", matchName: "ADBE Fake Glow-0002", defaultValue: 0 },
    ],
  },
  {
    // Shaped like ADBE Tint on AE 26.5x89: its fourth property has an empty
    // name and PropertyValueType.NO_VALUE, and reading its value throws.
    matchName: "ADBE Fake Tint",
    displayName: "AE Fake Tint",
    parameters: [
      { name: "Amount to Tint", matchName: "ADBE Fake Tint-0001", defaultValue: 0 },
      { name: "", matchName: "ADBE Fake Tint-0002", defaultValue: 0, valueType: "NO_VALUE" },
    ],
  },
  {
    // Shaped like ADBE Easy Levels2: the histogram is CUSTOM_VALUE, which AE
    // 26.5x89 refuses to read or write from a script.
    matchName: "ADBE Fake Levels",
    displayName: "AE Fake Levels",
    parameters: [
      { name: "Histogram", matchName: "ADBE Fake Levels-0001", defaultValue: 0, valueType: "CUSTOM_VALUE" },
      { name: "Gamma", matchName: "ADBE Fake Levels-0002", defaultValue: 1 },
    ],
  },
];

function findEffectSpec(identifier: string): FakeEffectSpec | undefined {
  const lowered = identifier.toLowerCase();
  return FAKE_EFFECTS.find(
    (effect) =>
      effect.matchName.toLowerCase() === lowered ||
      effect.displayName.toLowerCase() === lowered,
  );
}

/** Marks the owning project dirty, as any edit in real AE does. */
type Touch = () => void;
const untouched: Touch = () => {};

/** What AE 26.5x89 raises on reading or writing a value it cannot script. */
function unscriptableValue(matchName: string, valueType: FakeValueType): Error {
  return new Error(
    valueType === "NO_VALUE"
      ? `After Effects error: can't get or set the value of this property (matchname "${matchName}"); its propertyValueType is PropertyValueType.NO_VALUE.`
      : `After Effects error: can't get or set the value of this property (matchname "${matchName}"); propertyValueType CUSTOM_VALUE is not implemented.`,
  );
}

export class FakeProperty {
  readonly name: string;
  readonly matchName: string;
  readonly propertyType = PropertyType.PROPERTY;
  readonly #valueType: FakeValueType;
  #value: number;
  /** @internal */
  _touch: Touch = untouched;

  constructor(name: string, matchName: string, value: number, valueType: FakeValueType = "OneD") {
    this.name = name;
    this.matchName = matchName;
    this.#value = value;
    this.#valueType = valueType;
  }

  get propertyValueType(): number {
    return PropertyValueType[this.#valueType];
  }

  /** Whether a script can read and write this property's value. */
  get scriptable(): boolean {
    return this.#valueType === "OneD";
  }

  get value(): number {
    if (!this.scriptable) {
      throw unscriptableValue(this.matchName, this.#valueType);
    }
    return this.#value;
  }

  setValue(value: unknown): void {
    if (!this.scriptable) {
      throw unscriptableValue(this.matchName, this.#valueType);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw aeError(
        5024,
        `property "${this.name}" expects a finite number, got ${JSON.stringify(value)}`,
      );
    }
    this.#value = value;
    this._touch();
  }
}

/**
 * A property group. Like AE's `PropertyGroup` it has no `value` and no
 * `setValue`: reading `value` gives `undefined`, and calling `setValue` fails
 * because it is not a function.
 */
export class FakePropertyGroup {
  readonly name: string;
  readonly matchName: string;
  readonly propertyType: number;
  readonly #children: FakeProperty[] = [];
  /** @internal */
  _touch: Touch = untouched;

  constructor(name: string, matchName: string, propertyType: number = PropertyType.NAMED_GROUP) {
    this.name = name;
    this.matchName = matchName;
    this.propertyType = propertyType;
  }

  get numProperties(): number {
    return this.#children.length;
  }

  property(selector: string | number): FakeProperty | undefined {
    if (typeof selector === "number") {
      return this.#children[selector - 1];
    }
    return this.#children.find(
      (child) =>
        child.name === selector || child.matchName.toLowerCase() === selector.toLowerCase(),
    );
  }

  addProperty(identifier: string): FakeProperty {
    const spec = findEffectSpec(identifier);
    if (spec === undefined) {
      // 5023 is the error AE reports for an effect it cannot resolve.
      throw aeError(5023, `effect "${identifier}" is not available in this host`);
    }
    const group = new FakePropertyGroup(spec.displayName, spec.matchName);
    group._touch = () => this._touch();
    for (const parameter of spec.parameters) {
      const child = new FakeProperty(
        parameter.name,
        parameter.matchName,
        parameter.defaultValue,
        parameter.valueType,
      );
      child._touch = () => this._touch();
      group.addChild(child);
    }
    // Every effect on AE 26.5x89 ends with this group ("Compositing
    // Options"), which holds further properties of its own.
    const builtIn = new FakePropertyGroup("Compositing Options", "ADBE Effect Built In Params");
    const maskOpacity = new FakeProperty("Effect Opacity", "ADBE Effect Mask Opacity", 100);
    maskOpacity._touch = () => this._touch();
    builtIn.addChild(maskOpacity);
    group.addChild(builtIn.asProperty());
    this.#children.push(group as unknown as FakeProperty);
    this._touch();
    return group as unknown as FakeProperty;
  }

  addChild(property: FakeProperty): void {
    this.#children.push(property);
  }

  /**
   * The scriptable top-level parameters of every effect in this parade, used
   * by the fake renderer. Groups inside an effect (Compositing Options) and
   * properties without a scriptable value do not take part.
   */
  *leaves(): Generator<FakeProperty> {
    for (const effect of this.#children) {
      if (!(effect instanceof FakePropertyGroup)) {
        continue;
      }
      for (const child of effect.#children) {
        if (child instanceof FakeProperty && child.scriptable) {
          yield child;
        }
      }
    }
  }

  asProperty(): FakeProperty {
    return this as unknown as FakeProperty;
  }
}

export class FakeLayer {
  readonly name: string;
  readonly index: number;
  enabled = true;
  readonly #parade = new FakePropertyGroup("Effects", "ADBE Effect Parade", PropertyType.INDEXED_GROUP);

  constructor(name: string, index: number) {
    this.name = name;
    this.index = index;
  }

  property(selector: string | number): unknown {
    if (selector === "ADBE Effect Parade") {
      return this.#parade;
    }
    return this.#parade.property(selector);
  }

  get effects(): FakePropertyGroup {
    return this.#parade;
  }

  /** @internal */
  _attach(touch: Touch): void {
    this.#parade._touch = touch;
  }
}

export class FakeComp {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly frameRate: number;
  readonly #layers: FakeLayer[];

  constructor(
    options: {
      name: string;
      width: number;
      height: number;
      duration: number;
      frameRate: number;
      layers: ReadonlyArray<{ name: string }>;
    },
  ) {
    this.name = options.name;
    this.width = options.width;
    this.height = options.height;
    this.duration = options.duration;
    this.frameRate = options.frameRate;
    this.#layers = options.layers.map((layer, index) => new FakeLayer(layer.name, index + 1));
  }

  #resolutionFactor: [number, number] = [1, 1];
  #touch: Touch = untouched;

  /** The viewer's resolution; a real `saveFrameToPng` renders at it. Setting it is an edit. */
  get resolutionFactor(): [number, number] {
    return this.#resolutionFactor;
  }

  set resolutionFactor(value: [number, number]) {
    this.#resolutionFactor = value;
    this.#touch();
  }

  /** @internal */
  _attach(touch: Touch): void {
    this.#touch = touch;
    for (const layer of this.#layers) {
      layer._attach(touch);
    }
  }
  /** Every frame `saveFrameToPng` wrote, in order. */
  readonly renders: RenderCall[] = [];
  #saveFailure: string | undefined;

  /** Make the next `saveFrameToPng` fail the way AE reports it. */
  failNextSaveFrame(message = "Operation failed with error code: 790"): void {
    this.#saveFailure = message;
  }

  get numLayers(): number {
    return this.#layers.length;
  }

  get frameDuration(): number {
    return 1 / this.frameRate;
  }

  layer(selector: string | number): FakeLayer | undefined {
    if (typeof selector === "number") {
      return this.#layers[selector - 1];
    }
    return this.#layers.find((layer) => layer.name === selector);
  }

  /**
   * `CompItem.saveFrameToPng(time, file)` as AE 26.5x89 behaves: it returns
   * at once with a pending result, and the file is complete only after
   * `wait()`. A failure (observed: a missing directory) does not throw from
   * the call; `wait()` throws and the result carries the cause.
   *
   * The pixels are a pure function of the layer/effect state, so a parameter
   * write shows up in them.
   */
  saveFrameToPng(time: number, file: FakeFile): FakePendingFrame {
    const pending = new FakePendingFrame();
    const width = Math.round(this.width / this.resolutionFactor[0]);
    const height = Math.round(this.height / this.resolutionFactor[1]);
    const failure = this.#saveFailure;
    this.#saveFailure = undefined;
    pending._run = () => {
      if (failure !== undefined) {
        throw new Error(failure);
      }
      if (!existsSync(dirname(file.fsName))) {
        throw new Error("Operation failed with error code: 790");
      }
      const layer = this.layer(1);
      let factor = 1;
      if (layer !== undefined) {
        for (const leaf of layer.effects.leaves()) {
          factor *= 1 - Math.min(Math.max(leaf.value, 0), 100) / 100;
        }
      }
      const value = Math.round(255 * Math.max(0, Math.min(1, factor)));
      const shade: readonly [number, number, number] = [value, value, value];
      writeFileSync(file.fsName, encodePng(width, height, () => shade));
      this.renders.push({
        comp: this.name,
        frame: Math.round(time * this.frameRate),
        path: file.fsName,
        width,
        height,
      });
    };
    return pending;
  }
}

/** What a real `saveFrameToPng` returns: a result that is ready after `wait()`. */
export class FakePendingFrame {
  _isReady = false;
  _hasException = false;
  _exception: string | undefined = undefined;
  /** @internal */
  _run: () => void = () => {};

  wait(): string {
    if (!this._isReady) {
      this._isReady = true;
      try {
        this._run();
      } catch (caught) {
        this._hasException = true;
        this._exception = caught instanceof Error ? caught.message : String(caught);
      }
    }
    if (this._hasException) {
      // Real AE throws a message-less error here; the cause is on the result.
      throw new Error("undefined");
    }
    return "";
  }
}

export type RenderCall = {
  readonly comp: string;
  readonly frame: number;
  readonly path: string;
  readonly width: number;
  readonly height: number;
};

export class FakeProject {
  file: FakeFile | null = null;
  /** Unsaved changes, as AE's `Project.dirty`. */
  dirty = false;
  #items: FakeComp[] = [];

  get numItems(): number {
    return this.#items.length;
  }

  get items(): FakeComp[] {
    return this.#items;
  }

  load(comp: FakeComp, file: FakeFile | null): void {
    this.#items = [comp];
    this.file = file;
    this.dirty = false;
    comp._attach(() => {
      this.dirty = true;
    });
  }

  item(index: number): FakeComp | undefined {
    return this.#items[index - 1];
  }

  close(closeOptions: number): void {
    if (closeOptions !== CloseOptions.DO_NOT_SAVE_CHANGES && this.file !== null) {
      throw new Error("fake projects cannot be saved");
    }
    this.#items = [];
    this.file = null;
    this.dirty = false;
  }
}

export class FakeApplication {
  version = "26.0.0";
  // Real AE has `buildNumber` and no `build` (observed on 26.5x89).
  buildNumber = 0;
  project = new FakeProject();
  #quitCount = 0;
  /** Every project the fake has opened, in order. */
  readonly openedPaths: string[] = [];

  get quitCount(): number {
    return this.#quitCount;
  }

  open(file: FakeFile): FakeFile {
    this.openedPaths.push(file.fsName);
    this.project.load(createDefaultComp(), file);
    return file;
  }

  quit(): void {
    this.#quitCount += 1;
  }
}

export function createDefaultComp(): FakeComp {
  return new FakeComp({
    name: "Main",
    width: 64,
    height: 64,
    duration: 5,
    frameRate: 24,
    layers: [{ name: "Solid 1" }],
  });
}

export function createFakeGlobals(app: FakeApplication): HostGlobals {
  return {
    app,
    File: FakeFile,
    Folder: FakeFolder,
    CloseOptions,
    CompItem: FakeComp,
    PropertyType,
    PropertyValueType,
  };
}
