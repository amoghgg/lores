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
import { applyFilmCPU, type FilmRecipe, type FilmControls } from "./film";
import { needsPost, postFilm } from "./filmPost";

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

export type FilmInput = {
  recipe: FilmRecipe;
  controls: FilmControls;
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

/** Average each block×block cell into one pixel of a (w/block)×(h/block) grid. */
function gridDown(src: ImageData, block: number): ImageData {
  const w = src.width;
  const h = src.height;
  const gw = Math.ceil(w / block);
  const gh = Math.ceil(h / block);
  const out = new ImageData(gw, gh);
  const s = src.data;
  const d = out.data;
  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy * block;
    const y1 = Math.min(y0 + block, h);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * block;
      const x1 = Math.min(x0 + block, w);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += s[i];
          g += s[i + 1];
          b += s[i + 2];
          a += s[i + 3];
          n++;
        }
      }
      const o = (gy * gw + gx) * 4;
      d[o] = r / n;
      d[o + 1] = g / n;
      d[o + 2] = b / n;
      d[o + 3] = a / n;
    }
  }
  return out;
}

/**
 * Palette + dither at the working resolution: the block grid when pixelating
 * (patterns land on the pixel grid, and it's block² less work), else full size.
 */
function paletteStage(work: ImageData, settings: Settings): ImageData {
  let img = work;
  const palette = getPalette(settings.paletteId);
  if (palette.colors.length > 0 && settings.paletteAmount > 0) {
    const quantized = quantize(work, palette.colors);
    img = stippleBlend(work, quantized, settings.paletteAmount);
  }
  const afterPalette = img;
  if (settings.dither !== "none" && palette.colors.length > 0 && settings.ditherAmount > 0) {
    let dithered: ImageData | null = null;
    if (settings.dither === "floyd") dithered = floydSteinberg(work, palette.colors);
    else if (settings.dither === "atkinson") dithered = atkinson(work, palette.colors);
    else if (settings.dither === "jarvis") dithered = jarvis(work, palette.colors);
    else if (settings.dither === "bayer4") dithered = bayer4(work, palette.colors);
    else if (settings.dither === "bayer8") dithered = bayer8(work, palette.colors);
    // blue noise / IGN / halftone are GPU-only; without WebGPU they fall
    // back to plain quantize.
    if (dithered) img = stippleBlend(afterPalette, dithered, settings.ditherAmount);
  }
  return img;
}

function readSource(source: HTMLImageElement | ImageBitmap) {
  const w = "naturalWidth" in source ? source.naturalWidth : source.width;
  const h = "naturalHeight" in source ? source.naturalHeight : source.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0);
  return { w, h, canvas: c, ctx, data: ctx.getImageData(0, 0, w, h) };
}

/** CPU palette+dither at working resolution, as a bitmap for the GPU to finish. */
export async function cpuGridStage(
  source: HTMLImageElement | ImageBitmap,
  settings: Settings
): Promise<ImageBitmap> {
  const { data } = readSource(source);
  const eff = effectiveBlockSize(settings);
  const work = eff > 1 ? gridDown(data, eff) : data;
  return createImageBitmap(paletteStage(work, settings));
}

export function process(
  source: HTMLImageElement | ImageBitmap,
  settings: Settings,
  overlay?: OverlayInput | null,
  film?: FilmInput | null
): ProcessResult {
  const t0 = performance.now();
  const { w, h, canvas: work, ctx, data } = readSource(source);

  // 1–3. Grid down → palette + dither → back up with hard edges.
  const effBlock = effectiveBlockSize(settings);
  if (effBlock > 1) {
    const grid = paletteStage(gridDown(data, effBlock), settings);
    const g = document.createElement("canvas");
    g.width = grid.width;
    g.height = grid.height;
    g.getContext("2d")!.putImageData(grid, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(g, 0, 0, grid.width * effBlock, grid.height * effBlock);
  } else {
    ctx.putImageData(paletteStage(data, settings), 0, 0);
  }

  // 4. Film — stock / camera / print emulation over the pixel-art result.
  if (film && film.controls.amount > 0) {
    applyFilmCPU(ctx, w, h, film.recipe, film.controls);
  }

  // 5. Texture overlay — apply via Canvas 2D's globalCompositeOperation, which
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
  overlay?: OverlayInput | null,
  film?: FilmInput | null,
  /** Render on the thumbnail GPU instance instead of the main one. */
  target: "main" | "thumb" = "main"
): Promise<ProcessResult & { engine: "gpu" | "cpu" }> {
  // PS2 / airbrush / sticker / impasto restyle the source first; everything
  // else (grade, grain, pixel stages, texture) then runs on top as usual.
  let tempSource: ImageBitmap | null = null;
  if (film && film.recipe.stylize !== "none" && film.controls.amount > 0) {
    const { stylizedSource } = await import("./stylize");
    const r = await stylizedSource(
      source,
      film.recipe.stylize,
      film.recipe.stylizeBg,
      film.controls.amount,
      film.controls.seed
    );
    source = r.bitmap;
    if (r.owned) tempSource = r.bitmap;
    film = { ...film, controls: { ...film.controls, amount: 1 } };
  }
  try {
    return await renderBest(source, settings, overlay, film, target);
  } finally {
    tempSource?.close();
  }
}

async function renderBest(
  source: HTMLImageElement | ImageBitmap,
  settings: Settings,
  overlay: OverlayInput | null | undefined,
  film: FilmInput | null | undefined,
  target: "main" | "thumb"
): Promise<ProcessResult & { engine: "gpu" | "cpu" }> {
  const { needsCpuGrid, getWebGPU, getThumbGPU } = await import("./gpu/webgpu");
  {
    const gpu = await (target === "thumb" ? getThumbGPU() : getWebGPU());
    if (gpu) {
      try {
        // Error-diffusion dithers run on the CPU — but only at grid size;
        // upscale, film and texture still happen on the GPU.
        const cpuGrid = needsCpuGrid(settings) ? await cpuGridStage(source, settings) : undefined;
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
          film,
          cpuGrid,
          // Static path → texture readback to a real 2D canvas. Side-steps
          // every WebGPU compositor / first-frame timing issue, so what you
          // see in the preview is bit-exactly what gets exported.
          readback: true,
        });
        cpuGrid?.close();
        if (film && film.controls.amount > 0 && needsPost(film.recipe)) {
          await postFilm(r.canvas, film.recipe, film.controls.seed);
        }
        return { ...r, engine: "gpu" };
      } catch (err) {
        console.warn("[pixel] GPU pipeline failed, falling back to CPU:", err);
      }
    }
  }
  const r = process(source, settings, overlay, film);
  if (film && film.controls.amount > 0 && needsPost(film.recipe)) {
    await postFilm(r.canvas, film.recipe, film.controls.seed);
  }
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
