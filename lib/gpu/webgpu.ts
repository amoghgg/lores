import { getPalette } from "../palettes";
import { effectiveBlockSize, type Settings } from "../pipeline";

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
  let c = textureSample(src, samp, uv);
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
  let c = textureSample(src, samp, uv);
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
  let c = textureSample(src, samp, uv);
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
  let c = textureSample(src, samp, uv);
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
  let base = textureSample(src, samp, uv);

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

  let tex = textureSample(overlay, samp, tUV);
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
    return textureSample(texB, samp, uv);
  }
  return textureSample(texA, samp, uv);
}
`;

const FRAG_COPY = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(src, samp, uv);
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
    let r = textureSample(src, samp, sampleUV + bOff);
    let g = textureSample(src, samp, sampleUV);
    let b = textureSample(src, samp, sampleUV + tOff);
    col = vec4f(r.r, g.g, b.b, g.a);
  } else {
    col = textureSample(src, samp, sampleUV);
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

  private samplerLinear!: GPUSampler;
  private samplerLinearFilter!: GPUSampler;

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
      console.warn("[lores] WebGPU init failed:", err);
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

    // Track which work texture currently holds the latest result.
    let currentTex: GPUTexture = this.texSource!;
    let nextTex: GPUTexture = this.texA!;

    const swap = () => {
      const tmp = currentTex;
      currentTex = nextTex;
      // Cycle texture roles: texA → texB → texC → texA
      if (nextTex === this.texA) nextTex = this.texB!;
      else if (nextTex === this.texB) nextTex = this.texC!;
      else nextTex = this.texA!;
      void tmp;
    };

    // ─── 1. PIXELATE ──────────────────────────────────────────────────────
    const effBlock = effectiveBlockSize(settings);
    if (effBlock > 1) {
      this.device.queue.writeBuffer(
        this.bufPixelate,
        0,
        new Float32Array([w, h]).buffer
      );
      this.device.queue.writeBuffer(
        this.bufPixelate,
        8,
        new Uint32Array([effBlock, 0]).buffer
      );
      const bg = this.device.createBindGroup({
        layout: this.pipelinePixelate.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: currentTex.createView() },
          { binding: 1, resource: { buffer: this.bufPixelate } },
        ],
      });
      this.renderPass(
        encoder,
        nextTex.createView(),
        this.pipelinePixelate,
        bg
      );
      swap();
    }

    // ─── 2. PALETTE QUANTIZE ─────────────────────────────────────────────
    const palette = getPalette(settings.paletteId);
    let beforePaletteTex: GPUTexture | null = null;

    if (palette.colors.length > 0 && settings.paletteAmount > 0) {
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
      this.renderPass(
        encoder,
        nextTex.createView(),
        this.pipelineQuantize,
        bg
      );
      swap();

      // Stipple blend pre-palette and quantized using paletteAmount
      if (settings.paletteAmount < 1) {
        this.device.queue.writeBuffer(
          this.bufStipple,
          0,
          new Float32Array([w, h, settings.paletteAmount, 0]).buffer
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
        this.renderPass(
          encoder,
          nextTex.createView(),
          this.pipelineStipple,
          stippleBg
        );
        swap();
      }
    }

    // ─── 3. GPU DITHER (Bayer / Blue noise / IGN / Halftone) ─────────────
    // Floyd-Steinberg / Atkinson / JJN are sequential — handled on CPU.
    const gpuDithers = new Set([
      "bayer4",
      "bayer8",
      "bluenoise",
      "ign",
      "halftone",
    ]);
    const isGpuDither = gpuDithers.has(settings.dither);
    if (
      isGpuDither &&
      palette.colors.length > 0 &&
      settings.ditherAmount > 0 &&
      beforePaletteTex
    ) {
      // Snapshot afterPalette BEFORE the dither pass. The dither writes into
      // nextTex, which is by definition different from currentTex, so this
      // reference stays valid through the pass and we can stipple-blend
      // against it directly without a re-quantize round-trip (which used to
      // collide with beforePaletteTex when pixelate had run).
      const afterPaletteTex = currentTex;

      // Build the right uniform + bind group for the chosen dither, using
      // beforePaletteTex as input (each shader does its own bias-then-quantize).
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
        new Float32Array(buf, 0, 2).set([w, h]);
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
      } else if (settings.dither === "bluenoise") {
        // Layout: vec2 res(8) + count(4) + strength(4) = 16 header + palette
        const buf = new ArrayBuffer(16 + 32 * 16);
        new Float32Array(buf, 0, 2).set([w, h]);
        new Uint32Array(buf, 8, 1)[0] = palette.colors.length;
        new Float32Array(buf, 12, 1)[0] = 0.4;
        writePaletteVec4(buf, 16);
        this.device.queue.writeBuffer(this.bufNoiseDither, 0, buf);

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
      } else if (settings.dither === "ign") {
        // Same uniform layout as bluenoise; different pipeline (no LUT binding)
        const buf = new ArrayBuffer(16 + 32 * 16);
        new Float32Array(buf, 0, 2).set([w, h]);
        new Uint32Array(buf, 8, 1)[0] = palette.colors.length;
        new Float32Array(buf, 12, 1)[0] = 0.35;
        writePaletteVec4(buf, 16);
        this.device.queue.writeBuffer(this.bufNoiseDither, 0, buf);

        ditherPipeline = this.pipelineIGN;
        ditherBindGroup = this.device.createBindGroup({
          layout: this.pipelineIGN.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.samplerLinear },
            { binding: 1, resource: beforePaletteTex.createView() },
            { binding: 2, resource: { buffer: this.bufNoiseDither } },
          ],
        });
      } else {
        // halftone — cellSize tracks block size so the dot grid matches the
        // pixelation feel; clamped to a visible minimum.
        const cellSize = Math.max(4, settings.blockSize);
        const buf = new ArrayBuffer(16 + 32 * 16);
        new Float32Array(buf, 0, 2).set([w, h]);
        new Uint32Array(buf, 8, 2).set([palette.colors.length, cellSize]);
        writePaletteVec4(buf, 16);
        this.device.queue.writeBuffer(this.bufHalftone, 0, buf);

        ditherPipeline = this.pipelineHalftone;
        ditherBindGroup = this.device.createBindGroup({
          layout: this.pipelineHalftone.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.samplerLinear },
            { binding: 1, resource: beforePaletteTex.createView() },
            { binding: 2, resource: { buffer: this.bufHalftone } },
          ],
        });
      }

      this.renderPass(
        encoder,
        nextTex.createView(),
        ditherPipeline,
        ditherBindGroup
      );
      const ditheredTex = nextTex;
      swap();

      // Stipple blend (afterPalette, dithered, ditherAmount). We saved
      // afterPaletteTex above; pick an output slot that's neither it nor
      // ditheredTex, so the render-pass inputs and target are all distinct
      // (3 slots, 2 inputs, 1 output — always fits).
      if (settings.ditherAmount < 1) {
        const allTex = [this.texA!, this.texB!, this.texC!];
        const out = allTex.find(
          (t) => t !== afterPaletteTex && t !== ditheredTex
        )!;

        this.device.queue.writeBuffer(
          this.bufStipple,
          0,
          new Float32Array([w, h, settings.ditherAmount, 0]).buffer
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
        this.renderPass(
          encoder,
          out.createView(),
          this.pipelineStipple,
          stippleBg
        );
        currentTex = out;
        nextTex = ditheredTex;
      }
    }

    // ─── 4. TEXTURE OVERLAY ──────────────────────────────────────────────
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

export type OverlayParams = {
  blendMode: number;
  fitMode: number;
  opacity: number; // 0..1
};

// Singleton initialization — async, cached for app lifetime
let pipelinePromise: Promise<WebGPUPipeline | null> | null = null;
export function getWebGPU(): Promise<WebGPUPipeline | null> {
  if (!pipelinePromise) pipelinePromise = WebGPUPipeline.create();
  return pipelinePromise;
}

/** True iff this settings combo can be served by the GPU pipeline. */
export function gpuCanHandle(settings: Settings): boolean {
  // Sequential error-diffusion dithers stay on CPU.
  return (
    settings.dither !== "floyd" &&
    settings.dither !== "atkinson" &&
    settings.dither !== "jarvis"
  );
}
