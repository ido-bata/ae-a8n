#!/usr/bin/env node
/**
 * Reads a focus-witness log and says what changed.
 *
 * The log lines are `timestamp|app|pid|x,y|keys=<state>|keyCount|programmaticCount`
 * (see focus-watch.swift). The question the log answers is narrow: while the
 * isolated session worked, did anything on *this* desktop change hands?
 *
 * Key input is reported as **watched** or **unwatched**, never as "zero".
 * A witness that could not watch says so; "0" would be a claim it cannot make.
 * What was typed is never in the log: only counts, and whether an event was
 * posted programmatically rather than typed on the keyboard.
 *
 *   node analyze-focus.mjs focus.log
 */
import { readFileSync } from "node:fs";

function parse(text) {
  const samples = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("|");
    // timestamp|app|pid|x,y|keys=<state>|<keyCount>|<programmaticCount>
    if (parts.length < 4) continue;
    const [time, app, pid, cursor] = parts;
    const [x, y] = cursor.split(",").map((value) => Number(value));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const keysField = parts[4] ?? "";
    const gapMatch = /gapped\((\d+)\)/.exec(keysField);
    samples.push({
      time: Number(time),
      app,
      pid: Number(pid),
      x,
      y,
      keysWatched: keysField === "keys=watched",
      gapCount: gapMatch === null ? 0 : Number(gapMatch[1]),
      keyCount: parts[5] === undefined ? null : Number(parts[5]),
      programmaticCount: parts[6] === undefined ? null : Number(parts[6]),
    });
  }
  return samples;
}

function main() {
  const path = process.argv[2];
  if (path === undefined) {
    throw new Error("pass the focus log to read");
  }
  const samples = parse(readFileSync(path, "utf-8"));
  if (samples.length === 0) {
    throw new Error(`the focus log holds no samples: ${path}`);
  }
  const apps = new Map();
  for (const sample of samples) {
    apps.set(sample.app, (apps.get(sample.app) ?? 0) + 1);
  }
  const changes = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.app !== current.app) {
      changes.push({
        at: current.time,
        from: previous.app,
        to: current.app,
        cursor: `${current.x},${current.y}`,
      });
    }
  }
  let moved = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.x !== current.x || previous.y !== current.y) {
      moved += 1;
    }
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  console.log(`samples: ${samples.length} over ${(last.time - first.time).toFixed(1)}s`);
  console.log("frontmost applications:");
  for (const [app, count] of [...apps.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${app}: ${count}`);
  }
  console.log(`focus changes: ${changes.length}`);
  for (const change of changes.slice(0, 40)) {
    console.log(`  +${(change.at - first.time).toFixed(1)}s ${change.from} → ${change.to} (cursor ${change.cursor})`);
  }
  console.log(`pointer position samples that moved: ${moved}`);
  // Key input. "unwatched" is not "zero": it is the absence of a measurement.
  const watched = samples.some((sample) => sample.keysWatched);
  if (!watched) {
    console.log("key input: NOT MONITORED (the witness could not watch key events; no claim is made)");
  } else {
    const keys = last.keyCount ?? 0;
    const programmatic = last.programmaticCount ?? 0;
    console.log(`key events seen: ${keys} (typed by the human)`);
    console.log(`key events posted programmatically: ${programmatic}`);
  }
  // Gaps: macOS disabled the tap at some point, so keys during that time
  // were not seen. The counts above are then a lower bound, not a total.
  const gaps = samples.reduce((most, sample) => Math.max(most, sample.gapCount), 0);
  if (gaps > 0) {
    console.log(`key input gaps: the tap was disabled ${gaps} time(s); keys typed while it was off were not seen`);
  }
}

try {
  main();
} catch (error) {
  console.error(`analyze-focus: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
