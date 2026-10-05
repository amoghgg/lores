// Screen, print and machine-vision effects that run on the finished canvas,
// after the film pass: CRT tube, thermal receipt, 1-bit dither and blob
// tracking. They work on whatever is below them, so they stack: Portra on a
// Trinitron, a datamosh printed on a receipt.

import { hash2 } from "./film";
import type { Thing } from "./detect";

export type FxKind = "none" | "crt" | "receipt" | "onebit" | "blob";

export type FxParams = {
  fx: FxKind;
  /** Variant: CRT tube, receipt age, dither algorithm or blob style. */
  fxMode: string;
  fxInk: string;
  fxPaper: string;
  /** Dots across (1-bit / receipt). */
  fxScale: number;
  /** Blob IDs and coordinates — off with the global text switch. */
  fxLabels: boolean;
};

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

type RGB = [number, number, number];

function hex(s: string): RGB {
  const n = parseInt(s.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement) {
  return c.getContext("2d", { willReadFrequently: true })!;
}

/** Cheap wide blur: shrink by `f`, grow back with smoothing. */
function blurred(src: HTMLCanvasElement, f: number): Uint8ClampedArray {
  const { width: w, height: h } = src;
  const s = canvas(Math.max(1, Math.round(w / f)), Math.max(1, Math.round(h / f)));
  const sc = s.getContext("2d")!;
  sc.imageSmoothingQuality = "high";
  sc.drawImage(src, 0, 0, s.width, s.height);
  const b = canvas(w, h);
  const bc = ctx2d(b);
  bc.imageSmoothingQuality = "high";
  bc.drawImage(s, 0, 0, w, h);
  return bc.getImageData(0, 0, w, h).data;
}

/** A region of `src` resampled to cols×rows, as 0..1 luminance. */
function lumaGrid(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number, cols: number, rows: number) {
  const c = canvas(cols, rows);
  const cx = ctx2d(c);
  cx.imageSmoothingQuality = "high";
  cx.drawImage(src, sx, sy, sw, sh, 0, 0, cols, rows);
  const d = cx.getImageData(0, 0, cols, rows).data;
  const L = new Float32Array(cols * rows);
  for (let i = 0; i < L.length; i++) L[i] = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
  return L;
}

/** Stretch the 1st–99th percentile to 0..1, then a gamma. */
function levels(L: Float32Array, gamma: number) {
  const hist = new Uint32Array(256);
  for (const v of L) hist[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
  const lo = pct(hist, L.length * 0.01);
  const hi = Math.max(lo + 8, pct(hist, L.length * 0.99));
  for (let i = 0; i < L.length; i++) {
    const v = Math.min(1, Math.max(0, (L[i] * 255 - lo) / (hi - lo)));
    L[i] = Math.pow(v, gamma);
  }
}

function pct(hist: Uint32Array, n: number) {
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= n) return i;
  }
  return 255;
}

// ───────────────────────────────────────────────────────────────────────────
// 1-bit dithering — the grid is 1 where ink goes down.
// ───────────────────────────────────────────────────────────────────────────

const BAYER8 = (() => {
  const m = [0];
  let n = 1;
  let cur = m;
  while (n < 8) {
    const next = new Array(4 * n * n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const v = cur[y * n + x] * 4;
        next[y * 2 * n + x] = v;
        next[y * 2 * n + x + n] = v + 2;
        next[(y + n) * 2 * n + x] = v + 3;
        next[(y + n) * 2 * n + x + n] = v + 1;
      }
    cur = next;
    n *= 2;
  }
  return cur.map((v: number) => (v + 0.5) / 64);
})();

let blueTile: Float32Array | null = null;
/**
 * 64×64 blue-noise threshold tile, made once: points are added one at a time
 * into the emptiest spot (lowest Gaussian energy on a torus), and the order
 * they went in is the threshold — the void-and-cluster idea.
 */
function blueNoise(): Float32Array {
  if (blueTile) return blueTile;
  const N = 64;
  const T = N * N;
  const energy = new Float32Array(T);
  const rank = new Float32Array(T);
  const taken = new Uint8Array(T);
  const R = 5;
  const kern: number[] = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) kern.push(Math.exp(-(dx * dx + dy * dy) / (2 * 1.6 * 1.6)));
  let p = (hash2(7, 11, 3) * T) | 0;
  for (let k = 0; k < T; k++) {
    taken[p] = 1;
    rank[p] = (k + 0.5) / T;
    const px = p % N;
    const py = (p / N) | 0;
    let ki = 0;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) energy[((py + dy + N) % N) * N + ((px + dx + N) % N)] += kern[ki++];
    let best = Infinity;
    for (let i = 0; i < T; i++) {
      if (!taken[i] && energy[i] < best) {
        best = energy[i];
        p = i;
      }
    }
  }
  blueTile = rank;
  return rank;
}

function dither(L: Float32Array, cols: number, rows: number, algo: string): Uint8Array {
  const bits = new Uint8Array(cols * rows);
  if (algo === "bayer" || algo === "blue") {
    const tile = algo === "blue" ? blueNoise() : Float32Array.from(BAYER8);
    const n = algo === "blue" ? 64 : 8;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        bits[i] = L[i] < tile[(y % n) * n + (x % n)] ? 1 : 0;
      }
    return bits;
  }
  const e = Float32Array.from(L);
  const atk = algo === "atkinson";
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const v = e[i];
      const on = v < 0.5;
      bits[i] = on ? 1 : 0;
      const err = v - (on ? 0 : 1);
      const add = (dx: number, dy: number, k: number) => {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < cols && yy < rows) e[yy * cols + xx] += err * k;
      };
      if (atk) {
        // Bill Atkinson's 1984 Mac kernel: only 3/4 of the error moves on,
        // which keeps highlights and shadows clean.
        const k = 1 / 8;
        add(1, 0, k);
        add(2, 0, k);
        add(-1, 1, k);
        add(0, 1, k);
        add(1, 1, k);
        add(0, 2, k);
      } else {
        add(1, 0, 7 / 16);
        add(-1, 1, 3 / 16);
        add(0, 1, 5 / 16);
        add(1, 1, 1 / 16);
      }
    }
  return bits;
}

/** Sharpen a luminance grid a little before dithering, so edges survive. */
function unsharp(L: Float32Array, cols: number, rows: number, k: number) {
  const out = new Float32Array(L.length);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const l = x > 0 ? L[i - 1] : L[i];
      const r = x < cols - 1 ? L[i + 1] : L[i];
      const u = y > 0 ? L[i - cols] : L[i];
      const d = y < rows - 1 ? L[i + cols] : L[i];
      out[i] = Math.min(1, Math.max(0, L[i] + k * (L[i] - (l + r + u + d) / 4)));
    }
  return out;
}

function oneBit(c: HTMLCanvasElement, p: FxParams) {
  const { width: w, height: h } = c;
  const cols = Math.max(8, Math.min(w, Math.round(p.fxScale)));
  const rows = Math.max(8, Math.round((h * cols) / w));
  let L = lumaGrid(c, 0, 0, w, h, cols, rows);
  levels(L, 0.9);
  L = unsharp(L, cols, rows, 0.6);
  const bits = dither(L, cols, rows, p.fxMode);
  const ink = hex(p.fxInk);
  const paper = hex(p.fxPaper);
  const cx = ctx2d(c);
  const out = cx.createImageData(w, h);
  const o = out.data;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(rows - 1, ((y * rows) / h) | 0);
    for (let x = 0; x < w; x++) {
      const col = bits[gy * cols + Math.min(cols - 1, ((x * cols) / w) | 0)] ? ink : paper;
      const i = (y * w + x) * 4;
      o[i] = col[0];
      o[i + 1] = col[1];
      o[i + 2] = col[2];
      o[i + 3] = 255;
    }
  }
  cx.putImageData(out, 0, 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Thermal receipt — a 58 mm printer: 384 dots across at 8 dots/mm (203 dpi),
// unprintable margins, a print head with tired elements, serrated tear.
// ───────────────────────────────────────────────────────────────────────────

function receipt(c: HTMLCanvasElement, p: FxParams, seed: number, frame: boolean) {
  const { width: w, height: h } = c;
  const faded = p.fxMode === "faded";
  const margin = Math.round(w * 0.055);
  const pw = w - margin * 2;
  const cols = Math.max(8, Math.min(pw, Math.round(p.fxScale)));
  const dot = pw / cols;
  const rows = Math.max(8, Math.round(h / dot));
  let L = lumaGrid(c, margin, 0, pw, h, cols, rows);
  // Thermal paper prints dark: open the mids up before dithering.
  levels(L, faded ? 0.75 : 0.7);
  L = unsharp(L, cols, rows, 0.8);
  const bits = dither(L, cols, rows, p.fxMode === "faded" ? "atkinson" : "floyd");
  const ink = hex(p.fxInk);
  const paper = hex(p.fxPaper);
  // Some heating elements are weak — light vertical streaks down the roll.
  const colK = new Float32Array(cols);
  for (let x = 0; x < cols; x++) {
    const r = hash2(x, 3, seed);
    colK[x] = r < 0.008 ? 0.45 + r * 30 : 0.94 + hash2(x, 4, seed) * 0.06;
  }
  // Heat drifts as the roll feeds: slow bands of lighter and darker print.
  const rowK = new Float32Array(rows);
  for (let y = 0; y < rows; y++) {
    const t = y / rows;
    rowK[y] = (faded ? 0.84 : 0.95) + (faded ? 0.12 : 0.05) * Math.sin(t * 9.3 + seed) * Math.sin(t * 3.1 + seed * 0.7);
  }
  const tooth = Math.max(3, Math.round(Math.min(w, h) * 0.014));
  const table: RGB = [28, 27, 26];
  const cx = ctx2d(c);
  const out = cx.createImageData(w, h);
  const o = out.data;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(rows - 1, (y / dot) | 0);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Serrated cutter edge, top and bottom.
      if (frame) {
        const saw = Math.abs(((x / tooth) % 2) - 1) * tooth;
        if (y < saw * 0.9 || h - 1 - y < saw * 0.9) {
          o[i] = table[0];
          o[i + 1] = table[1];
          o[i + 2] = table[2];
          o[i + 3] = 255;
          continue;
        }
      }
      const grain = (hash2(x, y, seed + 17) - 0.5) * (faded ? 10 : 6);
      let r = paper[0] + grain;
      let g = paper[1] + grain;
      let b = paper[2] + grain;
      if (x >= margin && x < margin + pw) {
        const gx = Math.min(cols - 1, ((x - margin) / dot) | 0);
        if (bits[gy * cols + gx]) {
          const drop = faded && hash2(gx, gy, seed + 5) < 0.035;
          const k = drop ? 0 : colK[gx] * rowK[gy];
          r += (ink[0] - r) * k;
          g += (ink[1] - g) * k;
          b += (ink[2] - b) * k;
        }
      }
      o[i] = r;
      o[i + 1] = g;
      o[i + 2] = b;
      o[i + 3] = 255;
    }
  }
  cx.putImageData(out, 0, 0);
}

// ───────────────────────────────────────────────────────────────────────────
// CRT — curved glass, one beam per scanline that fattens on bright lines,
// a phosphor mask (aperture grille or slot), convergence error and bloom.
// ───────────────────────────────────────────────────────────────────────────

type Tube = {
  lines: number;
  curve: number;
  mask: "grille" | "slot" | "none";
  dark: number;
  phosphor?: string;
  bloom: number;
  gain: number;
  conv: number;
};

const TUBES: Record<string, Tube> = {
  trinitron: { lines: 300, curve: 0.04, mask: "grille", dark: 0.55, bloom: 0.3, gain: 1.75, conv: 0.4 },
  pvm: { lines: 480, curve: 0.012, mask: "grille", dark: 0.62, bloom: 0.16, gain: 1.6, conv: 0.15 },
  arcade: { lines: 224, curve: 0.08, mask: "slot", dark: 0.5, bloom: 0.42, gain: 1.95, conv: 0.9 },
  amber: { lines: 260, curve: 0.05, mask: "none", dark: 1, phosphor: "#ffb000", bloom: 0.5, gain: 1.45, conv: 0 },
  green: { lines: 260, curve: 0.05, mask: "none", dark: 1, phosphor: "#41ff6a", bloom: 0.5, gain: 1.45, conv: 0 },
};

function crt(c: HTMLCanvasElement, p: FxParams) {
  const t = TUBES[p.fxMode] ?? TUBES.trinitron;
  const { width: w, height: h } = c;
  const lines = Math.max(24, Math.min(t.lines, Math.floor(h / 2.4)));
  const lineH = h / lines;
  // Each scanline carries one row of picture.
  const rc = canvas(w, lines);
  const rx = ctx2d(rc);
  rx.imageSmoothingQuality = "high";
  rx.drawImage(c, 0, 0, w, lines);
  const src = rx.getImageData(0, 0, w, lines).data;
  const ph = t.phosphor ? hex(t.phosphor) : null;
  // Phosphor triad width — a multiple of 3 so R, G and B get equal stripes.
  const P = Math.max(3, Math.round((lineH * 0.9) / 3) * 3);
  const conv = t.conv * lineH * 0.35;
  const edgePx = Math.max(2, Math.min(w, h) * 0.012);
  // Beam profile: Gaussian across the line, wider when the line is bright.
  const PROF = 32;
  const LUMS = 16;
  const beam = new Float32Array(PROF * LUMS);
  for (let li = 0; li < LUMS; li++) {
    const sig = 0.26 + 0.2 * (li / (LUMS - 1));
    for (let k = 0; k < PROF; k++) {
      const d = (k + 0.5) / PROF - 0.5;
      beam[li * PROF + k] = Math.exp(-(d * d) / (2 * sig * sig));
    }
  }
  // Everything that depends only on the column or the row is computed once
  // (the per-pixel cosines were most of the cost on phones).
  const mR = new Float32Array(w).fill(1);
  const mG = new Float32Array(w).fill(1);
  const mB = new Float32Array(w).fill(1);
  if (t.mask !== "none") {
    // Smooth (cosine) phosphor stripes: no hard edges to alias into rainbow
    // bands when the picture is shown smaller than 1:1.
    for (let x = 0; x < w; x++) {
      const a = ((x % P) / P) * 6.2832;
      mR[x] = t.dark + (1 - t.dark) * (0.5 + 0.5 * Math.cos(a));
      mG[x] = t.dark + (1 - t.dark) * (0.5 + 0.5 * Math.cos(a - 2.0944));
      mB[x] = t.dark + (1 - t.dark) * (0.5 + 0.5 * Math.cos(a - 4.1888));
    }
  }
  const U = new Float32Array(w);
  for (let x = 0; x < w; x++) U[x] = ((x + 0.5) / w) * 2 - 1;
  const slot = t.mask === "slot";
  const slotGap = Math.max(1, P * 0.3);
  const curve = t.curve;
  const gain = t.gain;
  const pr = ph ? ph[0] / 255 : 0;
  const pg = ph ? ph[1] / 255 : 0;
  const pb = ph ? ph[2] / 255 : 0;
  const cx = ctx2d(c);
  const out = cx.createImageData(w, h);
  const o = out.data;
  const wm1 = w - 1;
  for (let y = 0; y < h; y++) {
    const v0 = ((y + 0.5) / h) * 2 - 1;
    const v0sq = v0 * v0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const u0 = U[x];
      const u = curve ? u0 * (1 + curve * v0sq) : u0;
      const v = curve ? v0 * (1 + curve * u0 * u0) : v0;
      o[i + 3] = 255;
      if (u <= -1 || u >= 1 || v <= -1 || v >= 1) {
        o[i] = o[i + 1] = o[i + 2] = 6; // bezel
        continue;
      }
      const sx = (u + 1) * 0.5 * w;
      const sy = (v + 1) * 0.5 * lines;
      const row = sy < lines - 1 ? sy | 0 : lines - 1;
      const fr = sy - row;
      const base = row * w;
      let xr = (sx + conv + 0.5) | 0;
      let xb = (sx - conv + 0.5) | 0;
      let xg = (sx + 0.5) | 0;
      xr = xr < 0 ? 0 : xr > wm1 ? wm1 : xr;
      xg = xg < 0 ? 0 : xg > wm1 ? wm1 : xg;
      xb = xb < 0 ? 0 : xb > wm1 ? wm1 : xb;
      let r = src[(base + xr) * 4];
      let g = src[(base + xg) * 4 + 1];
      let b = src[(base + xb) * 4 + 2];
      let lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
      if (ph) {
        r = lum * 255 * pr;
        g = lum * 255 * pg;
        b = lum * 255 * pb;
        lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
      }
      if (lum > 1) lum = 1;
      const fi = (fr * PROF) | 0;
      const wgt = beam[((lum * (LUMS - 1) + 0.5) | 0) * PROF + (fi < PROF ? fi : PROF - 1)];
      let mr = mR[x];
      let mg = mG[x];
      let mb = mB[x];
      if (slot && (y + (((x / P) | 0) & 1) * P) % (P * 2) < slotGap) {
        mr *= t.dark;
        mg *= t.dark;
        mb *= t.dark;
      }
      const au = u < 0 ? -u : u;
      const av = v < 0 ? -v : v;
      const ex = ((1 - au) * w * 0.5) / edgePx;
      const ey = ((1 - av) * h * 0.5) / edgePx;
      const edge = ex < ey ? (ex < 1 ? ex : 1) : ey < 1 ? ey : 1;
      const k = wgt * gain * (1 - 0.22 * (u * u + v * v)) * edge;
      o[i] = r * mr * k;
      o[i + 1] = g * mg * k;
      o[i + 2] = b * mb * k;
    }
  }
  cx.putImageData(out, 0, 0);
  // Bloom: the glass glows around bright phosphor. `o` already holds what's
  // on the canvas, so no second read-back.
  const bl = blurred(c, Math.max(3, Math.round(Math.min(w, h) / 70)));
  const kb = t.bloom * 1.6;
  for (let i = 0; i < o.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const sv = bl[i + ch] * kb;
      o[i + ch] = 255 - ((255 - o[i + ch]) * (255 - (sv > 255 ? 255 : sv))) / 255;
    }
  }
  cx.putImageData(out, 0, 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Blob tracking — the TouchDesigner machine-vision overlay: blobs found by a
// difference-of-Gaussians detector, boxed, numbered, joined to neighbours.
// ───────────────────────────────────────────────────────────────────────────

type Blob = { x: number; y: number; r: number; score: number; bright: boolean };

function boxBlurF(a: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return a;
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / d;
      acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / d;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function findBlobs(c: HTMLCanvasElement, seed: number): { blobs: Blob[]; sw: number; sh: number } {
  const long = 220;
  const k = long / Math.max(c.width, c.height);
  const sw = Math.max(16, Math.round(c.width * k));
  const sh = Math.max(16, Math.round(c.height * k));
  const L = lumaGrid(c, 0, 0, c.width, c.height, sw, sh);
  const scales = [2, 3, 5, 8, 12];
  const blur = scales.map((s) => boxBlurF(boxBlurF(L, sw, sh, s), sw, sh, s));
  const wide = scales.map((s) => boxBlurF(boxBlurF(L, sw, sh, Math.round(s * 1.8)), sw, sh, Math.round(s * 1.8)));
  const best = new Float32Array(sw * sh);
  const bestS = new Uint8Array(sw * sh);
  const bright = new Uint8Array(sw * sh);
  for (let si = 0; si < scales.length; si++) {
    for (let i = 0; i < best.length; i++) {
      const v = Math.abs(blur[si][i] - wide[si][i]) * Math.sqrt(scales[si]);
      if (v > best[i]) {
        best[i] = v;
        bestS[i] = si;
        bright[i] = blur[si][i] > wide[si][i] ? 1 : 0;
      }
    }
  }
  const cand: Blob[] = [];
  const m = 3;
  for (let y = m; y < sh - m; y++)
    for (let x = m; x < sw - m; x++) {
      const i = y * sw + x;
      const v = best[i];
      if (v < 0.02) continue;
      let peak = true;
      for (let dy = -2; dy <= 2 && peak; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if ((dx || dy) && best[i + dy * sw + dx] > v) {
            peak = false;
            break;
          }
      if (peak) cand.push({ x, y, r: scales[bestS[i]] * 1.9 + 3, score: v * (0.55 + 0.9 * hash2(x, y, seed)), bright: !!bright[i] });
    }
  cand.sort((a, b) => b.score - a.score);
  const want = 9 + Math.floor(hash2(seed, 1, 99) * 6);
  const minD = long * 0.07;
  const blobs: Blob[] = [];
  for (const b of cand) {
    if (blobs.length >= want) break;
    if (blobs.every((o) => Math.hypot(o.x - b.x, o.y - b.y) > Math.max(minD, (o.r + b.r) * 0.8))) blobs.push(b);
  }
  return { blobs, sw, sh };
}

type Tracked = { id: number; fixed?: boolean; label: string; kind: Thing["kind"] | "spot"; x0: number; y0: number; bw: number; bh: number; cx: number; cy: number };

function blob(c: HTMLCanvasElement, p: FxParams, seed: number, things: Thing[] | undefined) {
  const { width: w, height: h } = c;
  const S = Math.min(w, h);
  const boxes: Tracked[] = [];
  // What the detectors actually recognised, with their own labels and scores.
  for (const t of things ?? []) {
    const x0 = Math.max(0, t.x * w);
    const y0 = Math.max(0, t.y * h);
    const bw = Math.min(w - x0, t.w * w);
    const bh = Math.min(h - y0, t.h * h);
    if (bw < 2 || bh < 2) continue;
    const label = t.kind === "part" ? t.label : `${t.label} ${t.score.toFixed(2)}`;
    boxes.push({ id: t.id ?? 0, fixed: t.id !== undefined, label, kind: t.kind, x0, y0, bw, bh, cx: x0 + bw / 2, cy: y0 + bh / 2 });
  }
  // Nothing recognised (a landscape, an abstract): mark the strongest bright
  // and dark spots — and call them exactly that.
  if (!boxes.length) {
    const { blobs, sw } = findBlobs(c, seed);
    const k = w / sw;
    for (const b of blobs.slice(0, 8)) {
      const r = b.r * k;
      const x0 = Math.max(0, b.x * k - r);
      const y0 = Math.max(0, b.y * k - r);
      boxes.push({ id: 0, label: b.bright ? "BRIGHT SPOT" : "DARK SPOT", kind: "spot", x0, y0, bw: r * 2, bh: r * 2, cx: b.x * k, cy: b.y * k });
    }
  }
  boxes.forEach((b, i) => {
    if (!b.fixed) b.id = i + 1;
  });
  const main = boxes.filter((b) => b.kind !== "part");
  const cx = ctx2d(c);
  if (p.fxMode === "mono") {
    // Everything drops to dim grey; only what the tracker locked on keeps colour.
    const orig = canvas(w, h);
    orig.getContext("2d")!.drawImage(c, 0, 0);
    const img = cx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) * 0.5;
      d[i] = d[i + 1] = d[i + 2] = l;
    }
    cx.putImageData(img, 0, 0);
    for (const b of main) cx.drawImage(orig, b.x0, b.y0, b.bw, b.bh, b.x0, b.y0, b.bw, b.bh);
  }
  cx.save();
  if (p.fxMode === "invert") {
    // Invert the union of the boxes (nested boxes would otherwise flip back).
    const mask = canvas(w, h);
    const mx = mask.getContext("2d")!;
    mx.fillStyle = "#ffffff";
    for (const b of main) mx.fillRect(b.x0, b.y0, b.bw, b.bh);
    cx.globalCompositeOperation = "difference";
    cx.drawImage(mask, 0, 0);
    cx.globalCompositeOperation = "source-over";
  }
  const lw = Math.max(1, Math.round(S * 0.0022));
  // Things wired to their two nearest neighbours; face parts to their face.
  cx.strokeStyle = "rgba(255,255,255,0.6)";
  cx.lineWidth = Math.max(1, lw * 0.6);
  const seen = new Set<string>();
  cx.beginPath();
  for (const a of main) {
    const near = main
      .filter((b) => b !== a)
      .sort((p1, p2) => Math.hypot(p1.cx - a.cx, p1.cy - a.cy) - Math.hypot(p2.cx - a.cx, p2.cy - a.cy))
      .slice(0, 2);
    for (const b of near) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cx.moveTo(a.cx, a.cy);
      cx.lineTo(b.cx, b.cy);
    }
  }
  const faces = boxes.filter((b) => b.kind === "face");
  for (const part of boxes.filter((b) => b.kind === "part")) {
    const f = faces.find((fc) => part.cx >= fc.x0 - fc.bw * 0.3 && part.cx <= fc.x0 + fc.bw * 1.3 && part.cy >= fc.y0 - fc.bh * 0.3 && part.cy <= fc.y0 + fc.bh * 1.3);
    if (!f) continue;
    cx.moveTo(f.cx, f.cy);
    cx.lineTo(part.cx, part.cy);
  }
  cx.stroke();
  cx.strokeStyle = "#ffffff";
  for (const b of boxes) {
    cx.lineWidth = b.kind === "part" ? Math.max(1, lw * 0.7) : lw;
    cx.strokeRect(Math.round(b.x0) + 0.5, Math.round(b.y0) + 0.5, Math.round(b.bw), Math.round(b.bh));
  }
  cx.fillStyle = "#ffffff";
  const dotR = Math.max(1, lw * 1.2);
  for (const b of main) cx.fillRect(b.cx - dotR, b.cy - dotR, dotR * 2, dotR * 2);
  // Labels only where they'd be legible (not on thumbnails).
  if (p.fxLabels && S >= 360) {
    const size = Math.round(S * 0.02);
    cx.textBaseline = "bottom";
    cx.shadowColor = "rgba(0,0,0,0.6)";
    cx.shadowBlur = size * 0.25;
    // Place each label above its box, else below, else just inside — the
    // first spot that doesn't collide with a label already drawn.
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const hits = (r: { x: number; y: number; w: number; h: number }) =>
      placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
    for (const b of boxes) {
      const part = b.kind === "part";
      const fs = part ? Math.round(size * 0.75) : size;
      cx.font = `600 ${fs}px ${MONO}`;
      const label = part ? b.label : `#${String(b.id).padStart(2, "0")} ${b.label}`;
      const tw = cx.measureText(label).width;
      const tx = Math.max(2, Math.min(b.x0, w - tw - 2));
      const ys = [b.y0 - lw * 2, b.y0 + b.bh + fs + lw * 2, b.y0 + fs + lw * 3, b.y0 - lw * 2 - fs * 1.1, b.y0 + b.bh + fs * 2.2];
      const fits = ys.filter((y) => y - fs >= 0 && y <= h);
      const y = fits.find((yy) => !hits({ x: tx, y: yy - fs, w: tw, h: fs })) ?? fits[0] ?? ys[0];
      placed.push({ x: tx, y: y - fs, w: tw, h: fs });
      cx.fillText(label, tx, y);
    }
  }
  cx.restore();
}

// ───────────────────────────────────────────────────────────────────────────

/** Run the layer's effect in place; `amount` < 1 mixes the original back in. */
export function applyFx(
  c: HTMLCanvasElement,
  p: FxParams,
  seed: number,
  amount: number,
  frame: boolean,
  /** What's in the picture (blob tracking labels real things). */
  things?: Thing[]
) {
  if (p.fx === "none" || amount <= 0) return;
  const cx = ctx2d(c);
  const before = amount < 0.999 ? cx.getImageData(0, 0, c.width, c.height) : null;
  if (p.fx === "crt") crt(c, p);
  else if (p.fx === "receipt") receipt(c, p, seed, frame);
  else if (p.fx === "onebit") oneBit(c, p);
  else if (p.fx === "blob") blob(c, p, seed, things);
  if (before) {
    const after = cx.getImageData(0, 0, c.width, c.height);
    const a = after.data;
    const b = before.data;
    for (let i = 0; i < a.length; i++) a[i] = b[i] + (a[i] - b[i]) * amount;
    cx.putImageData(after, 0, 0);
  }
}
