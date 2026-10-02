"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SAMPLE } from "@/lib/sample";

// 5×7 bitmap glyphs for the wordmark.
const GLYPHS: Record<string, string[]> = {
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
};
const WORD = "PIXEL";
const COLS = WORD.length * 6 - 1;
const ROWS = 7;

// Block sizes the photo steps through as it resolves, coarse → sharp.
const RESOLVE = [96, 64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];

type Props = {
  /** The photo to resolve behind the wordmark (current image or sample). */
  photo: HTMLCanvasElement | null;
  hasPhoto: boolean;
  /** The bundled sample is on screen — introduce the test subject. */
  isSample?: boolean;
  onOpen: () => void;
  onClose: () => void;
};

/**
 * The landing: your photo resolves from giant blocks to full detail while
 * PIXEL assembles on an LED grid. Any key, click, or button dismisses it.
 */
export function Intro({ photo, isSample, onOpen, onClose }: Props) {
  const bg = useRef<HTMLCanvasElement>(null);
  const [leaving, setLeaving] = useState(false);

  // Each lit cell gets a stable pseudo-random drop-in delay.
  const cells = useMemo(() => {
    const out: { lit: boolean; delay: number }[] = [];
    let s = 1337;
    const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const li = Math.floor(x / 6);
        const gx = x % 6;
        const lit = gx < 5 && GLYPHS[WORD[li]][y][gx] === "1";
        out.push({ lit, delay: lit ? 120 + li * 90 + rand() * 520 : 0 });
      }
    }
    return out;
  }, []);

  // Resolve the photo: draw it tiny, scale up nearest-neighbour, step down.
  useEffect(() => {
    const c = bg.current;
    if (!c || !photo) return;
    const ctx = c.getContext("2d")!;
    const fit = () => {
      c.width = c.clientWidth * Math.min(2, devicePixelRatio);
      c.height = c.clientHeight * Math.min(2, devicePixelRatio);
    };
    fit();
    const small = document.createElement("canvas");
    const sctx = small.getContext("2d")!;
    let i = 0;
    let t = 0;
    const draw = (block: number) => {
      // Cover-fit the photo into the backdrop.
      const s = Math.max(c.width / photo.width, c.height / photo.height);
      const dw = photo.width * s;
      const dh = photo.height * s;
      const bw = Math.max(1, Math.round(dw / (block * 2)));
      const bh = Math.max(1, Math.round(dh / (block * 2)));
      small.width = bw;
      small.height = bh;
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(photo, 0, 0, bw, bh);
      ctx.imageSmoothingEnabled = block <= 1;
      ctx.drawImage(small, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
    };
    const step = () => {
      draw(RESOLVE[i]);
      i++;
      if (i < RESOLVE.length) t = window.setTimeout(step, 70 + i * 18);
    };
    t = window.setTimeout(step, 250);
    const onResize = () => {
      fit();
      draw(RESOLVE[Math.min(i, RESOLVE.length - 1)]);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, [photo]);

  const close = (then?: () => void) => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => {
      onClose();
      then?.();
    }, 380);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  return (
    <div className={`intro ${leaving ? "intro-leave" : ""}`} role="dialog" aria-label="Welcome to PIXEL">
      <canvas ref={bg} className="intro-bg" aria-hidden />
      <div className="intro-scrim" aria-hidden />
      <div className="intro-body">
        <div
          className="intro-mark"
          style={{ gridTemplateColumns: `repeat(${COLS}, var(--cell))` }}
          role="img"
          aria-label="PIXEL"
        >
          {cells.map((c, i) => (
            <span
              key={i}
              className={c.lit ? "intro-px intro-on" : "intro-px"}
              style={c.lit ? { animationDelay: `${c.delay}ms` } : undefined}
            />
          ))}
        </div>
        <p className="intro-tag">
          Vintage film and pixel art for your photos.
          <br />
          <span>Runs on your device — nothing is uploaded.</span>
        </p>
        <ol className="intro-steps">
          <li><b>1</b> Pick a look</li>
          <li><b>2</b> Adjust one slider</li>
          <li><b>3</b> Save</li>
        </ol>
        <div className="intro-cta">
          <button className="btn-primary intro-btn" onClick={() => close(onOpen)}>
            OPEN A PHOTO
          </button>
          <button className="btn-ghost intro-btn" onClick={() => close()}>
            {isSample ? "TRY IT ON CHUCK →" : "TRY IT ON THIS ONE →"}
          </button>
        </div>
        {isSample && (
          <p className="intro-lore">
            Test subject: Chuck Norris. He approved all 63 looks.
            <br />
            Nobody asked him to.
            <a href={SAMPLE.source} target="_blank" rel="noopener">{SAMPLE.credit}</a>
          </p>
        )}
      </div>
    </div>
  );
}
