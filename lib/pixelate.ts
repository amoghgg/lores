/**
 * Block-average downscale + nearest-neighbor upscale, in place.
 * Each blockSize × blockSize block in the source becomes one solid color.
 */
export function pixelate(src: ImageData, blockSize: number): ImageData {
  if (blockSize <= 1) return src;
  const w = src.width;
  const h = src.height;
  const out = new ImageData(w, h);
  const data = src.data;
  const dst = out.data;

  for (let y = 0; y < h; y += blockSize) {
    const yMax = Math.min(y + blockSize, h);
    for (let x = 0; x < w; x += blockSize) {
      const xMax = Math.min(x + blockSize, w);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let by = y; by < yMax; by++) {
        const rowOffset = by * w;
        for (let bx = x; bx < xMax; bx++) {
          const i = (rowOffset + bx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          count++;
        }
      }

      r = (r / count) | 0;
      g = (g / count) | 0;
      b = (b / count) | 0;
      a = (a / count) | 0;

      for (let by = y; by < yMax; by++) {
        const rowOffset = by * w;
        for (let bx = x; bx < xMax; bx++) {
          const i = (rowOffset + bx) * 4;
          dst[i] = r;
          dst[i + 1] = g;
          dst[i + 2] = b;
          dst[i + 3] = a;
        }
      }
    }
  }

  return out;
}
