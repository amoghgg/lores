import { pixelate } from "./pixelate";
import { quantize } from "./quantize";
import {
  floydSteinberg,
  atkinson,
  jarvis,
  bayer4,
  bayer8,
} from "./dither";
import { getPalette } from "./palettes";
import { stippleBlend } from "./blend";

export type DitherMode =
  | "none"
  | "floyd"
  | "atkinson"
  | "jarvis"
  | "bayer4"
  | "bayer8"
  | "bluenoise"
  | "ign"
  | "halftone";

export type Settings = {
  blockSize: number;
  pixelAmount: number; // 0..1 — interpolates effective block size 1 → blockSize
  paletteId: string;
  paletteAmount: number; // 0..1 — stipple blend pre/post quantize
  dither: DitherMode;
  ditherAmount: number; // 0..1 — stipple blend non-dither / dither
};

export type OverlayInput = {
  image: ImageBitmap;
  width: number;
  height: number;
  /** Canvas globalCompositeOperation value. Mirrored on the GPU side. */
  blendMode: GlobalCompositeOperation;
  /** GPU bit value for the same blend mode (see OVERLAY_BLEND_BITS in gpu/webgpu). */
  blendBit: number;
  /** GPU bit for fit mode (0=cover, 1=tile, 2=fit). */
  fitBit: number;
  fit: "cover" | "tile" | "fit";
  /** 0..1 */
  opacity: number;
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
  source: HTMLImageElement | ImageBitmap,
  settings: Settings,
  overlay?: OverlayInput | null
): ProcessResult {
  const t0 = performance.now();

  const w = "naturalWidth" in source ? source.naturalWidth : source.width;
  const h = "naturalHeight" in source ? source.naturalHeight : source.height;

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
    } else if (settings.dither === "atkinson") {
      dithered = atkinson(afterPixel, palette.colors);
    } else if (settings.dither === "jarvis") {
      dithered = jarvis(afterPixel, palette.colors);
    } else if (settings.dither === "bayer4") {
      dithered = bayer4(afterPixel, palette.colors);
    } else if (settings.dither === "bayer8") {
      dithered = bayer8(afterPixel, palette.colors);
    }
    // Note: "bluenoise" / "ign" / "halftone" are GPU-only; the CPU path treats
    // them as "no dither". Practically processBest routes those to the GPU
    // pipeline, so this fallthrough only fires if WebGPU is unavailable.
    if (dithered) {
      img = stippleBlend(afterPalette, dithered, settings.ditherAmount);
    }
  }

  ctx.putImageData(img, 0, 0);

  // 4. Texture overlay — apply via Canvas 2D's globalCompositeOperation, which
  // maps 1:1 to the Photoshop blend names exposed in the UI.
  if (overlay && overlay.opacity > 0) {
    applyOverlay(ctx, w, h, overlay);
  }

  return {
    canvas: work,
    ms: performance.now() - t0,
    effectiveBlockSize: effBlock,
  };
}

function applyOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  overlay: OverlayInput
) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, overlay.opacity));
  ctx.globalCompositeOperation = overlay.blendMode;
  ctx.imageSmoothingEnabled = true;

  if (overlay.fit === "tile") {
    // Native pixel size, repeat-fill the canvas
    const pat = ctx.createPattern(overlay.image as unknown as CanvasImageSource, "repeat");
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
    }
  } else {
    const tw = overlay.width;
    const th = overlay.height;
    const sx = w / tw;
    const sy = h / th;
    const scale = overlay.fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
    const dw = tw * scale;
    const dh = th * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    ctx.drawImage(
      overlay.image as unknown as CanvasImageSource,
      dx,
      dy,
      dw,
      dh
    );
  }
  ctx.restore();
}

/**
 * Re-render a processed canvas at an integer scale using nearest-neighbor.
 */
export function upscaleNN(
  source: HTMLCanvasElement,
  scale: number
): HTMLCanvasElement {
  const s = Math.max(1, scale);
  const out = document.createElement("canvas");
  out.width = source.width * s;
  out.height = source.height * s;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/**
 * Dispatch to GPU when possible, fall back to CPU on any failure.
 * Returns a stable shape with `engine` so the UI can surface which path ran.
 */
export async function processBest(
  source: HTMLImageElement | ImageBitmap,
  settings: Settings,
  overlay?: OverlayInput | null
): Promise<ProcessResult & { engine: "gpu" | "cpu" }> {
  const { gpuCanHandle, getWebGPU } = await import("./gpu/webgpu");
  if (gpuCanHandle(settings)) {
    const gpu = await getWebGPU();
    if (gpu) {
      try {
        // Sync the overlay texture upload to the live GPU bitmap. setOverlayTexture
        // is idempotent on identity, so it's effectively free if unchanged.
        if (overlay) {
          gpu.setOverlayTexture(overlay.image);
        } else {
          gpu.setOverlayTexture(null);
        }
        const r = await gpu.process(source, settings, {
          overlay: overlay
            ? {
                blendMode: overlay.blendBit,
                fitMode: overlay.fitBit,
                opacity: overlay.opacity,
              }
            : undefined,
        });
        return { ...r, engine: "gpu" };
      } catch (err) {
        console.warn("[lores] GPU pipeline failed, falling back to CPU:", err);
      }
    }
  }
  const r = process(source, settings, overlay);
  return { ...r, engine: "cpu" };
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
