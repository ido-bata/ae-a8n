/**
 * Look, don't touch: report the install, who owns After Effects, and what the
 * project contains. Safe to run against an After Effects someone is using —
 * it opens nothing unless you pass a project, and never discards changes.
 *
 *   node examples/inspect.ts [project.aep]
 */
import { AfterEffects, AfterEffectsNotInstalledError, UnsavedChangesError, resolveInstall } from "@ido-bata/ae-a8n";

let install: ReturnType<typeof resolveInstall>;
try {
  install = resolveInstall();
} catch (error) {
  if (error instanceof AfterEffectsNotInstalledError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
console.log(`install: ${install.versionName} (${install.executable})`);

const ae = await AfterEffects.launch({ timeoutMs: 60_000 });
try {
  console.log(`After Effects ${ae.info().version}, ownership: ${JSON.stringify(ae.ownership())}`);

  const projectPath = process.argv[2];
  if (projectPath !== undefined) {
    try {
      // Refuses rather than replace a project that has unsaved changes.
      await ae.openProject(projectPath);
    } catch (error) {
      if (error instanceof UnsavedChangesError) {
        console.error("the open project has unsaved changes; not replacing it");
        process.exitCode = 1;
      } else {
        throw error;
      }
    }
  }

  for (const comp of await ae.comps()) {
    console.log(`comp "${comp.name}" ${comp.width}x${comp.height} @ ${comp.frameRate} fps, ${comp.layerCount} layer(s)`);
  }
} finally {
  // No "discard": if anything is unsaved this rejects and AE keeps it.
  // An After Effects this script did not start is never quit.
  const closed = await ae.close();
  console.log(`closed: quit=${closed.quit}${closed.reason === undefined ? "" : ` (${closed.reason})`}`);
  console.log(`trace: ${ae.tracePath}`);
}
