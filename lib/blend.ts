/**
 * Linear RGB alpha blend. Kept for completeness; produces muddy mid-tones
 * when blending color-distant images, so prefer stippleBlend for pixel-art.
 */
export function blend(a: ImageData, b: ImageData, amount: number): ImageData {
  if (amount <= 0) return a;
  if (amount >= 1) return b;
  const out = new ImageData(a.width, a.height);
  const inv = 1 - amount;
  const ad = a.data;
  const bd = b.data;
  const od = out.data;
  for (let i = 0; i < ad.length; i += 4) {
    od[i] = ad[i] * inv + bd[i] * amount;
    od[i + 1] = ad[i + 1] * inv + bd[i + 1] * amount;
    od[i + 2] = ad[i + 2] * inv + bd[i + 2] * amount;
    od[i + 3] = ad[i + 3] * inv + bd[i + 3] * amount;
  }
  return out;
}

// 8×8 Bayer matrix normalized to [0, 1) — used as per-pixel thresholds for
// stipple blending. The values increase along a low-discrepancy ordering so
// that as `amount` rises smoothly, more positions cross threshold and switch
// from a→b in a visually pleasing pattern (no big banded transitions).
const BAYER_8: number[] = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => v / 64);

/**
 * Pick A or B per pixel based on a Bayer threshold against `amount`.
 * Produces a clean ordered-dither transition with no muddy mid-tones.
 * Ideal for blending palette-quantized output with the pre-quantize source.
 */
export function stippleBlend(
  a: ImageData,
  b: ImageData,
  amount: number
): ImageData {
  if (amount <= 0) return a;
  if (amount >= 1) return b;
  const w = a.width;
  const h = a.height;
  const out = new ImageData(w, h);
  const ad = a.data;
  const bd = b.data;
  const od = out.data;
  for (let y = 0; y < h; y++) {
    const matrixRow = (y & 7) * 8;
    for (let x = 0; x < w; x++) {
      const threshold = BAYER_8[matrixRow + (x & 7)];
      const i = (y * w + x) * 4;
      if (threshold < amount) {
        od[i] = bd[i];
        od[i + 1] = bd[i + 1];
        od[i + 2] = bd[i + 2];
        od[i + 3] = bd[i + 3];
      } else {
        od[i] = ad[i];
        od[i + 1] = ad[i + 1];
        od[i + 2] = ad[i + 2];
        od[i + 3] = ad[i + 3];
      }
    }
  }
  return out;
}
