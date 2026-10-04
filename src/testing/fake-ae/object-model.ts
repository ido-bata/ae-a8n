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

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CloseOptions, FakeFile, FakeFolder, type HostGlobals } from "./es3-runtime.js";
import { encodePng } from "./png.js";

/** AE raises host errors with a numeric `errorNumber`. Mirrored for fidelity. */
function aeError(errorNumber: number, message: string): Error {
  const error = new Error(message);
  (error as Error & { errorNumber: number }).errorNumber = errorNumber;
  return error;
}

export type FakeEffectSpec = {
  readonly matchName: string;
  readonly displayName: string;
  readonly parameters: ReadonlyArray<{
    readonly name: string;
    readonly matchName: string;
    readonly defaultValue: number;
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
];

function findEffectSpec(identifier: string): FakeEffectSpec | undefined {
  const lowered = identifier.toLowerCase();
  return FAKE_EFFECTS.find(
    (effect) =>
      effect.matchName.toLowerCase() === lowered ||
      effect.displayName.toLowerCase() === lowered,
  );
}

export class FakeProperty {
  readonly name: string;
  readonly matchName: string;
  #value: number;

  constructor(name: string, matchName: string, value: number) {
    this.name = name;
    this.matchName = matchName;
    this.#value = value;
  }

  get value(): number {
    return this.#value;
  }

  setValue(value: unknown): void {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw aeError(
        5024,
        `property "${this.name}" expects a finite number, got ${JSON.stringify(value)}`,
      );
    }
    this.#value = value;
  }
}

export class FakePropertyGroup {
  readonly name: string;
  readonly matchName: string;
  readonly #children: FakeProperty[] = [];

  constructor(name: string, matchName: string) {
    this.name = name;
    this.matchName = matchName;
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
    for (const parameter of spec.parameters) {
      group.addChild(
        new FakeProperty(parameter.name, parameter.matchName, parameter.defaultValue),
      );
    }
    this.#children.push(group as unknown as FakeProperty);
    return group as unknown as FakeProperty;
  }

  addChild(property: FakeProperty): void {
    this.#children.push(property);
  }

  /** Depth-first list of leaf parameters, used by the fake renderer. */
  *leaves(): Generator<FakeProperty> {
    for (const child of this.#children) {
      if (child instanceof FakePropertyGroup) {
        yield* child.leaves();
      } else {
        yield child;
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
  readonly #parade = new FakePropertyGroup("Effects", "ADBE Effect Parade");

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

  get numLayers(): number {
    return this.#layers.length;
  }

  layer(selector: string | number): FakeLayer | undefined {
    if (typeof selector === "number") {
      return this.#layers[selector - 1];
    }
    return this.#layers.find((layer) => layer.name === selector);
  }
}

export type RenderCall = {
  readonly comp: string;
  readonly frame: number;
  readonly path: string;
  readonly width: number;
  readonly height: number;
};

export class FakeRenderQueue {
  readonly #items: FakeRenderQueueItem[] = [];
  readonly calls: RenderCall[] = [];

  purge(): void {
    this.#items.length = 0;
  }

  add(item: FakeRenderQueueItem): FakeRenderQueueItem {
    item._bind(this);
    this.#items.push(item);
    return item;
  }

  render(item: FakeRenderQueueItem, comp: FakeComp, frame: number): RenderCall {
    // The render is a pure function of the layer/effect state, so a parameter
    // write shows up in the pixels. That is what makes an assertion about
    // "the plugin was configured" meaningful.
    const layer = comp.layer(1);
    let factor = 1;
    if (layer !== undefined) {
      for (const leaf of layer.effects.leaves()) {
        factor *= 1 - Math.min(Math.max(leaf.value, 0), 100) / 100;
      }
    }
    const value = Math.round(255 * Math.max(0, Math.min(1, factor)));
    const shade: readonly [number, number, number] = [value, value, value];

    const path = join(
      item.outputModule.outputDirectory,
      `${comp.name}.${String(frame).padStart(5, "0")}.png`,
    );
    writeFileSync(path, encodePng(comp.width, comp.height, () => shade));

    const call: RenderCall = {
      comp: comp.name,
      frame,
      path,
      width: comp.width,
      height: comp.height,
    };
    this.calls.push(call);
    return call;
  }
}

/** The `FileFormat` an `OutputModule` hands back from `module(name)`. */
export class FakeFileFormat {
  file: unknown = null;
  colorDepth = 8;
  colorMode = 0;
}

export class FakeOutputModule {
  readonly #target: FakeFile;
  readonly #settings = new FakeFileFormat();
  file: unknown = null;
  colorDepth = 8;
  colorMode = 0;

  constructor(target: FakeFile) {
    this.#target = target;
  }

  module(name: string): FakeFileFormat {
    if (name !== "PNG Sequence") {
      throw aeError(5025, `unsupported output format: ${name}`);
    }
    return this.#settings;
  }

  applySettings(settings: FakeFileFormat): void {
    this.file = settings.file;
    this.colorDepth = settings.colorDepth;
    this.colorMode = settings.colorMode;
  }

  renderSettings = {
    useSolidColor: false,
    solidColor: [0, 0, 0] as number[],
    changeComp: (_comp: FakeComp, _change: boolean): void => {},
  };

  get outputDirectory(): string {
    if (this.file instanceof FakeFolder) {
      return this.file.fsName;
    }
    if (typeof this.file === "string") {
      return this.file;
    }
    return this.#target.parent.fsName;
  }
}

export class FakeRenderQueueItem {
  startTime = 0;
  endTime = 0;
  readonly outputModule: FakeOutputModule;
  #queue: FakeRenderQueue | undefined;
  #comp: FakeComp | undefined;

  constructor(comp: FakeComp, outputModule: FakeOutputModule) {
    this.#comp = comp;
    this.outputModule = outputModule;
  }

  _bind(queue: FakeRenderQueue): void {
    this.#queue = queue;
  }

  render(): void {
    if (this.#queue === undefined || this.#comp === undefined) {
      throw aeError(5026, "render queue item is not bound to a queue");
    }
    if (this.startTime !== this.endTime) {
      throw aeError(5027, "fake renders are single-frame only");
    }
    this.#queue.render(this, this.#comp, this.startTime);
  }
}

export class FakeProject {
  file: FakeFile | null = null;
  readonly renderQueue = new FakeRenderQueue();
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
  }

  item(index: number): FakeComp | undefined {
    return this.#items[index - 1];
  }

  itemByName(name: string): FakeComp | undefined {
    return this.#items.find((item) => item.name === name);
  }

  close(closeOptions: number): void {
    if (closeOptions !== CloseOptions.DO_NOT_SAVE_CHANGES && this.file !== null) {
      throw new Error("fake projects cannot be saved");
    }
    this.#items = [];
    this.file = null;
  }
}

export class FakeApplication {
  version = "26.0.0";
  build = "0";
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
    OutputModule: FakeOutputModule,
    RenderQueueItem: FakeRenderQueueItem,
  };
}
