import { AfterEffects } from "file:///Users/rebui/work/ae-a8n.458/dist/index.js";
const sessionRoot = "/tmp/rc458/session-launch-2027";
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
try {
  const ae = await AfterEffects.launch({ sessionRoot, readinessTimeoutMs: 120_000 });
  console.log(`[${el()}] LAUNCH-OK`);
  const v = await ae.version();
  console.log(`[${el()}] FOLLOWUP version=${v}`);
  await ae.close({ unsavedChanges: "discard" });
  console.log(`[${el()}] CLOSED`);
} catch (error) {
  console.log(`[${el()}] LAUNCH-FAIL name=${error?.constructor?.name} code=${error?.code ?? "?"}`);
  console.log(`[${el()}] message=${String(error?.message ?? error).slice(0, 500)}`);
  if (error?.cause) console.log(`cause=${String(error.cause?.message ?? error.cause).slice(0, 300)}`);
}
