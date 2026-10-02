"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";

export type PixelWipeHandle = {
  /** Cover the screen in pixels radiating from `from`, swap views, reveal. */
  run: (from: { x: number; y: number }, swap: () => void) => void;
};

const CELL = 48;
const SPREAD = 340; // ms for the wave to cross the screen
const GROW = 170; // ms for one pixel to grow/shrink

export const PixelWipe = forwardRef<PixelWipeHandle>(function PixelWipe(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const busy = useRef(false);

  useImperativeHandle(ref, () => ({
    run(from, swap) {
      const c = canvas.current;
      if (!c || busy.current || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        swap();
        return;
      }
      busy.current = true;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const W = innerWidth;
      const H = innerHeight;
      c.width = W * dpr;
      c.height = H * dpr;
      c.style.display = "block";
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(document.documentElement);
      const ink = `rgb(${css.getPropertyValue("--ink-100").trim().split(/\s+/).join(",")})`;
      const lime = `rgb(${css.getPropertyValue("--lime").trim().split(/\s+/).join(",")})`;

      const cols = Math.ceil(W / CELL);
      const rows = Math.ceil(H / CELL);
      const maxD = Math.hypot(Math.max(from.x, W - from.x), Math.max(from.y, H - from.y));
      const delays: number[] = [];
      const accent: boolean[] = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const d = Math.hypot(x * CELL + CELL / 2 - from.x, y * CELL + CELL / 2 - from.y);
          delays.push((d / maxD) * SPREAD + Math.random() * 60);
          accent.push(Math.random() < 0.06);
        }
      }
      const coverEnd = SPREAD + 60 + GROW;
      let swapped = false;
      const t0 = performance.now();
      const draw = (now: number) => {
        const t = now - t0;
        ctx.clearRect(0, 0, W, H);
        const revealing = t > coverEnd + 40;
        if (!swapped && t >= coverEnd) {
          swapped = true;
          swap();
        }
        const tt = revealing ? t - coverEnd - 40 : t;
        let alive = false;
        for (let i = 0; i < delays.length; i++) {
          let k = Math.max(0, Math.min(1, (tt - delays[i]) / GROW));
          if (revealing) k = 1 - k;
          if (k <= 0) continue;
          alive = true;
          const e = k * k * (3 - 2 * k);
          const s = CELL * e;
          const x = (i % cols) * CELL + (CELL - s) / 2;
          const y = Math.floor(i / cols) * CELL + (CELL - s) / 2;
          // A few pixels flash the accent as the wave passes.
          ctx.fillStyle = accent[i] && k < 0.85 ? lime : ink;
          ctx.fillRect(x, y, s + 0.6, s + 0.6);
        }
        if (revealing && !alive) {
          c.style.display = "none";
          busy.current = false;
          return;
        }
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    },
  }));

  return <canvas ref={canvas} className="pixelwipe" aria-hidden />;
});
