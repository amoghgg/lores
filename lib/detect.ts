import { markReady } from "./models";

// What's actually in the photo, for the blob-tracking looks: objects
// (EfficientDet, the 80 COCO classes) and faces with their landmarks
// (BlazeFace: eyes, nose, mouth, ears). MediaPipe Tasks, self-hosted, on
// the device; loaded the first time a tracking look is used, cached per
// image.

export type Thing = {
  label: string;
  score: number;
  /** Box in 0..1 of the image. */
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "object" | "face" | "part";
  /** Stable across video frames (set by trackThings). */
  id?: number;
};

type Src = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

type Box = { originX: number; originY: number; width: number; height: number };
type Detection = {
  boundingBox?: Box;
  categories: { categoryName: string; score: number }[];
  keypoints?: { x: number; y: number }[];
};
type Detector = { detect(img: HTMLCanvasElement): { detections: Detection[] } };

export const OBJECT_MODEL = "/mediapipe/efficientdet_lite2.tflite";
const FACE_MODEL = "/mediapipe/blaze_face_short_range.tflite";
const WORK = 640;

let detectors: Promise<{ objects: Detector | null; faces: Detector | null }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getDetectors() {
  if (!detectors) {
    detectors = (async () => {
      const { FilesetResolver, ObjectDetector, FaceDetector } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      const make = async <T,>(what: string, f: () => Promise<T>) => {
        try {
          return await f();
        } catch (err) {
          // Flag and carry on: the look still draws whatever the other finds.
          console.warn(`[pixel] ${what} detector unavailable`, err);
          return null;
        }
      };
      const [objects, faces] = await Promise.all([
        make("object", () =>
          ObjectDetector.createFromOptions(files, {
            baseOptions: { modelAssetPath: OBJECT_MODEL, delegate: "CPU" },
            runningMode: "IMAGE",
            scoreThreshold: 0.35,
            maxResults: 12,
          })
        ),
        make("face", () =>
          FaceDetector.createFromOptions(files, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
            runningMode: "IMAGE",
            minDetectionConfidence: 0.5,
          })
        ),
      ]);
      markReady("detect");
      return { objects: objects as unknown as Detector | null, faces: faces as unknown as Detector | null };
    })();
  }
  return detectors;
}

// BlazeFace keypoint order. "R"/"L" are the person's own right and left.
const FACE_PARTS = ["EYE R", "EYE L", "NOSE", "MOUTH", "EAR R", "EAR L"];

const cache = new WeakMap<object, Promise<Thing[]>>();

/** Everything recognised in `src`, biggest first. Cached per image. */
export function detectThings(src: Src): Promise<Thing[]> {
  const hit = cache.get(src);
  if (hit) return hit;
  const job = (async () => {
    const sw = "naturalWidth" in src ? src.naturalWidth : src.width;
    const sh = "naturalHeight" in src ? src.naturalHeight : src.height;
    const k = Math.min(1, WORK / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
    const { objects, faces } = await getDetectors();
    // The detectors aren't re-entrant: one image at a time.
    const run = queue.then(() => ({
      o: objects?.detect(c).detections ?? [],
      f: faces?.detect(c).detections ?? [],
    }));
    queue = run.catch(() => undefined);
    const { o, f } = await run;
    const W = c.width;
    const H = c.height;
    const out: Thing[] = [];
    for (const d of o) {
      const b = d.boundingBox;
      const cat = d.categories[0];
      if (!b || !cat) continue;
      out.push({
        label: cat.categoryName.toUpperCase(),
        score: cat.score,
        x: b.originX / W,
        y: b.originY / H,
        w: b.width / W,
        h: b.height / H,
        kind: "object",
      });
    }
    for (const d of f) {
      const b = d.boundingBox;
      if (!b) continue;
      const fw = b.width / W;
      out.push({ label: "FACE", score: d.categories[0]?.score ?? 1, x: b.originX / W, y: b.originY / H, w: fw, h: b.height / H, kind: "face" });
      // Landmarks get small boxes of their own, sized to the face.
      const s = fw * 0.16;
      (d.keypoints ?? []).forEach((p, i) => {
        if (!FACE_PARTS[i]) return;
        const ar = W / H;
        out.push({ label: FACE_PARTS[i], score: 1, x: p.x - s / 2, y: p.y - (s * ar) / 2, w: s, h: s * ar, kind: "part" });
      });
    }
    return out.sort((a, b) => b.w * b.h - a.w * a.h);
  })();
  cache.set(src, job);
  job.catch(() => cache.delete(src));
  return job;
}

/**
 * Video: keep each thing's ID across frames — match by label and overlap,
 * ease the box towards the new detection so it glides instead of jitters,
 * and hold a lost thing for a few frames before dropping it.
 */
export function trackThings(session: import("./session").VideoSession, found: Thing[]): (Thing & { id: number })[] {
  const iou = (a: Thing, b: Thing) => {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
  };
  const used = new Set<number>();
  const next: import("./session").Track[] = [];
  for (const f of found) {
    let best = -1;
    let bestIou = 0.25;
    session.tracks.forEach((t, i) => {
      if (used.has(i) || t.label !== f.label) return;
      const o = iou(t, f);
      if (o > bestIou) {
        bestIou = o;
        best = i;
      }
    });
    if (best >= 0) {
      used.add(best);
      const t = session.tracks[best];
      const k = 0.55; // smoothing towards the new box
      next.push({ ...f, id: t.id, seen: 0, hits: t.hits + 1, x: t.x + (f.x - t.x) * k, y: t.y + (f.y - t.y) * k, w: t.w + (f.w - t.w) * k, h: t.h + (f.h - t.h) * k });
    } else {
      next.push({ ...f, id: session.nextId++, seen: 0, hits: 1 });
    }
  }
  // Briefly missed (blink, motion blur): keep it for up to 4 frames.
  session.tracks.forEach((t, i) => {
    if (!used.has(i) && t.seen < 4) next.push({ ...t, seen: t.seen + 1 });
  });
  session.tracks = next;
  // A one-frame flicker isn't a thing: show it once it's been seen twice.
  // (The first frame after a seek has no history, so it shows everything.)
  const fresh = next.every((t) => t.hits === 1);
  return fresh ? next : next.filter((t) => t.hits >= 2);
}
