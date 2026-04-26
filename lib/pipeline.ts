import { pixelate } from "./pixelate";
import { quantize } from "./quantize";
import { floydSteinberg, bayer4, bayer8 } from "./dither";
import { getPalette } from "./palettes";
import { stippleBlend } from "./blend";

export type DitherMode = "none" | "floyd" | "bayer4" | "bayer8";

export type Settings = {
  blockSize: number;
  pixelAmount: number; // 0..1 — interpolates effective block size 1 → blockSize
  paletteId: string;
  paletteAmount: number; // 0..1 — stipple blend pre/post quantize
  dither: DitherMode;
  ditherAmount: number; // 0..1 — stipple blend non-dither / dither
};

export type ProcessResult = {
  canvas: HTMLCanvasElement;
  ms: number;
  effectiveBlockSize: number;
};

/**
 * Compute the actual block size after applying the pixel amount.
 * 0% → 1 (no effect), 100% → configured blockSize, smooth in between.
 */
export function effectiveBlockSize(settings: Settings): number {
  if (settings.blockSize <= 1) return 1;
  return Math.max(
    1,
    Math.round(1 + (settings.blockSize - 1) * settings.pixelAmount)
  );
}

export function process(
  source: HTMLImageElement,
  settings: Settings
): ProcessResult {
  const t0 = performance.now();

  const w = source.naturalWidth;
  const h = source.naturalHeight;

  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D context unavailable");

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);
  const original = ctx.getImageData(0, 0, w, h);
  let img = original;

  // 1. Pixelate — amount controls effective block size (1 → blockSize)
  const effBlock = effectiveBlockSize(settings);
  if (effBlock > 1) {
    img = pixelate(original, effBlock);
  }
  const afterPixel = img;

  // 2. Palette quantize — stipple-blend pre-quantize and quantized.
  // At 50% you see a Bayer-pattern of palette colors over the originals;
  // crisp pixel-art transition, no muddy alpha mids.
  const palette = getPalette(settings.paletteId);
  if (palette.colors.length > 0 && settings.paletteAmount > 0) {
    const quantized = quantize(afterPixel, palette.colors);
    img = stippleBlend(afterPixel, quantized, settings.paletteAmount);
  }
  const afterPalette = img;

  // 3. Dither — stipple-blend the non-dither (afterPalette) with the dithered.
  // Both endpoints live in the same palette space so this remains crisp.
  if (
    settings.dither !== "none" &&
    palette.colors.length > 0 &&
    settings.ditherAmount > 0
  ) {
    let dithered: ImageData | null = null;
    if (settings.dither === "floyd") {
      dithered = floydSteinberg(afterPixel, palette.colors);
    } else if (settings.dither === "bayer4") {
      dithered = bayer4(afterPixel, palette.colors);
    } else if (settings.dither === "bayer8") {
      dithered = bayer8(afterPixel, palette.colors);
    }
    if (dithered) {
      img = stippleBlend(afterPalette, dithered, settings.ditherAmount);
    }
  }

  ctx.putImageData(img, 0, 0);
  return {
    canvas: work,
    ms: performance.now() - t0,
    effectiveBlockSize: effBlock,
  };
}

/**
 * Re-render a processed canvas at an integer scale using nearest-neighbor.
 */
export function upscaleNN(
  source: HTMLCanvasElement,
  scale: number
): HTMLCanvasElement {
  if (scale <= 1) return source;
  const out = document.createElement("canvas");
  out.width = source.width * scale;
  out.height = source.height * scale;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

export function downloadPNG(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");
}
