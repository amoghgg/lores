"use client";

import { useEffect, useRef, useState } from "react";
import { getThumbs, type ThumbView } from "@/lib/thumbs";
import type { Recipe } from "@/lib/recipe";

type Props = {
  recipe: Recipe;
  view?: ThumbView;
  size?: number;
  label: string;
  sub?: string;
  selected?: boolean;
  starred?: boolean;
  /** Bumps when the source/texture changes so cached canvases are re-fetched. */
  epoch: string;
  /** Render-queue group; the sheet cancels its own group on step change. */
  group?: string;
  onSelect: () => void;
  onHover?: (on: boolean) => void;
  /** Shows a ＋ corner button: add this look as another layer. */
  onAdd?: () => void;
  /** Positions of this look in the film stack (1-based), shown as a badge. */
  badge?: string;
  /** Don't render a preview; show this note instead (e.g. a model download). */
  placeholder?: string;
  className?: string;
  aspect?: string;
};

/**
 * A preset rendered on the user's own photo. Renders lazily when scrolled
 * into view; shows the label over a dark scrim at the bottom.
 */
export function Thumb({
  recipe,
  view = "fit",
  size = 240,
  label,
  sub,
  selected,
  starred,
  epoch,
  group = "sheet",
  onSelect,
  onHover,
  onAdd,
  badge,
  placeholder,
  className = "",
  aspect,
}: Props) {
  const box = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const thumbs = getThumbs();
    const put = (c: HTMLCanvasElement | null) => {
      const h = holder.current;
      if (!c || !h) return;
      const copy = document.createElement("canvas");
      copy.width = c.width;
      copy.height = c.height;
      copy.getContext("2d")!.drawImage(c, 0, 0);
      copy.className = "thumb-canvas";
      h.replaceChildren(copy);
      setReady(true);
    };
    const hit = thumbs.peek(recipe, view, size);
    if (hit) {
      put(hit);
      return;
    }
    setReady(false);
    if (!visible || placeholder) return;
    let live = true;
    void thumbs.render(recipe, view, size, group).then((c) => live && put(c));
    return () => {
      live = false;
    };
    // recipe identity changes every render; key on its code via epoch+label.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, epoch, view, size, placeholder, JSON.stringify(recipe)]);

  return (
    <button
      ref={box}
      onClick={onSelect}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className={`thumb ${selected ? "thumb-on" : ""} ${className}`}
      style={aspect ? { aspectRatio: aspect } : undefined}
      title={sub ? `${label} — ${sub}` : label}
    >
      {placeholder ? (
        <div className="thumb-img thumb-defer">{placeholder}</div>
      ) : (
        <div ref={holder} className={`thumb-img ${ready ? "" : "thumb-wait"}`} />
      )}
      {badge && <span className="thumb-badge">{badge}</span>}
      {onAdd && (
        <span
          role="button"
          tabIndex={0}
          className="thumb-plus"
          aria-label={`Add ${label} as another layer`}
          title="Add as another layer"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            e.stopPropagation();
            onAdd();
          }}
        >
          +
        </span>
      )}
      <span className="thumb-cap">
        <span className="thumb-name">
          {starred && <span className="text-lime mr-1">★</span>}
          {label}
        </span>
        {sub && <span className="thumb-sub">{sub}</span>}
      </span>
    </button>
  );
}
