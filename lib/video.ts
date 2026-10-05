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
  el.loop = true;
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
 * The frame currently showing in the <video>. Full working size for stills
 * and export; `long` (e.g. PREVIEW_LONG) for live playback, which only has
 * to look right at the size it's shown.
 */
export function grabFrame(v: LoadedVideo, long?: number): Promise<ImageBitmap> {
  const { w, h } = long ? fitSize(v.width, v.height, long) : { w: v.width, h: v.height };
  return createImageBitmap(v.el, { resizeWidth: w, resizeHeight: h, resizeQuality: long ? "medium" : "high" });
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
  onProgress: (p: number, mediaTime: number) => void
): Promise<ExportJob> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  const { w, h } = fitSize(track.displayWidth, track.displayHeight);
  // MP4/H.264 where the browser can encode it, else WebM/VP9.
  let ext: "mp4" | "webm" = "mp4";
  let codec = await mb.getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1"], { width: w, height: h });
  if (!codec || !["avc", "hevc", "av1", "vp9"].includes(codec)) {
    codec = await mb.getFirstEncodableVideoCodec(["vp9", "vp8", "av1"], { width: w, height: h });
    ext = "webm";
  }
  if (!codec) throw new Error("this browser can't encode video");
  const output = new mb.Output({
    format: ext === "mp4" ? new mb.Mp4OutputFormat({ fastStart: "in-memory" }) : new mb.WebMOutputFormat(),
    target: new mb.BufferTarget(),
  });
  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const wctx = work.getContext("2d")!;
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
    audio: aac ? { codec: "aac", quality: mb.QUALITY_HIGH } : undefined,
    video: {
      width: w,
      height: h,
      fit: "contain",
      codec,
      // A fixed bitrate scaled to the frame: ~8 Mbps at 1080p30, so dithered
      // or grainy looks can't balloon the file (quantizer mode spent ~50 Mbps
      // on a receipt).
      quality: new mb.Quality({ bitrate: videoBitrate(w, h), bitrateMode: "variable" }),
      hardwareAcceleration: "prefer-hardware",
      forceTranscode: true,
      process: async (sample) => {
        sample.draw(wctx, 0, 0, w, h);
        const frame = await createImageBitmap(work);
        try {
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
  const done = conversion.execute().then(() => {
    const buf = (output.target as InstanceType<typeof mb.BufferTarget>).buffer!;
    return { blob: new Blob([buf], { type: ext === "mp4" ? "video/mp4" : "video/webm" }), ext };
  });
  return { done, cancel: () => conversion.cancel(), duration: await input.computeDuration() };
}
