/**
 * Build a scene from nothing, run a menu command on it, and check what it did:
 * the layers it added, their geometry, the rendered pixels, and undo/redo.
 *
 *   node examples/menu-command.ts [<menu command name or id>]
 *
 * The default command is After Effects' own Layer › Create Shapes from Text,
 * by its id (3781 on AE 26.5x89, whose menu text is localised), so this runs
 * without any plugin. Pass an AEGP plugin's menu text to drive its command the
 * same way; it acts on the selected text layer of the active composition.
 *
 * It needs an After Effects that is not running yet: it starts one, works in
 * the untitled project AE opens with, and quits without saving.
 */
import { AfterEffects } from "@ido-bata/ae-a8n";

import { countChangedPixels, readPng } from "./png.ts";

const CREATE_SHAPES_FROM_TEXT = 3781;
const argument = process.argv[2];
const target = argument === undefined ? CREATE_SHAPES_FROM_TEXT : /^\d+$/.test(argument) ? Number(argument) : argument;

const ae = await AfterEffects.launch({ timeoutMs: 120_000 });
if (ae.ownership().kind !== "owned") {
  console.error(`After Effects was already running (${ae.ownership().evidence}); quit it and retry`);
  await ae.close();
  process.exit(1);
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const project = await ae.project();
  const info = await project.info();
  check(info.file === null && info.itemCount === 0, `starts from an empty untitled project (${JSON.stringify(info)})`);

  const comp = await project.createComp({ name: "a8n menu", width: 400, height: 300, duration: 1, frameRate: 30 });
  const { layer: text, info: textInfo } = await comp.addTextLayer({
    text: "H",
    font: "ArialMT",
    fontSize: 200,
    fillColor: [1, 1, 1],
    position: [140, 230],
  });
  console.log(`text layer: ${JSON.stringify(textInfo)}`);
  await comp.openInViewer();
  check((await comp.selectLayers([textInfo.name])).length === 1, "selected the text layer");
  const source = await comp.renderFrame(0, { subdirectory: "source" });

  const command = await ae.menuCommand(target);
  const run = await command.execute();
  console.log(`ran ${command.id} in ${run.durationMs} ms; added ${JSON.stringify(run.added)}`);
  const shapes = run.added.filter((layer) => layer.type === "shape");
  check(shapes.length > 0, "the command added at least one shape layer");

  let vertices = 0;
  for (const shape of shapes) {
    const paths = await (await comp.layer(shape.name)).shapePaths();
    vertices += paths.reduce((sum, path) => sum + path.vertices.length, 0);
    check(paths.length > 0 && paths.every((path) => path.closed), `${shape.name}: ${paths.length} closed path(s)`);
  }
  console.log(`vertices: ${vertices}`);

  // Straight after the command, so the command is the step undone.
  const names = (layers: readonly { name: string }[]) => JSON.stringify(layers.map((layer) => layer.name).sort());
  const undone = await ae.undo();
  check(names(undone.removed) === names(run.added) && undone.added.length === 0, `undo removed ${names(undone.removed)}`);
  const redone = await ae.redo();
  check(names(redone.added) === names(run.added) && redone.removed.length === 0, `redo restored ${names(redone.added)}`);

  // Only the output visible, so the frame shows what the command drew.
  for (const layer of await comp.layers()) {
    await (await comp.layer(layer.name)).setEnabled(shapes.some((shape) => shape.id === layer.id));
  }
  const output = await comp.renderFrame(0, { subdirectory: "output" });
  const differing = countChangedPixels(readPng(source.path), readPng(output.path));
  const total = output.width * output.height;
  console.log(`pixels differing from the text: ${differing} of ${total}`);
  check(differing < total * 0.02, "the output renders like the text it came from (< 2% of pixels differ)");
  check(!(await text.info()).enabled, "the text layer was hidden for the output render");
} finally {
  const closed = await ae.close({ unsavedChanges: "discard" });
  console.log(`closed: quit=${closed.quit}; trace: ${ae.tracePath}`);
}
console.log(failures.length === 0 ? "RESULT PASS" : `RESULT FAIL (${failures.length})`);
process.exitCode = failures.length === 0 ? 0 : 1;
