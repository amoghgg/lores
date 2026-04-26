import type { RGB } from "./palettes";

/**
 * Squared Euclidean distance in RGB space — the cheap, fine-for-art-tools metric.
 */
export function nearestColor(c: RGB, palette: RGB[]): RGB {
  let best = palette[0];
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = c[0] - p[0];
    const dg = c[1] - p[1];
    const db = c[2] - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/**
 * Apply a fixed palette to every pixel. No dithering.
 */
export function quantize(src: ImageData, palette: RGB[]): ImageData {
  if (palette.length === 0) return src;
  const out = new ImageData(
    new Uint8ClampedArray(src.data),
    src.width,
    src.height
  );
  const data = out.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const c: RGB = [data[i], data[i + 1], data[i + 2]];
    const n = nearestColor(c, palette);
    data[i] = n[0];
    data[i + 1] = n[1];
    data[i + 2] = n[2];
  }
  return out;
}
