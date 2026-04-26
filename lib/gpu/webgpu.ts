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
  let res = vec2u(params.resolution);
  let px = vec2u(uv * params.resolution);
  let bs = max(params.blockSize, 1u);
  let block = (px / bs) * bs;

  var sum: vec4f = vec4f(0.0);
  var count: f32 = 0.0;
  for (var dy: u32 = 0u; dy < 48u; dy = dy + 1u) {
    if (dy >= bs) { break; }
    for (var dx: u32 = 0u; dx < 48u; dx = dx + 1u) {
      if (dx >= bs) { break; }
      let p = block + vec2u(dx, dy);
      if (p.x < res.x && p.y < res.y) {
        sum = sum + textureLoad(src, vec2i(p), 0);
        count = count + 1.0;
      }
    }
  }
  return sum / max(count, 1.0);
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

// Audio-reactive post-FX. mode bits: 1=chroma, 2=shockwave, 4=color shift.
// COMBINED == 1|2|4 == 7. BASS BUMP needs no FX (handled by block-size).
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

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> p: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centered = uv - vec2f(0.5);
  let dist = length(centered);
  let radial = centered / max(dist, 0.0001);

  var sampleUV = uv;

  // Shockwave: ring radius grows with time-since-beat (encoded in beat decay)
  if ((p.mode & 2u) != 0u) {
    let ringRadius = (1.0 - p.beat) * 0.65;
    let ringDist = abs(dist - ringRadius);
    let ring = exp(-ringDist * 22.0) * p.beat;
    sampleUV = uv - radial * ring * 0.07 * p.intensity;
  }

  var col: vec4f;

  if ((p.mode & 1u) != 0u) {
    // Chroma split: R offset by bass, B by treble — channel separation feel
    let bOff = vec2f(p.bass * 0.018 * p.intensity, 0.0);
    let tOff = vec2f(-p.treble * 0.018 * p.intensity, 0.0);
    let r = textureSample(src, samp, sampleUV + bOff);
    let g = textureSample(src, samp, sampleUV);
    let b = textureSample(src, samp, sampleUV + tOff);
    col = vec4f(r.r, g.g, b.b, g.a);
  } else {
    col = textureSample(src, samp, sampleUV);
  }

  // Color shift: mid frequency rotates hue subtly via channel mixing
  if ((p.mode & 4u) != 0u) {
    let s = sin(p.time * 1.2 + p.mid * 6.0) * 0.18 * p.intensity;
    let c = cos(p.time * 1.2 + p.mid * 6.0) * 0.18 * p.intensity;
    let r2 = col.r + s * (col.g - col.b);
    let g2 = col.g + c * (col.b - col.r);
    let b2 = col.b + s * (col.r - col.g);
    col = vec4f(clamp(r2, 0.0, 1.0), clamp(g2, 0.0, 1.0), clamp(b2, 0.0, 1.0), col.a);
  }

  // Beat flash (always-on if any FX is on): subtle whiten on beats
  if (p.mode != 0u) {
    let flash = p.beat * 0.18 * p.intensity;
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
  private modStipple!: GPUShaderModule;
  private modCopy!: GPUShaderModule;
  private modVizFx!: GPUShaderModule;

  private samplerLinear!: GPUSampler;

  private pipelinePixelate!: GPURenderPipeline;
  private pipelineQuantize!: GPURenderPipeline;
  private pipelineBayer!: GPURenderPipeline;
  private pipelineStipple!: GPURenderPipeline;
  private pipelineCopyToCanvas!: GPURenderPipeline;
  private pipelineCopyToWork!: GPURenderPipeline;
  private pipelineVizFx!: GPURenderPipeline;
  private pipelineVizFxToCanvas!: GPURenderPipeline;
  private bufVizFx: GPUBuffer;
  private configuredCanvases = new WeakMap<HTMLCanvasElement, GPUCanvasContext>();

  // Lazily allocated work textures sized to the source image
  private width = 0;
  private height = 0;
  private texSource: GPUTexture | null = null;
  private texA: GPUTexture | null = null;
  private texB: GPUTexture | null = null;
  private texC: GPUTexture | null = null;

  private bufPixelate: GPUBuffer;
  private bufQuantize: GPUBuffer;
  private bufBayer: GPUBuffer;
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
  }

  private compile() {
    const d = this.device;

    this.modVert = d.createShaderModule({ code: VERT });
    this.modPixelate = d.createShaderModule({ code: FRAG_PIXELATE });
    this.modQuantize = d.createShaderModule({ code: FRAG_QUANTIZE });
    this.modBayer = d.createShaderModule({ code: FRAG_BAYER });
    this.modStipple = d.createShaderModule({ code: FRAG_STIPPLE });
    this.modCopy = d.createShaderModule({ code: FRAG_COPY });
    this.modVizFx = d.createShaderModule({ code: FRAG_VIZFX });

    this.samplerLinear = d.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
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
    const usage =
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
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
      bitmapAlreadyOwned?: boolean;
    }
  ): Promise<GPUProcessResult> {
    const t0 = performance.now();

    const w =
      "naturalWidth" in source ? source.naturalWidth : source.width;
    const h =
      "naturalHeight" in source ? source.naturalHeight : source.height;
    this.resize(w, h);

    const outCanvas = options?.outCanvas ?? document.createElement("canvas");
    if (outCanvas.width !== w) outCanvas.width = w;
    if (outCanvas.height !== h) outCanvas.height = h;
    const ctx = this.getCanvasContext(outCanvas);

    // Upload source bitmap to texSource. createImageBitmap fails on already-bitmap
    // sources in some browsers; skip in that case (live audio loop reuses bitmaps).
    let bitmap: ImageBitmap;
    if (source instanceof ImageBitmap) {
      bitmap = source;
    } else {
      bitmap = await createImageBitmap(source);
    }
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: this.texSource! },
      [w, h]
    );
    if (!(source instanceof ImageBitmap) || !options?.bitmapAlreadyOwned) {
      // Only close if we created it here
      if (!(source instanceof ImageBitmap)) bitmap.close();
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

    // ─── 3. BAYER DITHER (skip Floyd-Steinberg — handled by CPU path) ───
    const isBayer = settings.dither === "bayer4" || settings.dither === "bayer8";
    if (
      isBayer &&
      palette.colors.length > 0 &&
      settings.ditherAmount > 0 &&
      beforePaletteTex
    ) {
      const matrixSize = settings.dither === "bayer4" ? 4 : 8;

      // Layout: vec2 res (8 bytes) + count (4) + matrixSize (4) = 16 bytes header
      const buf = new ArrayBuffer(16 + 32 * 16);
      new Float32Array(buf, 0, 2).set([w, h]);
      new Uint32Array(buf, 8, 2).set([palette.colors.length, matrixSize]);
      const f32 = new Float32Array(buf, 16);
      for (let i = 0; i < palette.colors.length && i < 32; i++) {
        const c = palette.colors[i];
        f32[i * 4] = c[0] / 255;
        f32[i * 4 + 1] = c[1] / 255;
        f32[i * 4 + 2] = c[2] / 255;
        f32[i * 4 + 3] = 1;
      }
      this.device.queue.writeBuffer(this.bufBayer, 0, buf);

      const bg = this.device.createBindGroup({
        layout: this.pipelineBayer.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samplerLinear },
          { binding: 1, resource: beforePaletteTex.createView() },
          { binding: 2, resource: { buffer: this.bufBayer } },
        ],
      });
      this.renderPass(encoder, nextTex.createView(), this.pipelineBayer, bg);
      const ditheredTex = nextTex;
      swap();

      // Stipple blend (afterPalette, dithered, ditherAmount)
      // currentTex was just updated to ditheredTex; we need to blend against the prior
      // (afterPalette state). currentTex before the last swap was afterPalette.
      // After swap, "currentTex" is ditheredTex. We need the previous afterPalette.
      // Solution: route the dither result to texC, blend (currentBeforeBayer, texC).
      // For simplicity we re-bind: afterPalette == "the pre-bayer current".
      // We saved that as `beforePaletteTex` earlier... no, that's pre-palette.
      // afterPalette ≡ the texture currentTex held when we entered this block.
      // Since we've swapped once, let's track via a fresh variable.

      // (Implementation: capture afterPalette before the swap above.)
      // To keep this simple and correct, we accept full-strength bayer when
      // ditherAmount === 1 (skip blend). Otherwise blend.
      if (settings.ditherAmount < 1) {
        // Render plain palette-quantized into a fresh slot for the blend.
        // We need afterPalette (pre-bayer) as input A.
        // Easiest way: re-run quantize from beforePaletteTex into texC,
        // then stipple-blend (texC, ditheredTex, ditherAmount).
        const afterPaletteSlot = this.texC!;
        // Re-quantize beforePaletteTex into afterPaletteSlot
        const q2 = this.device.createBindGroup({
          layout: this.pipelineQuantize.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.samplerLinear },
            { binding: 1, resource: beforePaletteTex.createView() },
            { binding: 2, resource: { buffer: this.bufQuantize } },
          ],
        });
        this.renderPass(
          encoder,
          afterPaletteSlot.createView(),
          this.pipelineQuantize,
          q2
        );

        this.device.queue.writeBuffer(
          this.bufStipple,
          0,
          new Float32Array([w, h, settings.ditherAmount, 0]).buffer
        );

        // Output goes to whichever isn't currently in use as input (ditheredTex or afterPaletteSlot)
        const out = nextTex === afterPaletteSlot ? this.texA! : nextTex;
        const stippleBg = this.device.createBindGroup({
          layout: this.pipelineStipple.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.samplerLinear },
            { binding: 1, resource: afterPaletteSlot.createView() },
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
      }
    }

    // ─── 4. PRESENT to canvas (with optional viz post-FX) ────────────────
    const targetTex = ctx.getCurrentTexture();

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

      const vizBg = this.device.createBindGroup({
        layout: this.pipelineVizFxToCanvas.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.samplerLinear },
          { binding: 1, resource: currentTex.createView() },
          { binding: 2, resource: { buffer: this.bufVizFx } },
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

    return {
      canvas: outCanvas,
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
  /** Bit field: 1=chroma, 2=shockwave, 4=color shift. 0=none. */
  mode: number;
};

// Singleton initialization — async, cached for app lifetime
let pipelinePromise: Promise<WebGPUPipeline | null> | null = null;
export function getWebGPU(): Promise<WebGPUPipeline | null> {
  if (!pipelinePromise) pipelinePromise = WebGPUPipeline.create();
  return pipelinePromise;
}

/** True iff this settings combo can be served by the GPU pipeline. */
export function gpuCanHandle(settings: Settings): boolean {
  // Floyd-Steinberg is sequential — keep it on CPU.
  return settings.dither !== "floyd";
}
