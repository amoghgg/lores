"use client";

import { PALETTES } from "@/lib/palettes";
import { getStock } from "@/lib/filmStocks";
import { BLENDS, DITHERS, type Recipe } from "@/lib/recipe";
import type { Tab } from "./Panel";

type Layer = { key: string; kind: string; label: string; tab: Tab; remove: () => void };

type Props = {
  recipe: Recipe;
  hasTexture: boolean;
  set: (patch: Partial<Recipe>) => void;
  onClearTexture: () => void;
  onOpen: (tab: Tab) => void;
};

/**
 * Everything stacked on the photo, in the order it's applied. Tap a layer to
 * jump to its tab; × takes that one layer off.
 */
export function Layers({ recipe: r, hasTexture, set, onClearTexture, onOpen }: Props) {
  const layers: Layer[] = [];
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
  if (r.film !== "none") {
    layers.push({
      key: "film",
      kind: "FILM",
      label: getStock(r.film)?.name ?? r.film,
      tab: "film",
      remove: () => set({ film: "none" }),
    });
  }
  if (hasTexture) {
    layers.push({
      key: "texture",
      kind: "TEXTURE",
      label: BLENDS.find((b) => b.id === r.texBlend)?.name ?? r.texBlend,
      tab: "more",
      remove: onClearTexture,
    });
  }
  if (!layers.length) return null;
  return (
    <div className="layers" aria-label="Applied layers">
      {layers.map((l) => (
        <span key={l.key} className="layer">
          <button className="layer-main" onClick={() => onOpen(l.tab)} title={`Edit ${l.kind.toLowerCase()}`}>
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
