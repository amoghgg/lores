"use client";

import { useEffect, useState } from "react";

type Props = {
  playing: boolean;
  time: number;
  duration: number;
  onToggle: () => void;
  onScrub: (t: number) => void;
};

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** Play / pause and a scrubber, sitting on the bottom edge of the photo. */
export function VideoBar({ playing, time, duration, onToggle, onScrub }: Props) {
  // While dragging, the thumb follows the finger; the seek lands on release.
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    if (!playing) setDrag(null);
  }, [playing]);
  const shown = drag ?? time;
  return (
    <div className="vbar" onPointerDown={(e) => e.stopPropagation()}>
      <button className="vbar-play" onClick={onToggle} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (K)" : "Play (K)"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        className="vbar-seek"
        type="range"
        min={0}
        max={duration || 1}
        step={0.01}
        value={shown}
        aria-label="Position in video"
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag !== null) onScrub(drag);
          setDrag(null);
        }}
        onKeyUp={() => {
          if (drag !== null) onScrub(drag);
          setDrag(null);
        }}
      />
      <span className="vbar-time">
        {clock(shown)} / {clock(duration)}
      </span>
    </div>
  );
}
