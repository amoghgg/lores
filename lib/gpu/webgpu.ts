import { getPalette } from "../palettes";
import { effectiveBlockSize, type Settings } from "../pipeline";
import {
  packFilmUniform,
  FILM_UNIFORM_BYTES,
  type FilmRecipe,
  type FilmControls,
} from "../film";

// ───────────────────────────────────────────────────────────────────────────
// WGSL shader sources
// ───────────────────────────────────────────────────────────────────────────

const VERT = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  // Single fullscreen triangle covering [-1, 3] in both axes
  var p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
`;

// Pixelate via block-decimation: every fragment in the same block samples
// the same anchor texel (the block's center). One texelFetch per fragment,
// independent of block size — vital for the audio-reactive bass pump that
// can push block size up to 48. The previous block-average shader was
// O(blockSize²) per fragment and choked the GPU during live playback.
const FRAG_PIXELATE = /* wgsl */ `
struct Params {
  resolution: vec2f,
  blockSize: u32,
  _pad: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = params.resolution;
  let bs = f32(max(params.blockSize, 1u));
  let blockOrigin = floor(uv * res / bs) * bs;
  let centerPx = vec2i(blockOrigin + vec2f(bs * 0.5));
  let resI = vec2i(res);
  let clamped = clamp(centerPx, vec2i(0), resI - vec2i(1));
  return textureLoad(src, clamped, 0);
}
`;

// Grid downsample: one output texel per block, the average of a 4×4 sample
// lattice inside that block. Palette and dither then run at grid resolution,
// so patterns land on the pixel-art grid instead of dissolving each block.
const FRAG_DOWNSAMPLE = /* wgsl */ `
struct Params {
  srcRes: vec2f,
  grid: vec2f,
  block: f32,
  _p0: f32,
  _p1: vec2f,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> p: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = floor(uv * p.grid);
  let origin = cell * p.block;
  let maxPx = vec2i(p.srcRes) - vec2i(1);
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j = j + 1) {
    for (var i = 0; i < 4; i = i + 1) {
      let o = origin + (vec2f(f32(i), f32(j)) + 0.5) * p.block * 0.25;
      acc = acc + textureLoad(src, clamp(vec2i(o), vec2i(0), maxPx), 0);
    }
  }
  return acc / 16.0;
}
`;

// Grid upscale: every full-res pixel reads its block's grid texel — hard edges.
const FRAG_UPSCALE = /* wgsl */ `
struct Params {
  srcRes: vec2f,
  grid: vec2f,
  block: f32,
  _p0: f32,
  _p1: vec2f,
};

@group(0) @binding(0) var grid: texture_2d<f32>;
@group(0) @binding(1) var<uniform> p: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = vec2i(floor(uv * p.srcRes / p.block));
  return textureLoad(grid, clamp(cell, vec2i(0), vec2i(p.grid) - vec2i(1)), 0);
}
`;

const FRAG_QUANTIZE = /* wgsl */ `
struct Palette {
  count: u32,
  _p1: u32,
  _p2: u32,
  _p3: u32,
  colors: array<vec4f, 32>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> pal: Palette;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(src, samp, uv, 0.0);
  var best: vec3f = pal.colors[0].rgb;
  var bestDist: f32 = 1e9;
  for (var i: u32 = 0u; i < 32u; i = i + 1u) {
    if (i >= pal.count) { break; }
    let p = pal.colors[i].rgb;
    let d = c.rgb - p;
    let dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return vec4f(best, c.a);
}
`;

const FRAG_BAYER = /* wgsl */ `
struct Params {
  resolution: vec2f,
  paletteCount: u32,
  matrixSize: u32,
  colors: array<vec4f, 32>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

const BAYER4 = array<f32, 16>(
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);

const BAYER8 = array<f32, 64>(
  0.0, 32.0, 8.0, 40.0, 2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0, 4.0, 36.0, 14.0, 46.0, 6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
  3.0, 35.0, 11.0, 43.0, 1.0, 33.0, 9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0, 7.0, 39.0, 13.0, 45.0, 5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = vec2u(uv * params.resolution);
  var t: f32;
  if (params.matrixSize == 4u) {
    let bx = px.x % 4u;
    let by = px.y % 4u;
    t = (BAYER4[by * 4u + bx] / 16.0) - 0.5;
  } else {
    let bx = px.x % 8u;
    let by = px.y % 8u;
    t = (BAYER8[by * 8u + bx] / 64.0) - 0.5;
  }
  let c = textureSampleLevel(src, samp, uv, 0.0);
  let biased = clamp(c.rgb + vec3f(t * 0.25), vec3f(0.0), vec3f(1.0));

  var best: vec3f = params.colors[0].rgb;
  var bestDist: f32 = 1e9;
  for (var i: u32 = 0u; i < 32u; i = i + 1u) {
    if (i >= params.paletteCount) { break; }
    let p = params.colors[i].rgb;
    let d = biased - p;
    let dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return vec4f(best, c.a);
}
`;

// Blue noise dither — samples a precomputed 64×64 LUT (generated at init).
// Perceptually flat, no Bayer-style geometric patterns. Sampler is nearest +
// repeat so the LUT tiles cleanly across the source.
const FRAG_BLUENOISE = /* wgsl */ `
struct Params {
  resolution: vec2f,
  paletteCount: u32,
  strength: f32,
  colors: array<vec4f, 32>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var noise: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = vec2u(uv * params.resolution);
  let nuv = vec2i(i32(px.x % 64u), i32(px.y % 64u));
  let n = textureLoad(noise, nuv, 0).r - 0.5;
  let c = textureSampleLevel(src, samp, uv, 0.0);
  let biased = clamp(c.rgb + vec3f(n * params.strength), vec3f(0.0), vec3f(1.0));

  var best: vec3f = params.colors[0].rgb;
  var bestDist: f32 = 1e9;
  for (var i: u32 = 0u; i < 32u; i = i + 1u) {
    if (i >= params.paletteCount) { break; }
    let p = params.colors[i].rgb;
    let d = biased - p;
    let dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return vec4f(best, c.a);
}
`;

// Interleaved Gradient Noise (Jorge Jimenez / Frostbite). Hash-based, no LUT.
// Tiny but pleasing pattern, ~zero memory cost.
const FRAG_IGN = /* wgsl */ `
struct Params {
  resolution: vec2f,
  paletteCount: u32,
  strength: f32,
  colors: array<vec4f, 32>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

fn ign(p: vec2f) -> f32 {
  let m = vec3f(0.06711056, 0.00583715, 52.9829189);
  return fract(m.z * fract(dot(p, m.xy)));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * params.resolution;
  let n = ign(px) - 0.5;
  let c = textureSampleLevel(src, samp, uv, 0.0);
  let biased = clamp(c.rgb + vec3f(n * params.strength), vec3f(0.0), vec3f(1.0));

  var best: vec3f = params.colors[0].rgb;
  var bestDist: f32 = 1e9;
  for (var i: u32 = 0u; i < 32u; i = i + 1u) {
    if (i >= params.paletteCount) { break; }
    let p = params.colors[i].rgb;
    let d = biased - p;
    let dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return vec4f(best, c.a);
}
`;

// Halftone dot-screen — Photoshop-style "Color Halftone" feel. Each cell maps
// luminance to a dot radius; bias the source toward white/black accordingly,
// then quantize to palette so colors stay in the chosen aesthetic.
const FRAG_HALFTONE = /* wgsl */ `
struct Params {
  resolution: vec2f,
  paletteCount: u32,
  cellSize: u32,
  colors: array<vec4f, 32>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * params.resolution;
  let cs = f32(max(params.cellSize, 2u));
  let cell = floor(px / cs);
  let cellCenter = (cell + vec2f(0.5)) * cs;
  let centerPx = vec2i(clamp(cellCenter, vec2f(0.0), params.resolution - vec2f(1.0)));
  let centerCol = textureLoad(src, centerPx, 0);
  let lum = dot(centerCol.rgb, vec3f(0.299, 0.587, 0.114));
  let r = length(px - cellCenter) / (cs * 0.5);
  let radius = sqrt(clamp(1.0 - lum, 0.0, 1.0));
  let inside = step(r, radius);
  // inside dot = pull toward black; outside = pull toward white
  let bias = (inside * 2.0 - 1.0) * (-0.4);
  let biased = clamp(centerCol.rgb + vec3f(bias), vec3f(0.0), vec3f(1.0));

  var best: vec3f = params.colors[0].rgb;
  var bestDist: f32 = 1e9;
  for (var i: u32 = 0u; i < 32u; i = i + 1u) {
    if (i >= params.paletteCount) { break; }
    let p = params.colors[i].rgb;
    let d = biased - p;
    let dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return vec4f(best, centerCol.a);
}
`;

// User-uploaded texture overlay with Photoshop-style blend modes. Single pass:
// resample texture in fit/cover/tile space, then composite onto the dithered
// source via blendMode + opacity.
const FRAG_OVERLAY = /* wgsl */ `
struct Params {
  resolution: vec2f,
  textureSize: vec2f,
  blendMode: u32,
  fitMode: u32,
  opacity: f32,
  _pad: f32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var overlay: texture_2d<f32>;
@group(0) @binding(3) var<uniform> p: Params;

fn softLight1(b: f32, s: f32) -> f32 {
  // Photoshop soft-light formula
  if (s <= 0.5) {
    return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  }
  var d: f32;
  if (b <= 0.25) {
    d = ((16.0 * b - 12.0) * b + 4.0) * b;
  } else {
    d = sqrt(b);
  }
  return b + (2.0 * s - 1.0) * (d - b);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(src, samp, uv, 0.0);

  var tUV: vec2f;
  var inBounds: bool = true;

  if (p.fitMode == 1u) {
    tUV = fract(uv * p.resolution / max(p.textureSize, vec2f(1.0)));
  } else {
    let sx = p.resolution.x / max(p.textureSize.x, 1.0);
    let sy = p.resolution.y / max(p.textureSize.y, 1.0);
    var sFac: f32;
    if (p.fitMode == 0u) { sFac = max(sx, sy); }
    else { sFac = min(sx, sy); }
    let centerOffset = uv * p.resolution - p.resolution * 0.5;
    let texPx = centerOffset / sFac + p.textureSize * 0.5;
    tUV = texPx / max(p.textureSize, vec2f(1.0));
    if (p.fitMode == 2u) {
      inBounds = tUV.x >= 0.0 && tUV.x <= 1.0 && tUV.y >= 0.0 && tUV.y <= 1.0;
    } else {
      tUV = clamp(tUV, vec2f(0.0), vec2f(1.0));
    }
  }

  if (!inBounds) { return base; }

  let tex = textureSampleLevel(overlay, samp, tUV, 0.0);
  let effOpacity = tex.a * p.opacity;

  let b = base.rgb;
  let s = tex.rgb;
  var blended: vec3f;

  if (p.blendMode == 0u) {
    blended = s;
  } else if (p.blendMode == 1u) {
    blended = b * s;
  } else if (p.blendMode == 2u) {
    blended = vec3f(1.0) - (vec3f(1.0) - b) * (vec3f(1.0) - s);
  } else if (p.blendMode == 3u) {
    blended = select(
      vec3f(1.0) - 2.0 * (vec3f(1.0) - b) * (vec3f(1.0) - s),
      2.0 * b * s,
      b < vec3f(0.5)
    );
  } else if (p.blendMode == 4u) {
    blended = vec3f(
      softLight1(b.x, s.x),
      softLight1(b.y, s.y),
      softLight1(b.z, s.z)
    );
  } else if (p.blendMode == 5u) {
    blended = select(
      vec3f(1.0) - 2.0 * (vec3f(1.0) - b) * (vec3f(1.0) - s),
      2.0 * b * s,
      s < vec3f(0.5)
    );
  } else if (p.blendMode == 6u) {
    blended = abs(b - s);
  } else {
    let denom = max(s, vec3f(0.001));
    blended = clamp(vec3f(1.0) - (vec3f(1.0) - b) / denom, vec3f(0.0), vec3f(1.0));
  }

  let outRgb = mix(b, blended, effOpacity);
  return vec4f(outRgb, base.a);
}
`;

// Film emulation — mirrors applyFilmCPU / gradePixel in lib/film.ts.
// Order: frame remap → CA + corner softness → halation taps → grade (with
// flash) → hand-tint → autochrome → vignette → leak → date stamp → frame
// surround → grain → dust → amount mix.
const FRAG_FILM = /* wgsl */ `
struct Film {
  head: vec4f,        // res.xy, seed, amount
  mixR: vec4f, mixG: vec4f, mixB: vec4f,
  wb: vec4f,          // rgb, exposure stops
  curve: vec4f,       // contrast, shoulder, sat, balance
  gamma: vec4f,
  lift: vec4f,        // rgb, toneMix
  gain: vec4f,
  hue: array<vec4f, 3>,   // 12 bands, 30° apart
  sat: array<vec4f, 3>,
  lum: array<vec4f, 3>,
  shadowTint: vec4f,  // rgb, amount
  highTint: vec4f,
  tone0: vec4f, tone1: vec4f, tone2: vec4f,
  glowColor: vec4f,   // rgb, strength
  glowP: vec4f,       // threshold, radius, soft, ca
  grain: vec4f,       // amount, size, chroma, time
  vig: vec4f,         // amount, falloff
  vigColor: vec4f,
  leak: vec4f,        // amount, angle
  leakColor: vec4f,
  fx: vec4f,          // dust, scratches, border kind
  paper: vec4f,
  fx2: vec4f,         // flash, mosaic, handTint, dateStamp
  tone3: vec4f, tone4: vec4f,   // tone0..4 = ramp stops at 0, ¼, ½, ¾, 1
  quant: vec4f,       // mode, levels, cell px (2048 basis), simplify px
  plateA: vec4f,      // dx, dy (2048 basis), amount
  plateAColor: vec4f,
  plateB: vec4f,
  plateBColor: vec4f,
  fx3: vec4f,         // scanlines, chroma bleed px, smear, sharpen
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> F: Film;

const LUMA = vec3f(0.2126, 0.7152, 0.0722);
const GOLDEN = 2.39996323;

fn hash2(x: i32, y: i32, s: i32) -> f32 {
  var h: u32 = (bitcast<u32>(x) * 0x8da6b343u) ^ (bitcast<u32>(y) * 0xd8163841u) ^ (bitcast<u32>(s) * 0xcb1ab31fu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return f32(h) / 4294967296.0;
}

fn vnoise(p: vec2f, s: i32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i.x, i.y, s);
  let b = hash2(i.x + 1, i.y, s);
  let c = hash2(i.x, i.y + 1, s);
  let d = hash2(i.x + 1, i.y + 1, s);
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y - 0.5;
}

fn at12(b: array<vec4f, 3>, i: u32) -> f32 {
  let v = b[i / 4u];
  let c = i % 4u;
  if (c == 0u) { return v.x; }
  if (c == 1u) { return v.y; }
  if (c == 2u) { return v.z; }
  return v.w;
}

fn band(b: array<vec4f, 3>, h: f32) -> f32 {
  let x = h * 12.0;
  let i0 = u32(floor(x)) % 12u;
  let i1 = (i0 + 1u) % 12u;
  let t = x - floor(x);
  return at12(b, i0) * (1.0 - t) + at12(b, i1) * t;
}

// Hue shifts (in turns) interpolate along the shortest arc.
fn hueBand(b: array<vec4f, 3>, h: f32) -> f32 {
  let x = h * 12.0;
  let i0 = u32(floor(x)) % 12u;
  let i1 = (i0 + 1u) % 12u;
  let t = x - floor(x);
  let a = at12(b, i0);
  var d = at12(b, i1) - a;
  d = d - round(d);
  return a + d * t;
}

fn rgb2hsv(c: vec3f) -> vec3f {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let d = mx - mn;
  var h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) { h = (c.g - c.b) / d; }
    else if (mx == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
    if (h < 0.0) { h = h + 6.0; }
    h = h / 6.0;
  }
  var s = 0.0;
  if (mx > 1e-6) { s = d / mx; }
  return vec3f(fract(h), s, mx);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let k = (vec3f(5.0, 3.0, 1.0) + c.x * 6.0) % vec3f(6.0);
  return c.z - c.z * c.y * clamp(min(k, 4.0 - k), vec3f(0.0), vec3f(1.0));
}

fn curve1(v0: f32, gamma: f32, lift: f32, gain: f32) -> f32 {
  var v = clamp(v0, 0.0, 1.0);
  let s = v * v * (3.0 - 2.0 * v);
  v = v + F.curve.x * (s - v);
  let sh = F.curve.y;
  if (sh > 0.0) { v = (v * (1.0 + sh)) / (1.0 + sh * v); }
  v = pow(clamp(v, 0.0, 1.0), 1.0 / gamma);
  return lift + v * (gain - lift);
}

const BAYER8Q = array<f32, 64>(
  0.0, 32.0, 8.0, 40.0, 2.0, 34.0, 10.0, 42.0, 48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0, 4.0, 36.0, 14.0, 46.0, 6.0, 38.0, 60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
  3.0, 35.0, 11.0, 43.0, 1.0, 33.0, 9.0, 41.0, 51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0, 7.0, 39.0, 13.0, 45.0, 5.0, 37.0, 63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

// Luminance quantisers for the Afterdark looks — mirrors quantize() in film.ts.
fn quantize(l: f32, p: vec2f) -> f32 {
  let mode = u32(F.quant.x);
  if (mode == 0u) { return l; }
  let n = max(2.0, F.quant.y);
  let longEdge = max(F.head.x, F.head.y);
  let cell = max(1.0, F.quant.z * longEdge / 2048.0);
  if (mode == 1u) {
    return min(n - 1.0, floor(l * n)) / (n - 1.0);
  }
  if (mode == 2u) {
    let ci = vec2u(floor(p / cell)) % vec2u(8u);
    let t = BAYER8Q[ci.y * 8u + ci.x] / 64.0 - 0.5;
    return floor(clamp(l * (n - 1.0) + t + 0.5, 0.0, n - 1.0)) / (n - 1.0);
  }
  if (mode == 3u) {
    let a = 0.78539816;
    let uu = (p.x * cos(a) + p.y * sin(a)) / cell;
    let vv = (-p.x * sin(a) + p.y * cos(a)) / cell;
    let f = vec2f(uu - floor(uu) - 0.5, vv - floor(vv) - 0.5);
    return select(1.0, 0.0, length(f) < sqrt(max(0.0, 1.0 - l)) * 0.62);
  }
  if (l < 0.75 && hash2(i32(p.x), i32(p.y), 9) < 0.012) { return 0.0; }
  return step(0.5, l + vnoise(p / cell, 4) * 0.35);
}

fn ramp5(l: f32) -> vec3f {
  let seg = min(3.0, floor(l * 4.0));
  let t = l * 4.0 - seg;
  if (seg < 1.0) { return mix(F.tone0.xyz, F.tone1.xyz, t); }
  if (seg < 2.0) { return mix(F.tone1.xyz, F.tone2.xyz, t); }
  if (seg < 3.0) { return mix(F.tone2.xyz, F.tone3.xyz, t); }
  return mix(F.tone3.xyz, F.tone4.xyz, t);
}

fn grade(cin: vec3f, glow: vec3f, expGain: f32, p: vec2f) -> vec4f {
  var c = vec3f(dot(F.mixR.xyz, cin), dot(F.mixG.xyz, cin), dot(F.mixB.xyz, cin));
  c = clamp(c * F.wb.xyz * exp2(F.wb.w) * expGain + glow, vec3f(0.0), vec3f(1.0));

  let hsv = rgb2hsv(c);
  let nh = fract(hsv.x + hueBand(F.hue, hsv.x));
  let ns = clamp(hsv.y * band(F.sat, hsv.x) * F.curve.z, 0.0, 1.0);
  let nv = hsv.z * (1.0 + (band(F.lum, hsv.x) - 1.0) * hsv.y);
  c = hsv2rgb(vec3f(nh, ns, nv));

  c = vec3f(
    curve1(c.r, F.gamma.x, F.lift.x, F.gain.x),
    curve1(c.g, F.gamma.y, F.lift.y, F.gain.y),
    curve1(c.b, F.gamma.z, F.lift.z, F.gain.z)
  );

  let l = dot(c, LUMA);
  let ws = 1.0 - smoothstep(0.0, 0.55 + F.curve.w, l);
  let wh = smoothstep(0.45 + F.curve.w, 1.0, l);
  let st = F.shadowTint.xyz - dot(F.shadowTint.xyz, LUMA);
  let ht = F.highTint.xyz - dot(F.highTint.xyz, LUMA);
  c = c + st * F.shadowTint.w * ws + ht * F.highTint.w * wh;

  let tm = F.lift.w;
  var level = clamp(dot(c, LUMA), 0.0, 1.0);
  if (tm > 0.0) {
    level = quantize(level, p);
    c = mix(c, ramp5(level), tm);
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), level);
}

fn frameRect(kind: u32, res: vec2f) -> vec4f {
  let s = min(res.x, res.y);
  switch (kind) {
    case 1u: { return vec4f(s * 0.055, s * 0.06, res.x - s * 0.055, res.y - s * 0.235); }
    case 4u: { return vec4f(s * 0.07, s * 0.085, res.x - s * 0.07, res.y - s * 0.21); }
    case 2u: { return vec4f(s * 0.045, s * 0.045, res.x - s * 0.045, res.y - s * 0.045); }
    case 3u: { return vec4f(s * 0.035, s * 0.035, res.x - s * 0.035, res.y - s * 0.035); }
    case 6u: { return vec4f(s * 0.065, s * 0.065, res.x - s * 0.065, res.y - s * 0.065); }
    case 7u: { return vec4f(s * 0.05, s * 0.05, res.x - s * 0.05, res.y - s * 0.05); }
    case 5u: {
      var ih = res.y * 0.86;
      var iw = ih * 1.36;
      if (iw > res.x * 0.9) { iw = res.x * 0.9; ih = iw / 1.36; }
      return vec4f((res.x - iw) * 0.5, (res.y - ih) * 0.5, (res.x + iw) * 0.5, (res.y + ih) * 0.5);
    }
    case 8u: { return vec4f(s * 0.1, s * 0.08, res.x - s * 0.1, res.y - s * 0.08); }
    case 10u: { return vec4f(s * 0.05, s * 0.05, res.x - s * 0.05, res.y - s * 0.05); }
    case 9u: {
      let ih = min(res.y, res.x / 2.39);
      return vec4f(0.0, (res.y - ih) * 0.5, res.x, (res.y + ih) * 0.5);
    }
    default: { return vec4f(0.0, 0.0, res.x, res.y); }
  }
}

fn frameSDF(kind: u32, fr: vec4f, p: vec2f, s: f32, seed: i32) -> f32 {
  if (kind == 0u) { return -1e4; }
  let c = (fr.xy + fr.zw) * 0.5;
  if (kind == 8u) {
    let ax = (fr.z - fr.x) * 0.5;
    let ay = (fr.w - fr.y) * 0.5;
    let k = length(vec2f((p.x - c.x) / ax, (p.y - c.y) / ay));
    return (k - 1.0) * min(ax, ay);
  }
  var corner = array<f32, 11>(0.0, 0.004, 0.012, 0.02, 0.004, 0.0, 0.004, 0.01, 0.0, 0.0, 0.0);
  var rr = corner[kind] * s;
  if (kind == 5u) { rr = (fr.w - fr.y) * 0.07; }
  let hsz = (fr.zw - fr.xy) * 0.5 - vec2f(rr);
  let q = abs(p - c) - hsz;
  var d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rr;
  if (kind == 3u) {
    d = d + vnoise(p / (s * 0.01), seed + 77) * s * 0.012;
  } else if (kind == 6u) {
    var along = p.x;
    if (q.x > q.y) { along = p.y; }
    d = d + sin(along / (s * 0.022) * 6.2831853) * s * 0.006;
  } else if (kind == 7u) {
    d = d + vnoise(p / (s * 0.06), seed + 78) * s * 0.06
          + vnoise(vec2f(p.x / (s * 0.006), p.y / (s * 0.03)), seed + 79) * s * 0.01;
  } else if (kind == 10u) {
    // Torn photocopy edge: big rips, fibre streaks on both axes, fine bite.
    d = d + vnoise(p / (s * 0.05), seed + 140) * s * 0.07
          + vnoise(vec2f(p.x / (s * 0.004), p.y / (s * 0.12)), seed + 141) * s * 0.025
          + vnoise(vec2f(p.x / (s * 0.12), p.y / (s * 0.004)), seed + 142) * s * 0.025
          + vnoise(p / (s * 0.008), seed + 143) * s * 0.012;
  }
  return d;
}

// Ink specks and scratches clustered just inside a grunge border.
fn grungeSpeck(p: vec2f, s: f32, sdf: f32, seed: i32) -> f32 {
  let edge = clamp(1.0 + sdf / (s * 0.14), 0.0, 1.0);
  if (edge <= 0.0) { return 0.0; }
  let c = max(2.0, s / 360.0);
  let h = hash2(i32(floor(p.x / c)), i32(floor(p.y / c)), seed + 123);
  var v = select(0.0, 0.9, h > 1.0 - 0.09 * edge * edge);
  let band = i32(floor(p.x / max(2.0, s / 500.0)));
  if (hash2(band, 0, seed + 130) < 0.05 * edge) { v = max(v, 0.45 * edge); }
  return v;
}

fn surround(kind: u32, sdf: f32, p: vec2f, h: f32, s: f32, seed: i32) -> vec3f {
  let paper = F.paper.xyz;
  let pn = vnoise(p / 3.0, seed + 91) * 0.04;
  if (kind == 8u) {
    let sheen = 0.75 + 0.35 * sin(p.y / h * 3.14159265 * 3.0 + 0.6);
    let bevel = exp(-sdf / (s * 0.006)) * 0.35;
    return paper * sheen + vec3f(bevel, bevel * 0.85, bevel * 0.5) + vec3f(pn);
  }
  if (kind == 7u) {
    let k = exp(-sdf / (s * 0.02));
    let streak = 0.75 + 0.5 * vnoise(vec2f(p.x / (s * 0.003), p.y / (s * 0.04)), seed + 80);
    return paper * k * streak + vec3f(0.04, 0.035, 0.03);
  }
  return paper + vec3f(pn);
}

fn tarnish(c: vec3f, sdf: f32, s: f32, p: vec2f, seed: i32) -> vec3f {
  let t = clamp(-sdf / (s * 0.1), 0.0, 1.0);
  if (t >= 1.0) { return c; }
  let n = vnoise(p / (s * 0.05), seed + 61) + 0.5;
  let tt = clamp(t + (n - 0.5) * 0.3, 0.0, 1.0);
  var col: vec3f;
  if (tt < 0.5) { col = mix(vec3f(0.180, 0.361, 0.612), vec3f(0.541, 0.227, 0.478), tt * 2.0); }
  else { col = mix(vec3f(0.541, 0.227, 0.478), vec3f(0.788, 0.635, 0.271), (tt - 0.5) * 2.0); }
  return mix(c, col, (1.0 - tt) * 0.45 * n);
}

// Returns (dye rgb, lampblack edge factor).
fn autochrome(p: vec2f, s: f32, seed: i32) -> vec4f {
  let cell = max(2.2, s / 600.0);
  let g = vec2i(floor(p / cell));
  var d1 = 1e9;
  var d2 = 1e9;
  var best = g;
  for (var oy = -1; oy <= 1; oy = oy + 1) {
    for (var ox = -1; ox <= 1; ox = ox + 1) {
      let cc = g + vec2i(ox, oy);
      let fp = (vec2f(cc) + vec2f(hash2(cc.x, cc.y, seed + 31), hash2(cc.x, cc.y, seed + 32))) * cell;
      let d = length(p - fp);
      if (d < d1) { d2 = d1; d1 = d; best = cc; }
      else if (d < d2) { d2 = d; }
    }
  }
  let bias = vnoise(vec2f(best) / 5.0, seed + 33) * 0.5;
  let idx = u32(floor(clamp(hash2(best.x, best.y, seed + 34) + bias, 0.0, 1.0) * 2.999));
  var dyes = array<vec3f, 3>(
    vec3f(0.878, 0.400, 0.184),
    vec3f(0.310, 0.604, 0.290),
    vec3f(0.353, 0.310, 0.659)
  );
  return vec4f(dyes[idx], smoothstep(0.0, cell * 0.18, d2 - d1));
}

fn segDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t);
}

fn glyphDist(code: i32, p0: vec2f) -> f32 {
  if (code == -1) { return 9.0; }
  if (code == -2) { return segDist(p0, vec2f(0.5, 1.95), vec2f(0.4, 1.6)); }
  var seg = array<u32, 10>(63u, 6u, 91u, 79u, 102u, 109u, 125u, 7u, 127u, 111u);
  let m = seg[u32(code)];
  let p = vec2f(p0.x - p0.y * 0.12, p0.y);
  var d = 9.0;
  if ((m & 1u) != 0u) { d = min(d, segDist(p, vec2f(0.15, 2.0), vec2f(0.85, 2.0))); }
  if ((m & 2u) != 0u) { d = min(d, segDist(p, vec2f(0.9, 1.95), vec2f(0.9, 1.05))); }
  if ((m & 4u) != 0u) { d = min(d, segDist(p, vec2f(0.9, 0.95), vec2f(0.9, 0.05))); }
  if ((m & 8u) != 0u) { d = min(d, segDist(p, vec2f(0.15, 0.0), vec2f(0.85, 0.0))); }
  if ((m & 16u) != 0u) { d = min(d, segDist(p, vec2f(0.1, 0.95), vec2f(0.1, 0.05))); }
  if ((m & 32u) != 0u) { d = min(d, segDist(p, vec2f(0.1, 1.95), vec2f(0.1, 1.05))); }
  if ((m & 64u) != 0u) { d = min(d, segDist(p, vec2f(0.15, 1.0), vec2f(0.85, 1.0))); }
  return d;
}

fn stampDigit(seed: i32, k: i32) -> i32 {
  var years = array<i32, 9>(95, 96, 97, 98, 99, 0, 1, 2, 3);
  let yy = years[u32(floor(hash2(seed, 1, 71) * 9.0)) % 9u];
  let mm = 1 + i32(floor(hash2(seed, 2, 72) * 12.0));
  let dd = 1 + i32(floor(hash2(seed, 3, 73) * 28.0));
  switch (k) {
    case 0: { return -2; }
    case 1: { return yy / 10; }
    case 2: { return yy % 10; }
    case 4: { if (mm >= 10) { return 1; } return -1; }
    case 5: { return mm % 10; }
    case 7: { return dd / 10; }
    case 8: { return dd % 10; }
    default: { return -1; }
  }
}

fn stampAt(fr: vec4f, p: vec2f, s: f32, seed: i32) -> vec2f {
  let gh = s * 0.032;
  let unit = gh * 0.5;
  let adv = unit * 1.45;
  let right = fr.z - (fr.z - fr.x) * 0.06;
  let bottom = fr.w - (fr.w - fr.y) * 0.05;
  let left = right - adv * 9.0;
  if (p.x < left - gh || p.x > right + gh || p.y < bottom - gh * 2.0 || p.y > bottom + gh) {
    return vec2f(0.0);
  }
  let i = i32(floor((p.x - left) / adv));
  var d = 9.0;
  for (var k = max(0, i - 1); k <= min(8, i + 1); k = k + 1) {
    let g = vec2f((p.x - (left + f32(k) * adv)) / unit, (bottom - p.y) / unit);
    d = min(d, glyphDist(stampDigit(seed, k), g));
  }
  return vec2f(1.0 - smoothstep(0.09, 0.17, d), exp(-d * d * 6.0) * 0.8);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = F.head.xy;
  let s = min(res.x, res.y);
  let seed = i32(F.head.z);
  let p = uv * res;
  let orig = textureSampleLevel(src, samp, uv, 0.0);

  let kind = u32(F.fx.z);
  let fr = frameRect(kind, res);
  let fsz = fr.zw - fr.xy;
  let fc = (fr.xy + fr.zw) * 0.5;
  let scale = max(fsz.x / res.x, fsz.y / res.y);
  var suv = ((p - fc) / scale + res * 0.5) / res;
  let k2048 = max(res.x, res.y) / 2048.0;

  // Smear: bands of rows dragged sideways (tracking errors, witch-house drag).
  if (F.fx3.z > 0.0) {
    let band = i32(floor(p.y / max(2.0, s * 0.012)));
    if (hash2(band, 7, seed) < F.fx3.z * 0.35) {
      suv.x = suv.x + (hash2(band, 8, seed) - 0.5) * 0.12;
    }
  }

  let u = (p - fc) / fsz;
  let d = length(u) * 1.41421356;

  var c = textureSampleLevel(src, samp, suv, 0.0).rgb;

  let rot0 = hash2(i32(p.x), i32(p.y), seed + 5) * 6.2831853;
  // Simplify: soften shapes before posterize — Photoshop "Cutout" feel.
  if (F.quant.w > 0.0) {
    let R = F.quant.w * k2048;
    var acc = c;
    for (var i = 0; i < 12; i = i + 1) {
      let fi = f32(i) + 0.5;
      let a = fi * GOLDEN + rot0;
      acc = acc + textureSampleLevel(src, samp, suv + vec2f(cos(a), sin(a)) * sqrt(fi / 12.0) * R / res, 0.0).rgb;
    }
    c = acc / 13.0;
  }
  // VHS chroma bleed: luma stays sharp, colour smears sideways.
  if (F.fx3.y > 0.0) {
    let R = F.fx3.y * k2048;
    var ch = vec3f(0.0);
    for (var i = -3; i <= 3; i = i + 1) {
      let t = textureSampleLevel(src, samp, suv + vec2f(f32(i) * R / 3.0 / res.x, 0.0), 0.0).rgb;
      ch = ch + (t - vec3f(dot(t, LUMA)));
    }
    c = vec3f(dot(c, LUMA)) + ch / 7.0;
  }
  // Sharpen: unsharp against a 1px cross.
  if (F.fx3.w > 0.0) {
    let o = vec2f(1.0) / res;
    let nb = (textureSampleLevel(src, samp, suv + vec2f(o.x, 0.0), 0.0).rgb
            + textureSampleLevel(src, samp, suv - vec2f(o.x, 0.0), 0.0).rgb
            + textureSampleLevel(src, samp, suv + vec2f(0.0, o.y), 0.0).rgb
            + textureSampleLevel(src, samp, suv - vec2f(0.0, o.y), 0.0).rgb) * 0.25;
    c = clamp(c + (c - nb) * F.fx3.w * 1.5, vec3f(0.0), vec3f(1.0));
  }

  let ca = F.glowP.w * s;
  if (ca > 0.0) {
    let dir = u / max(length(u), 1e-4);
    let off = dir * ca * d * d / res;
    c.r = textureSampleLevel(src, samp, suv + off, 0.0).r;
    c.b = textureSampleLevel(src, samp, suv - off, 0.0).b;
  }

  let rot = hash2(i32(p.x), i32(p.y), seed + 5) * 6.2831853;

  if (F.glowP.z > 0.0) {
    let softR = F.glowP.z * s * d * d;
    var acc = c;
    for (var i = 0; i < 12; i = i + 1) {
      let fi = f32(i) + 0.5;
      let r = sqrt(fi / 12.0) * softR;
      let a = fi * GOLDEN + rot;
      acc = acc + textureSampleLevel(src, samp, suv + vec2f(cos(a), sin(a)) * r / res, 0.0).rgb;
    }
    c = acc / 13.0;
  }

  var glow = vec3f(0.0);
  let gAmt = F.glowColor.w;
  if (gAmt > 0.0) {
    let R = F.glowP.y * s;
    let thr = F.glowP.x;
    var e = 0.0;
    var wsum = 0.0;
    for (var i = 0; i < 20; i = i + 1) {
      let fi = f32(i) + 0.5;
      let t = sqrt(fi / 20.0);
      let a = fi * GOLDEN + rot;
      let tap = textureSampleLevel(src, samp, suv + vec2f(cos(a), sin(a)) * t * R / res, 0.0).rgb;
      let wgt = exp(-t * t * 2.5);
      e = e + max(0.0, dot(tap, LUMA) - thr) * wgt;
      wsum = wsum + wgt;
    }
    e = e / (wsum * max(0.05, 1.0 - thr));
    glow = F.glowColor.xyz * e * gAmt * 1.6;
  }

  var flashG = 1.0;
  if (F.fx2.x > 0.0) {
    flashG = 1.0 + (mix(1.2, 0.5, smoothstep(0.05, 0.95, d)) - 1.0) * F.fx2.x;
  }
  let graded = grade(c, glow, flashG, p);
  c = graded.rgb;

  // Misregistered plates: colour where a neighbour (offset) is ink but this
  // pixel isn't — the yellow/red fringe on print-artefact edits.
  if (F.plateA.z > 0.0 || F.plateB.z > 0.0) {
    // Only on genuinely light pixels next to ink — real misregistration shows
    // at shape edges, not throughout a dithered shadow.
    let lightHere = graded.w > 0.6;
    if (lightHere) {
      for (var pi = 0; pi < 2; pi = pi + 1) {
        var pl = F.plateA;
        var plc = F.plateAColor.xyz;
        if (pi == 1) { pl = F.plateB; plc = F.plateBColor.xyz; }
        if (pl.z <= 0.0) { continue; }
        let pp = p - pl.xy * k2048;
        let puv = ((pp - fc) / scale + res * 0.5) / res;
        let nb = grade(textureSampleLevel(src, samp, puv, 0.0).rgb, vec3f(0.0), 1.0, pp);
        if (nb.w < 0.2) { c = mix(c, plc, pl.z); break; }
      }
    }
  }

  if (F.fx2.z > 0.0) {
    // Hand-tint: wide blurred chroma bleeding past edges, gone in the shadows.
    let R = s * 0.02;
    var acc = vec3f(0.0);
    for (var i = 0; i < 16; i = i + 1) {
      let fi = f32(i) + 0.5;
      let r = sqrt(fi / 16.0) * R;
      let a = fi * GOLDEN + rot;
      acc = acc + textureSampleLevel(src, samp, suv + vec2f(cos(a), sin(a)) * r / res, 0.0).rgb;
    }
    acc = acc / 16.0;
    let k = F.fx2.z * 0.55 * smoothstep(0.18, 0.6, dot(c, LUMA));
    c = c + (acc - dot(acc, LUMA)) * k;
  }

  if (F.fx2.y > 0.0) {
    let ac = autochrome(p, s, seed);
    let mean = (ac.r + ac.g + ac.b) / 3.0;
    let lamp = 0.85 + 0.15 * ac.w;
    c = c * (vec3f(1.0) + 0.18 * F.fx2.y * (ac.rgb / mean - vec3f(1.0))) * (1.0 + (lamp - 1.0) * F.fx2.y);
  }

  let vAmt = F.vig.x;
  if (vAmt > 0.0) {
    let v = clamp(vAmt * pow(d, 1.5 + F.vig.y * 3.0), 0.0, 1.0);
    c = c * mix(vec3f(1.0), F.vigColor.xyz, v);
  }

  let lAmt = F.leak.x;
  if (lAmt > 0.0) {
    let e = u.x * cos(F.leak.y) + u.y * sin(F.leak.y) + vnoise(u * 2.2 + vec2f(F.head.z, 0.0), seed + 3) * 0.35;
    let k = smoothstep(0.12, 0.62, e) * lAmt;
    let hot = k * k * 0.6;
    let lc = F.leakColor.xyz + (vec3f(1.0, 0.92, 0.7) - F.leakColor.xyz) * hot;
    c = vec3f(1.0) - (vec3f(1.0) - c) * (vec3f(1.0) - lc * k);
  }

  if (F.fx2.w > 0.0) {
    let st = stampAt(fr, p, s, seed);
    let add = clamp(vec3f(1.0, 0.353, 0.071) * st.y + vec3f(1.0, 0.694, 0.290) * st.x, vec3f(0.0), vec3f(1.0));
    c = vec3f(1.0) - (vec3f(1.0) - c) * (vec3f(1.0) - add);
  }

  let sdf = frameSDF(kind, fr, p, s, seed);
  if (kind == 8u && sdf < 0.0) { c = tarnish(c, sdf, s, p, seed); }
  if (kind == 10u && sdf < 0.0) { c = mix(c, F.paper.xyz, grungeSpeck(p, s, sdf, seed)); }
  // Interlace / scanlines at ~480 lines regardless of image size.
  if (F.fx3.x > 0.0 && (u32(floor(p.y / max(1.0, res.y / 480.0))) % 2u) == 1u) {
    c = c * (1.0 - F.fx3.x);
  }
  var edgeSoft = 0.75;
  if (kind == 5u) { edgeSoft = s * 0.004; }
  let outside = smoothstep(-edgeSoft, edgeSoft, sdf);
  if (outside > 0.0) {
    c = mix(c, surround(kind, sdf, p, res.y, s, seed), outside);
  }

  let gr = F.grain.x;
  if (gr > 0.0) {
    // Grain size is specified at a 2048px long edge; scale with the image.
    let gs = max(0.6, F.grain.y * max(res.x, res.y) / 2048.0);
    // Live mode animates grain; a still (time = 0) stays fixed per seed.
    let gseed = seed + i32(F.grain.w * 24.0) * 131;
    let n = p / gs;
    let mono = vnoise(n, gseed) * 0.7 + vnoise(n * 2.1, gseed + 1) * 0.3;
    let chroma = vec3f(vnoise(n, gseed + 11), vnoise(n, gseed + 12), vnoise(n, gseed + 13));
    let nz = mix(vec3f(mono), chroma, F.grain.z);
    let l = dot(c, LUMA);
    c = c + nz * (0.3 + 2.8 * l * (1.0 - l)) * gr * 0.32;
  }

  if (F.fx.x > 0.0 || F.fx.y > 0.0) {
    c = c + (vec3f(1.0) - c) * dustAt(p, s, seed);
  }

  let outc = mix(orig.rgb, clamp(c, vec3f(0.0), vec3f(1.0)), F.head.w);
  return vec4f(outc, orig.a);
}

fn dustAt(p: vec2f, s: f32, seed: i32) -> f32 {
  var v = 0.0;
  let dust = F.fx.x;
  if (dust > 0.0) {
    let cell = max(8.0, s / 28.0);
    let ci = vec2i(floor(p / cell));
    if (hash2(ci.x, ci.y, seed + 41) < dust * 0.22) {
      let sp = (vec2f(ci) + vec2f(hash2(ci.x, ci.y, seed + 42), hash2(ci.x, ci.y, seed + 43))) * cell;
      let rad = (0.6 + hash2(ci.x, ci.y, seed + 44) * 2.2) * max(1.0, s / 900.0);
      v = max(v, (1.0 - smoothstep(rad * 0.5, rad, length(p - sp))) * 0.85);
    }
  }
  let scr = F.fx.y;
  if (scr > 0.0) {
    let col = i32(floor(p.x / 2.0));
    if (hash2(col, 0, seed + 51) < scr * 0.004) {
      let along = vnoise(vec2f(0.0, p.y / (s * 0.08)), seed + col) + 0.5;
      v = max(v, smoothstep(0.45, 0.8, along) * 0.45);
    }
  }
  return v;
}
`;

const FRAG_STIPPLE = /* wgsl */ `
struct Params {
  resolution: vec2f,
  amount: f32,
  _pad: u32,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var texA: texture_2d<f32>;
@group(0) @binding(2) var texB: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

const BAYER8 = array<f32, 64>(
  0.0, 32.0, 8.0, 40.0, 2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0, 4.0, 36.0, 14.0, 46.0, 6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
  3.0, 35.0, 11.0, 43.0, 1.0, 33.0, 9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0, 7.0, 39.0, 13.0, 45.0, 5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = vec2u(uv * params.resolution);
  let bx = px.x % 8u;
  let by = px.y % 8u;
  let threshold = BAYER8[by * 8u + bx] / 64.0;
  if (threshold < params.amount) {
    return textureSampleLevel(texB, samp, uv, 0.0);
  }
  return textureSampleLevel(texA, samp, uv, 0.0);
}
`;

const FRAG_COPY = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(src, samp, uv, 0.0);
}
`;

// Audio-reactive post-FX.
// mode bits: 1=chroma, 2=shockwave, 4=color shift, 8=spectrum, 16=invert strobe.
// COMBINED == 1|2|4|8|16 == 31. BASS BUMP needs no FX (handled by block-size on CPU).
const FRAG_VIZFX = /* wgsl */ `
struct Params {
  resolution: vec2f,
  bass: f32,
  mid: f32,
  treble: f32,
  beat: f32,
  time: f32,
  intensity: f32,
  mode: u32,
};

struct FFT {
  // 256 frequency bins packed as 64 vec4f. Each f in [0, 1].
  bins: array<vec4f, 64>,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var<uniform> fft: FFT;

fn fft_at(idx: u32) -> f32 {
  let v = fft.bins[idx / 4u];
  let c = idx % 4u;
  if (c == 0u) { return v.x; }
  if (c == 1u) { return v.y; }
  if (c == 2u) { return v.z; }
  return v.w;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centered = uv - vec2f(0.5);
  let dist = length(centered);
  let radial = centered / max(dist, 0.0001);

  var sampleUV = uv;

  // Shockwave: punchier ring + larger displacement so a single kick is unmistakable
  if ((p.mode & 2u) != 0u) {
    let ringRadius = (1.0 - p.beat) * 0.7;
    let ringDist = abs(dist - ringRadius);
    let ring = exp(-ringDist * 14.0) * p.beat;
    sampleUV = uv - radial * ring * 0.16 * p.intensity;
  }

  // Spectrum: each pixel column reads one FFT bin and offsets its V coord
  if ((p.mode & 8u) != 0u) {
    let binIdx = u32(clamp(uv.x, 0.0, 0.999) * 256.0);
    let energy = fft_at(binIdx);
    sampleUV.y = sampleUV.y + energy * 0.32 * p.intensity;
  }

  var col: vec4f;

  if ((p.mode & 1u) != 0u) {
    // Chroma split: much wider R/B separation, plus subtle vertical shimmer
    let bOff = vec2f(p.bass * 0.05 * p.intensity, p.bass * 0.012 * p.intensity);
    let tOff = vec2f(-p.treble * 0.05 * p.intensity, -p.treble * 0.012 * p.intensity);
    let r = textureSampleLevel(src, samp, sampleUV + bOff, 0.0);
    let g = textureSampleLevel(src, samp, sampleUV, 0.0);
    let b = textureSampleLevel(src, samp, sampleUV + tOff, 0.0);
    col = vec4f(r.r, g.g, b.b, g.a);
  } else {
    col = textureSampleLevel(src, samp, sampleUV, 0.0);
  }

  // Color shift: mid-frequency-driven hue rotation — dramatic
  if ((p.mode & 4u) != 0u) {
    let s = sin(p.time * 1.4 + p.mid * 8.0) * 0.42 * p.intensity;
    let c = cos(p.time * 1.4 + p.mid * 8.0) * 0.42 * p.intensity;
    let r2 = col.r + s * (col.g - col.b);
    let g2 = col.g + c * (col.b - col.r);
    let b2 = col.b + s * (col.r - col.g);
    col = vec4f(clamp(r2, 0.0, 1.0), clamp(g2, 0.0, 1.0), clamp(b2, 0.0, 1.0), col.a);
  }

  // Spectrum bar overlay: lime equalizer columns with brighter glow
  if ((p.mode & 8u) != 0u) {
    let binIdx = u32(clamp(uv.x, 0.0, 0.999) * 256.0);
    let energy = fft_at(binIdx);
    let barEdge = 1.0 - energy * 0.95;
    let glow = smoothstep(barEdge - 0.03, barEdge, uv.y) * smoothstep(1.0, 0.95, uv.y);
    col = vec4f(min(col.rgb + vec3f(glow * 0.7 * p.intensity, glow * 1.0 * p.intensity, glow * 0.25 * p.intensity), vec3f(1.0)), col.a);
  }

  // STROBE: invert image proportionally to beat pulse — DJ-club flicker
  if ((p.mode & 16u) != 0u) {
    let invStrength = p.beat * 0.85 * p.intensity;
    col = vec4f(mix(col.rgb, vec3f(1.0) - col.rgb, invStrength), col.a);
  }

  // Beat flash: stronger whiten on every beat
  if (p.mode != 0u) {
    let flash = p.beat * 0.32 * p.intensity;
    col = vec4f(min(col.rgb + vec3f(flash), vec3f(1.0)), col.a);
  }

  return col;
}
`;

// ───────────────────────────────────────────────────────────────────────────
// Pipeline
// ───────────────────────────────────────────────────────────────────────────

export type GPUProcessResult = {
  canvas: HTMLCanvasElement;
  ms: number;
  effectiveBlockSize: number;
};

const WORK_FORMAT: GPUTextureFormat = "rgba8unorm";

export class WebGPUPipeline {
  private device: GPUDevice;
  private canvasFormat: GPUTextureFormat;

  private modVert!: GPUShaderModule;
  private modPixelate!: GPUShaderModule;
  private modQuantize!: GPUShaderModule;
  private modBayer!: GPUShaderModule;
  private modBlueNoise!: GPUShaderModule;
  private modIGN!: GPUShaderModule;
  private modHalftone!: GPUShaderModule;
  private modOverlay!: GPUShaderModule;
  private modStipple!: GPUShaderModule;
  private modCopy!: GPUShaderModule;
  private modVizFx!: GPUShaderModule;
  private modFilm!: GPUShaderModule;
  private modDownsample!: GPUShaderModule;
  private modUpscale!: GPUShaderModule;
  private pipelineDownsample!: GPURenderPipeline;
  private pipelineUpscale!: GPURenderPipeline;
  private bufGrid!: GPUBuffer;
  /** Grid-resolution work textures, cached by size (bass pump flips sizes). */
  private gridCache = new Map<string, GPUTexture[]>();

  private samplerLinear!: GPUSampler;
  private samplerLinearFilter!: GPUSampler;
  private samplerClamp!: GPUSampler;

  private pipelinePixelate!: GPURenderPipeline;
  private pipelineQuantize!: GPURenderPipeline;
  private pipelineBayer!: GPURenderPipeline;
  private pipelineBlueNoise!: GPURenderPipeline;
  private pipelineIGN!: GPURenderPipeline;
  private pipelineHalftone!: GPURenderPipeline;
  private pipelineOverlay!: GPURenderPipeline;
  private pipelineStipple!: GPURenderPipeline;
  private pipelineCopyToCanvas!: GPURenderPipeline;
  private pipelineCopyToWork!: GPURenderPipeline;
  private pipelineVizFx!: GPURenderPipeline;
  private pipelineVizFxToCanvas!: GPURenderPipeline;
  private pipelineFilm!: GPURenderPipeline;
  private bufFilm: GPUBuffer;
  private bufVizFx: GPUBuffer;
  private bufFFT: GPUBuffer;
  private configuredCanvases = new WeakMap<HTMLCanvasElement, GPUCanvasContext>();

  // Lazily allocated work textures sized to the source image
  private width = 0;
  private height = 0;
  private texSource: GPUTexture | null = null;
  private texA: GPUTexture | null = null;
  private texB: GPUTexture | null = null;
  private texC: GPUTexture | null = null;

  // Blue-noise LUT (64×64 r8unorm, populated once at compile time).
  private texBlueNoise: GPUTexture | null = null;

  // User-uploaded overlay texture. Sized to the source image; kept across
  // process() calls until cleared or replaced.
  private texOverlay: GPUTexture | null = null;
  private overlayWidth = 0;
  private overlayHeight = 0;
  private lastUploadedOverlay: ImageBitmap | null = null;

  // Source-bitmap cache: skip re-uploading the same bitmap every frame
  private lastUploadedSource: ImageBitmap | null = null;

  private bufPixelate: GPUBuffer;
  private bufQuantize: GPUBuffer;
  private bufBayer: GPUBuffer;
  private bufNoiseDither: GPUBuffer;
  private bufHalftone: GPUBuffer;
  private bufOverlay: GPUBuffer;
  private bufStipple: GPUBuffer;

  static async create(): Promise<WebGPUPipeline | null> {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const format = navigator.gpu.getPreferredCanvasFormat();
      const pipeline = new WebGPUPipeline(device, format);
      pipeline.compile();
      return pipeline;
    } catch (err) {
      console.warn("[pixel] WebGPU init failed:", err);
      return null;
    }
  }

  private constructor(device: GPUDevice, canvasFormat: GPUTextureFormat) {
    this.device = device;
    this.canvasFormat = canvasFormat;
    this.bufPixelate = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Quantize uniform: count(4) + pad(12) + 32 vec4 (512) = 528 → align to 16
    this.bufQuantize = device.createBuffer({
      size: 16 + 32 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Bayer uniform: vec2 res(8) + count(4) + matrixSize(4) + 32 vec4 (512) = 528
    this.bufBayer = device.createBuffer({
      size: 16 + 32 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Noise-dither uniform (Blue-noise + IGN share layout):
    //   vec2 res(8) + count(4) + strength(4) = 16 header, then 32 vec4 = 528
    this.bufNoiseDither = device.createBuffer({
      size: 16 + 32 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Halftone uniform: vec2 res(8) + count(4) + cellSize(4) = 16 header + 32 vec4 = 528
    this.bufHalftone = device.createBuffer({
      size: 16 + 32 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Overlay uniform: vec2 res(8) + vec2 texSize(8) + blend(4) + fit(4) + opacity(4) + pad(4) = 32
    this.bufOverlay = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Stipple uniform: vec2 res(8) + amount(4) + pad(4) = 16
    this.bufStipple = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // VizFx uniform: 8 floats (32 bytes) — see Params struct in WGSL
    this.bufVizFx = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Film uniform: 33 vec4f — see `struct Film` in FRAG_FILM
    this.bufFilm = device.createBuffer({
      size: FILM_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // FFT uniform: 64 vec4f = 1024 bytes (256 frequency bins)
    this.bufFFT = device.createBuffer({
      size: 1024,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private compile() {
    const d = this.device;

    this.modVert = d.createShaderModule({ code: VERT });
    this.modPixelate = d.createShaderModule({ code: FRAG_PIXELATE });
    this.modQuantize = d.createShaderModule({ code: FRAG_QUANTIZE });
    this.modBayer = d.createShaderModule({ code: FRAG_BAYER });
    this.modBlueNoise = d.createShaderModule({ code: FRAG_BLUENOISE });
    this.modIGN = d.createShaderModule({ code: FRAG_IGN });
    this.modHalftone = d.createShaderModule({ code: FRAG_HALFTONE });
    this.modOverlay = d.createShaderModule({ code: FRAG_OVERLAY });
    this.modStipple = d.createShaderModule({ code: FRAG_STIPPLE });
    this.modCopy = d.createShaderModule({ code: FRAG_COPY });
    this.modVizFx = d.createShaderModule({ code: FRAG_VIZFX });
    this.modFilm = d.createShaderModule({ code: FRAG_FILM });
    this.modDownsample = d.createShaderModule({ code: FRAG_DOWNSAMPLE });
    this.modUpscale = d.createShaderModule({ code: FRAG_UPSCALE });
    this.bufGrid = d.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    for (const [mod, key] of [
      [this.modDownsample, "pipelineDownsample"],
      [this.modUpscale, "pipelineUpscale"],
    ] as const) {
      this[key] = d.createRenderPipeline({
        layout: "auto",
        vertex: { module: this.modVert, entryPoint: "vs" },
        fragment: { module: mod, entryPoint: "fs", targets: [{ format: WORK_FORMAT }] },
        primitive: { topology: "triangle-list" },
      });
    }

    this.samplerLinear = d.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    });
    // Linear sampler with repeat — used for the user-uploaded overlay texture so
    // tile mode works without per-pixel fract math, and Cover/Fit get smooth
    // resampling instead of nearest-neighbor stair-stepping.
    this.samplerLinearFilter = d.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });

    // Clamped linear sampler for the film pass: halation / softness taps
    // must not wrap across the frame edge the way the repeat sampler would.
    this.samplerClamp = d.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    this.pipelineFilm = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modFilm,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelinePixelate = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modPixelate,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineQuantize = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modQuantize,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineBayer = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modBayer,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineBlueNoise = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modBlueNoise,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineIGN = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modIGN,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineHalftone = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modHalftone,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineOverlay = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modOverlay,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineStipple = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modStipple,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineCopyToCanvas = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modCopy,
        entryPoint: "fs",
        targets: [{ format: this.canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineCopyToWork = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modCopy,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineVizFx = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modVizFx,
        entryPoint: "fs",
        targets: [{ format: WORK_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.pipelineVizFxToCanvas = d.createRenderPipeline({
      layout: "auto",
      vertex: { module: this.modVert, entryPoint: "vs" },
      fragment: {
        module: this.modVizFx,
        entryPoint: "fs",
        targets: [{ format: this.canvasFormat }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.initBlueNoiseTexture();
  }

  // Generate a 64×64 blue-noise LUT once at GPU init using Mitchell's
  // best-candidate algorithm. Toroidal distance keeps the pattern tileable.
  // Cost is one-time (~30ms for 64²); LUT lives on the GPU for the rest of
  // the session.
  private initBlueNoiseTexture() {
    const N = 64;
    const total = N * N;
    const ranks = new Float32Array(total);
    const filled: number[] = [];
    const filledSet = new Uint8Array(total);

    const dist2 = (a: number, b: number) => {
      let dx = (a % N) - (b % N);
      let dy = ((a / N) | 0) - ((b / N) | 0);
      // toroidal wrap so the LUT tiles cleanly
      if (dx > N / 2) dx -= N;
      else if (dx < -N / 2) dx += N;
      if (dy > N / 2) dy -= N;
      else if (dy < -N / 2) dy += N;
      return dx * dx + dy * dy;
    };

    // Seed first point
    const seed = Math.floor(Math.random() * total);
    filled.push(seed);
    filledSet[seed] = 1;
    ranks[seed] = 0;

    while (filled.length < total) {
      // Mitchell: pick the candidate that maximises distance to the nearest
      // already-placed point. More candidates = better quality, more cost;
      // 16 is a good sweet spot for N=64.
      const numCandidates = 16;
      let bestIdx = -1;
      let bestMinDist = -1;
      for (let c = 0; c < numCandidates; c++) {
        let cand = Math.floor(Math.random() * total);
        // Skip occupied — at high fill ratio this can spin, so cap retries
        let tries = 0;
        while (filledSet[cand] && tries < 8) {
          cand = Math.floor(Math.random() * total);
          tries++;
        }
        if (filledSet[cand]) continue;
        let minDist = Infinity;
        // Subsample filled when it's huge — exact min isn't worth O(N²) per insert
        const stride = filled.length > 256 ? Math.ceil(filled.length / 256) : 1;
        for (let i = 0; i < filled.length; i += stride) {
          const d = dist2(cand, filled[i]);
          if (d < minDist) {
            minDist = d;
            if (minDist <= bestMinDist) break;
          }
        }
        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestIdx = cand;
        }
      }
      if (bestIdx < 0) {
        // Fallback: pick any unoccupied slot
        for (let i = 0; i < total; i++) {
          if (!filledSet[i]) {
            bestIdx = i;
            break;
          }
        }
      }
      ranks[bestIdx] = filled.length / total;
      filledSet[bestIdx] = 1;
      filled.push(bestIdx);
    }

    const data = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      data[i] = Math.min(255, Math.floor(ranks[i] * 256));
    }

    this.texBlueNoise = this.device.createTexture({
      size: [N, N],
      format: "r8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.texBlueNoise },
      data,
      { bytesPerRow: N },
      [N, N]
    );
  }

  /**
   * Upload a user-supplied overlay texture. Idempotent: passing the same
   * ImageBitmap twice in a row skips the upload. Pass `null` to clear.
   */
  setOverlayTexture(bitmap: ImageBitmap | null): void {
    if (bitmap === null) {
      this.texOverlay?.destroy();
      this.texOverlay = null;
      this.overlayWidth = 0;
      this.overlayHeight = 0;
      this.lastUploadedOverlay = null;
      return;
    }
    if (this.lastUploadedOverlay === bitmap && this.texOverlay) return;

    const w = bitmap.width;
    const h = bitmap.height;
    if (
      this.texOverlay === null ||
      this.overlayWidth !== w ||
      this.overlayHeight !== h
    ) {
      this.texOverlay?.destroy();
      this.texOverlay = this.device.createTexture({
        size: [w, h],
        format: WORK_FORMAT,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.overlayWidth = w;
      this.overlayHeight = h;
    }
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: this.texOverlay! },
      [w, h]
    );
    this.lastUploadedOverlay = bitmap;
  }

  private getCanvasContext(canvas: HTMLCanvasElement): GPUCanvasContext {
    let ctx = this.configuredCanvases.get(canvas);
    if (!ctx) {
      const gpuCtx = canvas.getContext("webgpu");
      if (!gpuCtx) throw new Error("WebGPU canvas context unavailable");
      gpuCtx.configure({
        device: this.device,
        format: this.canvasFormat,
        alphaMode: "premultiplied",
      });
      this.configuredCanvases.set(canvas, gpuCtx);
      ctx = gpuCtx;
    }
    return ctx;
  }

  private resize(w: number, h: number) {
    if (this.width === w && this.height === h && this.texSource) return;
    this.dispose();
    this.lastUploadedSource = null; // texSource was destroyed → cache is stale
    // COPY_SRC is required so the readback path can copyTextureToBuffer the
    // final work texture into a host-readable buffer for export.
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT;
    this.width = w;
    this.height = h;
    this.texSource = this.device.createTexture({
      size: [w, h],
      format: WORK_FORMAT,
      usage,
    });
    this.texA = this.device.createTexture({
      size: [w, h],
      format: WORK_FORMAT,
      usage,
    });
    this.texB = this.device.createTexture({
      size: [w, h],
      format: WORK_FORMAT,
      usage,
    });
    this.texC = this.device.createTexture({
      size: [w, h],
      format: WORK_FORMAT,
      usage,
    });
  }

  private gridTextures(gw: number, gh: number): GPUTexture[] {
    const key = `${gw}x${gh}`;
    const hit = this.gridCache.get(key);
    if (hit) {
      // Refresh LRU order.
      this.gridCache.delete(key);
      this.gridCache.set(key, hit);
      return hit;
    }
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT;
    const set = [0, 1, 2].map(() =>
      this.device.createTexture({ size: [gw, gh], format: WORK_FORMAT, usage })
    );
    this.gridCache.set(key, set);
    if (this.gridCache.size > 6) {
      const [oldKey, old] = this.gridCache.entries().next().value!;
      old.forEach((t) => t.destroy());
      this.gridCache.delete(oldKey);
    }
    return set;
  }

  private dispose() {
    this.texSource?.destroy();
    this.texA?.destroy();
    this.texB?.destroy();
    this.texC?.destroy();
    this.texSource = null;
    this.texA = null;
    this.texB = null;
    this.texC = null;
  }

  // ─── Pass helpers ────────────────────────────────────────────────────────

  private renderPass(
    encoder: GPUCommandEncoder,
    target: GPUTextureView,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup
  ) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  // ─── Public: process a single image end-to-end ───────────────────────────

  async process(
    source: HTMLImageElement | ImageBitmap,
    settings: Settings,
    options?: {
      outCanvas?: HTMLCanvasElement;
      viz?: VizParams;
      overlay?: OverlayParams;
      film?: FilmParams | null;
      /**
       * Palette + dither already done on the CPU (error-diffusion dithers) at
       * the working resolution — grid size when pixelating, else full size.
       */
      cpuGrid?: ImageBitmap;
      bitmapAlreadyOwned?: boolean;
      /**
       * If true, await `queue.onSubmittedWorkDone()` after submit so the canvas
       * is guaranteed presented before this resolves. Live audio loop should
       * pass false (60fps pipeline can't afford a synchronous GPU stall every
       * frame). Ignored when `readback` is true since readback awaits the map.
       */
      awaitCompletion?: boolean;
      /**
       * If true, skip the WebGPU canvas present pass and instead copy the final
       * texture back to a CPU buffer + bake it into a fresh 2D canvas. This
       * yields stable, export-safe pixels — drawImage/toBlob on a WebGPU canvas
       * is timing-sensitive, especially right after upload, which is what was
       * causing "the first few downloads are trash". Static path uses this.
       */
      readback?: boolean;
    }
  ): Promise<GPUProcessResult> {
    const t0 = performance.now();

    const w =
      "naturalWidth" in source ? source.naturalWidth : source.width;
    const h =
      "naturalHeight" in source ? source.naturalHeight : source.height;
    this.resize(w, h);

    // Readback mode skips the WebGPU canvas entirely (compositor presentation
    // can be flaky, especially the first frame). We render to work textures
    // then copy the final result to a CPU buffer and bake it into a 2D canvas.
    const useReadback = options?.readback === true;

    const outCanvas =
      !useReadback
        ? options?.outCanvas ?? document.createElement("canvas")
        : null;
    if (outCanvas) {
      if (outCanvas.width !== w) outCanvas.width = w;
      if (outCanvas.height !== h) outCanvas.height = h;
    }
    const ctx = outCanvas ? this.getCanvasContext(outCanvas) : null;

    // Upload source bitmap to texSource — but only if it changed since the last
    // call. The audio-reactive loop calls process() at 60Hz with the same bitmap,
    // and copyExternalImageToTexture isn't free.
    const sourceIsBitmap = source instanceof ImageBitmap;
    const sameAsCached =
      sourceIsBitmap && this.lastUploadedSource === source;
    if (!sameAsCached) {
      let bitmap: ImageBitmap;
      if (sourceIsBitmap) {
        bitmap = source;
      } else {
        bitmap = await createImageBitmap(source);
      }
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.texSource! },
        [w, h]
      );
      if (sourceIsBitmap) {
        this.lastUploadedSource = bitmap;
      } else {
        // We created this bitmap; close it since we don't track it
        bitmap.close();
      }
    }

    const encoder = this.device.createCommandEncoder();

    // ─── Working resolution ───────────────────────────────────────────────
    // With pixelation on, palette + dither run on the block grid (one texel
    // per block), then upscale with hard edges. Patterns sit on the pixel
    // grid, and the work shrinks by block² — the big speed win.
    const effBlock = effectiveBlockSize(settings);
    const onGrid = effBlock > 1;
    const gw = Math.ceil(w / effBlock);
    const gh = Math.ceil(h / effBlock);
    const rw = onGrid ? gw : w;
    const rh = onGrid ? gh : h;
    const full = [this.texA!, this.texB!, this.texC!];
    const ring = onGrid ? this.gridTextures(gw, gh) : full;

    let currentTex: GPUTexture = this.texSource!;
    let nextTex: GPUTexture = ring[0];
    const swap = () => {
      currentTex = nextTex;
      nextTex = ring[(ring.indexOf(nextTex) + 1) % ring.length];
    };

    const gridParams = () =>
      this.device.queue.writeBuffer(
        this.bufGrid,
        0,
        new Float32Array([w, h, gw, gh, effBlock, 0, 0, 0]).buffer
      );

    // ─── 1. SOURCE → working texture ─────────────────────────────────────
    const cpuGrid = options?.cpuGrid;
    if (cpuGrid) {
      // Palette + error-diffusion dither already ran on the CPU at this size.
      this.device.queue.copyExternalImageToTexture(
        { source: cpuGrid },
        { texture: nextTex },
        [rw, rh]
      );
      swap();
    } else if (onGrid) {
      gridParams();
      const bg = this.device.createBindGroup({
        layout: this.pipelineDownsample.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: currentTex.createView() },
          { binding: 1, resource: { buffer: this.bufGrid } },
        ],
      });
      this.renderPass(encoder, nextTex.createView(), this.pipelineDownsample, bg);
      swap();
    }

    // ─── 2. PALETTE QUANTIZE ─────────────────────────────────────────────
    const palette = getPalette(settings.paletteId);
    let beforePaletteTex: GPUTexture | null = null;

    if (!cpuGrid && palette.colors.length > 0 && settings.paletteAmount > 0) {
      // Snapshot the pre-palette state for stipple blend
      beforePaletteTex = currentTex;

      // Build palette uniform: 16-byte header (count + pad) + 32 vec4
      const pBuf = new ArrayBuffer(16 + 32 * 16);
      const u32 = new Uint32Array(pBuf, 0, 4);
      u32[0] = palette.colors.length;
      const f32 = new Float32Array(pBuf, 16);
      for (let i = 0; i < palette.colors.length && i < 32; i++) {
        const c = palette.colors[i];
        f32[i * 4] = c[0] / 255;
        f32[i * 4 + 1] = c[1] / 255;
        f32[i * 4 + 2] = c[2] / 255;
        f32[i * 4 + 3] = 1;
      }
      this.device.queue.writeBuffer(this.bufQuantize, 0, pBuf);

      const bg = this.device.createBindGroup({
        layout: this.pipelineQuantize.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samplerLinear },
          { binding: 1, resource: currentTex.createView() },
          { binding: 2, resource: { buffer: this.bufQuantize } },
        ],
      });
      this.renderPass(encoder, nextTex.createView(), this.pipelineQuantize, bg);
      swap();

      // Stipple blend pre-palette and quantized using paletteAmount
      if (settings.paletteAmount < 1) {
        this.device.queue.writeBuffer(
          this.bufStipple,
          0,
          new Float32Array([rw, rh, settings.paletteAmount, 0]).buffer
        );
        const stippleBg = this.device.createBindGroup({
          layout: this.pipelineStipple.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.samplerLinear },
            { binding: 1, resource: beforePaletteTex.createView() },
            { binding: 2, resource: currentTex.createView() },
            { binding: 3, resource: { buffer: this.bufStipple } },
          ],
        });
        // Both inputs must differ from the target: pick the free slot.
        const out = ring.find((t) => t !== beforePaletteTex && t !== currentTex)!;
        this.renderPass(encoder, out.createView(), this.pipelineStipple, stippleBg);
        currentTex = out;
        nextTex = ring.find((t) => t !== currentTex && t !== beforePaletteTex) ?? ring[0];
      }
    }

    // ─── 3. GPU DITHER (Bayer / Blue noise / IGN / Halftone) ─────────────
    // Floyd-Steinberg / Atkinson / JJN are sequential — those arrive as cpuGrid.
    const gpuDithers = new Set(["bayer4", "bayer8", "bluenoise", "ign", "halftone"]);
    const isGpuDither = gpuDithers.has(settings.dither);
    if (
      !cpuGrid &&
      isGpuDither &&
      palette.colors.length > 0 &&
      settings.ditherAmount > 0 &&
      beforePaletteTex
    ) {
      const afterPaletteTex = currentTex;
      const target = ring.find((t) => t !== afterPaletteTex && t !== beforePaletteTex)!;

      let ditherPipeline: GPURenderPipeline;
      let ditherBindGroup: GPUBindGroup;

      const writePaletteVec4 = (target: ArrayBuffer, byteOffset: number) => {
        const f = new Float32Array(target, byteOffset);
        for (let i = 0; i < palette.colors.length && i < 32; i++) {
          const c = palette.colors[i];
          f[i * 4] = c[0] / 255;
          f[i * 4 + 1] = c[1] / 255;
          f[i * 4 + 2] = c[2] / 255;
          f[i * 4 + 3] = 1;
        }
      };

      if (settings.dither === "bayer4" || settings.dither === "bayer8") {
        const matrixSize = settings.dither === "bayer4" ? 4 : 8;
        const buf = new ArrayBuffer(16 + 32 * 16);
        new Float32Array(buf, 0, 2).set([rw, rh]);
        new Uint32Array(buf, 8, 2).set([palette.colors.length, matrixSize]);
        writePaletteVec4(buf, 16);
        this.device.queue.writeBuffer(this.bufBayer, 0, buf);
        ditherPipeline = this.pipelineBayer;
        ditherBindGroup = this.device.createBindGroup({
          layout: this.pipelineBayer.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.samplerLinear },
            { binding: 1, resource: beforePaletteTex.createView() },
            { binding: 2, resource: { buffer: this.bufBayer } },
          ],
        });
      } else if (settings.dither === "bluenoise" || settings.dither === "ign") {
        // Same uniform layout; blue noise also binds its LUT.
        const buf = new ArrayBuffer(16 + 32 * 16);
        new Float32Array(buf, 0, 2).set([rw, rh]);
        new Uint32Array(buf, 8, 1)[0] = palette.colors.length;
        new Float32Array(buf, 12, 1)[0] = settings.dither === "bluenoise" ? 0.4 : 0.35;
        writePaletteVec4(buf, 16);
        this.device.queue.writeBuffer(this.bufNoiseDither, 0, buf);
        if (settings.dither === "bluenoise") {
          ditherPipeline = this.pipelineBlueNoise;
          ditherBindGroup = this.device.createBindGroup({
            layout: this.pipelineBlueNoise.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.samplerLinear },
              { binding: 1, resource: beforePaletteTex.createView() },
              { binding: 2, resource: this.texBlueNoise!.createView() },
              { binding: 3, resource: { buffer: this.bufNoiseDither } },
            ],
          });
        } else {
          ditherPipeline = this.pipelineIGN;
          ditherBindGroup = this.device.createBindGroup({
            layout: this.pipelineIGN.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: this.samplerLinear },
              { binding: 1, resource: beforePaletteTex.createView() },
              { binding: 2, resource: { buffer: this.bufNoiseDither } },
            ],
          });
        }
      } else {
        // Halftone: on the grid each dot cell spans 4 blocks; at full res the
        // cell scales with the image so dots read at any size.
        const cellSize = onGrid ? 4 : Math.max(4, Math.round(Math.min(w, h) / 160));
        const buf = new ArrayBuffer(16 + 32 * 16);
        new Float32Array(buf, 0, 2).set([rw, rh]);
        new Uint32Array(buf, 8, 2).set([palette.colors.length, cellSize]);
        writePaletteVec4(buf, 16);
        this.device.queue.writeBuffer(this.bufHalftone, 0, buf);
        ditherPipeline = this.pipelineHalftone;
        // The halftone shader reads texels directly — no sampler binding
        // (passing one made the bind group invalid and the pass blank).
        ditherBindGroup = this.device.createBindGroup({
          layout: this.pipelineHalftone.getBindGroupLayout(0),
          entries: [
            { binding: 1, resource: beforePaletteTex.createView() },
            { binding: 2, resource: { buffer: this.bufHalftone } },
          ],
        });
      }

      this.renderPass(encoder, target.createView(), ditherPipeline, ditherBindGroup);
      const ditheredTex = target;
      currentTex = ditheredTex;

      // Stipple blend (afterPalette, dithered, ditherAmount) into the slot
      // that's neither input.
      if (settings.ditherAmount < 1) {
        const out = ring.find((t) => t !== afterPaletteTex && t !== ditheredTex)!;
        this.device.queue.writeBuffer(
          this.bufStipple,
          0,
          new Float32Array([rw, rh, settings.ditherAmount, 0]).buffer
        );
        const stippleBg = this.device.createBindGroup({
          layout: this.pipelineStipple.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.samplerLinear },
            { binding: 1, resource: afterPaletteTex.createView() },
            { binding: 2, resource: ditheredTex.createView() },
            { binding: 3, resource: { buffer: this.bufStipple } },
          ],
        });
        this.renderPass(encoder, out.createView(), this.pipelineStipple, stippleBg);
        currentTex = out;
      }
    }

    // ─── 3b. GRID → FULL RES (hard edges) ─────────────────────────────────
    if (onGrid) {
      gridParams();
      const bg = this.device.createBindGroup({
        layout: this.pipelineUpscale.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: currentTex.createView() },
          { binding: 1, resource: { buffer: this.bufGrid } },
        ],
      });
      this.renderPass(encoder, full[0].createView(), this.pipelineUpscale, bg);
      currentTex = full[0];
    }
    // Downstream stages (film, overlay) work on the full-res ring.
    nextTex = full.find((t) => t !== currentTex)!;

    // ─── 4. FILM ─────────────────────────────────────────────────────────
    // Stock / camera / print emulation on top of the pixel-art result. With
    // block size 1 and palette ORIGINAL this is a plain photo film look.
    const film = options?.film;
    if (film && film.controls.amount > 0) {
      this.device.queue.writeBuffer(
        this.bufFilm,
        0,
        packFilmUniform(film.recipe, film.controls, w, h, film.time ?? 0)
      );
      const filmBg = this.device.createBindGroup({
        layout: this.pipelineFilm.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samplerClamp },
          { binding: 1, resource: currentTex.createView() },
          { binding: 2, resource: { buffer: this.bufFilm } },
        ],
      });
      // The dither stipple path can leave nextTex === a live input; pick a
      // slot that's free.
      const target = [this.texA!, this.texB!, this.texC!].find(
        (t) => t !== currentTex
      )!;
      this.renderPass(encoder, target.createView(), this.pipelineFilm, filmBg);
      nextTex = [this.texA!, this.texB!, this.texC!].find(
        (t) => t !== target && t !== currentTex
      )!;
      currentTex = target;
    }

    // ─── 5. TEXTURE OVERLAY ──────────────────────────────────────────────
    // User-uploaded image composited via Photoshop-style blend modes. Skipped
    // entirely when no overlay is bound or opacity is 0.
    const overlayOpts = options?.overlay;
    if (overlayOpts && this.texOverlay && overlayOpts.opacity > 0) {
      const buf = new ArrayBuffer(32);
      new Float32Array(buf, 0, 4).set([
        w,
        h,
        this.overlayWidth,
        this.overlayHeight,
      ]);
      new Uint32Array(buf, 16, 2).set([
        overlayOpts.blendMode,
        overlayOpts.fitMode,
      ]);
      new Float32Array(buf, 24, 1)[0] = overlayOpts.opacity;
      // pad bytes left as 0
      this.device.queue.writeBuffer(this.bufOverlay, 0, buf);

      const overlayBg = this.device.createBindGroup({
        layout: this.pipelineOverlay.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samplerLinearFilter },
          { binding: 1, resource: currentTex.createView() },
          { binding: 2, resource: this.texOverlay.createView() },
          { binding: 3, resource: { buffer: this.bufOverlay } },
        ],
      });
      this.renderPass(
        encoder,
        nextTex.createView(),
        this.pipelineOverlay,
        overlayBg
      );
      swap();
    }

    // ─── 5. READBACK PATH (export-safe 2D canvas) ───────────────────────
    if (useReadback) {
      // Row stride must be a multiple of 256 for copyTextureToBuffer.
      const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
      const readbackBuf = this.device.createBuffer({
        size: bytesPerRow * h,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      encoder.copyTextureToBuffer(
        { texture: currentTex },
        { buffer: readbackBuf, bytesPerRow, rowsPerImage: h },
        [w, h]
      );
      this.device.queue.submit([encoder.finish()]);

      await readbackBuf.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(readbackBuf.getMappedRange());

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = w;
      exportCanvas.height = h;
      const ctx2d = exportCanvas.getContext("2d");
      if (!ctx2d) throw new Error("2D context unavailable for export canvas");
      const imageData = ctx2d.createImageData(w, h);
      const tightRowBytes = w * 4;
      if (bytesPerRow === tightRowBytes) {
        imageData.data.set(padded.subarray(0, tightRowBytes * h));
      } else {
        // Strip the row padding the GPU required.
        for (let y = 0; y < h; y++) {
          imageData.data.set(
            padded.subarray(
              y * bytesPerRow,
              y * bytesPerRow + tightRowBytes
            ),
            y * tightRowBytes
          );
        }
      }
      ctx2d.putImageData(imageData, 0, 0);
      readbackBuf.unmap();
      readbackBuf.destroy();

      return {
        canvas: exportCanvas,
        ms: performance.now() - t0,
        effectiveBlockSize: effBlock,
      };
    }

    // ─── 5. PRESENT to canvas (with optional viz post-FX) ────────────────
    const targetTex = ctx!.getCurrentTexture();

    const useViz = !!options?.viz && options.viz.mode !== 0;
    if (useViz) {
      const v = options!.viz!;
      const buf = new ArrayBuffer(32);
      new Float32Array(buf, 0, 7).set([
        w,
        h,
        v.bass,
        v.mid,
        v.treble,
        v.beat,
        v.time,
      ]);
      // Slot 7 = intensity (f32), slot 8 = mode (u32)
      new Float32Array(buf, 24, 1)[0] = v.intensity;
      new Uint32Array(buf, 28, 1)[0] = v.mode;
      this.device.queue.writeBuffer(this.bufVizFx, 0, buf);

      // FFT data: 256 floats packed into 64 vec4f (1024 bytes). When the caller
      // didn't provide one (or it's shorter), pad with zeros — the SPECTRUM bit
      // sees no displacement which is the safe no-op.
      const fftIn = v.fft;
      const fftBuf = new Float32Array(256);
      if (fftIn) {
        const len = Math.min(256, fftIn.length);
        for (let i = 0; i < len; i++) fftBuf[i] = fftIn[i];
      }
      this.device.queue.writeBuffer(this.bufFFT, 0, fftBuf.buffer);

      const vizBg = this.device.createBindGroup({
        layout: this.pipelineVizFxToCanvas.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samplerLinear },
          { binding: 1, resource: currentTex.createView() },
          { binding: 2, resource: { buffer: this.bufVizFx } },
          { binding: 3, resource: { buffer: this.bufFFT } },
        ],
      });
      const presentPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: targetTex.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      presentPass.setPipeline(this.pipelineVizFxToCanvas);
      presentPass.setBindGroup(0, vizBg);
      presentPass.draw(3, 1, 0, 0);
      presentPass.end();
    } else {
      const presentBg = this.device.createBindGroup({
        layout: this.pipelineCopyToCanvas.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samplerLinear },
          { binding: 1, resource: currentTex.createView() },
        ],
      });
      const presentPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: targetTex.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      presentPass.setPipeline(this.pipelineCopyToCanvas);
      presentPass.setBindGroup(0, presentBg);
      presentPass.draw(3, 1, 0, 0);
      presentPass.end();
    }

    this.device.queue.submit([encoder.finish()]);

    if (options?.awaitCompletion) {
      await this.device.queue.onSubmittedWorkDone();
    }

    return {
      canvas: outCanvas!,
      ms: performance.now() - t0,
      effectiveBlockSize: effBlock,
    };
  }
}

export type VizParams = {
  bass: number;
  mid: number;
  treble: number;
  beat: number;
  time: number;
  intensity: number;
  /** Bit field: 1=chroma, 2=shockwave, 4=color shift, 8=spectrum. 0=none. */
  mode: number;
  /** Optional 256-bin frequency data for SPECTRUM mode (each value 0..1). */
  fft?: Float32Array;
};

export type OverlayBlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "color-burn";

export const OVERLAY_BLEND_BITS: Record<OverlayBlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  "soft-light": 4,
  "hard-light": 5,
  difference: 6,
  "color-burn": 7,
};

export type OverlayFitMode = "cover" | "tile" | "fit";
export const OVERLAY_FIT_BITS: Record<OverlayFitMode, number> = {
  cover: 0,
  tile: 1,
  fit: 2,
};

export type FilmParams = {
  recipe: FilmRecipe;
  controls: FilmControls;
  /** Seconds; animates grain in the live loop. 0 for a stable still. */
  time?: number;
};

export type OverlayParams = {
  blendMode: number;
  fitMode: number;
  opacity: number; // 0..1
};

/**
 * A separate pipeline (own device + work textures) for thumbnail rendering,
 * so small proxy renders never thrash the main preview's texture sizes.
 */
let thumbPromise: Promise<WebGPUPipeline | null> | null = null;
export function getThumbGPU(): Promise<WebGPUPipeline | null> {
  if (!thumbPromise) thumbPromise = WebGPUPipeline.create();
  return thumbPromise;
}

// Singleton initialization — async, cached for app lifetime
let pipelinePromise: Promise<WebGPUPipeline | null> | null = null;
export function getWebGPU(): Promise<WebGPUPipeline | null> {
  if (!pipelinePromise) pipelinePromise = WebGPUPipeline.create();
  return pipelinePromise;
}

/** Error-diffusion dithers are sequential: their palette+dither stage runs on the CPU. */
export function needsCpuGrid(settings: Settings): boolean {
  return (
    settings.paletteId !== "none" &&
    settings.ditherAmount > 0 &&
    (settings.dither === "floyd" || settings.dither === "atkinson" || settings.dither === "jarvis")
  );
}
