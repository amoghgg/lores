import { pixelate } from "./pixelate";
import { quantize } from "./quantize";
import { floydSteinberg, bayer4, bayer8 } from "./dither";
import { getPalette } from "./palettes";

export type DitherMode = "none" | "floyd" | "bayer4" | "bayer8";

export type Settings = {
  blockSize: number;
  paletteId: string;
  dither: DitherMode;
};

export type ProcessResult = {
  canvas: HTMLCanvasElement;
  ms: number;
};

/**
 * Run the full pixelate → palette → dither pipeline on a source image.
 * Output is a same-size canvas (use ExportCanvas to upscale on download).
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
  let img = ctx.getImageData(0, 0, w, h);

  // 1. Pixelate (block average)
  if (settings.blockSize > 1) {
    img = pixelate(img, settings.blockSize);
  }

  // 2. Palette + dithering
  const palette = getPalette(settings.paletteId);
  if (palette.colors.length > 0) {
    if (settings.dither === "floyd") {
      img = floydSteinberg(img, palette.colors);
    } else if (settings.dither === "bayer4") {
      img = bayer4(img, palette.colors);
    } else if (settings.dither === "bayer8") {
      img = bayer8(img, palette.colors);
    } else {
      img = quantize(img, palette.colors);
    }
  }

  ctx.putImageData(img, 0, 0);
  return { canvas: work, ms: performance.now() - t0 };
}

/**
 * Re-render a processed canvas at an integer scale using nearest-neighbor.
 * Used at export time for chunky printable output.
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
