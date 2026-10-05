// Source restyling that can't be a per-pixel shader: the PS2 low-poly
// airbrush ("sharp blurriness" — hard polygon edges, soft insides), a sticker
// cut-out, and an oil impasto. Runs on the CPU at a working resolution, is
// cached per (source, look), and hands a restyled bitmap to the normal
// pipeline — so grain, the PIXEL tab and saving all still apply on top.

import type { FilmRecipe } from "./film";
import { markReady } from "./models";

export type StylizeKind = FilmRecipe["stylize"];

type Src = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

const WORK_LONG = 960; // working resolution — the look is soft, this is plenty
const GRID_LONG = 200; // region analysis resolution — big facets, like a real low-poly model

// ───────────────────────────────────────────────────────────────────────────
// Person segmentation (MediaPipe selfie segmenter, Apache-2.0, self-hosted)
// ───────────────────────────────────────────────────────────────────────────

type Segmenter = {
  segment: (img: HTMLCanvasElement) => {
    confidenceMasks?: { getAsFloat32Array(): Float32Array; width: number; height: number }[];
    close(): void;
  };
};

let segmenterPromise: Promise<Segmenter | null> | null = null;
let segQueue: Promise<unknown> = Promise.resolve();

function getSegmenter(): Promise<Segmenter | null> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      try {
        const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
        const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        const seg = await ImageSegmenter.createFromOptions(files, {
          baseOptions: { modelAssetPath: "/mediapipe/selfie_segmenter.tflite", delegate: "CPU" },
          runningMode: "IMAGE",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        markReady("segment");
        return seg as unknown as Segmenter;
      } catch (err) {
        // Flag and carry on: cut-out looks fall back to the full frame.
        console.warn("[pixel] segmenter unavailable — cut-out looks use the full frame", err);
        return null;
      }
    })();
  }
  return segmenterPromise;
}

/** Person mask at the canvas size (1 = person), or null if none was found. */
async function personMask(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const seg = await getSegmenter();
  if (!seg) return null;
  // The segmenter isn't re-entrant: serialise calls.
  const run = segQueue.then(() => {
    const res = seg.segment(canvas);
    const cm = res.confidenceMasks?.[0];
    const conf = cm ? cm.getAsFloat32Array().slice() : null;
    const mw = cm?.width ?? 0;
    const mh = cm?.height ?? 0;
    res.close();
    return { conf, mw, mh };
  });
  segQueue = run.catch(() => undefined);
  const { conf, mw, mh } = await run;
  if (!conf || mw !== canvas.width || mh !== canvas.height) return null;
  const w = canvas.width;
  const h = canvas.height;
  const soft = boxBlur1(conf, w, h, 2);
  const m = new Uint8Array(w * h);
  let on = 0;
  for (let i = 0; i < m.length; i++) {
    if (soft[i] > 0.5) {
      m[i] = 1;
      on++;
    }
  }
  // A "person" filling nearly the whole frame (drawings, close textures) or
  // barely any of it isn't a cut-out we can use — fall back to full frame.
  return on > m.length * 0.005 && on < m.length * 0.85 ? m : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────────────

function draw(src: Src, w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return { canvas: c, ctx, data: ctx.getImageData(0, 0, w, h).data };
}

function srcSize(src: Src) {
  return "naturalWidth" in src ? [src.naturalWidth, src.naturalHeight] : [src.width, src.height];
}

/** Separable running-sum box blur of one float channel (radius r). */
function boxBlur1(a: Float32Array, w: number, h: number, r: number): Float32Array {
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

/** Three box passes ≈ a Gaussian of `sigma`. */
function gauss1(a: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round(sigma * 0.95));
  return boxBlur1(boxBlur1(boxBlur1(a, w, h, r), w, h, r), w, h, r);
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// sRGB → CIE Lab (D65), enough precision for clustering.
function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// ───────────────────────────────────────────────────────────────────────────
// Regions → polygons
// ───────────────────────────────────────────────────────────────────────────

/** Edge-preserving smoothing + k-means in Lab on a small grid → label map. */
function regionLabels(src: Src, gw: number, gh: number, k: number, seed: number): Uint8Array {
  const { data } = draw(src, gw, gh);
  const n = gw * gh;
  let px = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    px[i * 3] = data[i * 4];
    px[i * 3 + 1] = data[i * 4 + 1];
    px[i * 3 + 2] = data[i * 4 + 2];
  }
  // Three passes of a colour-gated 5×5 mean: flattens texture, keeps edges.
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(px.length);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = (y * gw + x) * 3;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = Math.min(gh - 1, Math.max(0, y + dy));
          for (let dx = -2; dx <= 2; dx++) {
            const xx = Math.min(gw - 1, Math.max(0, x + dx));
            const j = (yy * gw + xx) * 3;
            const dr = px[j] - px[i], dg = px[j + 1] - px[i + 1], db = px[j + 2] - px[i + 2];
            if (dr * dr + dg * dg + db * db < 30 * 30) {
              r += px[j];
              g += px[j + 1];
              b += px[j + 2];
              c++;
            }
          }
        }
        next[i] = r / c;
        next[i + 1] = g / c;
        next[i + 2] = b / c;
      }
    }
    px = next;
  }
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [L, A, B] = toLab(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]);
    lab[i * 3] = L;
    lab[i * 3 + 1] = A;
    lab[i * 3 + 2] = B;
  }
  // k-means++ init, 10 Lloyd iterations.
  const rand = rng(seed * 7919 + 1);
  const cent = new Float32Array(k * 3);
  const first = Math.floor(rand() * n);
  cent.set(lab.subarray(first * 3, first * 3 + 3), 0);
  const dist = new Float32Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d0 = lab[i * 3] - cent[(c - 1) * 3], d1 = lab[i * 3 + 1] - cent[(c - 1) * 3 + 1], d2 = lab[i * 3 + 2] - cent[(c - 1) * 3 + 2];
      dist[i] = Math.min(dist[i], d0 * d0 + d1 * d1 + d2 * d2);
      sum += dist[i];
    }
    let t = rand() * sum;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      t -= dist[i];
      if (t <= 0) {
        pick = i;
        break;
      }
    }
    cent.set(lab.subarray(pick * 3, pick * 3 + 3), c * 3);
  }
  let lbl = new Uint8Array(n);
  for (let it = 0; it < 10; it++) {
    const sums = new Float32Array(k * 4);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d0 = lab[i * 3] - cent[c * 3], d1 = lab[i * 3 + 1] - cent[c * 3 + 1], d2 = lab[i * 3 + 2] - cent[c * 3 + 2];
        const d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      lbl[i] = best;
      sums[best * 4] += lab[i * 3];
      sums[best * 4 + 1] += lab[i * 3 + 1];
      sums[best * 4 + 2] += lab[i * 3 + 2];
      sums[best * 4 + 3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c * 4 + 3] > 0) {
        cent[c * 3] = sums[c * 4] / sums[c * 4 + 3];
        cent[c * 3 + 1] = sums[c * 4 + 1] / sums[c * 4 + 3];
        cent[c * 3 + 2] = sums[c * 4 + 2] / sums[c * 4 + 3];
      }
    }
  }
  // Two passes of a 5×5 majority filter: no speckle islands.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(n);
    const votes = new Uint16Array(k);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        votes.fill(0);
        for (let dy = -2; dy <= 2; dy++) {
          const yy = Math.min(gh - 1, Math.max(0, y + dy));
          for (let dx = -2; dx <= 2; dx++) {
            votes[lbl[yy * gw + Math.min(gw - 1, Math.max(0, x + dx))]]++;
          }
        }
        let best = 0;
        for (let c = 1; c < k; c++) if (votes[c] > votes[best]) best = c;
        next[y * gw + x] = best;
      }
    }
    lbl = next;
  }
  return lbl;
}

type Pt = [number, number];
type Poly = { pts: Pt[]; area: number };

/** Moore-neighbour trace of the outer boundary of the component containing `start`. */
function traceBoundary(comp: Int32Array, w: number, h: number, id: number, start: number): Pt[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && comp[y * w + x] === id;
  const dirs: Pt[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const sx = start % w;
  const sy = (start / w) | 0;
  const pts: Pt[] = [[sx, sy]];
  let cx = sx, cy = sy;
  let back = 4; // we entered the start pixel from the left (scan order)
  for (let guard = 0; guard < w * h * 4; guard++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (inside(nx, ny)) {
        back = (d + 4) % 8;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break; // single pixel
    if (cx === sx && cy === sy) break;
    pts.push([cx, cy]);
  }
  return pts;
}

/** Ramer–Douglas–Peucker on a closed ring. */
function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 4) return pts;
  const rdp = (a: number, b: number, out: Pt[]) => {
    let md = 0, mi = -1;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > eps && mi > 0) {
      rdp(a, mi, out);
      rdp(mi, b, out);
    } else out.push(pts[b]);
  };
  // Split the ring at the point farthest from the first one.
  let far = 0, fd = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const out: Pt[] = [pts[0]];
  rdp(0, far, out);
  const tail = pts.slice(far).concat([pts[0]]);
  const sub = simplifyOpen(tail, eps);
  return out.concat(sub.slice(1, -1));
}

function simplifyOpen(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  const rdp = (a: number, b: number) => {
    let md = 0, mi = -1;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > eps && mi > 0) {
      rdp(a, mi);
      rdp(mi, b);
    } else out.push(pts[b]);
  };
  rdp(0, pts.length - 1);
  return out;
}

/** Every connected component of every label → simplified polygon. */
function polygonsFrom(lbl: Uint8Array, gw: number, gh: number, epsFrac: number, minArea: number, skip0: boolean): Poly[] {
  const comp = new Int32Array(gw * gh).fill(-1);
  const polys: Poly[] = [];
  let next = 0;
  const stack: number[] = [];
  for (let i = 0; i < comp.length; i++) {
    if (comp[i] !== -1) continue;
    const v = lbl[i];
    const id = next++;
    let area = 0;
    stack.push(i);
    comp[i] = id;
    while (stack.length) {
      const j = stack.pop()!;
      area++;
      const x = j % gw;
      const y = (j / gw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const k = ny * gw + nx;
        if (comp[k] === -1 && lbl[k] === v) {
          comp[k] = id;
          stack.push(k);
        }
      }
    }
    if (area < minArea || (skip0 && v === 0)) continue;
    const ring = traceBoundary(comp, gw, gh, id, i);
    if (ring.length < 3) continue;
    const peri = ring.length;
    const pts = simplify(ring, Math.max(0.6, epsFrac * peri));
    if (pts.length >= 3) polys.push({ pts, area });
  }
  polys.sort((a, b) => b.area - a.area); // big shapes first, details on top
  return polys;
}

/** Even–odd scanline fill of `pts` (grid coords scaled by sx, sy) into `ids`. */
function fillPoly(ids: Uint16Array, w: number, h: number, pts: Pt[], sx: number, sy: number, id: number, onlyInside: boolean) {
  const P = pts.map(([x, y]) => [(x + 0.5) * sx, (y + 0.5) * sy] as Pt);
  let y0 = h, y1 = 0;
  for (const [, y] of P) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const xs: number[] = [];
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i];
      const [xj, yj] = P[j];
      if (yi > yc !== yj > yc) xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) {
        const i = y * w + x;
        if (!onlyInside || ids[i] !== 0) ids[i] = id;
      }
    }
  }
}

/**
 * Blur clamped to each region: normalised convolution inside each region's
 * bounding box, so colour never crosses a polygon edge — "sharp blurriness".
 */
function clampedAirbrush(data: Uint8ClampedArray, ids: Uint16Array, w: number, h: number, sigmas: Float32Array, out: Uint8ClampedArray) {
  const nIds = sigmas.length;
  const bx0 = new Int32Array(nIds).fill(w), by0 = new Int32Array(nIds).fill(h), bx1 = new Int32Array(nIds).fill(-1), by1 = new Int32Array(nIds).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = ids[y * w + x];
      if (x < bx0[id]) bx0[id] = x;
      if (x > bx1[id]) bx1[id] = x;
      if (y < by0[id]) by0[id] = y;
      if (y > by1[id]) by1[id] = y;
    }
  }
  for (let id = 1; id < nIds; id++) {
    if (bx1[id] < 0) continue;
    const sg = sigmas[id];
    const pad = Math.ceil(sg * 3);
    const x0 = Math.max(0, bx0[id] - pad), y0 = Math.max(0, by0[id] - pad);
    const x1 = Math.min(w - 1, bx1[id] + pad), y1 = Math.min(h - 1, by1[id] + pad);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const m = new Float32Array(bw * bh);
    const r = new Float32Array(bw * bh), g = new Float32Array(bw * bh), b = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const gi = (y + y0) * w + (x + x0);
        if (ids[gi] === id) {
          const k = y * bw + x;
          m[k] = 1;
          r[k] = data[gi * 4];
          g[k] = data[gi * 4 + 1];
          b[k] = data[gi * 4 + 2];
        }
      }
    }
    const M = gauss1(m, bw, bh, sg), R = gauss1(r, bw, bh, sg), G = gauss1(g, bw, bh, sg), B = gauss1(b, bw, bh, sg);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const gi = (y + y0) * w + (x + x0);
        if (ids[gi] !== id) continue;
        const k = y * bw + x;
        const d = Math.max(1e-4, M[k]);
        out[gi * 4] = R[k] / d;
        out[gi * 4 + 1] = G[k] / d;
        out[gi * 4 + 2] = B[k] / d;
        out[gi * 4 + 3] = 255;
      }
    }
  }
}

function hexRGB(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ───────────────────────────────────────────────────────────────────────────
// The looks
// ───────────────────────────────────────────────────────────────────────────

async function lowPoly(src: Src, w: number, h: number, cutout: boolean, bg: string, seed: number): Promise<ImageData> {
  const s = Math.min(w, h);
  const { canvas, data } = draw(src, w, h);
  const mask = cutout ? await personMask(canvas) : null;
  const gs = GRID_LONG / Math.max(w, h);
  const gw = Math.max(16, Math.round(w * gs)), gh = Math.max(16, Math.round(h * gs));
  const sx = w / gw, sy = h / gh;
  let lbl = regionLabels(src, gw, gh, mask ? 6 : 7, seed);
  // Inside the person, labels shift by one; 0 is the flat background.
  let gmask: Uint8Array | null = null;
  if (mask) {
    gmask = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        gmask[y * gw + x] = mask[Math.min(h - 1, Math.floor((y + 0.5) * sy)) * w + Math.min(w - 1, Math.floor((x + 0.5) * sx))];
      }
    }
    lbl = lbl.map((v, i) => (gmask![i] ? v + 1 : 0));
  }
  const minArea = gw * gh * 0.0012;
  const polys = polygonsFrom(lbl, gw, gh, 0.02, minArea, !!mask);
  const ids = new Uint16Array(w * h);
  const sigma = s * 0.03;
  const sigmas: number[] = [0];
  if (mask && gmask) {
    // The silhouette first, as straight-edged polygons, so facets never leave
    // gaps that show the background through the body.
    const silPolys = polygonsFrom(gmask, gw, gh, 0.006, gw * gh * 0.002, true);
    for (const p of silPolys) fillPoly(ids, w, h, p.pts, sx, sy, 1, false);
    sigmas.push(sigma);
  } else {
    ids.fill(1);
    sigmas.push(sigma);
  }
  for (const p of polys) {
    const id = sigmas.length;
    if (id >= 65000) break;
    fillPoly(ids, w, h, p.pts, sx, sy, id, !!mask);
    // Smaller facets get a smaller airbrush so features survive.
    const areaPx = p.area * sx * sy;
    sigmas.push(Math.max(3, Math.min(sigma, Math.sqrt(areaPx) * 0.22)));
  }
  const out = new ImageData(w, h);
  const o = out.data;
  const [br, bgc, bb] = hexRGB(bg);
  for (let i = 0; i < w * h; i++) {
    o[i * 4] = br;
    o[i * 4 + 1] = bgc;
    o[i * 4 + 2] = bb;
    o[i * 4 + 3] = 255;
  }
  clampedAirbrush(data, ids, w, h, Float32Array.from(sigmas), o);
  return out;
}

async function sticker(src: Src, w: number, h: number): Promise<ImageData> {
  const s = Math.min(w, h);
  const { canvas, ctx, data } = draw(src, w, h);
  const mask = await personMask(canvas);
  // Slight smudge on the subject.
  ctx.filter = `blur(${Math.max(1, s * 0.0025)}px)`;
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = "none";
  const soft = ctx.getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h);
  const o = out.data;
  // Ring = mask dilated by a box blur + low threshold.
  const ring = mask
    ? boxBlur1(Float32Array.from(mask), w, h, Math.max(2, Math.round(s * 0.016)))
    : null;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    // Cartoon sky into grass, Frank-Dorrey-ish.
    const skyR = 92 + (70 - 92) * t, skyG = 170 + (170 - 170) * t, skyB = 235 + (90 - 235) * t;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      if (!mask || mask[i]) {
        o[p] = soft[p];
        o[p + 1] = soft[p + 1];
        o[p + 2] = soft[p + 2];
      } else if (ring && ring[i] > 0.02) {
        o[p] = o[p + 1] = o[p + 2] = 8;
      } else {
        o[p] = skyR;
        o[p + 1] = skyG;
        o[p + 2] = skyB;
      }
      o[p + 3] = 255;
    }
  }
  void data;
  return out;
}

/** Kuwahara (summed-area tables, 4 quadrants) + emboss: wet oil impasto. */
function impasto(src: Src, w: number, h: number): ImageData {
  const s = Math.min(w, h);
  const { data } = draw(src, w, h);
  const R = Math.max(3, Math.round(s * 0.009));
  const W1 = w + 1;
  const sat = (ch: number) => {
    const t = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        const v = ch < 3 ? data[(y * w + x) * 4 + ch] : (() => {
          const i = (y * w + x) * 4;
          const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          return ch === 3 ? l : l * l;
        })();
        row += v;
        t[(y + 1) * W1 + x + 1] = t[y * W1 + x + 1] + row;
      }
    }
    return t;
  };
  const S = [sat(0), sat(1), sat(2), sat(3), sat(4)];
  const box = (t: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    t[(y1 + 1) * W1 + x1 + 1] - t[y0 * W1 + x1 + 1] - t[(y1 + 1) * W1 + x0] + t[y0 * W1 + x0];
  const out = new ImageData(w, h);
  const o = out.data;
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity, br = 0, bg = 0, bb = 0;
      for (let q = 0; q < 4; q++) {
        const x0 = Math.max(0, q & 1 ? x : x - R), x1 = Math.min(w - 1, q & 1 ? x + R : x);
        const y0 = Math.max(0, q & 2 ? y : y - R), y1 = Math.min(h - 1, q & 2 ? y + R : y);
        const n = (x1 - x0 + 1) * (y1 - y0 + 1);
        const ml = box(S[3], x0, y0, x1, y1) / n;
        const v = box(S[4], x0, y0, x1, y1) / n - ml * ml;
        if (v < best) {
          best = v;
          br = box(S[0], x0, y0, x1, y1) / n;
          bg = box(S[1], x0, y0, x1, y1) / n;
          bb = box(S[2], x0, y0, x1, y1) / n;
        }
      }
      const i = y * w + x;
      o[i * 4] = br;
      o[i * 4 + 1] = bg;
      o[i * 4 + 2] = bb;
      o[i * 4 + 3] = 255;
      lum[i] = br * 0.299 + bg * 0.587 + bb * 0.114;
    }
  }
  // Emboss: light from the top-left raking across the paint ridges.
  const L = boxBlur1(lum, w, h, 1);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + w] - L[i - w];
      const shade = Math.max(0.7, Math.min(1.3, 1 + (-gx - gy) * 0.006));
      o[i * 4] = Math.min(255, o[i * 4] * shade);
      o[i * 4 + 1] = Math.min(255, o[i * 4 + 1] * shade);
      o[i * 4 + 2] = Math.min(255, o[i * 4 + 2] * shade);
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Depth — Depth Anything V2 Small (Apache-2.0) via Transformers.js, on the
// device: WebGPU when the GPU can do f16, else WebAssembly. Loaded only the
// first time a depth look is used, then kept; one depth map per photo.
// ───────────────────────────────────────────────────────────────────────────

const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm";
const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
// A real browser import the bundler leaves alone.
const importUrl = new Function("u", "return import(u)") as (u: string) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

type DepthPipe = { run: (c: HTMLCanvasElement) => Promise<{ data: ArrayLike<number>; w: number; h: number; ch: number }> };
let depthPipe: Promise<DepthPipe> | null = null;
let depthQueue: Promise<unknown> = Promise.resolve();

function getDepth(): Promise<DepthPipe> {
  if (!depthPipe) {
    depthPipe = (async () => {
      const t = await importUrl(TRANSFORMERS);
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
      const f16 = gpu ? !!(await gpu.requestAdapter().catch(() => null))?.features?.has("shader-f16") : false;
      const tries = [...(f16 ? [{ device: "webgpu", dtype: "q4f16" }] : []), { device: "wasm", dtype: "q8" }];
      let lastErr: unknown = null;
      for (const opts of tries) {
        try {
          const pipe = await t.pipeline("depth-estimation", DEPTH_MODEL, opts);
          markReady("depth");
          return {
            run: async (c: HTMLCanvasElement) => {
              const out = await pipe(t.RawImage.fromCanvas(c));
              const d = (Array.isArray(out) ? out[0] : out).depth;
              return { data: d.data, w: d.width, h: d.height, ch: d.channels };
            },
          };
        } catch (err) {
          lastErr = err;
          console.warn(`[pixel] depth model failed on ${opts.device}`, err);
        }
      }
      throw lastErr ?? new Error("depth model unavailable");
    })();
    depthPipe.catch(() => (depthPipe = null));
  }
  return depthPipe;
}

const depthMaps = new WeakMap<object, Promise<Float32Array>>();

/** Depth at w×h, 0 = far … 1 = near. */
function depthOf(src: Src, w: number, h: number): Promise<Float32Array> {
  const hit = depthMaps.get(src);
  if (hit) return hit;
  const job = (async () => {
    const { canvas } = draw(src, w, h);
    let raw: Float32Array;
    try {
      const pipe = await getDepth();
      const run = depthQueue.then(() => pipe.run(canvas));
      depthQueue = run.catch(() => undefined);
      const r = await run;
      // Resample the model's map to the working size.
      const m = document.createElement("canvas");
      m.width = r.w;
      m.height = r.h;
      const mx = m.getContext("2d", { willReadFrequently: true })!;
      const img = mx.createImageData(r.w, r.h);
      for (let i = 0; i < r.w * r.h; i++) {
        const v = r.data[i * r.ch];
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      mx.putImageData(img, 0, 0);
      const { data } = draw(m, w, h);
      raw = new Float32Array(w * h);
      for (let i = 0; i < raw.length; i++) raw[i] = data[i * 4] / 255;
    } catch (err) {
      // Flag and carry on: without the model, a person is near and the
      // frame recedes upwards — rough, but the look still renders.
      console.warn("[pixel] depth model unavailable — using a rough person/ground estimate", err);
      const mask = await personMask(canvas);
      raw = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) raw[y * w + x] = 0.15 + 0.45 * (y / h) + (mask?.[y * w + x] ? 0.4 : 0);
      raw = gauss1(raw, w, h, Math.max(w, h) * 0.01);
    }
    // Percentile stretch so every photo uses the whole range.
    const sorted = Float32Array.from(raw).sort();
    const lo = sorted[Math.floor(sorted.length * 0.01)];
    const hi = Math.max(lo + 1e-3, sorted[Math.floor(sorted.length * 0.995)]);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.min(1, Math.max(0, (raw[i] - lo) / (hi - lo)));
    return raw;
  })();
  depthMaps.set(src, job);
  job.catch(() => depthMaps.delete(src));
  return job;
}

/** Google's Turbo colormap (polynomial fit, Mikhailov 2019). */
function turbo(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [r * 255, g * 255, b * 255];
}

async function depthLook(src: Src, w: number, h: number, kind: StylizeKind, bg: string): Promise<ImageData> {
  const D = await depthOf(src, w, h);
  const out = new ImageData(w, h);
  const o = out.data;
  if (kind === "depth") {
    for (let i = 0; i < D.length; i++) {
      const v = Math.pow(D[i], 1.1) * 255;
      o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v;
      o[i * 4 + 3] = 255;
    }
  } else if (kind === "depthheat") {
    for (let i = 0; i < D.length; i++) {
      const [r, g, b] = turbo(D[i]);
      o[i * 4] = r;
      o[i * 4 + 1] = g;
      o[i * 4 + 2] = b;
      o[i * 4 + 3] = 255;
    }
  } else if (kind === "depthlines") {
    // Topographic iso-depth lines, anti-aliased by the local gradient.
    const N = 30;
    const ink = hexRGB(bg);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const f = D[i] * N;
        const gx = (D[Math.min(w - 1, x + 1) + y * w] - D[Math.max(0, x - 1) + y * w]) * N * 0.5;
        const gy = (D[x + Math.min(h - 1, y + 1) * w] - D[x + Math.max(0, y - 1) * w]) * N * 0.5;
        const g = Math.max(1e-4, Math.hypot(gx, gy));
        const fr = f - Math.floor(f);
        // Flat plateaus (clamped near/far) have no contours to draw.
        const flat = g < 0.004 || D[i] <= 0.001 || D[i] >= 0.999;
        const dist = Math.min(fr, 1 - fr) / g; // in pixels
        const major = Math.round(f) % 5 === 0;
        const a = flat ? 0 : Math.max(0, 1 - dist / (major ? 1.4 : 0.9)) * (major ? 1 : 0.7);
        const base = 8 + D[i] * 22;
        o[i * 4] = base + (ink[0] - base) * a;
        o[i * 4 + 1] = base + (ink[1] - base) * a;
        o[i * 4 + 2] = base + (ink[2] - base) * a;
        o[i * 4 + 3] = 255;
      }
  } else {
    // Haze: the far half of the scene sinks into atmosphere.
    const { data } = draw(src, w, h);
    const fog = hexRGB(bg);
    for (let i = 0; i < D.length; i++) {
      const a = Math.pow(1 - D[i], 1.6) * 0.88;
      o[i * 4] = data[i * 4] + (fog[0] - data[i * 4]) * a;
      o[i * 4 + 1] = data[i * 4 + 1] + (fog[1] - data[i * 4 + 1]) * a;
      o[i * 4 + 2] = data[i * 4 + 2] + (fog[2] - data[i * 4 + 2]) * a;
      o[i * 4 + 3] = 255;
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Datamosh — a still has no motion, so we invent a motion-vector field (one
// vector per 16px macroblock, flowing like a camera move) and apply it over
// and over to the same picture: P-frame bloom. Chroma then goes blocky, the
// way 4:2:0 macroblocks smear colour, and a real JPEG crunch follows.
// ───────────────────────────────────────────────────────────────────────────

/** `t` (0..1, the STRENGTH slider) is how hard it moshes: how many blocks
 *  lose their keyframe, how far vectors push, how many times they repeat. */
function mosh(src: Src, w: number, h: number, seed: number, melt: boolean, t: number): ImageData {
  const { data } = draw(src, w, h);
  const B = Math.max(8, Math.round(Math.max(w, h) / 60));
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const rand = rng(seed * 7919 + 13);
  // Smooth random field: a few big swirls.
  const waves = Array.from({ length: 4 }, () => ({
    fx: 0.5 + rand() * 2.5,
    fy: 0.5 + rand() * 2.5,
    ph: rand() * 6.283,
    a: 0.5 + rand(),
  }));
  const vx = new Float32Array(bw * bh);
  const vy = new Float32Array(bw * bh);
  const on = new Uint8Array(bw * bh);
  const step = Math.max(1.5, Math.max(w, h) * 0.004) * (0.6 + 0.6 * t);
  const bandA = rand();
  const bandB = rand();
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const u = bx / bw;
      const v = by / bh;
      let ang = 0;
      let mag = 0;
      for (const wv of waves) {
        ang += wv.a * Math.sin(u * wv.fx * 6.283 + wv.ph) * Math.cos(v * wv.fy * 6.283 - wv.ph);
        mag += wv.a * Math.cos(u * wv.fy * 3.1 + v * wv.fx * 3.1 + wv.ph);
      }
      const k = by * bw + bx;
      if (melt) {
        // Everything drips down, swaying a little.
        vx[k] = Math.sin(ang) * step * 0.35;
        vy[k] = -step * (0.6 + 0.5 * Math.abs(Math.cos(ang)));
      } else {
        vx[k] = Math.cos(ang * 1.7) * step * (0.6 + Math.abs(mag) * 0.4);
        vy[k] = Math.sin(ang * 1.7) * step * (0.6 + Math.abs(mag) * 0.4);
      }
      // Which macroblocks lost their I-frame: blobs plus a couple of bands.
      const inBand = t > 0.45 && (Math.abs(v - bandA) < 0.09 || Math.abs(v - bandB) < 0.05);
      on[k] = melt ? (mag > 1.6 - 3.2 * t ? 1 : 0) : mag > 2.2 - 3.2 * t || inBand ? 1 : 0;
    }
  let cur = new Uint8ClampedArray(data);
  let nxt = new Uint8ClampedArray(data);
  const iters = Math.max(1, Math.round(melt ? 6 + 32 * t : 4 + 22 * t));
  for (let it = 0; it < iters; it++) {
    nxt.set(cur);
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        const k = by * bw + bx;
        if (!on[k]) continue;
        const dx = Math.round(vx[k]);
        const dy = Math.round(vy[k]);
        const x1 = Math.min(w, (bx + 1) * B);
        const y1 = Math.min(h, (by + 1) * B);
        for (let y = by * B; y < y1; y++) {
          const sy = Math.min(h - 1, Math.max(0, y + dy));
          for (let x = bx * B; x < x1; x++) {
            const sx = Math.min(w - 1, Math.max(0, x + dx));
            const s4 = (sy * w + sx) * 4;
            const d4 = (y * w + x) * 4;
            nxt[d4] = cur[s4];
            nxt[d4 + 1] = cur[s4 + 1];
            nxt[d4 + 2] = cur[s4 + 2];
          }
        }
      }
    const t = cur;
    cur = nxt;
    nxt = t;
  }
  // Blocky chroma inside the moshed blocks: keep luma per pixel, colour per 8px.
  const C = Math.max(4, B >> 1);
  for (let cy = 0; cy < h; cy += C)
    for (let cx = 0; cx < w; cx += C) {
      if (!on[Math.min(bh - 1, (cy / B) | 0) * bw + Math.min(bw - 1, (cx / B) | 0)]) continue;
      let cb = 0;
      let cr = 0;
      let n = 0;
      const x1 = Math.min(w, cx + C);
      const y1 = Math.min(h, cy + C);
      for (let y = cy; y < y1; y++)
        for (let x = cx; x < x1; x++) {
          const i = (y * w + x) * 4;
          cb += -0.1687 * cur[i] - 0.3313 * cur[i + 1] + 0.5 * cur[i + 2];
          cr += 0.5 * cur[i] - 0.4187 * cur[i + 1] - 0.0813 * cur[i + 2];
          n++;
        }
      cb = (cb / n) * 1.35;
      cr = (cr / n) * 1.35;
      for (let y = cy; y < y1; y++)
        for (let x = cx; x < x1; x++) {
          const i = (y * w + x) * 4;
          const Y = 0.299 * cur[i] + 0.587 * cur[i + 1] + 0.114 * cur[i + 2];
          cur[i] = Y + 1.402 * cr;
          cur[i + 1] = Y - 0.344136 * cb - 0.714136 * cr;
          cur[i + 2] = Y + 1.772 * cb;
        }
    }
  return new ImageData(cur, w, h);
}

// ───────────────────────────────────────────────────────────────────────────
// Public: cached restyle + strength blend
// ───────────────────────────────────────────────────────────────────────────

const cache = new WeakMap<object, Map<string, Promise<ImageBitmap>>>();

const MOSH = new Set<StylizeKind>(["mosh", "melt"]);
/** Looks whose STRENGTH changes the restyle itself, not a fade. */
export const intensityRestyle = (kind: StylizeKind) => MOSH.has(kind);
const quant = (a: number) => Math.round(Math.max(0, Math.min(1, a)) * 20) / 20;

function restyle(src: Src, kind: StylizeKind, bg: string, seed: number, amount = 1): Promise<ImageBitmap> {
  let m = cache.get(src);
  if (!m) {
    m = new Map();
    cache.set(src, m);
  }
  const key = MOSH.has(kind) ? `${kind}|${seed}|${quant(amount)}` : `${kind}|${bg}`;
  const hit = m.get(key);
  if (hit) return hit;
  const job = (async () => {
    const [sw, sh] = srcSize(src);
    const k = Math.min(1, WORK_LONG / Math.max(sw, sh));
    const w = Math.max(16, Math.round(sw * k));
    const h = Math.max(16, Math.round(sh * k));
    let img: ImageData;
    if (kind === "ps2") img = await lowPoly(src, w, h, true, bg, seed);
    else if (kind === "airbrush") img = await lowPoly(src, w, h, false, bg, seed);
    else if (kind === "sticker") img = await sticker(src, w, h);
    else if (kind === "impasto") img = impasto(src, w, h);
    else if (MOSH.has(kind)) img = mosh(src, w, h, seed, kind === "melt", quant(amount));
    else img = await depthLook(src, w, h, kind, bg);
    // Back up to the source size so the rest of the pipeline is unchanged.
    const small = await createImageBitmap(img);
    const big = await createImageBitmap(small, { resizeWidth: sw, resizeHeight: sh, resizeQuality: "high" });
    small.close();
    return big;
  })();
  m.set(key, job);
  job.catch(() => m!.delete(key));
  if (MOSH.has(kind)) {
    // Each strength step is its own full-size bitmap: keep only the latest
    // few. Freed a moment later so a render still using one can finish.
    const moshKeys = [...m.keys()].filter((k) => MOSH.has(k.split("|")[0] as StylizeKind));
    for (const old of moshKeys.slice(0, Math.max(0, moshKeys.length - 6))) {
      const p = m.get(old)!;
      m.delete(old);
      p.then((b) => setTimeout(() => b.close(), 3000)).catch(() => undefined);
    }
  }
  return job;
}

/**
 * The restyled source, blended with the original by `amount` (the STRENGTH
 * slider) — except datamosh, where strength drives the mosh itself — ready
 * to feed the normal pipeline.
 */
export async function stylizedSource(
  src: Src,
  kind: StylizeKind,
  bg: string,
  amount: number,
  seed: number
): Promise<{ bitmap: ImageBitmap; owned: boolean }> {
  // Datamosh: strength = how much it moshes, so no fade.
  if (MOSH.has(kind)) return { bitmap: await restyle(src, kind, bg, seed, amount), owned: false };
  const styled = await restyle(src, kind, bg, seed);
  // The cached bitmap is shared — never close it. A blend is ours to free.
  if (amount >= 0.999) return { bitmap: styled, owned: false };
  const [w, h] = srcSize(src);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0, w, h);
  ctx.globalAlpha = Math.max(0, amount);
  ctx.drawImage(styled, 0, 0, w, h);
  return { bitmap: await createImageBitmap(c), owned: true };
}
