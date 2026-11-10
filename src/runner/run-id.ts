/**
 * Run identifiers.
 *
 * The same format names a Windows job and a CLI run: a UTC stamp that sorts
 * lexicographically, plus random hex so two runs in the same second cannot
 * collide. It contains only characters that are safe in a path on both macOS
 * and Windows.
 */

export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/u;

export function newRunId(now: Date, random: Uint8Array): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  const suffix = Buffer.from(random).toString("hex").slice(0, 8);
  return `${stamp}-${suffix}`;
}
