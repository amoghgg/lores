// State that carries from one video frame to the next: where tracked things
// were (so IDs stay on the same object), and the previous moshed frame plus
// its source (so datamosh follows the video's real motion). Photos never
// have a session.

import type { Thing } from "./detect";

export type MoshState = {
  w: number;
  h: number;
  /** Previous source frame's luma, for motion estimation. */
  prevLuma: Float32Array;
  /** Previous output (RGBA) — what the next P-frame is predicted from. */
  prevOut: Uint8ClampedArray;
};

/** `seen` = frames since last detected; `hits` = frames it has been detected in. */
export type Track = Thing & { id: number; seen: number; hits: number };

export class VideoSession {
  mosh = new Map<string, MoshState>();
  tracks: Track[] = [];
  nextId = 1;
  /** Video time of the last detector run (tracking runs it at most 15×/s). */
  lastDetect = -Infinity;
  /** Last depth map (the depth model runs at most 15×/s). */
  depth: { w: number; h: number; time: number; map: Float32Array } | null = null;
  /** Seeking or a new export starts a fresh "keyframe". */
  reset() {
    this.mosh.clear();
    this.tracks = [];
    this.nextId = 1;
    this.lastDetect = -Infinity;
    this.depth = null;
  }
}

/** One video frame: when it is, and the session it belongs to. */
export type FrameContext = { time: number; session: VideoSession };

/** Looks that redraw the picture too heavily to run per frame. */
export const PHOTO_ONLY = new Set(["ps2", "airbrush", "sticker", "impasto"]);
