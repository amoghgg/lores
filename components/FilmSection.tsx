"use client";

import { useMemo } from "react";
import { Section } from "./Section";
import { Slider } from "./Slider";
import { AmountSlider } from "./AmountSlider";
import { FILM_CATEGORIES, FILM_STOCKS, type FilmStock } from "@/lib/filmStocks";
import { gradeCtx, gradePixel, type FilmControls, type Vec3 } from "@/lib/film";

// Reference patches the swatch strip runs through each stock's grade:
// shadow, skin, foliage, sky, red, highlight.
const PATCHES: Vec3[] = [
  [0.09, 0.09, 0.1],
  [0.86, 0.66, 0.55],
  [0.32, 0.5, 0.22],
  [0.46, 0.66, 0.9],
  [0.78, 0.2, 0.16],
  [0.94, 0.93, 0.9],
];

type Props = {
  stockId: string;
  category: string;
  controls: FilmControls;
  /** True when the pixel / palette stages are still shaping the image. */
  pixelActive: boolean;
  onStock: (id: string) => void;
  onCategory: (id: string) => void;
  onControls: (patch: Partial<FilmControls>) => void;
  onPhotoMode: () => void;
};

export function FilmSection({
  stockId,
  category,
  controls,
  pixelActive,
  onStock,
  onCategory,
  onControls,
  onPhotoMode,
}: Props) {
  const stock = FILM_STOCKS.find((s) => s.id === stockId) ?? null;
  const visible = FILM_STOCKS.filter((s) => s.category === category);
  const pct = (v: number) => Math.round(v * 100);

  return (
    <Section
      index="05"
      title="FILM"
      badge={stock ? stock.name : `${FILM_STOCKS.length} STOCKS`}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {FILM_CATEGORIES.map((c) => {
            const on = c.id === category;
            const count = FILM_STOCKS.filter((s) => s.category === c.id).length;
            return (
              <button
                key={c.id}
                onClick={() => onCategory(c.id)}
                className={`px-2 py-1 border text-[9px] tracking-widest uppercase transition-colors ${
                  on
                    ? "border-lime text-lime bg-ink-200"
                    : "border-ink-400 text-ink-700 hover:text-ink-900 hover:bg-ink-200"
                }`}
              >
                {c.label}
                <span className="ml-1 text-ink-600">{count}</span>
              </button>
            );
          })}
        </div>

        <p className="text-[9px] tracking-wider text-ink-700 leading-relaxed normal-case">
          {FILM_CATEGORIES.find((c) => c.id === category)?.blurb}
        </p>

        <div className="grid grid-cols-2 gap-1">
          {visible.map((s) => (
            <StockCard
              key={s.id}
              stock={s}
              selected={s.id === stockId}
              onSelect={() => onStock(s.id === stockId ? "none" : s.id)}
            />
          ))}
        </div>

        {stock && (
          <div className="border border-ink-400 bg-ink-50 p-3 space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-[10px] tracking-widest uppercase">
              <span className="text-ink-900">{stock.name}</span>
              <span className="text-ink-700 readout text-[9px]">{stock.meta}</span>
            </div>
            <p className="text-[10px] text-ink-800 leading-snug normal-case tracking-normal">
              {stock.note}
            </p>
          </div>
        )}

        {stock && pixelActive && (
          <button
            onClick={onPhotoMode}
            className="w-full px-3 py-2 border border-dashed border-ink-500 hover:border-lime hover:text-lime text-[10px] tracking-widest uppercase text-ink-700 transition-colors text-left"
          >
            [ PHOTO MODE ]
            <span className="block text-[9px] tracking-wider normal-case text-ink-700 mt-1">
              Bypass pixel + palette so the stock reads on the full photo.
            </span>
          </button>
        )}

        {stock && (
          <>
            <AmountSlider
              value={controls.amount}
              onChange={(amount) => onControls({ amount })}
            />
            <Slider
              label="GRAIN"
              value={pct(controls.grain)}
              min={0}
              max={200}
              onChange={(v) => onControls({ grain: v / 100 })}
              format={(n) => `${String(n).padStart(3, "0")}%`}
            />
            <Slider
              label="HALATION"
              value={pct(controls.glow)}
              min={0}
              max={200}
              onChange={(v) => onControls({ glow: v / 100 })}
              format={(n) => `${String(n).padStart(3, "0")}%`}
            />
            <Slider
              label="VIGNETTE"
              value={pct(controls.vignette)}
              min={0}
              max={200}
              onChange={(v) => onControls({ vignette: v / 100 })}
              format={(n) => `${String(n).padStart(3, "0")}%`}
            />
            <Slider
              label="LIGHT LEAK"
              value={pct(controls.leak)}
              min={0}
              max={200}
              onChange={(v) => onControls({ leak: v / 100 })}
              format={(n) => `${String(n).padStart(3, "0")}%`}
            />
            <div className="flex gap-1">
              {stock.recipe.border !== "none" && (
                <button
                  onClick={() => onControls({ frame: !controls.frame })}
                  className={`flex-1 px-3 py-2 border text-[10px] tracking-widest uppercase transition-colors ${
                    controls.frame
                      ? "border-lime text-lime bg-ink-200"
                      : "border-ink-400 text-ink-700 hover:text-ink-900"
                  }`}
                >
                  {controls.frame ? "■" : "□"} FRAME
                </button>
              )}
              <button
                onClick={() =>
                  onControls({ seed: (controls.seed * 7919 + 13) % 9973 })
                }
                className="flex-1 px-3 py-2 border border-ink-400 hover:border-lime hover:text-lime text-[10px] tracking-widest uppercase text-ink-700 transition-colors"
                title="New grain, dust and light-leak pattern"
              >
                [ REROLL ]
              </button>
              <button
                onClick={() => onStock("none")}
                className="px-3 py-2 border border-ink-400 hover:border-err hover:text-err text-[10px] tracking-widest uppercase text-ink-700 transition-colors"
                title="Remove film"
              >
                ×
              </button>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

function StockCard({
  stock,
  selected,
  onSelect,
}: {
  stock: FilmStock;
  selected: boolean;
  onSelect: () => void;
}) {
  const swatch = useMemo(() => {
    const g = gradeCtx(stock.recipe);
    return PATCHES.map((p) => gradePixel(g, p[0], p[1], p[2]));
  }, [stock]);

  return (
    <button
      onClick={onSelect}
      className={`text-left border transition-colors ${
        selected
          ? "border-lime bg-ink-200"
          : "border-ink-400 bg-ink-50 hover:bg-ink-200"
      }`}
    >
      <div className="px-2 pt-2 pb-1.5">
        <div className="text-[10px] tracking-widest uppercase font-medium flex items-center gap-1.5 text-ink-900">
          <span className={selected ? "text-lime" : "text-ink-600"}>
            {selected ? "■" : "□"}
          </span>
          <span className="truncate">{stock.name}</span>
        </div>
        <div className="text-[9px] tracking-wider text-ink-700 mt-0.5 truncate">
          {stock.hint}
        </div>
      </div>
      <div className="flex h-2.5 border-t border-ink-400">
        {swatch.map((c, i) => (
          <div
            key={i}
            className="flex-1"
            style={{
              background: `rgb(${Math.round(c[0] * 255)},${Math.round(
                c[1] * 255
              )},${Math.round(c[2] * 255)})`,
            }}
          />
        ))}
      </div>
    </button>
  );
}
