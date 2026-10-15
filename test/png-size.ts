import { readFileSync } from "node:fs";

/** Width and height from a PNG's IHDR. */
export function decodePngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error(`not a PNG: ${path}`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
