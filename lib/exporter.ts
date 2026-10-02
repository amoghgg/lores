// Export: integer nearest-neighbour upscales for pixel art, smooth scaling for
// photo looks, optional platform frames (padded, never cropped).

import { embedRecipe } from "./pngmeta";

export type FrameId = "none" | "ig45" | "ig34" | "story" | "square";

export const FRAMES: { id: FrameId; name: string; w: number; h: number }[] = [
  { id: "none", name: "NATIVE", w: 0, h: 0 },
  { id: "ig45", name: "IG 4:5", w: 1080, h: 1350 },
  { id: "ig34", name: "IG 3:4", w: 1080, h: 1440 },
  { id: "story", name: "STORY 9:16", w: 1080, h: 1920 },
  { id: "square", name: "SQUARE", w: 1080, h: 1080 },
];

export type ExportFormat = "png" | "jpeg";

export type ExportOptions = {
  scale: number; // 1,2,4,8 for native
  frame: FrameId;
  format: ExportFormat;
  /** Pixel art → nearest-neighbour; photo looks → smooth. */
  crisp: boolean;
  matte: string; // pad colour for frames
};

export function renderExport(src: HTMLCanvasElement, o: ExportOptions): HTMLCanvasElement {
  const out = document.createElement("canvas");
  const ctx = out.getContext("2d")!;
  const f = FRAMES.find((x) => x.id === o.frame) ?? FRAMES[0];
  if (f.id === "none") {
    out.width = src.width * o.scale;
    out.height = src.height * o.scale;
    ctx.imageSmoothingEnabled = !o.crisp && o.scale === 1 ? true : !o.crisp;
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }
  out.width = f.w;
  out.height = f.h;
  ctx.fillStyle = o.matte;
  ctx.fillRect(0, 0, f.w, f.h);
  const pad = Math.round(f.w * 0.06);
  const fitW = f.w - pad * 2;
  const fitH = f.h - pad * 2;
  let s = Math.min(fitW / src.width, fitH / src.height);
  // Pixel art: largest whole-number scale that fits, so pixels stay square.
  if (o.crisp && s >= 1) s = Math.floor(s);
  const dw = Math.round(src.width * s);
  const dh = Math.round(src.height * s);
  ctx.imageSmoothingEnabled = !o.crisp;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, Math.round((f.w - dw) / 2), Math.round((f.h - dh) / 2), dw, dh);
  return out;
}

export async function toBlob(canvas: HTMLCanvasElement, o: ExportOptions, code: string): Promise<Blob> {
  const type = o.format === "png" ? "image/png" : "image/jpeg";
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, 0.93)
  );
  return o.format === "png" ? embedRecipe(blob, code) : blob;
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
