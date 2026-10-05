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
