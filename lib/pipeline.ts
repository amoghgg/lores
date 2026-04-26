import { pixelate } from "./pixelate";
import { quantize } from "./quantize";
import { floydSteinberg, bayer4, bayer8 } from "./dither";
import { getPalette } from "./palettes";
import { blend } from "./blend";

export type DitherMode = "none" | "floyd" | "bayer4" | "bayer8";

export type Settings = {
  blockSize: number;
  pixelAmount: number; // 0..1
  paletteId: string;
  paletteAmount: number; // 0..1
  dither: DitherMode;
  ditherAmount: number; // 0..1
};

export type ProcessResult = {
  canvas: HTMLCanvasElement;
  ms: number;
};

/**
 * Run the full pixelate → palette → dither pipeline. Each stage has its own
 * blend amount so users can dial in subtle effects.
 */
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

  // 1. Pixelate (with amount blend back to original)
  if (settings.blockSize > 1 && settings.pixelAmount > 0) {
    const pixelated = pixelate(original, settings.blockSize);
    img = blend(original, pixelated, settings.pixelAmount);
  }
  const afterPixel = img;

  // 2. Palette quantize
  const palette = getPalette(settings.paletteId);
  if (palette.colors.length > 0 && settings.paletteAmount > 0) {
    const quantized = quantize(afterPixel, palette.colors);
    img = blend(afterPixel, quantized, settings.paletteAmount);
  }
  const afterPalette = img;

  // 3. Dither (only if a palette is active and dither mode != none)
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
      img = blend(afterPalette, dithered, settings.ditherAmount);
    }
  }

  ctx.putImageData(img, 0, 0);
  return { canvas: work, ms: performance.now() - t0 };
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
