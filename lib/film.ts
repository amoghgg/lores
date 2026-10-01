// Parametric film-emulation model. One recipe shape describes every stock,
// camera, and alt-process in lib/filmStocks.ts. The same math runs in WGSL
// (FRAG_FILM in gpu/webgpu.ts) and on the CPU (applyFilmCPU below) — keep the
// two in step when touching either.

export type Vec3 = [number, number, number];
/** 12 hue bands, 30° apart, starting at red (0°). */
export type Bands = number[];

export type BorderKind =
  | "none"
  | "polaroid"
  | "print"
  | "rebate"
  | "instax"
  | "gate"
  | "deckle"
  | "pour"
  | "oval"
  | "letterbox";

export type FilmRecipe = {
  /** Channel mixer rows (out.r = dot(mix[0], in)). Spectral response quirks. */
  mix: [Vec3, Vec3, Vec3];
  /** Exposure in stops. */
  exposure: number;
  /** White balance multipliers (display space). */
  wb: Vec3;
  /** S-curve strength. 0 = linear, 1 = smoothstep, <0 flattens. */
  contrast: number;
  /** Highlight shoulder: compresses whites, film-like rolloff. 0..1. */
  shoulder: number;
  /** Global saturation multiplier. 0 = mono. */
  sat: number;
  /** Per-hue-band hue shift in degrees, 12 bands at 0°, 30°, … 330°. */
  hue: Bands;
  /** Per-hue-band saturation multiplier. */
  satBand: Bands;
  /** Per-hue-band brightness multiplier (scaled by pixel saturation). */
  lumBand: Bands;
  /** Per-channel gamma (>1 brightens). */
  gamma: Vec3;
  /** Per-channel black point — matte / faded shadows. */
  lift: Vec3;
  /** Per-channel white point — <1 = dull print highlights. */
  gain: Vec3;
  shadowTint: string;
  shadowAmt: number;
  highTint: string;
  highAmt: number;
  /** Shifts the shadow/highlight split. -0.3..0.3. */
  balance: number;
  /** Luminance gradient map (shadow, mid, highlight). Used by toned/alt prints. */
  tone: [string, string, string];
  toneMix: number;
  /** Halation / bloom: highlights bleed this color. */
  glowColor: string;
  glow: number;
  glowThreshold: number;
  /** Glow radius as a fraction of min(w, h). */
  glowRadius: number;
  /** Corner softness radius (fraction of min dim) — toy-lens falloff. */
  soft: number;
  /** Lateral chromatic aberration at the corner, in fraction of min dim. */
  ca: number;
  grain: number;
  /** Grain clump size in source pixels. */
  grainSize: number;
  /** 0 = monochrome grain (B&W, fine colour stocks), 1 = full RGB dye clouds. */
  grainChroma: number;
  vignette: number;
  /** 0 = gentle wide falloff, 1 = hard tunnel. */
  vignetteFalloff: number;
  vignetteColor: string;
  leak: number;
  leakColor: string;
  /** Edge the leak enters from, radians. */
  leakAngle: number;
  dust: number;
  scratches: number;
  border: BorderKind;
  paper: string;
  /** On-camera flash: hot centre, falloff to the edges. 0..1. */
  flash: number;
  /** Autochrome potato-starch colour-screen mosaic. 0..1. */
  mosaic: number;
  /** Hand-tinting: blurred, bleeding watercolour chroma over a mono print. */
  handTint: number;
  /** Burned-in orange LED date stamp, '98-style. */
  dateStamp: boolean;
  /** Every reroll draws a different expired-roll cast. */
  lottery: boolean;
};

export const NEUTRAL: FilmRecipe = {
  mix: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  exposure: 0,
  wb: [1, 1, 1],
  contrast: 0,
  shoulder: 0,
  sat: 1,
  hue: Array(12).fill(0),
  satBand: Array(12).fill(1),
  lumBand: Array(12).fill(1),
  gamma: [1, 1, 1],
  lift: [0, 0, 0],
  gain: [1, 1, 1],
  shadowTint: "#808080",
  shadowAmt: 0,
  highTint: "#808080",
  highAmt: 0,
  balance: 0,
  tone: ["#000000", "#808080", "#ffffff"],
  toneMix: 0,
  glowColor: "#ff6a3d",
  glow: 0,
  glowThreshold: 0.8,
  glowRadius: 0.012,
  soft: 0,
  ca: 0,
  grain: 0,
  grainSize: 1.2,
  grainChroma: 0.3,
  vignette: 0,
  vignetteFalloff: 0.4,
  vignetteColor: "#000000",
  leak: 0,
  leakColor: "#ff5a1f",
  leakAngle: 0,
  dust: 0,
  scratches: 0,
  border: "none",
  paper: "#f4f1ea",
  flash: 0,
  mosaic: 0,
  handTint: 0,
  dateStamp: false,
  lottery: false,
};

/** User-facing multipliers layered on top of a stock's recipe. */
export type FilmControls = {
  /** 0..1 — mix between the untouched image and the full look. */
  amount: number;
  grain: number; // 0..2 multiplier
  glow: number; // 0..2
  vignette: number; // 0..2
  leak: number; // 0..2
  /** Show the stock's border (Polaroid frame, gate, mat…) when it has one. */
  frame: boolean;
  seed: number;
};

export const DEFAULT_CONTROLS: FilmControls = {
  amount: 1,
  grain: 1,
  glow: 1,
  vignette: 1,
  leak: 1,
  frame: true,
  seed: 7,
};

export const BORDER_BITS: Record<BorderKind, number> = {
  none: 0,
  polaroid: 1,
  print: 2,
  rebate: 3,
  instax: 4,
  gate: 5,
  deckle: 6,
  pour: 7,
  oval: 8,
  letterbox: 9,
};

export function hex3(s: string): Vec3 {
  const n = parseInt(s.replace("#", ""), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// ───────────────────────────────────────────────────────────────────────────
// Expired-roll lottery: a fogged, tinted base + hue drift drawn from the seed.
// Kodak-ish magenta, Fuji-ish green, Agfa-ish cyan, ferrotype amber.
// ───────────────────────────────────────────────────────────────────────────

const LOTTERY_FOG: Vec3[] = [
  [0.23, 0.15, 0.22],
  [0.14, 0.2, 0.17],
  [0.12, 0.19, 0.21],
  [0.24, 0.17, 0.1],
];

export function resolveRecipe(r: FilmRecipe, seed: number): FilmRecipe {
  if (!r.lottery) return r;
  const pick = hash2(seed, 3, 17);
  const fog = LOTTERY_FOG[Math.floor(pick * LOTTERY_FOG.length) % LOTTERY_FOG.length];
  const drift = (hash2(seed, 5, 19) - 0.5) * 30;
  const k = 0.45 + hash2(seed, 7, 23) * 0.35;
  return {
    ...r,
    lift: [
      r.lift[0] + (fog[0] - r.lift[0]) * k,
      r.lift[1] + (fog[1] - r.lift[1]) * k,
      r.lift[2] + (fog[2] - r.lift[2]) * k,
    ],
    hue: r.hue.map((h) => h + drift),
    leakAngle: hash2(seed, 9, 29) * Math.PI * 2,
  };
}

/** Uniform layout: 33 vec4f — mirrors `struct Film` in FRAG_FILM. */
export const FILM_UNIFORM_BYTES = 33 * 16;

export function packFilmUniform(
  recipeIn: FilmRecipe,
  c: FilmControls,
  w: number,
  h: number,
  time: number
): ArrayBuffer {
  const r = resolveRecipe(recipeIn, c.seed);
  const buf = new ArrayBuffer(FILM_UNIFORM_BYTES);
  const f = new Float32Array(buf);
  let o = 0;
  const v4 = (a: number, b: number, cc: number, d: number) => {
    f[o++] = a;
    f[o++] = b;
    f[o++] = cc;
    f[o++] = d;
  };
  const col = (hx: string, wv: number) => {
    const [x, y, z] = hex3(hx);
    v4(x, y, z, wv);
  };
  v4(w, h, c.seed, c.amount);
  v4(...r.mix[0], 0);
  v4(...r.mix[1], 0);
  v4(...r.mix[2], 0);
  v4(...r.wb, r.exposure);
  v4(r.contrast, r.shoulder, r.sat, r.balance);
  v4(...r.gamma, 0);
  v4(...r.lift, r.toneMix);
  v4(...r.gain, 0);
  for (let k = 0; k < 12; k += 4) {
    v4(r.hue[k] / 360, r.hue[k + 1] / 360, r.hue[k + 2] / 360, r.hue[k + 3] / 360);
  }
  for (let k = 0; k < 12; k += 4) {
    v4(r.satBand[k], r.satBand[k + 1], r.satBand[k + 2], r.satBand[k + 3]);
  }
  for (let k = 0; k < 12; k += 4) {
    v4(r.lumBand[k], r.lumBand[k + 1], r.lumBand[k + 2], r.lumBand[k + 3]);
  }
  col(r.shadowTint, r.shadowAmt);
  col(r.highTint, r.highAmt);
  col(r.tone[0], 0);
  col(r.tone[1], 0);
  col(r.tone[2], 0);
  col(r.glowColor, r.glow * c.glow);
  v4(r.glowThreshold, r.glowRadius, r.soft, r.ca);
  v4(r.grain * c.grain, r.grainSize, r.grainChroma, time);
  v4(r.vignette * c.vignette, r.vignetteFalloff, 0, 0);
  col(r.vignetteColor, 0);
  v4(r.leak * c.leak, r.leakAngle, 0, 0);
  col(r.leakColor, 0);
  v4(r.dust, r.scratches, c.frame ? BORDER_BITS[r.border] : 0, 0);
  col(r.paper, 0);
  v4(r.flash, r.mosaic, r.handTint, r.dateStamp ? 1 : 0);
  return buf;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared math (CPU side of the shader).
// ───────────────────────────────────────────────────────────────────────────

const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];
const lum = (r: number, g: number, b: number) =>
  r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function bandValue(bands: Bands, h: number): number {
  // h in [0, 1). Triangular weights across 12 band centres, circular.
  const x = h * 12;
  const i0 = Math.floor(x) % 12;
  const i1 = (i0 + 1) % 12;
  const t = x - Math.floor(x);
  return bands[i0] * (1 - t) + bands[i1] * t;
}

/** Hue-shift bands interpolate along the shortest arc (values in turns). */
function hueBandValue(bands: Bands, h: number): number {
  const x = h * 12;
  const i0 = Math.floor(x) % 12;
  const i1 = (i0 + 1) % 12;
  const t = x - Math.floor(x);
  const a = bands[i0] / 360;
  let d = bands[i1] / 360 - a;
  d -= Math.round(d);
  return a + d * t;
}

function rgb2hsv(r: number, g: number, b: number): Vec3 {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = (g - b) / d;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    if (h < 0) h += 6;
    h /= 6;
  }
  return [h - Math.floor(h), mx > 1e-6 ? d / mx : 0, mx];
}

function hsv2rgb(h: number, s: number, v: number): Vec3 {
  const k = (n: number) => {
    const kk = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1));
  };
  return [k(5), k(3), k(1)];
}

/** Pre-resolved recipe so the hot loop doesn't re-parse hex. */
export type GradeCtx = {
  r: FilmRecipe;
  shadowTint: Vec3;
  highTint: Vec3;
  tone: [Vec3, Vec3, Vec3];
  expMul: number;
};

export function gradeCtx(r: FilmRecipe): GradeCtx {
  return {
    r,
    shadowTint: hex3(r.shadowTint),
    highTint: hex3(r.highTint),
    tone: [hex3(r.tone[0]), hex3(r.tone[1]), hex3(r.tone[2])],
    expMul: Math.pow(2, r.exposure),
  };
}

/**
 * The colour half of the film model: mixer → exposure/WB → hue bands →
 * saturation → curve → matte → split tone → gradient map. `glow` is added
 * pre-curve, the way halation lives in the negative before printing.
 */
export function gradePixel(
  g: GradeCtx,
  ri: number,
  gi: number,
  bi: number,
  glow: Vec3 = [0, 0, 0],
  expGain = 1
): Vec3 {
  const r = g.r;
  let x = r.mix[0][0] * ri + r.mix[0][1] * gi + r.mix[0][2] * bi;
  let y = r.mix[1][0] * ri + r.mix[1][1] * gi + r.mix[1][2] * bi;
  let z = r.mix[2][0] * ri + r.mix[2][1] * gi + r.mix[2][2] * bi;
  const e = g.expMul * expGain;
  x = clamp01(x * r.wb[0] * e + glow[0]);
  y = clamp01(y * r.wb[1] * e + glow[1]);
  z = clamp01(z * r.wb[2] * e + glow[2]);

  const [hh, ss, vv] = rgb2hsv(x, y, z);
  // Shifts may be unwrapped past ±360° (see LomoChrome Purple), so wrap with floor.
  const hs = hh + hueBandValue(r.hue, hh);
  const nh = hs - Math.floor(hs);
  const ns = clamp01(ss * bandValue(r.satBand, hh) * r.sat);
  const nv = vv * (1 + (bandValue(r.lumBand, hh) - 1) * ss);
  [x, y, z] = hsv2rgb(nh, ns, nv);

  const curve = (v: number, i: 0 | 1 | 2) => {
    v = clamp01(v);
    const s = v * v * (3 - 2 * v);
    v = v + r.contrast * (s - v);
    if (r.shoulder > 0) v = (v * (1 + r.shoulder)) / (1 + r.shoulder * v);
    v = Math.pow(clamp01(v), 1 / r.gamma[i]);
    return r.lift[i] + v * (r.gain[i] - r.lift[i]);
  };
  x = curve(x, 0);
  y = curve(y, 1);
  z = curve(z, 2);

  const l = lum(x, y, z);
  const ws = 1 - smooth(0, 0.55 + r.balance, l);
  const wh = smooth(0.45 + r.balance, 1, l);
  const st = g.shadowTint;
  const ht = g.highTint;
  const sl = lum(st[0], st[1], st[2]);
  const hl = lum(ht[0], ht[1], ht[2]);
  x += (st[0] - sl) * r.shadowAmt * ws + (ht[0] - hl) * r.highAmt * wh;
  y += (st[1] - sl) * r.shadowAmt * ws + (ht[1] - hl) * r.highAmt * wh;
  z += (st[2] - sl) * r.shadowAmt * ws + (ht[2] - hl) * r.highAmt * wh;

  if (r.toneMix > 0) {
    const l2 = clamp01(lum(x, y, z));
    const [a, m, b] = g.tone;
    const t = l2 < 0.5 ? l2 * 2 : (l2 - 0.5) * 2;
    const lo = l2 < 0.5 ? a : m;
    const hi = l2 < 0.5 ? m : b;
    x += (lo[0] + (hi[0] - lo[0]) * t - x) * r.toneMix;
    y += (lo[1] + (hi[1] - lo[1]) * t - y) * r.toneMix;
    z += (lo[2] + (hi[2] - lo[2]) * t - z) * r.toneMix;
  }
  return [clamp01(x), clamp01(y), clamp01(z)];
}

// Hash → [0, 1). Same integer mix as the shader's `hash2`.
export function hash2(x: number, y: number, s: number): number {
  let h =
    (Math.imul(x | 0, 0x8da6b343) ^
      Math.imul(y | 0, 0xd8163841) ^
      Math.imul(s | 0, 0xcb1ab31f)) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

function vnoise(px: number, py: number, s: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, s);
  const b = hash2(ix + 1, iy, s);
  const c = hash2(ix, iy + 1, s);
  const d = hash2(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy - 0.5;
}

export type FrameRect = { x0: number; y0: number; x1: number; y1: number };

/** Inner picture window for a border kind, in output pixels. */
export function frameRect(kind: number, w: number, h: number): FrameRect {
  const s = Math.min(w, h);
  const inset = (l: number, t: number, rr: number, b: number) => ({
    x0: s * l,
    y0: s * t,
    x1: w - s * rr,
    y1: h - s * b,
  });
  switch (kind) {
    case 1:
      return inset(0.055, 0.06, 0.055, 0.235); // Polaroid: fat chin
    case 4:
      return inset(0.07, 0.085, 0.07, 0.21); // Instax Mini
    case 2:
      return inset(0.045, 0.045, 0.045, 0.045);
    case 3:
      return inset(0.035, 0.035, 0.035, 0.035);
    case 6:
      return inset(0.065, 0.065, 0.065, 0.065);
    case 7:
      return inset(0.05, 0.05, 0.05, 0.05);
    case 5: {
      // Super 8 gate: 1.36:1 window floating in black.
      let ih = h * 0.86;
      let iw = ih * 1.36;
      if (iw > w * 0.9) {
        iw = w * 0.9;
        ih = iw / 1.36;
      }
      return { x0: (w - iw) / 2, y0: (h - ih) / 2, x1: (w + iw) / 2, y1: (h + ih) / 2 };
    }
    case 8:
      return inset(0.1, 0.08, 0.1, 0.08); // oval mat opening (bounding box)
    case 9: {
      const ih = Math.min(h, w / 2.39);
      return { x0: 0, y0: (h - ih) / 2, x1: w, y1: (h + ih) / 2 };
    }
  }
  return { x0: 0, y0: 0, x1: w, y1: h };
}

const CORNER = [0, 0.004, 0.012, 0.02, 0.004, 0, 0.004, 0.01, 0, 0];

/** Signed distance (px) to the picture window; <0 is inside. */
export function frameSDF(
  kind: number,
  fr: FrameRect,
  px: number,
  py: number,
  s: number,
  seed: number
): number {
  if (kind === 0) return -1e4;
  const cx = (fr.x0 + fr.x1) / 2;
  const cy = (fr.y0 + fr.y1) / 2;
  if (kind === 8) {
    // Ellipse, approximate SDF scaled to pixels.
    const ax = (fr.x1 - fr.x0) / 2;
    const ay = (fr.y1 - fr.y0) / 2;
    const k = Math.hypot((px - cx) / ax, (py - cy) / ay);
    return (k - 1) * Math.min(ax, ay);
  }
  // Gate: corner radius ≈ 7% of frame height.
  const rr = kind === 5 ? (fr.y1 - fr.y0) * 0.07 : CORNER[kind] * s;
  const hx = (fr.x1 - fr.x0) / 2 - rr;
  const hy = (fr.y1 - fr.y0) / 2 - rr;
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  let d =
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
  if (kind === 3) {
    // Filed-out negative carrier: hand-filed edge wobbles.
    d += vnoise(px / (s * 0.01), py / (s * 0.01), seed + 77) * s * 0.012;
  } else if (kind === 6) {
    // Deckle: scalloped paper edge.
    const along = qx > qy ? py : px;
    d += Math.sin((along / (s * 0.022)) * Math.PI * 2) * s * 0.006;
  } else if (kind === 7) {
    // Collodion pour: big lazy wobble + fine streaks.
    d +=
      vnoise(px / (s * 0.06), py / (s * 0.06), seed + 78) * s * 0.06 +
      vnoise(px / (s * 0.006), py / (s * 0.03), seed + 79) * s * 0.01;
  }
  return d;
}

/** Colour for a pixel outside the picture window (paper, metal, black gate). */
function surround(
  kind: number,
  paper: Vec3,
  sdf: number,
  px: number,
  py: number,
  h: number,
  s: number,
  seed: number
): Vec3 {
  const pn = vnoise(px / 3, py / 3, seed + 91) * 0.04;
  if (kind === 8) {
    // Brass mat: vertical metallic sheen + a bevel highlight at the opening.
    const sheen = 0.75 + 0.35 * Math.sin((py / h) * Math.PI * 3 + 0.6);
    const bevel = Math.exp(-sdf / (s * 0.006)) * 0.35;
    return [
      paper[0] * sheen + bevel + pn,
      paper[1] * sheen + bevel * 0.85 + pn,
      paper[2] * sheen + bevel * 0.5 + pn,
    ];
  }
  if (kind === 7) {
    // Milky collodion streaks fading into black lacquer.
    const k = Math.exp(-sdf / (s * 0.02));
    const streak = 0.75 + 0.5 * vnoise(px / (s * 0.003), py / (s * 0.04), seed + 80);
    return [paper[0] * k * streak + 0.04, paper[1] * k * streak + 0.035, paper[2] * k * streak + 0.03];
  }
  return [paper[0] + pn, paper[1] + pn, paper[2] + pn];
}

// Daguerreotype tarnish: blue → purple → gold bloom just inside the mat.
const TARNISH: Vec3[] = [hex3("#2e5c9c"), hex3("#8a3a7a"), hex3("#c9a245")];
function tarnish(c: Vec3, sdf: number, s: number, px: number, py: number, seed: number): Vec3 {
  const t = clamp01(-sdf / (s * 0.1));
  if (t >= 1) return c;
  const n = vnoise(px / (s * 0.05), py / (s * 0.05), seed + 61) + 0.5;
  const tt = clamp01(t + (n - 0.5) * 0.3);
  const a = tt < 0.5 ? TARNISH[0] : TARNISH[1];
  const b = tt < 0.5 ? TARNISH[1] : TARNISH[2];
  const k = tt < 0.5 ? tt * 2 : (tt - 0.5) * 2;
  const col: Vec3 = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const m = (1 - tt) * 0.45 * n;
  return [c[0] + (col[0] - c[0]) * m, c[1] + (col[1] - c[1]) * m, c[2] + (col[2] - c[2]) * m];
}

// Autochrome: jittered-grid Voronoi of dyed starch grains with lampblack gaps.
const STARCH: Vec3[] = [hex3("#e0662f"), hex3("#4f9a4a"), hex3("#5a4fa8")];
function autochrome(px: number, py: number, s: number, seed: number): [Vec3, number] {
  const cell = Math.max(2.2, s / 600);
  const gx = Math.floor(px / cell);
  const gy = Math.floor(py / cell);
  let d1 = 1e9;
  let d2 = 1e9;
  let bx = 0;
  let by = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = gx + ox;
      const cy = gy + oy;
      const fx = (cx + hash2(cx, cy, seed + 31)) * cell;
      const fy = (cy + hash2(cx, cy, seed + 32)) * cell;
      const d = Math.hypot(px - fx, py - fy);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        bx = cx;
        by = cy;
      } else if (d < d2) d2 = d;
    }
  }
  // Clumping: low-freq noise biases which dye a grain gets.
  const bias = vnoise(bx / 5, by / 5, seed + 33) * 0.5;
  const idx = Math.floor(clamp01(hash2(bx, by, seed + 34) + bias) * 2.999);
  const edge = smooth(0, cell * 0.18, d2 - d1);
  return [STARCH[idx], edge];
}

// Seven-segment LED date stamp ("'98 7 14"), burned in additively.
// Segment bits: a b c d e f g = 1 2 4 8 16 32 64
const SEG7 = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];
export function stampDigits(seed: number): number[] {
  const yy = [95, 96, 97, 98, 99, 0, 1, 2, 3][Math.floor(hash2(seed, 1, 71) * 9) % 9];
  const mm = 1 + Math.floor(hash2(seed, 2, 72) * 12);
  const dd = 1 + Math.floor(hash2(seed, 3, 73) * 28);
  // -2 = apostrophe, -1 = blank
  return [
    -2,
    Math.floor(yy / 10),
    yy % 10,
    -1,
    mm >= 10 ? 1 : -1,
    mm % 10,
    -1,
    Math.floor(dd / 10),
    dd % 10,
  ];
}

function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const t = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * t, pay - bay * t);
}

/** Distance (in glyph units, height 2) to the nearest lit segment. */
function glyphDist(code: number, x: number, y: number): number {
  if (code === -1) return 9;
  if (code === -2) return segDist(x, y, 0.5, 1.95, 0.4, 1.6);
  const m = SEG7[code];
  let d = 9;
  // Slight italic lean, like the real Fuji/Kodak LCD backs.
  x -= y * 0.12;
  if (m & 1) d = Math.min(d, segDist(x, y, 0.15, 2, 0.85, 2));
  if (m & 2) d = Math.min(d, segDist(x, y, 0.9, 1.95, 0.9, 1.05));
  if (m & 4) d = Math.min(d, segDist(x, y, 0.9, 0.95, 0.9, 0.05));
  if (m & 8) d = Math.min(d, segDist(x, y, 0.15, 0, 0.85, 0));
  if (m & 16) d = Math.min(d, segDist(x, y, 0.1, 0.95, 0.1, 0.05));
  if (m & 32) d = Math.min(d, segDist(x, y, 0.1, 1.95, 0.1, 1.05));
  if (m & 64) d = Math.min(d, segDist(x, y, 0.15, 1, 0.85, 1));
  return d;
}

/** Stamp glow intensity at pixel (core, glow) for the given frame. */
export function stampAt(
  digits: number[],
  fr: FrameRect,
  px: number,
  py: number,
  s: number
): [number, number] {
  const gh = s * 0.032; // glyph height
  const unit = gh / 2;
  const adv = unit * 1.45;
  const right = fr.x1 - (fr.x1 - fr.x0) * 0.06;
  const bottom = fr.y1 - (fr.y1 - fr.y0) * 0.05;
  const left = right - adv * digits.length;
  if (px < left - gh || px > right + gh || py < bottom - gh * 2 || py > bottom + gh) {
    return [0, 0];
  }
  const i = Math.floor((px - left) / adv);
  let d = 9;
  for (let k = Math.max(0, i - 1); k <= Math.min(digits.length - 1, i + 1); k++) {
    const gx = (px - (left + k * adv)) / unit;
    const gy = (bottom - py) / unit;
    d = Math.min(d, glyphDist(digits[k], gx, gy));
  }
  const core = 1 - smooth(0.09, 0.17, d);
  const glow = Math.exp(-d * d * 6) * 0.8;
  return [core, glow];
}

const STAMP_CORE = hex3("#ffb14a");
const STAMP_GLOW = hex3("#ff5a12");

/** Disposable-camera flash: gain at normalised radius d (0 centre → 1 corner). */
export function flashGain(flash: number, d: number): number {
  if (flash <= 0) return 1;
  const g = 1.2 + (0.5 - 1.2) * smooth(0.05, 0.95, d);
  return 1 + (g - 1) * flash;
}

// ───────────────────────────────────────────────────────────────────────────
// CPU port. Per-pixel maths is identical to the shader; the spatial passes
// (glow, corner soft, hand-tint bleed) use Canvas2D's native blur instead of
// the shader's spiral taps.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Full CPU film pass, in place on `ctx`'s canvas. Used when WebGPU is
 * unavailable or a sequential (CPU-only) dither forced the CPU pipeline.
 */
export function applyFilmCPU(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  recipeIn: FilmRecipe,
  c: FilmControls
) {
  const r = resolveRecipe(recipeIn, c.seed);
  const s = Math.min(w, h);
  const kind = c.frame ? BORDER_BITS[r.border] : 0;
  const fr = frameRect(kind, w, h);
  const fw = fr.x1 - fr.x0;
  const fh = fr.y1 - fr.y0;

  // Source re-fitted (cover) into the frame window, so a border never squashes.
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  const scale = Math.max(fw / w, fh / h);
  const dw = w * scale;
  const dh = h * scale;
  sctx.drawImage(ctx.canvas, (fr.x0 + fr.x1) / 2 - dw / 2, (fr.y0 + fr.y1) / 2 - dh / 2, dw, dh);

  const blurred = (radiusPx: number) => {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const bctx = cv.getContext("2d", { willReadFrequently: true })!;
    bctx.filter = `blur(${Math.max(0.5, radiusPx)}px)`;
    bctx.drawImage(src, 0, 0);
    return bctx.getImageData(0, 0, w, h).data;
  };

  const bd = sctx.getImageData(0, 0, w, h).data;
  const orig = ctx.getImageData(0, 0, w, h).data;
  const glowAmt = r.glow * c.glow;
  const glowData = glowAmt > 0 ? blurred(r.glowRadius * s * 0.6) : null;
  const softData = r.soft > 0 ? blurred(r.soft * s * 0.5) : null;
  const tintData = r.handTint > 0 ? blurred(s * 0.02) : null;
  const gc = hex3(r.glowColor);
  const vc = hex3(r.vignetteColor);
  const lc = hex3(r.leakColor);
  const paper = hex3(r.paper);
  const g = gradeCtx(r);
  const grainAmt = r.grain * c.grain;
  const vigAmt = r.vignette * c.vignette;
  const leakAmt = r.leak * c.leak;
  const seed = c.seed;
  const thr = r.glowThreshold;
  const digits = r.dateStamp ? stampDigits(seed) : null;

  const out = ctx.createImageData(w, h);
  const od = out.data;
  const cx = (fr.x0 + fr.x1) / 2;
  const cy = (fr.y0 + fr.y1) / 2;
  const caPx = r.ca * s;
  const edgeSoft = kind === 5 ? s * 0.004 : 0.75;

  const at = (x: number, y: number) =>
    (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      const ux = (px - cx) / fw;
      const uy = (py - cy) / fh;
      // 0 at centre, 1 at the frame corner.
      const d = Math.hypot(ux, uy) * Math.SQRT2;
      let R = bd[i] / 255;
      let G = bd[i + 1] / 255;
      let B = bd[i + 2] / 255;
      if (caPx > 0) {
        const off = caPx * d * d;
        const len = Math.hypot(ux, uy) || 1;
        const ox = Math.round((ux / len) * off);
        const oy = Math.round((uy / len) * off);
        R = bd[at(px + ox, py + oy)] / 255;
        B = bd[at(px - ox, py - oy) + 2] / 255;
      }
      if (softData) {
        const k = clamp01(d * d);
        R += (softData[i] / 255 - R) * k;
        G += (softData[i + 1] / 255 - G) * k;
        B += (softData[i + 2] / 255 - B) * k;
      }
      let glow: Vec3 = [0, 0, 0];
      if (glowData) {
        const gl = lum(glowData[i] / 255, glowData[i + 1] / 255, glowData[i + 2] / 255);
        const e = Math.max(0, gl - thr) / Math.max(0.05, 1 - thr);
        const k = e * glowAmt * 1.6;
        glow = [gc[0] * k, gc[1] * k, gc[2] * k];
      }
      let col = gradePixel(g, R, G, B, glow, flashGain(r.flash, d));
      [R, G, B] = col;

      if (tintData) {
        const tr = tintData[i] / 255;
        const tg = tintData[i + 1] / 255;
        const tb = tintData[i + 2] / 255;
        const tl = lum(tr, tg, tb);
        const k = r.handTint * 0.55 * smooth(0.18, 0.6, lum(R, G, B));
        R += (tr - tl) * k;
        G += (tg - tl) * k;
        B += (tb - tl) * k;
      }
      if (r.mosaic > 0) {
        const [dye, edge] = autochrome(px, py, s, seed);
        const mean = (dye[0] + dye[1] + dye[2]) / 3;
        const lamp = 0.85 + 0.15 * edge;
        const k = 0.18 * r.mosaic;
        R *= (1 + k * (dye[0] / mean - 1)) * (1 + (lamp - 1) * r.mosaic);
        G *= (1 + k * (dye[1] / mean - 1)) * (1 + (lamp - 1) * r.mosaic);
        B *= (1 + k * (dye[2] / mean - 1)) * (1 + (lamp - 1) * r.mosaic);
      }
      if (vigAmt > 0) {
        const v = clamp01(vigAmt * Math.pow(d, 1.5 + r.vignetteFalloff * 3));
        R *= 1 + (vc[0] - 1) * v;
        G *= 1 + (vc[1] - 1) * v;
        B *= 1 + (vc[2] - 1) * v;
      }
      if (leakAmt > 0) {
        const e =
          ux * Math.cos(r.leakAngle) +
          uy * Math.sin(r.leakAngle) +
          vnoise(ux * 2.2 + seed, uy * 2.2, seed + 3) * 0.35;
        const k = smooth(0.12, 0.62, e) * leakAmt;
        const hot = k * k * 0.6;
        const lr = lc[0] + (1 - lc[0]) * hot;
        const lg = lc[1] + (0.92 - lc[1]) * hot;
        const lb = lc[2] + (0.7 - lc[2]) * hot;
        R = 1 - (1 - R) * (1 - lr * k);
        G = 1 - (1 - G) * (1 - lg * k);
        B = 1 - (1 - B) * (1 - lb * k);
      }
      if (digits) {
        const [core, gl] = stampAt(digits, fr, px, py, s);
        if (core > 0 || gl > 0.001) {
          const ar = STAMP_GLOW[0] * gl + STAMP_CORE[0] * core;
          const ag = STAMP_GLOW[1] * gl + STAMP_CORE[1] * core;
          const ab = STAMP_GLOW[2] * gl + STAMP_CORE[2] * core;
          R = 1 - (1 - R) * (1 - clamp01(ar));
          G = 1 - (1 - G) * (1 - clamp01(ag));
          B = 1 - (1 - B) * (1 - clamp01(ab));
        }
      }

      const sdf = frameSDF(kind, fr, px, py, s, seed);
      if (kind === 8 && sdf < 0) [R, G, B] = tarnish([R, G, B], sdf, s, px, py, seed);
      const outside = smooth(-edgeSoft, edgeSoft, sdf);
      if (outside > 0) {
        const sc = surround(kind, paper, sdf, px, py, h, s, seed);
        R += (sc[0] - R) * outside;
        G += (sc[1] - G) * outside;
        B += (sc[2] - B) * outside;
      }

      if (grainAmt > 0) {
        // Grain size is specified at a 2048px long edge; scale with the image.
        const gs = Math.max(0.6, (r.grainSize * Math.max(w, h)) / 2048);
        const nx = px / gs;
        const ny = py / gs;
        const mono = vnoise(nx, ny, seed) * 0.7 + vnoise(nx * 2.1, ny * 2.1, seed + 1) * 0.3;
        const ch = r.grainChroma;
        const nr = mono + (vnoise(nx, ny, seed + 11) - mono) * ch;
        const ng = mono + (vnoise(nx, ny, seed + 12) - mono) * ch;
        const nb = mono + (vnoise(nx, ny, seed + 13) - mono) * ch;
        const l = lum(R, G, B);
        const wgt = (0.3 + 2.8 * l * (1 - l)) * grainAmt * 0.32;
        R += nr * wgt;
        G += ng * wgt;
        B += nb * wgt;
      }
      if (r.dust > 0 || r.scratches > 0) {
        const dv = dustAt(px, py, s, r.dust, r.scratches, seed);
        R += (1 - R) * dv;
        G += (1 - G) * dv;
        B += (1 - B) * dv;
      }
      col = [R, G, B];
      const a = c.amount;
      const oR = orig[i] / 255;
      const oG = orig[i + 1] / 255;
      const oB = orig[i + 2] / 255;
      od[i] = Math.round(clamp01(oR + (col[0] - oR) * a) * 255);
      od[i + 1] = Math.round(clamp01(oG + (col[1] - oG) * a) * 255);
      od[i + 2] = Math.round(clamp01(oB + (col[2] - oB) * a) * 255);
      od[i + 3] = orig[i + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
}

function dustAt(px: number, py: number, s: number, dust: number, scratches: number, seed: number): number {
  let v = 0;
  if (dust > 0) {
    const cell = Math.max(8, s / 28);
    const cxI = Math.floor(px / cell);
    const cyI = Math.floor(py / cell);
    if (hash2(cxI, cyI, seed + 41) < dust * 0.22) {
      const sx = (cxI + hash2(cxI, cyI, seed + 42)) * cell;
      const sy = (cyI + hash2(cxI, cyI, seed + 43)) * cell;
      const rad = (0.6 + hash2(cxI, cyI, seed + 44) * 2.2) * Math.max(1, s / 900);
      const dd = Math.hypot(px - sx, py - sy);
      v = Math.max(v, (1 - smooth(rad * 0.5, rad, dd)) * 0.85);
    }
  }
  if (scratches > 0) {
    const col = Math.floor(px / 2);
    if (hash2(col, 0, seed + 51) < scratches * 0.004) {
      const along = vnoise(0, py / (s * 0.08), seed + col) + 0.5;
      v = Math.max(v, smooth(0.45, 0.8, along) * 0.45);
    }
  }
  return v;
}
