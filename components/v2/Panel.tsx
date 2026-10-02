"use client";

import { useRef, useState } from "react";
import { Thumb } from "./Thumb";
import { Range } from "./Range";
import { PALETTES } from "@/lib/palettes";
import { FILM_CATEGORIES, FILM_STOCKS, getStock } from "@/lib/filmStocks";
import { BLENDS, BLOCKS, DITHERS, describeRecipe, type Recipe } from "@/lib/recipe";

export type Tab = "film" | "pixel" | "more";
export type SetRecipe = (patch: Partial<Recipe>, commit?: boolean) => void;

const pct = (v: number) => `${Math.round(v * 100)}%`;

// ───────────────────────────────────────────────────────────────────────────
// Tabs
// ───────────────────────────────────────────────────────────────────────────

export function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string }[] = [
    { id: "film", label: "FILM" },
    { id: "pixel", label: "PIXEL" },
    { id: "more", label: "MORE" },
  ];
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button
          key={i.id}
          role="tab"
          aria-selected={tab === i.id}
          className={`tabs-btn ${tab === i.id ? "tabs-on" : ""}`}
          onClick={() => onTab(i.id)}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Looks — the thumbnails for the current tab
// ───────────────────────────────────────────────────────────────────────────

type LooksProps = {
  tab: Tab;
  recipe: Recipe;
  /** Recipe the thumbnails render from — trails `recipe` while a slider moves. */
  base: Recipe;
  epoch: string;
  set: SetRecipe;
  onPreview: (r: Recipe | null) => void;
  favorites: string[];
  filmCat: string;
  onFilmCat: (c: string) => void;
  texture: { filename: string } | null;
  onTexture: (f: File) => void;
  onClearTexture: () => void;
  sound: React.ReactNode;
};

export function Looks(p: LooksProps) {
  const { recipe: r, set, epoch } = p;
  const hoverT = useRef<number | null>(null);
  const hover = (next: Recipe | null) => {
    if (hoverT.current) window.clearTimeout(hoverT.current);
    if (!next) return p.onPreview(null);
    hoverT.current = window.setTimeout(() => p.onPreview(next), 160);
  };
  const t = (patch: Partial<Recipe>) => {
    const next = { ...p.base, ...patch, off: {} };
    return { recipe: next, epoch, onHover: (on: boolean) => hover(on ? next : null) };
  };

  if (p.tab === "film") {
    const faves = FILM_STOCKS.filter((s) => p.favorites.includes(s.id));
    const cat = p.filmCat === "faves" && !faves.length ? FILM_CATEGORIES[0].id : p.filmCat;
    const list = cat === "faves" ? faves : FILM_STOCKS.filter((s) => s.category === cat);
    return (
      <div className="looks">
        <div className="chips">
          {faves.length > 0 && (
            <button className={`chip ${cat === "faves" ? "chip-on" : ""}`} onClick={() => p.onFilmCat("faves")}>
              ★ SAVED
            </button>
          )}
          {FILM_CATEGORIES.map((c) => (
            <button key={c.id} className={`chip ${cat === c.id ? "chip-on" : ""}`} onClick={() => p.onFilmCat(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="strip strip-grid">
          <Thumb {...t({ film: "none" })} label="NONE" selected={r.film === "none"} onSelect={() => set({ film: "none" })} />
          {list.map((s) => (
            <Thumb
              key={s.id}
              {...t({ film: s.id })}
              label={s.name}
              starred={p.favorites.includes(s.id)}
              selected={r.film === s.id}
              onSelect={() => set({ film: s.id })}
            />
          ))}
        </div>
      </div>
    );
  }

  if (p.tab === "pixel") {
    const hasColours = r.palette !== "none";
    return (
      <div className="looks looks-rows">
        <Row title="SIZE">
          {BLOCKS.map((b) => (
            <Thumb key={b} {...t({ block: b })} view="crop" size={160} label={b === 1 ? "NONE" : `${b}PX`}
              selected={r.block === b} onSelect={() => set({ block: b })} />
          ))}
        </Row>
        <Row title="COLOURS">
          {PALETTES.map((pal) => (
            <Thumb key={pal.id} {...t({ palette: pal.id })} label={pal.id === "none" ? "NONE" : pal.name}
              selected={r.palette === pal.id} onSelect={() => set({ palette: pal.id })} />
          ))}
        </Row>
        <Row title="PATTERN" note={hasColours ? undefined : "Pick colours first — a pattern needs a palette to work with."}>
          {hasColours &&
            DITHERS.map((d) => (
              <Thumb key={d.id} {...t({ dither: d.id })} view="crop" size={160} label={d.id === "none" ? "NONE" : d.name}
                selected={r.dither === d.id} onSelect={() => set({ dither: d.id })} />
            ))}
        </Row>
      </div>
    );
  }

  return (
    <div className="looks looks-rows">
      <Row title="TEXTURE" note={p.texture ? undefined : "Lay paper, grain or any image over your photo."}>
        <TextureButton texture={p.texture} onLoad={p.onTexture} onClear={p.onClearTexture} />
        {p.texture &&
          BLENDS.map((b) => (
            <Thumb key={b.id} {...t({ texBlend: b.id })} label={b.name}
              selected={r.texBlend === b.id} onSelect={() => set({ texBlend: b.id })} />
          ))}
      </Row>
      <div className="row">
        <div className="row-title">SOUND</div>
        <div className="sound">{p.sound}</div>
      </div>
    </div>
  );
}

function Row({ title, note, children }: { title: string; note?: string; children?: React.ReactNode }) {
  return (
    <div className="row">
      <div className="row-title">{title}</div>
      {note && <p className="row-note">{note}</p>}
      <div className="strip">{children}</div>
    </div>
  );
}

function TextureButton({
  texture,
  onLoad,
  onClear,
}: {
  texture: { filename: string } | null;
  onLoad: (f: File) => void;
  onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onLoad(f);
          e.currentTarget.value = "";
        }}
      />
      <button
        className="thumb thumb-add"
        onClick={() => (texture ? onClear() : input.current?.click())}
        title={texture ? `Remove ${texture.filename}` : "Add a texture image"}
      >
        <span className="thumb-add-icon">{texture ? "×" : "+"}</span>
        <span className="thumb-cap">
          <span className="thumb-name">{texture ? "REMOVE" : "ADD IMAGE"}</span>
        </span>
      </button>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Now — what's applied, one main slider, and the rest under ADJUST
// ───────────────────────────────────────────────────────────────────────────

type NowProps = {
  tab: Tab;
  recipe: Recipe;
  set: SetRecipe;
  favorites: string[];
  onToggleFavorite: (id: string) => void;
  hasTexture: boolean;
};

export function Now({ tab, recipe: r, set, favorites, onToggleFavorite, hasTexture }: NowProps) {
  const [open, setOpen] = useState(false);
  const live = (patch: Partial<Recipe>) => set(patch, false);
  const commit = (patch: Partial<Recipe>) => set(patch, true);

  let title = "";
  let sub = "";
  let main: React.ReactNode = null;
  let extra: React.ReactNode = null;
  let star: React.ReactNode = null;

  if (tab === "film") {
    const s = getStock(r.film);
    title = s ? s.name : "NO FILM";
    sub = s ? s.meta : "Pick a look below";
    if (s) {
      star = (
        <button
          className={`now-star ${favorites.includes(s.id) ? "text-lime" : ""}`}
          onClick={() => onToggleFavorite(s.id)}
          title={favorites.includes(s.id) ? "Saved to ★ SAVED" : "Save to ★ SAVED"}
        >
          {favorites.includes(s.id) ? "★" : "☆"}
        </button>
      );
      main = (
        <Range label="STRENGTH" value={r.filmAmt} min={0} max={1} step={0.01} reset={1} format={pct}
          onChange={(filmAmt) => live({ filmAmt })} onCommit={(filmAmt) => commit({ filmAmt })} />
      );
      extra = (
        <>
          <p className="now-note">{s.note}</p>
          <Range label="GRAIN" value={r.grain} min={0} max={2} step={0.01} reset={1} format={pct}
            onChange={(grain) => live({ grain })} onCommit={(grain) => commit({ grain })} />
          <Range label="GLOW" value={r.glow} min={0} max={2} step={0.01} reset={1} format={pct}
            onChange={(glow) => live({ glow })} onCommit={(glow) => commit({ glow })} />
          <Range label="VIGNETTE" value={r.vignette} min={0} max={2} step={0.01} reset={1} format={pct}
            onChange={(vignette) => live({ vignette })} onCommit={(vignette) => commit({ vignette })} />
          <Range label="LIGHT LEAK" value={r.leak} min={0} max={2} step={0.01} reset={1} format={pct}
            onChange={(leak) => live({ leak })} onCommit={(leak) => commit({ leak })} />
          <div className="now-buttons">
            {s.recipe.border !== "none" && (
              <button className={`btn-ghost ${r.frame ? "btn-on" : ""}`} onClick={() => commit({ frame: !r.frame })}>
                {r.frame ? "■" : "□"} FRAME
              </button>
            )}
            <button className="btn-ghost" onClick={() => commit({ seed: (r.seed * 7919 + 13) % 9973 })}>
              ⟲ NEW GRAIN
            </button>
          </div>
        </>
      );
    }
  } else if (tab === "pixel") {
    const d = describeRecipe({ ...r, film: "none" });
    title = d === "ORIGINAL" ? "NO PIXEL EFFECT" : d;
    sub = r.block > 1 ? "Drag SIZE for bigger or smaller pixels" : "Pick a size, colours or pattern below";
    // One slider per effect, always in view — no digging under ADJUST.
    main = (
      <>
        <Range label="SIZE" value={r.block} min={1} max={48} reset={1} format={(v) => (v === 1 ? "OFF" : `${v}px`)}
          onChange={(block) => live({ block })} onCommit={(block) => commit({ block })} />
        {r.palette !== "none" && (
          <Range label="COLOURS" value={r.paletteAmt} min={0} max={1} step={0.01} reset={1} format={pct}
            onChange={(paletteAmt) => live({ paletteAmt })} onCommit={(paletteAmt) => commit({ paletteAmt })} />
        )}
        {r.palette !== "none" && r.dither !== "none" && (
          <Range label="PATTERN" value={r.ditherAmt} min={0} max={1} step={0.01} reset={1} format={pct}
            onChange={(ditherAmt) => live({ ditherAmt })} onCommit={(ditherAmt) => commit({ ditherAmt })} />
        )}
      </>
    );
  } else {
    title = hasTexture ? "TEXTURE" : "EXTRAS";
    sub = hasTexture ? r.texBlend.toUpperCase() : "Texture overlay and sound-reactive mode";
    if (hasTexture) {
      main = (
        <Range label="OPACITY" value={r.texOpacity} min={0} max={1} step={0.01} reset={0.6} format={pct}
          onChange={(texOpacity) => live({ texOpacity })} onCommit={(texOpacity) => commit({ texOpacity })} />
      );
      extra = (
        <div className="now-buttons">
          {(["cover", "tile", "fit"] as const).map((f) => (
            <button key={f} className={`btn-ghost ${r.texFit === f ? "btn-on" : ""}`} onClick={() => commit({ texFit: f })}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      );
    }
  }

  return (
    <div className="now">
      <div className="now-head">
        <div className="min-w-0">
          <div className="now-title">
            {title}
            {star}
          </div>
          <div className="now-sub">{sub}</div>
        </div>
        {extra && (
          <button className="now-adjust" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "DONE" : "ADJUST"}
          </button>
        )}
      </div>
      {main}
      {open && extra && <div className="now-extra">{extra}</div>}
    </div>
  );
}
