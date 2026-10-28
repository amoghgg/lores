// Video in, video out — all on the device. Preview plays a hidden <video>
// and runs each frame through the same pipeline as photos; export decodes
// every frame with WebCodecs (Mediabunny), renders it, and re-encodes, with
// the original audio passed through.

import type { FrameContext } from "./session";

/** Frames are worked at up to 1080p — film looks don't need more, phones can't take more. */
export const VIDEO_MAX_LONG = 1920;

export const isVideoFile = (f: Blob, name = "") =>
  f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(name);

/** ~0.13 bits per pixel per frame at 30 fps, clamped to 2–12 Mbps. */
export const videoBitrate = (w: number, h: number) => Math.round(Math.min(12e6, Math.max(2e6, w * h * 30 * 0.13)));

export function fitSize(w: number, h: number, long = VIDEO_MAX_LONG) {
  const k = Math.min(1, long / Math.max(w, h));
  // Encoders want even dimensions.
  return { w: Math.max(2, Math.round((w * k) / 2) * 2), h: Math.max(2, Math.round((h * k) / 2) * 2) };
}

/** Part of the frame to keep, as fractions of the full picture (after rotation). */
export type Crop = { x: number; y: number; w: number; h: number };
export const FULL_FRAME: Crop = { x: 0, y: 0, w: 1, h: 1 };
/** Part of the clip to keep, in seconds. */
export type Trim = { start: number; end: number };

/** Frame shapes offered for cropping; `ratio` = width / height, null = keep the original. */
export const ASPECTS = [
  { id: "original", label: "ORIGINAL", ratio: null },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
] as const;
export type AspectId = (typeof ASPECTS)[number]["id"];

/** Output sizes, by the short edge (720p = 720 px across a portrait clip). Never upscales. */
export const SIZES = [
  { id: "720", label: "720P", short: 720 },
  { id: "1080", label: "1080P", short: 1080 },
  { id: "max", label: "ORIGINAL", short: 2160 },
] as const;
export type SizeId = (typeof SIZES)[number]["id"];

/** The largest centred crop of shape `ratio` in a `w`×`h` picture. */
export function centredCrop(w: number, h: number, ratio: number | null): Crop {
  if (!ratio) return { ...FULL_FRAME };
  const fw = Math.min(1, (h * ratio) / w);
  const fh = Math.min(1, w / ratio / h);
  return { x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh };
}

/** Crop in source pixels (even, inside the picture). */
export function cropPixels(srcW: number, srcH: number, c: Crop) {
  const w = Math.max(2, Math.floor((c.w * srcW) / 2) * 2);
  const h = Math.max(2, Math.floor((c.h * srcH) / 2) * 2);
  const left = Math.min(srcW - w, Math.max(0, Math.round(c.x * srcW)));
  const top = Math.min(srcH - h, Math.max(0, Math.round(c.y * srcH)));
  return { left, top, width: w, height: h };
}

/** Size of the saved video for a crop of the source at a chosen size. */
export function outputSize(srcW: number, srcH: number, c: Crop, size: SizeId) {
  const px = cropPixels(srcW, srcH, c);
  const short = SIZES.find((s) => s.id === size)!.short;
  const k = Math.min(1, short / Math.min(px.width, px.height), 3840 / Math.max(px.width, px.height));
  return { w: Math.max(2, Math.round((px.width * k) / 2) * 2), h: Math.max(2, Math.round((px.height * k) / 2) * 2) };
}

export type LoadedVideo = {
  el: HTMLVideoElement;
  url: string;
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  duration: number;
};

export async function loadVideo(blob: Blob, filename: string): Promise<LoadedVideo> {
  const url = URL.createObjectURL(blob);
  const el = document.createElement("video");
  el.playsInline = true;
  el.preload = "auto";
  el.loop = false; // the app loops the trimmed stretch itself
  // Browsers (iOS Safari especially) only decode a video that's in the page,
  // so it lives there, invisible; the picture is drawn by the pipeline.
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.appendChild(el);
  el.src = url;
  el.load();
  try {
    await new Promise<void>((ok, fail) => {
      const t = window.setTimeout(() => fail(new Error("the video didn't load")), 20_000);
      el.onloadedmetadata = () => {
        window.clearTimeout(t);
        ok();
      };
      el.onerror = () => {
        window.clearTimeout(t);
        fail(new Error("this browser can't play that video"));
      };
    });
  } catch (err) {
    el.remove();
    URL.revokeObjectURL(url);
    throw err;
  }
  const { w, h } = fitSize(el.videoWidth, el.videoHeight);
  return { el, url, blob, filename, width: w, height: h, duration: el.duration };
}

/** Long edge for frames while previewing playback: about a quarter of the pixels of 1080p. */
export const PREVIEW_LONG = 960;

/**
 * The frame currently showing in the <video>, cropped. Full working size for
 * stills (long edge ≤ 1920); `long` (e.g. PREVIEW_LONG) for live playback,
 * which only has to look right at the size it's shown.
 */
export function grabFrame(v: LoadedVideo, long = VIDEO_MAX_LONG, crop: Crop = FULL_FRAME): Promise<ImageBitmap> {
  const px = cropPixels(v.el.videoWidth, v.el.videoHeight, crop);
  const { w, h } = fitSize(px.width, px.height, long);
  return createImageBitmap(v.el, px.left, px.top, px.width, px.height, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: long < VIDEO_MAX_LONG ? "medium" : "high",
  });
}

/** `n` small frames spread across the clip, for the timeline strip. */
export async function filmstrip(blob: Blob, n: number, height: number): Promise<HTMLCanvasElement[]> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return [];
  const start = await track.getFirstTimestamp();
  const dur = await track.computeDuration();
  const width = Math.max(2, Math.round((height * track.displayWidth) / track.displayHeight));
  const sink = new mb.CanvasSink(track, { width, height, fit: "cover", poolSize: 0 });
  const times = Array.from({ length: n }, (_, i) => start + ((i + 0.5) / n) * (dur - start));
  const out: HTMLCanvasElement[] = [];
  for await (const c of sink.canvasesAtTimestamps(times)) {
    if (c && c.canvas instanceof HTMLCanvasElement) out.push(c.canvas);
    else if (c) {
      const k = document.createElement("canvas");
      k.width = c.canvas.width;
      k.height = c.canvas.height;
      k.getContext("2d")!.drawImage(c.canvas, 0, 0);
      out.push(k);
    }
  }
  return out;
}

/** Seek and wait until the frame is actually there. */
export function seekTo(v: LoadedVideo, t: number): Promise<void> {
  const target = Math.max(0, Math.min(v.duration - 0.001, t));
  // Already there: no "seeked" event would ever come.
  if (Math.abs(v.el.currentTime - target) < 1e-3 && v.el.readyState >= 2) return Promise.resolve();
  return new Promise((ok) => {
    const done = () => {
      window.clearTimeout(timer);
      v.el.removeEventListener("seeked", done);
      ok();
    };
    const timer = window.setTimeout(done, 5000);
    v.el.addEventListener("seeked", done);
    v.el.currentTime = target;
  });
}

export type ExportJob = {
  /** Length of the clip in seconds. */
  duration: number;
  done: Promise<{ blob: Blob; ext: "mp4" | "webm" }>;
  cancel: () => Promise<void>;
};

/**
 * Re-render every frame of `blob` through `render` and encode the result.
 * `render` receives each decoded frame (at working size) and its context.
 */
export async function exportVideo(
  blob: Blob,
  render: (frame: ImageBitmap, ctx: Omit<FrameContext, "session">) => Promise<HTMLCanvasElement>,
  /** `p` 0..1, `mediaTime` = seconds of video rendered so far. */
  onProgress: (p: number, mediaTime: number) => void,
  /** Called before a retry in another format: per-frame state must start over. */
  onRestart: () => void = () => {},
  opts: { trim?: Trim; crop?: Crop; size?: SizeId } = {}
): Promise<ExportJob> {
  const mb = await import("mediabunny");
  const probe = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  const full = await probe.computeDuration();
  const trim = opts.trim && (opts.trim.start > 0.01 || opts.trim.end < full - 0.01) ? opts.trim : undefined;
  const duration = trim ? trim.end - trim.start : full;
  const crop = opts.crop ?? FULL_FRAME;
  const cropped = crop.w < 0.999 || crop.h < 0.999;
  const cropPx = cropPixels(track.displayWidth, track.displayHeight, crop);
  // Mediabunny crops and scales each frame before it reaches `render`, so a
  // smaller output is cheaper to render, not just smaller to store.
  const { w, h } = outputSize(track.displayWidth, track.displayHeight, crop, opts.size ?? "1080");
  const bitrate = videoBitrate(w, h);
  // MP4 first (plays everywhere), WebM if this machine can't encode MP4's
  // codecs. A codec can pass the capability check and still be refused when
  // the encoder actually starts (seen on Linux Chromium), so each attempt is
  // a full run that falls through to the next on an encoder error.
  const plans: { ext: "mp4" | "webm"; codecs: ("avc" | "hevc" | "av1" | "vp9" | "vp8")[] }[] = [
    { ext: "mp4", codecs: ["avc", "hevc", "av1"] },
    { ext: "webm", codecs: ["vp9", "vp8", "av1"] },
  ];
  let current: { cancel(): Promise<void> } | null = null;
  let cancelled = false;

  const attempt = async (ext: "mp4" | "webm", codec: string) => {
    const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const output = new mb.Output({
      format: ext === "mp4" ? new mb.Mp4OutputFormat({ fastStart: "in-memory" }) : new mb.WebMOutputFormat(),
      target: new mb.BufferTarget(),
    });
    // MP4 should carry AAC so it plays everywhere (QuickTime, iPhone,
    // Instagram); keep the original audio only if AAC can't be encoded here.
    const audioTrack = await input.getPrimaryAudioTrack();
    const aac =
      ext === "mp4" && audioTrack
        ? await mb.getFirstEncodableAudioCodec(["aac"], {
            numberOfChannels: audioTrack.numberOfChannels,
            sampleRate: audioTrack.sampleRate,
          })
        : null;
    const conversion = await mb.Conversion.init({
      input,
      output,
      showWarnings: false,
      trim,
      audio: aac ? { codec: "aac", quality: mb.QUALITY_HIGH } : undefined,
      video: {
        width: w,
        height: h,
        fit: "fill",
        crop: cropped ? cropPx : undefined,
        codec: codec as "avc",
        // A fixed bitrate scaled to the frame: ~8 Mbps at 1080p30, so
        // dithered or grainy looks can't balloon the file (quantizer mode
        // spent ~50 Mbps on a receipt).
        quality: new mb.Quality({ bitrate, bitrateMode: "variable" }),
        // The browser already picks a hardware encoder when there is one;
        // insisting on it makes machines without one refuse to encode.
        hardwareAcceleration: "no-preference",
        forceTranscode: true,
        process: async (sample) => {
          // Already cropped and scaled to w×h by Mediabunny.
          const frame = await createImageBitmap(sample.toCanvasImageSource());
          try {
            // Timestamps already count from the start of the trimmed clip.
            return await render(frame, { time: sample.timestamp });
          } finally {
            frame.close();
          }
        },
        processedWidth: w,
        processedHeight: h,
      },
    });
    if (!conversion.isValid) throw new Error("this video can't be converted here");
    conversion.onProgress = (p, t) => onProgress(p, t);
    current = conversion;
    await conversion.execute();
    const buf = (output.target as InstanceType<typeof mb.BufferTarget>).buffer!;
    return { blob: new Blob([buf], { type: ext === "mp4" ? "video/mp4" : "video/webm" }), ext };
  };

  const done = (async () => {
    let lastErr: unknown = new Error("this browser can't encode video");
    let first = true;
    for (const plan of plans) {
      const codec = await mb.getFirstEncodableVideoCodec(plan.codecs, { width: w, height: h, bitrate });
      if (!codec) continue;
      if (!first) onRestart();
      first = false;
      try {
        return await attempt(plan.ext, codec);
      } catch (err) {
        if (cancelled || (err instanceof Error && /cancel/i.test(err.name + err.message))) throw err;
        console.warn(`[pixel] ${plan.ext}/${codec} encode failed, trying the next format`, err);
        lastErr = err;
        onProgress(0, 0);
      }
    }
    throw lastErr;
  })();
  return {
    done,
    duration,
    cancel: async () => {
      cancelled = true;
      await current?.cancel();
    },
  };
}
