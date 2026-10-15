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

export type LayerInfo = {
  readonly name: string;
  readonly index: number;
  readonly enabled?: boolean;
};

export type EffectInfo = {
  readonly name: string;
  readonly matchName?: string;
};

export type PropertyInfo = {
  readonly name: string;
  readonly matchName?: string;
  readonly value: number;
};

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
};
