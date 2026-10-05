// Screen, print and machine-vision effects that run on the finished canvas,
// after the film pass: CRT tube, thermal receipt, 1-bit dither and blob
// tracking. They work on whatever is below them, so they stack: Portra on a
// Trinitron, a datamosh printed on a receipt.

import { hash2 } from "./film";

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
  const cx = ctx2d(c);
  const out = cx.createImageData(w, h);
  const o = out.data;
  const at = (row: number, x: number, ch: number) => src[(row * w + Math.min(w - 1, Math.max(0, Math.round(x)))) * 4 + ch];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let u = ((x + 0.5) / w) * 2 - 1;
      let v = ((y + 0.5) / h) * 2 - 1;
      if (t.curve) {
        const cu = u * (1 + t.curve * v * v);
        const cv = v * (1 + t.curve * u * u);
        u = cu;
        v = cv;
      }
      o[i + 3] = 255;
      if (u <= -1 || u >= 1 || v <= -1 || v >= 1) {
        o[i] = o[i + 1] = o[i + 2] = 6; // bezel
        continue;
      }
      const sx = ((u + 1) / 2) * w;
      const sy = ((v + 1) / 2) * lines;
      const row = Math.min(lines - 1, sy | 0);
      const fr = sy - row;
      let r = at(row, sx + conv, 0);
      let g = at(row, sx, 1);
      let b = at(row, sx - conv, 2);
      if (ph) {
        const l = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
        r = l * ph[0];
        g = l * ph[1];
        b = l * ph[2];
      }
      const lum = Math.min(1, (r * 0.3 + g * 0.59 + b * 0.11) / 255);
      const wgt = beam[Math.round(lum * (LUMS - 1)) * PROF + Math.min(PROF - 1, (fr * PROF) | 0)];
      let mr = 1;
      let mg = 1;
      let mb = 1;
      if (t.mask !== "none") {
        // Smooth (cosine) phosphor stripes: no hard edges to alias into
        // rainbow bands when the picture is shown smaller than 1:1.
        const ph0 = ((x % P) / P) * 6.2832;
        mr = t.dark + (1 - t.dark) * (0.5 + 0.5 * Math.cos(ph0));
        mg = t.dark + (1 - t.dark) * (0.5 + 0.5 * Math.cos(ph0 - 2.0944));
        mb = t.dark + (1 - t.dark) * (0.5 + 0.5 * Math.cos(ph0 - 4.1888));
        if (t.mask === "slot") {
          const cell = (x / P) | 0;
          if ((y + (cell & 1) * P) % (P * 2) < Math.max(1, P * 0.3)) {
            mr *= t.dark;
            mg *= t.dark;
            mb *= t.dark;
          }
        }
      }
      const px = (1 - Math.abs(u)) * w * 0.5;
      const py = (1 - Math.abs(v)) * h * 0.5;
      const edge = Math.min(1, px / edgePx, py / edgePx);
      const vig = 1 - 0.22 * (u * u + v * v);
      const k = wgt * t.gain * vig * edge;
      o[i] = r * mr * k;
      o[i + 1] = g * mg * k;
      o[i + 2] = b * mb * k;
    }
  }
  cx.putImageData(out, 0, 0);
  // Bloom: the glass glows around bright phosphor.
  const bl = blurred(c, Math.max(3, Math.round(Math.min(w, h) / 70)));
  const img = cx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const a = d[i + ch];
      const s = bl[i + ch] * t.bloom * 1.6;
      d[i + ch] = 255 - ((255 - a) * (255 - Math.min(255, s))) / 255;
    }
  }
  cx.putImageData(img, 0, 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Blob tracking — the TouchDesigner machine-vision overlay: blobs found by a
// difference-of-Gaussians detector, boxed, numbered, joined to neighbours.
// ───────────────────────────────────────────────────────────────────────────

type Blob = { x: number; y: number; r: number; score: number };

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
  for (let si = 0; si < scales.length; si++) {
    for (let i = 0; i < best.length; i++) {
      const v = Math.abs(blur[si][i] - wide[si][i]) * Math.sqrt(scales[si]);
      if (v > best[i]) {
        best[i] = v;
        bestS[i] = si;
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
      if (peak) cand.push({ x, y, r: scales[bestS[i]] * 1.9 + 3, score: v * (0.55 + 0.9 * hash2(x, y, seed)) });
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

function blob(c: HTMLCanvasElement, p: FxParams, seed: number) {
  const { width: w, height: h } = c;
  const S = Math.min(w, h);
  const { blobs, sw } = findBlobs(c, seed);
  const k = w / sw;
  const boxes = blobs.map((b, i) => {
    const r = b.r * k;
    return { id: i + 1, x: b.x * k, y: b.y * k, x0: Math.max(0, b.x * k - r), y0: Math.max(0, b.y * k - r), s: r * 2 };
  });
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
    for (const b of boxes) cx.drawImage(orig, b.x0, b.y0, b.s, b.s, b.x0, b.y0, b.s, b.s);
  }
  cx.save();
  if (p.fxMode === "invert") {
    cx.globalCompositeOperation = "difference";
    cx.fillStyle = "#ffffff";
    for (const b of boxes) cx.fillRect(b.x0, b.y0, b.s, b.s);
    cx.globalCompositeOperation = "source-over";
  }
  const lw = Math.max(1, Math.round(S * 0.0022));
  // Each blob wired to its two nearest neighbours.
  cx.strokeStyle = "rgba(255,255,255,0.6)";
  cx.lineWidth = Math.max(1, lw * 0.6);
  const seen = new Set<string>();
  cx.beginPath();
  for (const a of boxes) {
    const near = boxes
      .filter((b) => b !== a)
      .sort((p1, p2) => Math.hypot(p1.x - a.x, p1.y - a.y) - Math.hypot(p2.x - a.x, p2.y - a.y))
      .slice(0, 2);
    for (const b of near) {
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cx.moveTo(a.x, a.y);
      cx.lineTo(b.x, b.y);
    }
  }
  cx.stroke();
  cx.strokeStyle = "#ffffff";
  cx.lineWidth = lw;
  for (const b of boxes) cx.strokeRect(Math.round(b.x0) + 0.5, Math.round(b.y0) + 0.5, Math.round(b.s), Math.round(b.s));
  cx.fillStyle = "#ffffff";
  const dotR = Math.max(1, lw * 1.2);
  for (const b of boxes) cx.fillRect(b.x - dotR, b.y - dotR, dotR * 2, dotR * 2);
  // Labels only where they'd be legible (not on thumbnails).
  if (p.fxLabels && S >= 360) {
    const size = Math.round(S * 0.02);
    cx.font = `600 ${size}px ${MONO}`;
    cx.textBaseline = "bottom";
    cx.shadowColor = "rgba(0,0,0,0.55)";
    cx.shadowBlur = size * 0.25;
    for (const b of boxes) {
      const label = `#${String(b.id).padStart(2, "0")}  ${(b.x / w).toFixed(3)} ${(b.y / h).toFixed(3)}`;
      const ty = b.y0 > size * 1.4 ? b.y0 - lw * 2 : b.y0 + b.s + size + lw * 2;
      cx.fillText(label, Math.min(b.x0, w - cx.measureText(label).width - 2), ty);
    }
  }
  cx.restore();
}

// ───────────────────────────────────────────────────────────────────────────

/** Run the layer's effect in place; `amount` < 1 mixes the original back in. */
export function applyFx(c: HTMLCanvasElement, p: FxParams, seed: number, amount: number, frame: boolean) {
  if (p.fx === "none" || amount <= 0) return;
  const cx = ctx2d(c);
  const before = amount < 0.999 ? cx.getImageData(0, 0, c.width, c.height) : null;
  if (p.fx === "crt") crt(c, p);
  else if (p.fx === "receipt") receipt(c, p, seed, frame);
  else if (p.fx === "onebit") oneBit(c, p);
  else if (p.fx === "blob") blob(c, p, seed);
  if (before) {
    const after = cx.getImageData(0, 0, c.width, c.height);
    const a = after.data;
    const b = before.data;
    for (let i = 0; i < a.length; i++) a[i] = b[i] + (a[i] - b[i]) * amount;
    cx.putImageData(after, 0, 0);
  }
}
