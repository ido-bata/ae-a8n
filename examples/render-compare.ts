/**
 * Apply an effect, change one parameter, render the same frame before and
 * after, and prove the change reached the pixels.
 *
 *   node examples/render-compare.ts \
  *     <project.aep> <comp> <layer> <effect match name> <parameter match name> <before> <after> \
 *     [<other parameter match name>=<value> ...]
 *
 * e.g. copy.aep Main "Solid 1" "ADBE Gaussian Blur 2" "ADBE Gaussian Blur 2-0001" 0 100 \
 *      "ADBE Gaussian Blur 2-0003=0"
 * (Gaussian Blur's Repeat Edge Pixels, 2-0003, defaults on and keeps the blur
 * inside the layer, where a uniform solid would not change at all.)
 *
 * Use a disposable copy of a project: the edits are discarded at the end, and
 * the file itself is never saved.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { AfterEffects } from "@ido-bata/ae-a8n";

import { countChangedPixels, readPng } from "./png.ts";

const [projectPath, compName, layerName, effectId, parameterId, beforeText, afterText, ...extra] = process.argv.slice(2);
if (afterText === undefined || beforeText === undefined || parameterId === undefined || effectId === undefined || layerName === undefined || compName === undefined || projectPath === undefined) {
  console.error("usage: render-compare.ts <project> <comp> <layer> <effect> <parameter> <before> <after>");
  process.exit(2);
}
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const ae = await AfterEffects.launch({ timeoutMs: 120_000 });
if (ae.ownership().kind !== "owned") {
  // Someone else's After Effects: do not open projects in it.
  console.error(`After Effects was already running (${ae.ownership().evidence}); quit it and retry`);
  await ae.close();
  process.exit(1);
}

let ok = false;
try {
  const project = await ae.openProject(projectPath);
  const comp = await project.comp(compName);
  const layer = await comp.layer(layerName);
  // Match names are stable across UI languages; display names are not.
  const effect = await layer.effects.apply(effectId);
  for (const setting of extra) {
    const at = setting.lastIndexOf("=");
    const id = setting.slice(0, at);
    console.log(`set ${id} = ${await effect.parameter(id).set(Number(setting.slice(at + 1)))}`);
  }
  const parameter = effect.parameter(parameterId);

  console.log(`set ${parameterId} = ${await parameter.set(Number(beforeText))}`);
  const before = await comp.renderFrame(0, { subdirectory: "before" });
  console.log(`set ${parameterId} = ${await parameter.set(Number(afterText))}`);
  const after = await comp.renderFrame(0, { subdirectory: "after" });

  const changed = countChangedPixels(readPng(before.path), readPng(after.path));
  console.log(`before: ${before.path} ${before.width}x${before.height} sha256 ${sha256(before.path)}`);
  console.log(`after:  ${after.path} ${after.width}x${after.height} sha256 ${sha256(after.path)}`);
  console.log(`pixels changed: ${changed}`);
  ok = changed > 0;
} finally {
  // The edits are this script's own, in an After Effects it started.
  const closed = await ae.close({ unsavedChanges: "discard" });
  console.log(`closed: quit=${closed.quit}; trace: ${ae.tracePath}`);
}
process.exitCode = ok ? 0 : 1;
