"use client";

import { useEffect, useRef, useState } from "react";
import {
  ASPECTS,
  SIZES,
  type AspectId,
  type SizeId,
  type Trim,
} from "@/lib/video";

type Props = {
  el: HTMLVideoElement;
  duration: number;
  playing: boolean;
  onToggle: () => void;
  /** `done` = the hand let go (render the frame properly). */
  onSeek: (t: number, done: boolean) => void;
  trim: Trim;
  onTrim: (t: Trim, done: boolean) => void;
  /** Small frames across the clip, drawn under the timeline. */
  strip: HTMLCanvasElement[];
  aspect: AspectId;
  onAspect: (a: AspectId) => void;
  cropping: boolean;
  onCropDone: () => void;
  size: SizeId;
  onSize: (s: SizeId) => void;
  /** e.g. "1080 × 1920" — what SAVE VIDEO will produce. */
  outSize: string;
};

const clock = (t: number, tenths = false) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${(tenths ? s.toFixed(1) : String(Math.floor(s))).padStart(tenths ? 4 : 2, "0")}`;
};

/** Shortest clip the trim handles allow. */
const MIN_LEN = 0.3;

/**
 * Under the picture: play/pause, a filmstrip timeline with trim handles and
 * a playhead, and the crop + size choices for SAVE VIDEO. The playhead reads
 * the <video> directly every frame, so playback never re-renders the page.
 */
export function VideoDock(p: Props) {
  const { el, duration, trim } = p;
  const [now, setNow] = useState(el.currentTime);
  const [drag, setDrag] = useState<null | "seek" | "start" | "end">(null);
  const track = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setNow((prev) =>
        Math.abs(prev - el.currentTime) > 1 / 120 ? el.currentTime : prev,
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el]);

  useEffect(() => {
    const h = stripRef.current;
    if (!h) return;
    for (const c of p.strip) c.className = "vdock-thumb";
    h.replaceChildren(...p.strip);
  }, [p.strip]);

  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };
  const pct = (t: number) => `${(t / (duration || 1)) * 100}%`;

  const move = (e: React.PointerEvent, kind = drag, done = false) => {
    const t = at(e.clientX);
    if (kind === "start")
      p.onTrim({ start: Math.min(t, trim.end - MIN_LEN), end: trim.end }, done);
    else if (kind === "end")
      p.onTrim(
        { start: trim.start, end: Math.max(t, trim.start + MIN_LEN) },
        done,
      );
    else if (kind === "seek")
      p.onSeek(Math.max(trim.start, Math.min(trim.end, t)), done);
  };

  const down = (e: React.PointerEvent, kind: "seek" | "start" | "end") => {
    e.stopPropagation();
    if (e.button !== 0) return;
    track.current!.setPointerCapture(e.pointerId);
    setDrag(kind);
    move(e, kind);
  };

  const trimmed = trim.start > 0.01 || trim.end < duration - 0.01;

  return (
    <div className="vdock" onPointerDown={(e) => e.stopPropagation()}>
      <div className="vdock-row">
        <button
          className="vdock-play"
          onClick={p.onToggle}
          aria-label={p.playing ? "Pause" : "Play"}
          title={p.playing ? "Pause (K)" : "Play (K)"}
        >
          {p.playing ? "❚❚" : "▶"}
        </button>
        <div
          ref={track}
          className={`vdock-track ${drag ? "vdock-dragging" : ""}`}
          onPointerDown={(e) => down(e, "seek")}
          onPointerMove={(e) => drag && move(e)}
          onPointerUp={(e) => {
            if (!drag) return;
            move(e, drag, true);
            setDrag(null);
          }}
          onPointerCancel={() => setDrag(null)}
        >
          <div ref={stripRef} className="vdock-strip" />
          <div
            className="vdock-shade"
            style={{ left: 0, width: pct(trim.start) }}
          />
          <div
            className="vdock-shade"
            style={{ left: pct(trim.end), right: 0 }}
          />
          <div
            className="vdock-window"
            style={{ left: pct(trim.start), width: pct(trim.end - trim.start) }}
          />
          <button
            className="vdock-handle vdock-handle-start"
            style={{ left: pct(trim.start) }}
            onPointerDown={(e) => down(e, "start")}
            role="slider"
            aria-label="Trim start"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={trim.start}
            title="Drag to trim the start"
          />
          <button
            className="vdock-handle vdock-handle-end"
            style={{ left: pct(trim.end) }}
            onPointerDown={(e) => down(e, "end")}
            role="slider"
            aria-label="Trim end"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={trim.end}
            title="Drag to trim the end"
          />
          <div className="vdock-head" style={{ left: pct(now) }} />
        </div>
        <span className="vdock-time">
          {clock(now)} / {clock(duration)}
        </span>
      </div>

      <div className="vdock-row vdock-opts">
        <div className="vdock-group">
          <span className="vdock-label">CROP</span>
          <div className="vdock-chips">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                className={`chip ${p.aspect === a.id ? "chip-on" : ""}`}
                onClick={() => p.onAspect(a.id)}
              >
                {a.label}
              </button>
            ))}
            {p.cropping && (
              <button className="chip chip-done" onClick={p.onCropDone}>
                DONE
              </button>
            )}
          </div>
        </div>
        <div className="vdock-group">
          <span className="vdock-label">SIZE</span>
          <div className="vdock-chips">
            {SIZES.map((s) => (
              <button
                key={s.id}
                className={`chip ${p.size === s.id ? "chip-on" : ""}`}
                onClick={() => p.onSize(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <span className="vdock-out" title="What SAVE VIDEO will make">
          {p.outSize} · {clock(trim.end - trim.start, trimmed)}
          {trimmed ? " TRIMMED" : ""}
        </span>
      </div>
    </div>
  );
}
