/**
 * Bounded OCR for dialog perception (#462,
 * specs/dialog-perception/spec.md §3, ADR-0009).
 *
 * The only engine this substrate ships is **tesseract**, run as a child
 * process with a runtime-enforced timeout — never inside the supervision
 * monitor tick, never awaited on the probe's synchronous `observe()`.
 * A hung or absent engine degrades the reading to `unreadable` with the
 * measured reason; it can never stall a session.
 *
 * macOS Vision was evaluated and rejected on the RC-S17 fixtures
 * (2026-11-28, docs/evidence/dialog-perception/ocr-spike.md): its
 * `VNRecognizeTextRequest` crashes inside result bridging whenever
 * observations exist, and `.accurate` hangs past 40 s. If a future macOS
 * revives it, it may be added behind the same `OcrRunner` contract —
 * callers never see the engine.
 *
 * Language honesty: the runner asks `tesseract --list-langs` once and
 * intersects the requested set with what is actually installed. A
 * Japanese dialog read by an `eng`-only install produces garbage that
 * looks like text — so the languages *actually used* are recorded in
 * every result (`OcrSummary.languages`), and a request that resolves to
 * no usable language fails honestly instead of guessing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { OcrSummary } from "../dialog-reading.js";

/** What one OCR attempt produced. `text` is present only when `ok`. */
export type OcrResult = OcrSummary & {
  /** Extracted text; may be empty — empty is data, not failure. */
  readonly text?: string;
};

/** The engine seam: image path in, bounded result out. */
export type OcrRunner = (imagePath: string) => Promise<OcrResult>;

export type TesseractOcrOptions = {
  /**
   * Preferred languages, in priority order. Intersected with
   * `tesseract --list-langs`; the first entries that exist win. Default
   * `["jpn", "eng"]` — the RC-S17 dialogs are Japanese, and `eng` covers
   * the Latin fragments (product names, digits) Japanese models miss.
   */
  readonly languages?: readonly string[];
  /** Hard subprocess timeout; the child is killed, never awaited past it. */
  readonly timeoutMs?: number;
  /** Tesseract binary; default `tesseract` on PATH. */
  readonly tesseractPath?: string;
  /**
   * `TESSDATA_PREFIX` equivalent for installs whose traineddata lives
   * outside the default datadir. `undefined` inherits the environment.
   */
  readonly tessdataPrefix?: string;
  /** Page segmentation mode; default 6 (uniform block — dialog text). */
  readonly psm?: number;
  /**
   * Test seam replacing `execFile`. Production never sets it.
   */
  readonly exec?: OcrExec;
};

export type OcrExecResult = { readonly stdout: string; readonly stderr: string };
export type OcrExec = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv },
) => Promise<OcrExecResult>;

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_LANGUAGES = ["jpn", "eng"] as const;
/** Traineddata names that are script/engine data, not languages. */
const NON_LANGUAGE_DATA = new Set(["osd"]);

const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: readonly string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv; maxBuffer: number },
) => Promise<OcrExecResult>;

function defaultExec(): OcrExec {
  return (file, args, options) =>
    execFileAsync(file, [...args], {
      timeout: options.timeout,
      ...(options.env === undefined ? {} : { env: options.env }),
      maxBuffer: 8 * 1024 * 1024,
    });
}

/**
 * Parse `tesseract --list-langs` stdout: a header line, then one
 * traineddata stem per line. Unrecognised lines are skipped.
 */
export function parseTesseractLanguages(stdout: string): string[] {
  const langs: string[] = [];
  for (const line of stdout.split("\n")) {
    const name = line.trim();
    if (name === "" || name.startsWith("List of")) continue;
    if (NON_LANGUAGE_DATA.has(name)) continue;
    langs.push(name);
  }
  return langs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build an OCR runner. Language availability is probed lazily on first
 * use and cached — a missing binary or empty intersection is an honest
 * `ok:false` result, never a throw.
 */
export function createTesseractOcr(options: TesseractOcrOptions = {}): OcrRunner {
  const tesseract = options.tesseractPath ?? "tesseract";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const psm = options.psm ?? 6;
  const preferred = options.languages ?? DEFAULT_LANGUAGES;
  const exec: OcrExec = options.exec ?? defaultExec();
  const env =
    options.tessdataPrefix === undefined
      ? undefined
      : { ...process.env, TESSDATA_PREFIX: options.tessdataPrefix };

  let languagesPromise: Promise<readonly string[] | null> | null = null;
  const resolveLanguages = (): Promise<readonly string[] | null> => {
    languagesPromise ??= (async () => {
      try {
        const { stdout } = await exec(tesseract, ["--list-langs"], {
          timeout: Math.min(timeoutMs, 10_000),
          ...(env === undefined ? {} : { env }),
        });
        const available = new Set(parseTesseractLanguages(stdout));
        const usable = preferred.filter((lang) => available.has(lang));
        return usable.length > 0 ? usable : null;
      } catch {
        return null;
      }
    })();
    return languagesPromise;
  };

  return async (imagePath: string): Promise<OcrResult> => {
    const started = Date.now();
    const languages = await resolveLanguages();
    if (languages === null) {
      return {
        engine: "tesseract",
        languages: [],
        durationMs: Date.now() - started,
        timedOut: false,
        ok: false,
        reason:
          `tesseract language data unavailable: none of ` +
          `[${preferred.join(", ")}] found (is tesseract installed with traineddata?)`,
      };
    }
    try {
      const { stdout, stderr } = await exec(
        tesseract,
        [imagePath, "stdout", "-l", languages.join("+"), "--psm", String(psm)],
        { timeout: timeoutMs, ...(env === undefined ? {} : { env }) },
      );
      void stderr;
      return {
        engine: "tesseract",
        languages,
        durationMs: Date.now() - started,
        timedOut: false,
        ok: true,
        text: stdout,
      };
    } catch (error) {
      const timedOut =
        typeof error === "object" &&
        error !== null &&
        ((error as { killed?: boolean }).killed === true ||
          (error as { signal?: string }).signal === "SIGKILL");
      return {
        engine: "tesseract",
        languages,
        durationMs: Date.now() - started,
        timedOut,
        ok: false,
        reason: timedOut
          ? `tesseract exceeded its ${timeoutMs}ms timeout and was killed`
          : `tesseract failed: ${errorMessage(error)}`,
      };
    }
  };
}
