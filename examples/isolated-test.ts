/**
 * Isolated-session acceptance fixture: proves `ae-a8n test --user <name>`
 * really ran this code as the helper account, then runs the smallest real
 * After Effects smoke inside that session.
 *
 * It ships inside the npm tarball, so it needs no repository checkout. The
 * helper session is a different OS account, so the installed package must
 * live somewhere that account can read — for example a prefix under the
 * macOS Shared folder (docs/isolated-testing.md §2.1 has the full command):
 *
 *   npm install --prefix <shared-dir>/ae-a8n-fixture @ido-bata/ae-a8n
 *   ae-a8n doctor --user ae-test
 *   ae-a8n setup  --user ae-test
 *   ae-a8n test --user ae-test -- \
 *     "$(which node)" <shared-dir>/ae-a8n-fixture/node_modules/@ido-bata/ae-a8n/examples/isolated-test.ts \
 *     --expect-user ae-test
 *
 * `$(which node)` is expanded on the controller side, so the job names an
 * absolute node binary the helper session can find regardless of its PATH.
 * The package import resolves through the file's own location (the package
 * self-references its exports map), so no NODE_PATH or symlink is needed.
 *
 * The session check is the point of the fixture: if the command ran as the
 * console user instead of the helper, it exits 3 before touching After
 * Effects. When no After Effects installation is discoverable it exits 0
 * with a skip notice — a skip is not a pass (docs/consumer-acceptance.md).
 */
import os from "node:os";

import {
  AfterEffects,
  AfterEffectsNotInstalledError,
  resolveInstall,
} from "@ido-bata/ae-a8n";

const args = process.argv.slice(2);
let expectUser: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--expect-user") {
    expectUser = args[i + 1];
    i += 1;
  } else {
    console.error(`unknown argument ${args[i]}; usage: isolated-test.ts [--expect-user <name>]`);
    process.exit(2);
  }
}

const who = os.userInfo();
const session = { uid: who.uid, username: who.username, homedir: who.homedir };
if (expectUser !== undefined && who.username !== expectUser) {
  console.log(JSON.stringify({ ok: false, reason: "wrong-session", session, expectedUser: expectUser }));
  console.error(
    `this command ran as ${who.username}, not ${expectUser}: the isolated session did not take the job. ` +
      "Nothing was launched.",
  );
  process.exit(3);
}
console.log(`session: uid ${who.uid} (${who.username}), home ${who.homedir}`);

let install: ReturnType<typeof resolveInstall>;
try {
  install = resolveInstall();
} catch (error) {
  if (error instanceof AfterEffectsNotInstalledError) {
    console.log(JSON.stringify({ ok: true, skipped: "no After Effects installation is discoverable" }));
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
      `${handshake.availableCapabilities.length} capabilities`,
  );

  const project = await ae.project();
  const projectInfo = await project.info();
  console.log(`project: ${projectInfo.file ?? projectInfo.name ?? "(unsaved)"}, ${projectInfo.itemCount} item(s)`);

  console.log(JSON.stringify({ ok: true, session, aeVersion: info.version }));
} finally {
  const closed = await ae.close();
  console.log(`closed: quit=${closed.quit}${closed.reason === undefined ? "" : ` (${closed.reason})`}`);
}
process.exit(0);
