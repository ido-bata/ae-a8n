/**
 * The smallest real-host smoke a consumer runs: is After Effects there, does
 * a session launch, and what does the open project contain? Read-only — it
 * opens nothing unless you pass a project, creates nothing, and quits only
 * an instance this run started.
 *
 * This is the same sequence scripts/check-consumer-smoke.js automates against
 * the packed tarball; run it by hand against an installed package:
 *
 *   node examples/smoke.ts ["$PWD/project.aep"]   # an absolute path
 *
 * Exits 0 with a skip notice when no After Effects installation is
 * discoverable, so it is safe in CI — but a skip is not a pass: record the
 * verification level honestly (docs/consumer-acceptance.md).
 */
import {
  AfterEffects,
  AfterEffectsNotInstalledError,
  resolveInstall,
} from "@ido-bata/ae-a8n";

let install: ReturnType<typeof resolveInstall>;
try {
  install = resolveInstall();
} catch (error) {
  if (error instanceof AfterEffectsNotInstalledError) {
    console.log("skipped: no After Effects installation is discoverable on this host");
    process.exit(0);
  }
  throw error;
}
console.log(`install: ${install.versionName} (${install.executable})`);

const ae = await AfterEffects.launch({ timeoutMs: 120_000 });
try {
  const info = ae.info();
  console.log(`After Effects ${info.version}${info.build === undefined ? "" : ` (${info.build})`}`);
  console.log(`ownership: ${ae.ownership().kind}`);

  const handshake = await ae.capabilities();
  console.log(
    `handshake: contract ${handshake.contractVersion.major}.${handshake.contractVersion.minor}, ` +
      `${handshake.availableCapabilities.length} capabilities, ` +
      `${handshake.diagnostics.length} diagnostics`,
  );

  const projectPath = process.argv[2];
  const project = projectPath === undefined ? await ae.project() : await ae.openProject(projectPath);
  const projectInfo = await project.info();
  console.log(`project: ${projectInfo.file ?? projectInfo.name ?? "(unsaved)"}, ${projectInfo.itemCount} item(s)`);

  for (const comp of await ae.comps()) {
    console.log(`comp "${comp.name}" ${comp.width}x${comp.height} @ ${comp.frameRate} fps`);
  }
} finally {
  // No "discard": if anything is unsaved this rejects and AE keeps it.
  // An After Effects this script did not start is never quit.
  const closed = await ae.close();
  console.log(`closed: quit=${closed.quit}${closed.reason === undefined ? "" : ` (${closed.reason})`}`);
  console.log(`trace: ${ae.tracePath}`);
}
