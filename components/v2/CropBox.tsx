"use client";

import { useEffect, useRef } from "react";
import type { Crop } from "@/lib/video";

type Props = {
  /** The whole, unprocessed frame. */
  frame: HTMLCanvasElement;
  /** Width / height of the box in pixels; null = free. */
  ratio: number | null;
  crop: Crop;
  onChange: (c: Crop) => void;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Framing a video: the whole frame with the kept part lit. Drag inside the
 * box to move it, drag a corner to resize (the shape stays locked).
 */
export function CropBox({ frame, ratio, crop, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; crop: Crop; corner: string | null } | null>(null);

  useEffect(() => {
    frame.className = "crop-canvas";
    host.current?.replaceChildren(frame);
  }, [frame]);

  // Box shape in fractions of the frame: w/h in pixels must equal `ratio`.
  const fw = frame.width;
  const fh = frame.height;
  const hFor = (w: number) => (ratio ? (w * fw) / (fh * ratio) : null);

  const onDown = (e: React.PointerEvent, corner: string | null) => {
    e.stopPropagation();
    box.current!.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, y: e.clientY, crop, corner };
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const r = host.current!.getBoundingClientRect();
    const dx = (e.clientX - s.x) / r.width;
    const dy = (e.clientY - s.y) / r.height;
    const c = s.crop;
    if (!s.corner) {
      onChange({ ...c, x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h) });
      return;
    }
    // Resize from a corner; the opposite corner stays put.
    const left = s.corner.includes("l");
    const top = s.corner.includes("t");
    const ax = left ? c.x + c.w : c.x;
    const ay = top ? c.y + c.h : c.y;
    const maxW = left ? ax : 1 - ax;
    const maxH = top ? ay : 1 - ay;
    let w = clamp(c.w + (left ? -dx : dx), 0.08, maxW);
    let h = hFor(w) ?? clamp(c.h + (top ? -dy : dy), 0.08, maxH);
    if (h > maxH) {
      h = maxH;
      if (ratio) w = (h * fh * ratio) / fw;
    }
    onChange({ x: left ? ax - w : ax, y: top ? ay - h : ay, w, h });
  };
  const onUp = () => {
    start.current = null;
  };

  const pc = (v: number) => `${v * 100}%`;
  return (
    <div className="crop-layer" onPointerDown={(e) => e.stopPropagation()}>
      <div className="crop-frame">
        <div ref={host} className="crop-host" />
        <div
          ref={box}
          className="crop-box"
          style={{ left: pc(crop.x), top: pc(crop.y), width: pc(crop.w), height: pc(crop.h) }}
          onPointerDown={(e) => onDown(e, null)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <i className="crop-third crop-third-v" />
          <i className="crop-third crop-third-h" />
          {["tl", "tr", "bl", "br"].map((k) => (
            <span key={k} className={`crop-corner crop-${k}`} onPointerDown={(e) => onDown(e, k)} />
          ))}
        </div>
      </div>
      <div className="crop-hint">DRAG TO FRAME · CORNERS RESIZE</div>
    </div>
  );
}
