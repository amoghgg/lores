import { GIFEncoder, quantize as gifQuantize, applyPalette } from "gifenc";
import { process, type Settings } from "./pipeline";

export type AnimationMode = "pixel-sweep" | "amount-fade" | "block-pulse";

export type AnimationOptions = {
  source: HTMLImageElement;
  settings: Settings;
  mode: AnimationMode;
  durationMs: number;
  fps: number;
  scale?: number;
  onProgress?: (frame: number, total: number) => void;
  signal?: AbortSignal;
};

const MAX_FRAMES = 120;

/**
 * Generate an animated GIF by re-running the pipeline with interpolated
 * settings across N frames. Yields between frames so the UI stays responsive.
 */
export async function generateGIF(opts: AnimationOptions): Promise<Blob> {
  const { source, settings, mode, durationMs, fps, scale = 1, onProgress, signal } = opts;

  const requested = Math.round((durationMs / 1000) * fps);
  const totalFrames = Math.max(2, Math.min(MAX_FRAMES, requested));
  const delay = Math.round(1000 / fps);

  const gif = GIFEncoder();

  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const t = totalFrames === 1 ? 1 : i / (totalFrames - 1);
    const frameSettings = computeFrameSettings(settings, mode, t);
    const result = process(source, frameSettings);

    let canvas: HTMLCanvasElement = result.canvas;
    if (scale > 1) {
      canvas = upscale(canvas, scale);
    }

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D context unavailable");
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    // gifenc: per-frame palette quantize → apply → write
    const palette = gifQuantize(data, 256, { format: "rgb444" });
    const indexed = applyPalette(data, palette, "rgb444");
    gif.writeFrame(indexed, canvas.width, canvas.height, {
      palette,
      delay,
    });

    onProgress?.(i + 1, totalFrames);
    // Yield to UI
    await new Promise((r) => setTimeout(r, 0));
  }

  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}

function upscale(src: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = src.width * scale;
  out.height = src.height * scale;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

function computeFrameSettings(
  base: Settings,
  mode: AnimationMode,
  t: number
): Settings {
  // ease-in-out cubic for natural motion
  const ease =
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  if (mode === "pixel-sweep") {
    // Block size from 1 → base.blockSize
    return {
      ...base,
      blockSize: Math.max(1, Math.round(1 + (base.blockSize - 1) * ease)),
    };
  }

  if (mode === "amount-fade") {
    return {
      ...base,
      pixelAmount: base.pixelAmount * ease,
      paletteAmount: base.paletteAmount * ease,
      ditherAmount: base.ditherAmount * ease,
    };
  }

  if (mode === "block-pulse") {
    // Sine-based pulse that eases through extremes and lands back on base
    const phase = Math.sin(t * Math.PI * 2);
    const range = Math.max(2, base.blockSize);
    const blockSize = Math.max(
      1,
      Math.round(base.blockSize + phase * range * 0.7)
    );
    return { ...base, blockSize };
  }

  return base;
}

export function downloadGIF(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function estimateFileSize(
  width: number,
  height: number,
  frames: number
): string {
  // Empirical: pixelated GIF averages ~0.4 bytes per pixel × frames
  const bytes = width * height * frames * 0.4;
  if (bytes < 1024 * 1024) return `~${(bytes / 1024).toFixed(0)} KB`;
  return `~${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
