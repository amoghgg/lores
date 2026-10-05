// After the GPU pass: overlays a real camera / deck would burn into the frame,
// then real JPEG re-encodes for the crunchy looks. Canvas 2D, so the type and
// the compression artefacts are the genuine article.

import { hash2, type FilmControls, type FilmRecipe } from "./film";
import { applyFx } from "./fx";
import type { Thing } from "./detect";

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

function stamp(seed: number, time = 0) {
  const yy = 2000 + Math.floor(hash2(seed, 1, 81) * 9);
  const mo = 1 + Math.floor(hash2(seed, 2, 82) * 12);
  const dd = 1 + Math.floor(hash2(seed, 3, 83) * 28);
  const hh = Math.floor(hash2(seed, 4, 84) * 5) + 1;
  const mm = Math.floor(hash2(seed, 5, 85) * 60);
  // Video: the clock runs with the footage.
  const t0 = Math.floor(hash2(seed, 4, 84) * 5 + 1) * 3600 + Math.floor(hash2(seed, 5, 85) * 60) * 60 + Math.floor(hash2(seed, 6, 86) * 60) + Math.floor(time);
  const hh2 = Math.floor(t0 / 3600) % 24;
  return { yy, mo, dd, hh: time ? hh2 : hh, mm: Math.floor(t0 / 60) % 60, ss: t0 % 60 };
}

const MONTHS = ["JAN.", "FEB.", "MAR.", "APR.", "MAY", "JUN.", "JUL.", "AUG.", "SEP.", "OCT.", "NOV.", "DEC."];

function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number, kind: FilmRecipe["hud"], seed: number, time = 0) {
  const s = Math.min(w, h);
  const t = stamp(seed, time);
  ctx.save();
  ctx.textBaseline = "top";
  if (kind === "rec" || kind === "vhs") {
    const size = Math.max(9, Math.round(s * 0.045));
    ctx.font = `700 ${size}px ${MONO}`;
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = size * 0.15;
    const ink = kind === "rec" ? "#e4ffd9" : "#f2f2f2";
    ctx.fillStyle = ink;
    const m = s * 0.05;
    if (kind === "rec") {
      ctx.fillStyle = "#ff3b30";
      ctx.beginPath();
      ctx.arc(m + size * 0.35, m + size * 0.52, size * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.fillText("REC", m + size * 0.85, m);
      ctx.textAlign = "right";
      ctx.fillText("NIGHTSHOT", w - m, m);
      ctx.textBaseline = "bottom";
      ctx.fillText(`${t.hh % 3}:${pad(t.mm)}:${pad(t.ss)}`, w - m, h - m);
    } else {
      ctx.fillText("PLAY ▶", m, m);
      ctx.textBaseline = "bottom";
      ctx.fillText(`${MONTHS[t.mo - 1]} ${pad(t.dd)} ${t.yy}`, m, h - m - size * 1.15);
      ctx.fillText(` ${t.hh}:${pad(t.mm)} AM`, m, h - m);
    }
  } else if (kind === "trail") {
    const bar = Math.round(s * 0.075);
    ctx.fillStyle = "#060606";
    ctx.fillRect(0, h - bar, w, bar);
    const size = Math.max(8, Math.round(bar * 0.42));
    ctx.font = `600 ${size}px ${MONO}`;
    ctx.fillStyle = "#ececec";
    ctx.textBaseline = "middle";
    const moon = 20 + Math.floor(hash2(seed, 7, 87) * 80);
    const tf = 38 + Math.floor(hash2(seed, 8, 88) * 30);
    const tc = Math.round(((tf - 32) * 5) / 9);
    ctx.fillText(
      `CAM ${pad(1 + Math.floor(hash2(seed, 9, 89) * 8))}   ◐ ${moon}%   ${tf}°F ${tc}°C   ${pad(t.mo)}/${pad(t.dd)}/${t.yy}  ${pad(t.hh)}:${pad(t.mm)}:${pad(t.ss)}`,
      s * 0.025,
      h - bar / 2
    );
  } else if (kind === "thermal") {
    const size = Math.max(9, Math.round(s * 0.042));
    ctx.font = `700 ${size}px ${MONO}`;
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = size * 0.2;
    ctx.textAlign = "right";
    const temp = (35.5 + hash2(seed, 10, 90) * 2.5).toFixed(1);
    ctx.fillText(`${temp}°C`, w - s * 0.05, s * 0.05);
    // Centre crosshair, like a FLIR spot meter.
    const cx = w / 2;
    const cy = h / 2;
    const r = s * 0.035;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, s * 0.003);
    ctx.beginPath();
    ctx.moveTo(cx - r * 1.6, cy);
    ctx.lineTo(cx - r * 0.5, cy);
    ctx.moveTo(cx + r * 0.5, cy);
    ctx.lineTo(cx + r * 1.6, cy);
    ctx.moveTo(cx, cy - r * 1.6);
    ctx.lineTo(cx, cy - r * 0.5);
    ctx.moveTo(cx, cy + r * 0.5);
    ctx.lineTo(cx, cy + r * 1.6);
    ctx.stroke();
  } else if (kind === "witch") {
    const tri = s * 0.11;
    const cx = w / 2;
    const top = s * 0.07;
    ctx.strokeStyle = "rgba(240,240,248,0.92)";
    ctx.lineWidth = Math.max(1.5, s * 0.005);
    ctx.beginPath();
    ctx.moveTo(cx, top);
    ctx.lineTo(cx - tri, top + tri * 1.6);
    ctx.lineTo(cx + tri, top + tri * 1.6);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

async function jpegPass(canvas: HTMLCanvasElement, quality: number) {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
  if (!blob) return;
  const bmp = await createImageBitmap(blob);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
}

export function needsPost(r: FilmRecipe): boolean {
  return r.hud !== "none" || r.crunch > 0 || r.fx !== "none";
}

/** Overlays, then real JPEG re-encodes. Mutates and returns `canvas`. */
export async function postFilm(
  canvas: HTMLCanvasElement,
  r: FilmRecipe,
  c: Pick<FilmControls, "seed" | "amount" | "frame">,
  things?: Thing[],
  /** Seconds into a video (photos: 0). */
  time = 0
) {
  const seed = c.seed;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  if (r.fx !== "none") applyFx(canvas, r, seed, c.amount, c.frame, things);
  if (r.hud !== "none") drawHud(ctx, canvas.width, canvas.height, r.hud, seed, time);
  if (r.crunch > 0) {
    // 1 → three passes at very low quality (deep-fried); 0.5 → one mid pass (digicam).
    const passes = r.crunch > 0.7 ? 3 : 1;
    const q = Math.max(0.04, 0.62 - r.crunch * 0.55);
    for (let i = 0; i < passes; i++) await jpegPass(canvas, q);
  }
  return canvas;
}
