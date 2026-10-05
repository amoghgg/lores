"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// 5×7 bitmap glyphs for the wordmark.
const GLYPHS: Record<string, string[]> = {
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
};
const WORD = "LORES";
const COLS = WORD.length * 6 - 1;
const ROWS = 7;

type Props = {
  /** The photo behind the wordmark — the user's last one, or the sample. */
  photo: HTMLCanvasElement | null;
  /** The user was already working on a photo of their own. */
  canContinue: boolean;
  onOpen: (from: DOMRect) => void;
  onEnter: (from: DOMRect) => void;
};

/**
 * Home. The photo lives behind the wordmark as a breathing LED matrix; a
 * loupe follows the pointer (or drifts on its own) and shows it sharp.
 * LORES twinkles, leans away from the pointer, and scatters when tapped.
 */
export function Home({ photo, canContinue, onOpen, onEnter }: Props) {
  const bg = useRef<HTMLCanvasElement>(null);
  const mark = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number; t: number } | null>(null);
  const [scatter, setScatter] = useState(0);

  const cells = useMemo(() => {
    const out: { lit: boolean; delay: number; tw: number; dx: number; dy: number }[] = [];
    let s = 1337;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const li = Math.floor(x / 6);
        const gx = x % 6;
        const lit = gx < 5 && GLYPHS[WORD[li]][y][gx] === "1";
        out.push({
          lit,
          delay: lit ? 120 + li * 90 + rand() * 520 : 0,
          tw: 2 + rand() * 4,
          dx: (rand() - 0.5) * 2,
          dy: (rand() - 0.5) * 2,
        });
      }
    }
    return out;
  }, []);

  // ─── The living backdrop ─────────────────────────────────────────────
  useEffect(() => {
    const c = bg.current;
    if (!c || !photo) return;
    const ctx = c.getContext("2d")!;
    const small = document.createElement("canvas");
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let data: Uint8ClampedArray | null = null;
    let cover = { x: 0, y: 0, w: 0, h: 0 };
    let bgColor = "#0a0a0a";
    let bgRGB = [10, 10, 10];
    let ringColor = "#a3e635";
    const CELL = 22;

    const layout = () => {
      dpr = Math.min(2, devicePixelRatio || 1);
      W = c.clientWidth;
      H = c.clientHeight;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      const s = Math.max(W / photo.width, H / photo.height);
      cover = { w: photo.width * s, h: photo.height * s, x: 0, y: 0 };
      cover.x = (W - cover.w) / 2;
      cover.y = (H - cover.h) / 2;
      cols = Math.ceil(W / CELL);
      rows = Math.ceil(H / CELL);
      small.width = cols;
      small.height = rows;
      sctx.drawImage(photo, (cover.x / W) * cols, (cover.y / H) * rows, (cover.w / W) * cols, (cover.h / H) * rows);
      data = sctx.getImageData(0, 0, cols, rows).data;
      const css = getComputedStyle(document.documentElement);
      const rgb = (v: string) => `rgb(${css.getPropertyValue(v).trim().split(/\s+/).join(",")})`;
      bgColor = rgb("--ink-100");
      bgRGB = css.getPropertyValue("--ink-100").trim().split(/\s+/).map(Number);
      ringColor = rgb("--lime");
    };
    layout();

    const start = performance.now();
    let raf = 0;
    const lens = { x: W * 0.62, y: H * 0.42 };
    const frame = (now: number) => {
      const t = (now - start) / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);

      // The photo resolves in: big blocks first, settling to the LED grid.
      const settle = Math.min(1, t / 1.3);
      const grow = 1 + (1 - settle) * (1 - settle) * 5;
      const p = pointer.current;
      const idle = !p || now - p.t > 2500;
      // Without a pointer the loupe drifts on a slow Lissajous path.
      const tx = idle ? W * (0.5 + 0.32 * Math.sin(t * 0.37)) : p.x;
      const ty = idle ? H * (0.45 + 0.28 * Math.sin(t * 0.53 + 1)) : p.y;
      lens.x += (tx - lens.x) * 0.08;
      lens.y += (ty - lens.y) * 0.08;
      const R = Math.min(W, H) * 0.2;

      if (data) {
        const step = Math.max(1, Math.round(grow));
        for (let gy = 0; gy < rows; gy += step) {
          for (let gx = 0; gx < cols; gx += step) {
            const i = (gy * cols + gx) * 4;
            const x = gx * CELL;
            const y = gy * CELL;
            const d = Math.hypot(x + CELL / 2 - lens.x, y + CELL / 2 - lens.y);
            // A slow wave of brightness rolls across the matrix.
            const wave = reduce ? 0.85 : 0.72 + 0.28 * Math.sin(t * 1.6 - gx * 0.18 + gy * 0.11);
            const near = Math.max(0, 1 - d / (R * 1.6));
            // Blend the photo into the page colour — dark on ink, faded on paper.
            const k = (0.38 + near * 0.5) * wave;
            const r = bgRGB[0] + (data[i] - bgRGB[0]) * k;
            const g = bgRGB[1] + (data[i + 1] - bgRGB[1]) * k;
            const b = bgRGB[2] + (data[i + 2] - bgRGB[2]) * k;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            const size = CELL * step - 3;
            ctx.fillRect(x + 1.5, y + 1.5, size, size);
          }
        }
      }

      // The loupe: the real photo, sharp, inside a ring.
      if (settle >= 1) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(lens.x, lens.y, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = 0.9;
        ctx.drawImage(photo, cover.x, cover.y, cover.w, cover.h);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(lens.x, lens.y, R, 0, Math.PI * 2);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", layout);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", layout);
    };
  }, [photo]);

  // ─── The wordmark leans away from the pointer ─────────────────────────
  const onMove = (e: React.PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    const m = mark.current;
    if (!m) return;
    // Read every rect first, then write — no layout thrash.
    const kids = Array.from(m.children) as HTMLElement[];
    const rects = kids.map((el) => el.getBoundingClientRect());
    kids.forEach((el, i) => {
      const r = rects[i];
      const dx = r.left + r.width / 2 - e.clientX;
      const dy = r.top + r.height / 2 - e.clientY;
      const d = Math.hypot(dx, dy);
      const f = Math.max(0, 1 - d / 140);
      el.style.setProperty("--push-x", `${(dx / (d || 1)) * f * 10}px`);
      el.style.setProperty("--push-y", `${(dy / (d || 1)) * f * 10}px`);
      el.style.setProperty("--near", f.toFixed(3));
    });
  };
  const onLeave = () => {
    pointer.current = null;
    const m = mark.current;
    if (!m) return;
    for (const el of Array.from(m.children) as HTMLElement[]) {
      el.style.setProperty("--push-x", "0px");
      el.style.setProperty("--push-y", "0px");
      el.style.setProperty("--near", "0");
    }
  };

  const rectOf = (e: React.MouseEvent) => (e.currentTarget as HTMLElement).getBoundingClientRect();

  return (
    <div className="home" onPointerMove={onMove} onPointerLeave={onLeave} role="main" aria-label="LORES home">
      <canvas ref={bg} className="home-bg" aria-hidden />
      <div className="home-scrim" aria-hidden />
      <div className="home-body">
        <button
          ref={mark as unknown as React.RefObject<HTMLButtonElement>}
          className={`home-mark ${scatter % 2 ? "home-scatter" : ""}`}
          style={{ gridTemplateColumns: `repeat(${COLS}, var(--cell))` }}
          aria-label="LORES"
          onClick={() => {
            setScatter((s) => s + 1);
            window.setTimeout(() => setScatter((s) => s + 1), 650);
          }}
        >
          {cells.map((c, i) => (
            <span
              key={i}
              className={c.lit ? "home-px home-on" : "home-px"}
              style={
                {
                  "--d": `${c.delay}ms`,
                  "--tw": `${c.tw}s`,
                  "--sx": c.dx,
                  "--sy": c.dy,
                } as React.CSSProperties
              }
            />
          ))}
        </button>
        <p className="home-tag">Film, screens, glitches &amp; pixel art for your photos.</p>
        <div className="home-cta">
          {canContinue ? (
            <>
              <button className="home-btn home-btn-primary" onClick={(e) => onEnter(rectOf(e))}>
                CONTINUE
              </button>
              <button className="home-btn" onClick={(e) => onOpen(rectOf(e))}>
                NEW PHOTO
              </button>
            </>
          ) : (
            <>
              <button className="home-btn home-btn-primary" onClick={(e) => onOpen(rectOf(e))}>
                OPEN A PHOTO
              </button>
              <button className="home-btn" onClick={(e) => onEnter(rectOf(e))}>
                TRY ON CHUCK
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
