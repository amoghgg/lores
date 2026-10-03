// A Recipe is the whole look as one small, serialisable value: every step of
// the signal chain, its bypass state, and the seed. It is what undo stores,
// what the URL hash carries, what gets embedded in exported PNGs, and what
// Shuffle generates. Images are never part of it.

import type { DitherMode, Settings, OverlayInput, FilmInput } from "./pipeline";
import { PALETTES } from "./palettes";
import { FILM_STOCKS, getStock } from "./filmStocks";
import { DEFAULT_CONTROLS, type FilmControls } from "./film";

export type StepId = "pixel" | "palette" | "dither" | "film" | "texture" | "audio";

export type BlendName =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "color-burn";

export type FitName = "cover" | "tile" | "fit";

export type Recipe = {
  block: number; // 1..48
  pixelAmt: number; // 0..1
  palette: string;
  paletteAmt: number;
  dither: DitherMode;
  ditherAmt: number;
  film: string; // stock id or "none"
  filmAmt: number;
  grain: number; // 0..2
  glow: number;
  vignette: number;
  leak: number;
  frame: boolean;
  seed: number;
  texBlend: BlendName;
  texFit: FitName;
  texOpacity: number; // 0..1
  /** Further film layers stacked on top of the one above, in order. */
  stack: FilmLayer[];
  /** Bypassed (stomped-off) steps keep their settings but don't render. */
  off: Partial<Record<StepId, boolean>>;
};

/** One film look in the stack, with its own strength and controls. */
export type FilmLayer = {
  film: string;
  filmAmt: number;
  grain: number;
  glow: number;
  vignette: number;
  leak: number;
  frame: boolean;
  seed: number;
};

/** Most film layers a recipe keeps — past this a look is mud anyway. */
export const MAX_FILMS = 8;

export const DEFAULT_RECIPE: Recipe = {
  block: 1,
  pixelAmt: 1,
  palette: "none",
  paletteAmt: 1,
  dither: "none",
  ditherAmt: 1,
  film: "portra400",
  filmAmt: 1,
  grain: 1,
  glow: 1,
  vignette: 1,
  leak: 1,
  frame: true,
  seed: 7,
  texBlend: "multiply",
  texFit: "cover",
  texOpacity: 0.6,
  stack: [],
  off: {},
};

export function newLayer(film: string, seed = 7): FilmLayer {
  return { film, filmAmt: 1, grain: 1, glow: 1, vignette: 1, leak: 1, frame: true, seed };
}

const layerOf = (r: Recipe): FilmLayer => ({
  film: r.film,
  filmAmt: r.filmAmt,
  grain: r.grain,
  glow: r.glow,
  vignette: r.vignette,
  leak: r.leak,
  frame: r.frame,
  seed: r.seed,
});

/** Every film layer in order (bottom first). Empty when there is no look. */
export function filmLayers(r: Recipe): FilmLayer[] {
  const all = [layerOf(r), ...(r.stack ?? [])];
  return all.filter((l) => l.film !== "none");
}

/** Recipe with its film stack replaced by `layers` (bottom first). */
export function withLayers(r: Recipe, layers: FilmLayer[]): Recipe {
  const ls = layers.filter((l) => l.film !== "none").slice(0, MAX_FILMS);
  const [first = { ...layerOf(r), film: "none" }, ...rest] = ls;
  return { ...r, ...first, stack: rest };
}

/** Patch one layer; index past the end appends (used to add a look). */
export function patchLayer(r: Recipe, i: number, patch: Partial<FilmLayer>): Recipe {
  const ls = filmLayers(r);
  if (i >= ls.length) {
    if (!patch.film || patch.film === "none") return r;
    return withLayers(r, [...ls, { ...newLayer(patch.film, 1 + ((r.seed * 31 + ls.length * 977) % 9000)), ...patch }]);
  }
  return withLayers(r, ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
}

export function removeLayer(r: Recipe, i: number): Recipe {
  return withLayers(r, filmLayers(r).filter((_, j) => j !== i));
}

export const DITHERS: { id: DitherMode; name: string; hint: string }[] = [
  { id: "none", name: "NONE", hint: "flat quantize" },
  { id: "floyd", name: "F·STEIN", hint: "error diffusion" },
  { id: "atkinson", name: "ATKINSON", hint: "1984 mac, crisp" },
  { id: "jarvis", name: "JARVIS", hint: "wide kernel" },
  { id: "bayer4", name: "BAYER 4", hint: "ordered 4×4" },
  { id: "bayer8", name: "BAYER 8", hint: "ordered 8×8" },
  { id: "bluenoise", name: "BLUE NOISE", hint: "perceptual" },
  { id: "ign", name: "IGN", hint: "hash dither" },
  { id: "halftone", name: "HALFTONE", hint: "dot screen" },
];

export const BLOCKS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export const BLENDS: { id: BlendName; name: string; hint: string }[] = [
  { id: "multiply", name: "MULTIPLY", hint: "darken / ink" },
  { id: "screen", name: "SCREEN", hint: "lighten / glow" },
  { id: "overlay", name: "OVERLAY", hint: "contrast" },
  { id: "soft-light", name: "SOFT LIGHT", hint: "subtle" },
  { id: "hard-light", name: "HARD LIGHT", hint: "punchy" },
  { id: "difference", name: "DIFFERENCE", hint: "invert mix" },
  { id: "color-burn", name: "COLOR BURN", hint: "deep dark" },
  { id: "normal", name: "NORMAL", hint: "alpha only" },
];

export function isOn(r: Recipe, step: StepId): boolean {
  return !r.off[step];
}

/** Recipe → the pipeline's render settings. Bypassed steps fall away. */
export function toSettings(r: Recipe): Settings {
  const pixelOn = isOn(r, "pixel") && r.block > 1;
  const paletteOn = isOn(r, "palette");
  return {
    blockSize: pixelOn ? r.block : 1,
    pixelAmount: r.pixelAmt,
    paletteId: paletteOn ? r.palette : "none",
    paletteAmount: r.paletteAmt,
    dither: isOn(r, "dither") && paletteOn ? r.dither : "none",
    ditherAmount: r.ditherAmt,
  };
}

export function layerFilm(l: FilmLayer): FilmInput | null {
  const stock = getStock(l.film);
  if (!stock) return null;
  const controls: FilmControls = {
    ...DEFAULT_CONTROLS,
    amount: l.filmAmt,
    grain: l.grain,
    glow: l.glow,
    vignette: l.vignette,
    leak: l.leak,
    frame: l.frame,
    seed: l.seed,
  };
  return { recipe: stock.recipe, controls };
}

/** Recipe → the pipeline's film passes, bottom layer first. */
export function toFilms(r: Recipe): FilmInput[] {
  if (!isOn(r, "film")) return [];
  return filmLayers(r)
    .map(layerFilm)
    .filter((f): f is FilmInput => !!f);
}

export function toOverlayOpts(
  r: Recipe,
  image: ImageBitmap | null,
  bits: { blend: Record<BlendName, number>; fit: Record<FitName, number> }
): OverlayInput | null {
  if (!image || !isOn(r, "texture")) return null;
  return {
    image,
    width: image.width,
    height: image.height,
    blendMode: r.texBlend as GlobalCompositeOperation,
    blendBit: bits.blend[r.texBlend],
    fitBit: bits.fit[r.texFit],
    fit: r.texFit,
    opacity: r.texOpacity,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Recipe codes — readable enough to paste in a caption:
//   1~px:8~pal:pico8.80~dt:atkinson~film:portra400.g120.s7~tx:multiply.cover.60
// Defaults are omitted; a leading "!" on a segment means the step is bypassed.
// ───────────────────────────────────────────────────────────────────────────

const pct = (v: number) => String(Math.round(v * 100));
const unpct = (s: string | undefined, d: number) =>
  s === undefined || s === "" || isNaN(Number(s)) ? d : Math.max(0, Math.min(2, Number(s) / 100));

export function encodeRecipe(r: Recipe): string {
  const segs: string[] = ["1"];
  const bang = (step: StepId) => (r.off[step] ? "!" : "");
  if (r.block > 1) segs.push(`${bang("pixel")}px:${r.block}${r.pixelAmt < 1 ? "." + pct(r.pixelAmt) : ""}`);
  if (r.palette !== "none") segs.push(`${bang("palette")}pal:${r.palette}${r.paletteAmt < 1 ? "." + pct(r.paletteAmt) : ""}`);
  if (r.dither !== "none") segs.push(`${bang("dither")}dt:${r.dither}${r.ditherAmt < 1 ? "." + pct(r.ditherAmt) : ""}`);
  for (const l of filmLayers(r)) {
    const p = [`film:${l.film}`];
    if (l.filmAmt !== 1) p.push(pct(l.filmAmt));
    if (l.grain !== 1) p.push("g" + pct(l.grain));
    if (l.glow !== 1) p.push("h" + pct(l.glow));
    if (l.vignette !== 1) p.push("v" + pct(l.vignette));
    if (l.leak !== 1) p.push("l" + pct(l.leak));
    if (!l.frame) p.push("f0");
    p.push("s" + l.seed);
    segs.push(bang("film") + p.join("."));
  }
  if (
    r.texBlend !== DEFAULT_RECIPE.texBlend ||
    r.texFit !== DEFAULT_RECIPE.texFit ||
    r.texOpacity !== DEFAULT_RECIPE.texOpacity ||
    r.off.texture
  ) {
    segs.push(`${bang("texture")}tx:${r.texBlend}.${r.texFit}.${pct(r.texOpacity)}`);
  }
  return segs.join("~");
}

export function decodeRecipe(code: string): Recipe | null {
  const s = code.trim().replace(/^#?r=/, "");
  const segs = s.split("~");
  if (segs[0] !== "1") return null;
  const r: Recipe = {
    ...DEFAULT_RECIPE,
    block: 1,
    palette: "none",
    dither: "none",
    film: "none",
    stack: [],
    off: {},
  };
  const films: FilmLayer[] = [];
  for (const raw of segs.slice(1)) {
    const off = raw.startsWith("!");
    const seg = off ? raw.slice(1) : raw;
    const [key, rest = ""] = seg.split(":");
    const parts = rest.split(".");
    switch (key) {
      case "px": {
        const b = parseInt(parts[0], 10);
        if (b >= 1 && b <= 48) r.block = b;
        r.pixelAmt = Math.min(1, unpct(parts[1], 1));
        if (off) r.off.pixel = true;
        break;
      }
      case "pal":
        if (PALETTES.some((p) => p.id === parts[0])) r.palette = parts[0];
        r.paletteAmt = Math.min(1, unpct(parts[1], 1));
        if (off) r.off.palette = true;
        break;
      case "dt":
        if (DITHERS.some((d) => d.id === parts[0])) r.dither = parts[0] as DitherMode;
        r.ditherAmt = Math.min(1, unpct(parts[1], 1));
        if (off) r.off.dither = true;
        break;
      case "film": {
        if (!getStock(parts[0])) break;
        const l = newLayer(parts[0]);
        for (const p of parts.slice(1)) {
          const tag = p[0];
          const v = p.slice(1);
          if (/^\d+$/.test(p)) l.filmAmt = Math.min(1, unpct(p, 1));
          else if (tag === "g") l.grain = unpct(v, 1);
          else if (tag === "h") l.glow = unpct(v, 1);
          else if (tag === "v") l.vignette = unpct(v, 1);
          else if (tag === "l") l.leak = unpct(v, 1);
          else if (tag === "f") l.frame = v !== "0";
          else if (tag === "s" && /^\d+$/.test(v)) l.seed = Number(v);
        }
        films.push(l);
        if (off) r.off.film = true;
        break;
      }
      case "tx":
        if (BLENDS.some((b) => b.id === parts[0])) r.texBlend = parts[0] as BlendName;
        if (["cover", "tile", "fit"].includes(parts[1])) r.texFit = parts[1] as FitName;
        r.texOpacity = Math.min(1, unpct(parts[2], DEFAULT_RECIPE.texOpacity));
        if (off) r.off.texture = true;
        break;
    }
  }
  return withLayers(r, films);
}

/** Human caption for a recipe — used on contact-sheet frames and toasts. */
export function describeRecipe(r: Recipe): string {
  const bits: string[] = [];
  if (isOn(r, "film")) for (const l of filmLayers(r)) bits.push(getStock(l.film)?.name ?? l.film);
  if (isOn(r, "palette") && r.palette !== "none")
    bits.push(PALETTES.find((p) => p.id === r.palette)?.name ?? r.palette);
  if (isOn(r, "dither") && r.dither !== "none" && r.palette !== "none")
    bits.push(DITHERS.find((d) => d.id === r.dither)?.name ?? r.dither);
  if (isOn(r, "pixel") && r.block > 1) bits.push(`${r.block}PX`);
  return bits.length ? bits.join(" · ") : "ORIGINAL";
}

// ───────────────────────────────────────────────────────────────────────────
// Shuffle. Seeded so a contact sheet can be regenerated exactly.
// ───────────────────────────────────────────────────────────────────────────

export type Locks = Partial<Record<StepId, boolean>>;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

/**
 * New recipe with every unlocked step re-rolled. Weighted toward results that
 * look good: most rolls are either a film look on the photo, or pixel art,
 * not a muddy blend of everything at once.
 */
export function shuffleRecipe(base: Recipe, locks: Locks, seed: number): Recipe {
  const rand = rng(seed * 2654435761);
  const r: Recipe = { ...base, off: { ...base.off } };
  const mode = rand() < 0.55 ? "film" : "pixel";

  if (!locks.film) {
    r.film = mode === "film" || rand() < 0.35 ? pick(rand, FILM_STOCKS).id : "none";
    r.filmAmt = 1;
    r.grain = 1;
    r.glow = 1;
    r.vignette = 1;
    r.leak = 1;
    r.seed = 1 + Math.floor(rand() * 9000);
    r.stack = [];
    r.off.film = false;
  }
  if (!locks.pixel) {
    r.block = mode === "pixel" ? pick(rand, [2, 3, 4, 6, 8, 12]) : rand() < 0.15 ? pick(rand, [2, 3, 4]) : 1;
    r.pixelAmt = 1;
    r.off.pixel = false;
  }
  if (!locks.palette) {
    r.palette =
      mode === "pixel"
        ? pick(rand, PALETTES.filter((p) => p.id !== "none")).id
        : rand() < 0.12
        ? pick(rand, ["mono", "gb-pocket"])
        : "none";
    r.paletteAmt = 1;
    r.off.palette = false;
  }
  if (!locks.dither) {
    r.dither = r.palette === "none" ? "none" : pick(rand, DITHERS).id;
    r.ditherAmt = 1;
    r.off.dither = false;
  }
  return r;
}

/** Small nudges around the current look — for "near this one" exploration. */
export function mutateRecipe(base: Recipe, locks: Locks, seed: number): Recipe {
  const rand = rng(seed * 40503 + 17);
  const r: Recipe = { ...base, off: { ...base.off } };
  const jitter = (v: number, span: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Math.round((v + (rand() - 0.5) * span) * 100) / 100));
  if (!locks.film && r.film !== "none") {
    r.grain = jitter(r.grain, 0.8, 0, 2);
    r.glow = jitter(r.glow, 0.8, 0, 2);
    r.vignette = jitter(r.vignette, 0.8, 0, 2);
    r.leak = jitter(r.leak, 0.8, 0, 2);
    r.seed = 1 + Math.floor(rand() * 9000);
    if (rand() < 0.35) {
      const same = FILM_STOCKS.filter(
        (s) => s.category === getStock(r.film)?.category
      );
      r.film = pick(rand, same).id;
    }
  }
  if (!locks.pixel && r.block > 1) {
    const i = BLOCKS.indexOf(r.block);
    const j = Math.max(1, Math.min(BLOCKS.length - 1, (i < 0 ? 4 : i) + (rand() < 0.5 ? -1 : 1)));
    r.block = BLOCKS[j];
  }
  if (!locks.dither && r.palette !== "none" && rand() < 0.5) {
    r.dither = pick(rand, DITHERS).id;
  }
  return r;
}

export function sameRecipe(a: Recipe, b: Recipe): boolean {
  return encodeRecipe(a) === encodeRecipe(b);
}
