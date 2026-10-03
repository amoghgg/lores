// Live thumbnails of the user's own photo under any recipe. Renders run one at
// a time on a dedicated GPU instance (see getThumbGPU) from small proxies of
// the source, and are cached by (source, view, recipe code).
//
// Two views:
//  - "fit":  the whole photo, long edge = size. Block sizes are scaled down
//            with it, so the thumb shows the overall look.
//  - "crop": a 1:1 centre crop of the full-res source, so pixel and dither
//            detail reads at true scale.

import { processBest } from "./pipeline";
import {
  encodeRecipe,
  toSettings,
  toFilm,
  toOverlayOpts,
  type Recipe,
} from "./recipe";
import { OVERLAY_BLEND_BITS, OVERLAY_FIT_BITS } from "./gpu/webgpu";

export type ThumbView = "fit" | "crop";

type Job = {
  key: string;
  recipe: Recipe;
  view: ThumbView;
  size: number;
  group: string;
  gen: number;
  resolve: (c: HTMLCanvasElement | null) => void;
};

const CACHE_MAX = 500;

class ThumbRenderer {
  private source: ImageBitmap | null = null;
  private sourceId = "";
  private texture: ImageBitmap | null = null;
  private textureId = "";
  private proxies = new Map<string, ImageBitmap>();
  private cache = new Map<string, HTMLCanvasElement>();
  private queue: Job[] = [];
  private running = false;
  /** Per-group generation: cancelling one group never starves another. */
  private gens = new Map<string, number>();

  setSource(bitmap: ImageBitmap | null, id: string) {
    if (id === this.sourceId) return;
    this.source = bitmap;
    this.sourceId = id;
    for (const p of this.proxies.values()) p.close();
    this.proxies.clear();
    this.cache.clear();
    this.cancel();
  }

  setTexture(bitmap: ImageBitmap | null, id: string) {
    if (id === this.textureId) return;
    this.texture = bitmap;
    this.textureId = id;
  }

  private genOf(group: string) {
    return this.gens.get(group) ?? 0;
  }

  /** Drop waiting jobs in `group` (all groups if omitted). */
  cancel(group?: string) {
    if (group === undefined) {
      for (const k of this.gens.keys()) this.gens.set(k, this.genOf(k) + 1);
      for (const j of this.queue) j.resolve(null);
      this.queue = [];
      return;
    }
    this.gens.set(group, this.genOf(group) + 1);
    this.queue = this.queue.filter((j) => {
      if (j.group !== group) return true;
      j.resolve(null);
      return false;
    });
  }

  keyFor(recipe: Recipe, view: ThumbView, size: number) {
    return `${this.sourceId}|${this.textureId}|${view}${size}|${encodeRecipe(recipe)}`;
  }

  peek(recipe: Recipe, view: ThumbView, size: number): HTMLCanvasElement | null {
    return this.cache.get(this.keyFor(recipe, view, size)) ?? null;
  }

  render(
    recipe: Recipe,
    view: ThumbView,
    size: number,
    group = "default"
  ): Promise<HTMLCanvasElement | null> {
    const key = this.keyFor(recipe, view, size);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      this.queue.push({ key, recipe, view, size, group, gen: this.genOf(group), resolve });
      void this.pump();
    });
  }

  private async proxy(view: ThumbView, size: number): Promise<ImageBitmap | null> {
    const src = this.source;
    if (!src) return null;
    const k = `${view}${size}`;
    const have = this.proxies.get(k);
    if (have) return have;
    const bmp = await makeProxy(src, view, size);
    if (this.source !== src) {
      bmp.close();
      return null;
    }
    this.proxies.set(k, bmp);
    return bmp;
  }

  /**
   * Restyled looks (PS2, sticker…) are computed ONCE on the full source and
   * the thumb is cut from that — so a thumbnail can never show a cut-out the
   * full image doesn't get. Returns the proxy plus the film with the restyle
   * already applied.
   */
  private async styledProxy(recipe: Recipe, view: ThumbView, size: number) {
    const src = this.source;
    const film = toFilm(recipe);
    if (!src || !film || film.recipe.stylize === "none" || film.controls.amount <= 0) return null;
    const { stylizedSource } = await import("./stylize");
    const r = film.recipe;
    const key = `${view}${size}|${r.stylize}|${r.stylizeBg}|${film.controls.amount.toFixed(2)}`;
    let bmp = this.proxies.get(key);
    if (!bmp) {
      const st = await stylizedSource(src, r.stylize, r.stylizeBg, film.controls.amount, film.controls.seed);
      bmp = await makeProxy(st.bitmap, view, size);
      if (st.owned) st.bitmap.close();
      if (this.source !== src) {
        bmp.close();
        return null;
      }
      this.proxies.set(key, bmp);
    }
    return {
      bitmap: bmp,
      film: { ...film, recipe: { ...r, stylize: "none" as const }, controls: { ...film.controls, amount: 1 } },
    };
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        if (job.gen !== this.genOf(job.group)) {
          job.resolve(null);
          continue;
        }
        const cached = this.cache.get(job.key);
        if (cached) {
          job.resolve(cached);
          continue;
        }
        const src = this.source;
        const styled = await this.styledProxy(job.recipe, job.view, job.size);
        const prox = styled ? styled.bitmap : await this.proxy(job.view, job.size);
        if (!prox || !src) {
          job.resolve(null);
          continue;
        }
        const film = styled ? styled.film : toFilm(job.recipe);
        const settings = toSettings(job.recipe);
        if (job.view === "fit") {
          // Keep the look proportional: an 8px block on a 1600px photo is a
          // 1px block on a 200px thumbnail.
          const k = prox.width / src.width;
          settings.blockSize = Math.max(1, Math.round(settings.blockSize * k));
        }
        const overlay = toOverlayOpts(job.recipe, this.texture, {
          blend: OVERLAY_BLEND_BITS,
          fit: OVERLAY_FIT_BITS,
        });
        try {
          const r = await processBest(prox, settings, overlay, film, "thumb");
          this.cache.set(job.key, r.canvas);
          if (this.cache.size > CACHE_MAX) {
            const first = this.cache.keys().next().value;
            if (first !== undefined) this.cache.delete(first);
          }
          job.resolve(r.canvas);
        } catch (err) {
          console.warn("[pixel] thumb failed", err);
          job.resolve(null);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

/** A thumb-sized view of `src`: the whole frame, or a 1:1 upper-third crop. */
async function makeProxy(src: ImageBitmap, view: ThumbView, size: number): Promise<ImageBitmap> {
  if (view === "fit") {
    const s = Math.min(1, size / Math.max(src.width, src.height));
    return createImageBitmap(src, {
      resizeWidth: Math.max(8, Math.round(src.width * s)),
      resizeHeight: Math.max(8, Math.round(src.height * s)),
      resizeQuality: "high",
    });
  }
  const w = Math.min(size, src.width);
  const h = Math.min(size, src.height);
  // Centre crop nudged up to the upper third — where faces and subjects sit.
  const x = Math.round((src.width - w) / 2);
  const y = Math.round((src.height - h) * 0.3);
  return createImageBitmap(src, x, y, w, h);
}

let renderer: ThumbRenderer | null = null;
export function getThumbs(): ThumbRenderer {
  if (!renderer) renderer = new ThumbRenderer();
  return renderer;
}
