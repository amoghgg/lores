// Looks that need an on-device AI model (cut-out, tracking, depth) download
// it the first time they're actually chosen — never just because their
// thumbnail scrolled into view. Until then their thumbnail says what it
// costs. Ready state lives here; the loaders call markReady.

import type { FilmRecipe } from "./film";

export type ModelKind = "segment" | "detect" | "depth";

/** Rough first-time download (compressed), for the "tap to load" tiles. */
export const MODEL_SIZE: Record<ModelKind, string> = { segment: "4 MB", detect: "9 MB", depth: "25 MB" };

export function modelsFor(r: FilmRecipe): ModelKind[] {
  const out: ModelKind[] = [];
  if (r.stylize === "ps2" || r.stylize === "sticker") out.push("segment");
  if (r.stylize.startsWith("depth")) out.push("depth");
  if (r.fx === "blob") out.push("detect");
  return out;
}

const ready = new Set<ModelKind>();
export const EVENT = "lores:models";

export const isReady = (k: ModelKind) => ready.has(k);
export const readyCount = () => ready.size;
export const missingFor = (r: FilmRecipe) => modelsFor(r).filter((k) => !ready.has(k));

export function markReady(k: ModelKind) {
  if (ready.has(k)) return;
  ready.add(k);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}
