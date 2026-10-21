/**
 * Value types crossing the public API boundary.
 *
 * These are the shapes the host returns, narrowed. Anything not modelled here
 * is not part of the contract, so the host can grow without silently changing
 * what callers see.
 */

import type { HostTransport } from "../driver/transport.js";

export type ApplicationInfo = {
  readonly version: string;
  readonly build?: string;
};

export type ProjectInfo = {
  readonly file: string | null;
  readonly name: string | null;
  readonly itemCount: number;
};

export type CompInfo = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly frameRate: number;
  readonly layerCount: number;
};

/** `TextLayer`, `ShapeLayer`, any other `AVLayer`, or a camera/light. */
export type LayerType = "text" | "shape" | "av" | "other";

export type LayerInfo = {
  /** `Layer.id`: stable for the layer's life, unlike `index` or `name`. */
  readonly id: number;
  readonly name: string;
  /** Position in the stack, 1 at the top; changes when layers are added. */
  readonly index: number;
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly type: LayerType;
};

export type CreateCompOptions = {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Seconds. */
  readonly duration: number;
  readonly frameRate: number;
  /** Defaults to 1 (square pixels). */
  readonly pixelAspect?: number;
};

export type TextLayerOptions = {
  readonly text: string;
  /** Layer name; defaults to what AE names it (the text). */
  readonly name?: string;
  /** PostScript name, e.g. `"ArialMT"`. AE falls back silently if it has no such font. */
  readonly font?: string;
  readonly fontSize?: number;
  /** `[r, g, b]`, each 0–1. */
  readonly fillColor?: readonly [number, number, number];
  /** `[x, y]` in comp pixels; AE centres a new text layer by default. */
  readonly position?: readonly [number, number];
};

/** A new text layer, with the font AE actually applied. */
export type TextLayerInfo = LayerInfo & {
  readonly font: string;
  readonly fontSize: number;
};

/** Layer transform values as AE reports them (`[x, y, z]` for 2D layers too). */
export type LayerTransform = {
  readonly anchorPoint: readonly number[];
  readonly position: readonly number[];
  readonly scale: readonly number[];
  readonly rotation: number;
  readonly opacity: number;
};

/**
 * One path of a shape layer, in layer space: `[x, y]` vertices and the
 * tangents relative to them. Group transforms are not applied; `groups`
 * names the groups the path sits in, outermost first.
 */
export type ShapePath = {
  readonly groups: readonly string[];
  readonly name: string;
  readonly closed: boolean;
  readonly vertices: ReadonlyArray<readonly [number, number]>;
  readonly inTangents: ReadonlyArray<readonly [number, number]>;
  readonly outTangents: ReadonlyArray<readonly [number, number]>;
};

/** The project and active composition at one moment, as a menu command saw them. */
export type SceneSnapshot = {
  readonly itemCount: number;
  /** Name of the active composition, or null when none is active. */
  readonly comp: string | null;
  /** Layers of the active composition, top first; empty when none is active. */
  readonly layers: readonly LayerInfo[];
};

/**
 * What running a menu command did. `added` and `removed` compare layer ids
 * of the active composition before and after; when the active composition
 * itself changed, they compare the two compositions' layers.
 */
export type CommandExecution = {
  readonly id: number;
  /** The name it was looked up by, when it was. */
  readonly name?: string;
  readonly durationMs: number;
  readonly before: SceneSnapshot;
  readonly after: SceneSnapshot;
  readonly added: readonly LayerInfo[];
  readonly removed: readonly LayerInfo[];
};

export type EffectInfo = {
  readonly name: string;
  readonly matchName?: string;
};

/**
 * What a property holds, as far as scripting can tell without reading it.
 *
 * - `value`: a value a script can read and write; `value` is present, shaped
 *   by `valueType`.
 * - `no-value`: `PropertyValueType.NO_VALUE`, nothing to read or write
 *   (e.g. Tint's `ADBE Tint-0004`, Gradient Ramp's `ADBE Ramp-0008`).
 * - `custom-value`: a value this API does not carry: `CUSTOM_VALUE` (Levels'
 *   histogram, Curves), which After Effects does not expose to scripts, and
 *   `MARKER`, `SHAPE`, `TEXT_DOCUMENT`.
 * - `group`: a property group, such as every effect's Compositing Options
 *   (`ADBE Effect Built In Params`).
 */
export type PropertyKind = "value" | "no-value" | "custom-value" | "group";

/**
 * The `PropertyValueType` of a property this API reads and writes, by its
 * After Effects enum name.
 */
export type ValueType =
  | "OneD"
  | "TwoD"
  | "TwoD_SPATIAL"
  | "ThreeD"
  | "ThreeD_SPATIAL"
  | "COLOR"
  | "LAYER_INDEX"
  | "MASK_INDEX";

/** A value as read or written: a number, or an array of numbers. */
export type ParameterValue = number | readonly number[];

/**
 * A readable property's `valueType` and the `value` it reads as, observed on
 * AE 26.5x89. Writes take the same shape, except that `ThreeD*` also takes 2
 * numbers (z becomes 0) and `COLOR` 3 (alpha becomes 1).
 */
export type ValueProperty =
  | { readonly kind: "value"; readonly valueType: "OneD" | "LAYER_INDEX" | "MASK_INDEX"; readonly value: number }
  | { readonly kind: "value"; readonly valueType: "TwoD" | "TwoD_SPATIAL"; readonly value: readonly [number, number] }
  | {
      readonly kind: "value";
      readonly valueType: "ThreeD" | "ThreeD_SPATIAL";
      readonly value: readonly [number, number, number];
    }
  | {
      readonly kind: "value";
      readonly valueType: "COLOR";
      /** `[r, g, b, a]`, each normally 0–1. */
      readonly value: readonly [number, number, number, number];
    };

/**
 * One property of an effect. `value` is present exactly when `kind` is
 * `"value"`; narrow on `kind`, then on `valueType`, to read it.
 */
export type PropertyInfo = {
  readonly name: string;
  readonly matchName?: string;
} & (
  | ValueProperty
  | { readonly kind: "no-value"; readonly valueType: "NO_VALUE"; readonly value?: undefined }
  | {
      readonly kind: "custom-value";
      /** `CUSTOM_VALUE`, `MARKER`, `SHAPE` or `TEXT_DOCUMENT`. */
      readonly valueType: string;
      readonly value?: undefined;
    }
  | { readonly kind: "group"; readonly valueType?: undefined; readonly value?: undefined }
);

export type RenderedFrame = {
  /** Absolute path to the written PNG. */
  readonly path: string;
  readonly frame: number;
  readonly width: number;
  readonly height: number;
};

/**
 * A budget for one operation, overriding the session's `timeoutMs` for that
 * call only. As with the session budget, it ends the wait, not the work: a
 * script that is still running in After Effects at the deadline runs to
 * completion, and the next call waits for it.
 */
export type OperationOptions = {
  readonly timeoutMs?: number;
};

export type OpenProjectOptions = OperationOptions & {
  /** `"discard"` drops the open project's unsaved changes; default refuses. */
  readonly unsavedChanges?: "refuse" | "discard";
};

export type RenderOptions = OperationOptions & {
  /** Subdirectory of the session's artifact directory. Defaults to the root. */
  readonly subdirectory?: string;
  /** Filename stem. Defaults to the composition name. */
  readonly prefix?: string;
};

export type LaunchOptions = {
  /**
   * Where request files, results, artifacts, and the trace live. Defaults to a
   * fresh directory under the OS temp dir.
   */
  readonly sessionRoot?: string;
  /** Explicit After Effects install directory; skips discovery. */
  readonly installDir?: string;
  /** Per-operation timeout, excluding the readiness probe. */
  readonly timeoutMs?: number;
  /**
   * Supply a transport to bypass process invocation entirely. This is how the
   * fake host is injected, and how `ae-farm` runs against a remote worker.
   */
  readonly transport?: HostTransport;
  /**
   * Environment variables to set inside the After Effects process once it
   * is ready, before anything else runs (`$.setenv`). Native plugins read
   * them with `getenv`. They live in that process only: nothing is written
   * to preferences, and they are gone when AE exits. Needed on macOS, where
   * AE started through LaunchServices does not inherit the caller's
   * environment. Applied only to a host this session owns; otherwise launch
   * rejects with `HostNotOwnedError` and leaves the running AE untouched.
   */
  readonly hostEnvironment?: Readonly<Record<string, string>>;
};
