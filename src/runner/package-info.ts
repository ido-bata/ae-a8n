/**
 * The package's own name and version, read once.
 *
 * Both the envelope and a run manifest record them, so the reader lives here
 * rather than in either writer. A missing or unreadable `package.json` is not
 * fatal to a diagnostic command; it is reported as the fallback identity.
 */

import { readFileSync } from "node:fs";

export type PackageInfo = { readonly name: string; readonly version: string };

let cached: PackageInfo | null = null;

export function packageInfo(): PackageInfo {
  if (cached !== null) {
    return cached;
  }
  try {
    const parsed = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as Partial<PackageInfo>;
    cached = {
      name: typeof parsed.name === "string" ? parsed.name : "@ido-bata/ae-a8n",
      version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
    };
  } catch {
    cached = { name: "@ido-bata/ae-a8n", version: "0.0.0" };
  }
  return cached;
}
