/**
 * A minimal PNG reader for examples: 8- or 16-bit RGB/RGBA, non-interlaced,
 * which is what After Effects' saveFrameToPng writes. Not part of the package
 * API — copy it if you need it.
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export type Png = {
  readonly width: number;
  readonly height: number;
  /** Channels at (x, y), scaled to 0–255: [r, g, b] or [r, g, b, a]. */
  pixel(x: number, y: number): number[];
};

export function readPng(path: string): Png {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`not a PNG: ${path}`);
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] ?? 0;
      color = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (interlace !== 0 || (color !== 2 && color !== 6) || (depth !== 8 && depth !== 16)) {
    throw new Error(`unsupported PNG (depth ${depth}, color type ${color}, interlace ${interlace})`);
  }
  const channels = color === 6 ? 4 : 3;
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0;
      let v = raw[y * (stride + 1) + 1 + x] ?? 0;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const offset = y * stride + x * bpp;
      const values: number[] = [];
      for (let i = 0; i < channels; i++) {
        values.push(depth === 16 ? out.readUInt16BE(offset + i * 2) >> 8 : (out[offset + i] ?? 0));
      }
      return values;
    },
  };
}

/** Number of pixels whose channels differ by more than `tolerance` anywhere. */
export function countChangedPixels(a: Png, b: Png, tolerance = 0): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let changed = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const pa = a.pixel(x, y);
      const pb = b.pixel(x, y);
      if (pa.some((value, i) => Math.abs(value - (pb[i] ?? 0)) > tolerance)) changed++;
    }
  }
  return changed;
}
