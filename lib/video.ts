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
  onProgress: (p: number, mediaTime: number) => void,
  /** Called before a retry in another format: per-frame state must start over. */
  onRestart: () => void = () => {}
): Promise<ExportJob> {
  const mb = await import("mediabunny");
  const probe = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  const duration = await probe.computeDuration();
  const { w, h } = fitSize(track.displayWidth, track.displayHeight);
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
