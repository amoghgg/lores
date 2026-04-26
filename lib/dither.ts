import type { RGB } from "./palettes";
import { nearestColor } from "./quantize";

/**
 * Floyd-Steinberg error diffusion. Distributes quantization error to neighbors:
 *     . X 7
 *     3 5 1   (divided by 16)
 */
export function floydSteinberg(src: ImageData, palette: RGB[]): ImageData {
  if (palette.length === 0) return src;
  const w = src.width;
  const h = src.height;
  const out = new ImageData(
    new Uint8ClampedArray(src.data),
    w,
    h
  );
  // Work in a signed buffer so error diffusion can underflow/overflow safely.
  const buf = new Float32Array(w * h * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = out.data[i];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (buf[i + 3] === 0) continue;

      const old: RGB = [buf[i], buf[i + 1], buf[i + 2]];
      const nu = nearestColor(old, palette);

      buf[i] = nu[0];
      buf[i + 1] = nu[1];
      buf[i + 2] = nu[2];

      const er = old[0] - nu[0];
      const eg = old[1] - nu[1];
      const eb = old[2] - nu[2];

      const distribute = (dx: number, dy: number, factor: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
        const ni = (ny * w + nx) * 4;
        buf[ni] += er * factor;
        buf[ni + 1] += eg * factor;
        buf[ni + 2] += eb * factor;
      };

      distribute(1, 0, 7 / 16);
      distribute(-1, 1, 3 / 16);
      distribute(0, 1, 5 / 16);
      distribute(1, 1, 1 / 16);
    }
  }

  // Copy clamped values back to the output ImageData.
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    out.data[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }
  return out;
}

// 8x8 Bayer matrix, normalized to [-0.5, 0.5]
const BAYER_8: number[] = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => v / 64 - 0.5);

const BAYER_4: number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
].map((v) => v / 16 - 0.5);

function bayerDither(
  src: ImageData,
  palette: RGB[],
  matrix: number[],
  size: number,
  strength: number
): ImageData {
  if (palette.length === 0) return src;
  const w = src.width;
  const h = src.height;
  const out = new ImageData(
    new Uint8ClampedArray(src.data),
    w,
    h
  );
  const data = out.data;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      const t = matrix[(y % size) * size + (x % size)] * strength;
      const c: RGB = [
        Math.max(0, Math.min(255, data[i] + t)),
        Math.max(0, Math.min(255, data[i + 1] + t)),
        Math.max(0, Math.min(255, data[i + 2] + t)),
      ];
      const n = nearestColor(c, palette);
      data[i] = n[0];
      data[i + 1] = n[1];
      data[i + 2] = n[2];
    }
  }

  return out;
}

export function bayer4(src: ImageData, palette: RGB[]): ImageData {
  return bayerDither(src, palette, BAYER_4, 4, 64);
}

export function bayer8(src: ImageData, palette: RGB[]): ImageData {
  return bayerDither(src, palette, BAYER_8, 8, 64);
}
