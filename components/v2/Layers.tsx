"use client";

import { PALETTES } from "@/lib/palettes";
import { getStock } from "@/lib/filmStocks";
import { BLENDS, DITHERS, filmLayers, stageOf, type Recipe } from "@/lib/recipe";
import type { Tab } from "./Panel";

type Layer = {
  key: string;
  kind: string;
  label: string;
  tab: Tab;
  remove: () => void;
  open?: () => void;
  active?: boolean;
};

type Props = {
  recipe: Recipe;
  hasTexture: boolean;
  set: (patch: Partial<Recipe>) => void;
  onClearTexture: () => void;
  onOpen: (tab: Tab) => void;
  /** Selected film layer, and how to select / remove one. */
  filmLayer: number;
  onFilmLayer: (i: number) => void;
  onRemoveFilm: (i: number) => void;
  /** Highlight the selected film layer (only while the FILM tab is open). */
  filmTab: boolean;
};

/**
 * Everything stacked on the photo, in the order it's applied. Tap a layer to
 * jump to its tab; × takes that one layer off.
 */
export function Layers({
  recipe: r,
  hasTexture,
  set,
  onClearTexture,
  onOpen,
  filmLayer,
  onFilmLayer,
  onRemoveFilm,
  filmTab,
}: Props) {
  const layers: Layer[] = [];
  // Shown in the order the engine really applies them: restyles, then the
  // PIXEL tab, then grades, then texture, then screens.
  const films = filmLayers(r);
  const looks = (stage: number) =>
    films.forEach((l, i) => {
      if (stageOf(l.film) !== stage) return;
      layers.push({
        key: `film${i}`,
        kind: films.length > 1 ? `LOOK ${i + 1}` : "LOOK",
        label: getStock(l.film)?.name ?? l.film,
        tab: "film",
        open: () => onFilmLayer(i),
        remove: () => onRemoveFilm(i),
        active: filmTab && films.length > 1 && i === filmLayer,
      });
    });
  looks(0);
  if (r.block > 1) {
    layers.push({ key: "size", kind: "SIZE", label: `${r.block}px`, tab: "pixel", remove: () => set({ block: 1 }) });
  }
  if (r.palette !== "none") {
    layers.push({
      key: "colours",
      kind: "COLOURS",
      label: PALETTES.find((p) => p.id === r.palette)?.name ?? r.palette,
      tab: "pixel",
      remove: () => set({ palette: "none", dither: "none" }),
    });
    if (r.dither !== "none") {
      layers.push({
        key: "pattern",
        kind: "PATTERN",
        label: DITHERS.find((d) => d.id === r.dither)?.name ?? r.dither,
        tab: "pixel",
        remove: () => set({ dither: "none" }),
      });
    }
  }
  looks(1);
  if (hasTexture) {
    layers.push({
      key: "texture",
      kind: "TEXTURE",
      label: BLENDS.find((b) => b.id === r.texBlend)?.name ?? r.texBlend,
      tab: "more",
      remove: onClearTexture,
    });
  }
  looks(2);
  if (!layers.length) return null;
  return (
    <div className="layers" aria-label="Applied layers">
      {layers.map((l) => (
        <span key={l.key} className={`layer ${l.active ? "layer-active" : ""}`}>
          <button
            className="layer-main"
            onClick={() => {
              l.open?.();
              onOpen(l.tab);
            }}
            title={`Edit ${l.kind.toLowerCase()}`}
          >
            <span className="layer-kind">{l.kind}</span>
            {l.label}
          </button>
          <button className="layer-x" onClick={l.remove} aria-label={`Remove ${l.kind.toLowerCase()}`} title="Remove">
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
