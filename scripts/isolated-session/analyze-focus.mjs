#!/usr/bin/env node
/**
 * Reads a focus-witness log and says what changed.
 *
 * The log lines are `timestamp|app|pid|x,y` (see focus-watch.swift). The
 * question the log answers is narrow: while the isolated session worked,
 * did anything on *this* desktop change hands?
 *
 *   node analyze-focus.mjs focus.log
 */
import { readFileSync } from "node:fs";

function parse(text) {
  const samples = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const [time, app, pid, cursor] = parts;
    const [x, y] = cursor.split(",").map((value) => Number(value));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    samples.push({ time: Number(time), app, pid: Number(pid), x, y });
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
}

try {
  main();
} catch (error) {
  console.error(`analyze-focus: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
