"use client";

import { useEffect, useRef, useState } from "react";
import { Section } from "./Section";
import { Slider } from "./Slider";
import { RadioBoxes } from "./RadioBoxes";
import { getAudio, type AudioState } from "@/lib/audio";

export type VizMode = "off" | "bass-bump" | "chroma" | "shockwave" | "combined";

export const VIZ_MODE_BITS: Record<VizMode, number> = {
  off: 0,
  "bass-bump": 0, // bass-bump modulates blockSize, no FX bits
  chroma: 1,
  shockwave: 2,
  combined: 1 | 2 | 4,
};

type Props = {
  mode: VizMode;
  intensity: number;
  bassBump: number;
  onModeChange: (m: VizMode) => void;
  onIntensityChange: (v: number) => void;
  onBassBumpChange: (v: number) => void;
};

export function VisualizeSection({
  mode,
  intensity,
  bassBump,
  onModeChange,
  onIntensityChange,
  onBassBumpChange,
}: Props) {
  const audio = getAudio();
  const [state, setState] = useState<AudioState>(audio.state);
  const [filename, setFilename] = useState(audio.filename);
  const [duration, setDuration] = useState(audio.duration);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = audio.subscribe(() => {
      setState(audio.state);
      setFilename(audio.filename);
      setDuration(audio.duration);
    });
    return unsubscribe;
  }, [audio]);

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) return;
    await audio.loadFile(file);
  };

  const onPickClick = () => inputRef.current?.click();
  const onTogglePlay = async () => {
    if (state === "playing") audio.pause();
    else if (state === "loaded" || state === "paused") await audio.play();
  };
  const onStop = () => audio.stop();
  const onClearAudio = () => {
    audio.dispose();
  };

  const playLabel =
    state === "playing"
      ? "[ PAUSE ]"
      : state === "paused"
      ? "[ RESUME ]"
      : "[ PLAY ]";

  const fmtTime = (s: number) => {
    if (!isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const badge =
    state === "playing"
      ? "LIVE"
      : state === "paused"
      ? "PAUSED"
      : state === "loaded"
      ? "READY"
      : state === "loading"
      ? "DECODING"
      : state === "error"
      ? "FAILED"
      : "EMPTY";

  return (
    <Section index="05" title="VISUALIZE" badge={badge}>
      <div className="space-y-3">
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          className="sr-only"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        {state === "empty" || state === "error" ? (
          <button
            onClick={onPickClick}
            className="w-full px-4 py-4 border border-dashed border-ink-500 hover:border-lime hover:text-lime active:border-lime text-[10px] tracking-widest uppercase text-ink-700 bg-ink-50 hover:bg-ink-200 transition-colors"
          >
            <div className="flex flex-col items-center gap-1">
              <span className="font-display text-xl tracking-wider leading-none">
                DROP AUDIO
              </span>
              <span className="text-[9px] text-ink-700">MP3 · WAV · OGG · M4A</span>
            </div>
          </button>
        ) : (
          <div className="border border-ink-400 bg-ink-50 p-3 space-y-2">
            <div className="flex items-baseline justify-between gap-2 text-[10px] tracking-widest uppercase">
              <span className="text-ink-700">TRACK</span>
              <span
                className="text-ink-900 normal-case font-mono truncate flex-1 text-right"
                title={filename}
              >
                {truncate(filename, 22)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2 text-[10px] tracking-widest uppercase">
              <span className="text-ink-700">DURATION</span>
              <span className="text-ink-900 tabular-nums">{fmtTime(duration)}</span>
            </div>
            <div className="flex gap-1 pt-1">
              <button
                onClick={onTogglePlay}
                disabled={state === "loading"}
                className="flex-1 px-3 py-2 border border-lime bg-lime text-ink-100 hover:bg-lime-glow active:bg-lime-glow disabled:bg-ink-400 disabled:border-ink-400 disabled:text-ink-700 text-[10px] tracking-widest uppercase font-bold transition-colors"
              >
                {playLabel}
              </button>
              <button
                onClick={onStop}
                disabled={state === "loading"}
                className="px-3 py-2 border border-ink-400 hover:border-warn hover:text-warn text-[10px] tracking-widest uppercase text-ink-700 transition-colors"
              >
                [ STOP ]
              </button>
              <button
                onClick={onClearAudio}
                className="px-3 py-2 border border-ink-400 hover:border-err hover:text-err text-[10px] tracking-widest uppercase text-ink-700 transition-colors"
              >
                ×
              </button>
            </div>
          </div>
        )}

        <div>
          <div className="text-[10px] tracking-widest uppercase text-ink-700 mb-2">
            MODE
          </div>
          <RadioBoxes<VizMode>
            value={mode}
            onChange={onModeChange}
            options={[
              { value: "off", label: "STATIC", hint: "no animation" },
              { value: "bass-bump", label: "BASS BUMP", hint: "kick = block" },
              { value: "chroma", label: "CHROMA", hint: "rgb split" },
              { value: "shockwave", label: "SHOCKWAVE", hint: "ring on beat" },
            ]}
          />
          <div className="mt-1">
            <RadioBoxes<VizMode>
              value={mode}
              onChange={onModeChange}
              options={[
                { value: "combined", label: "COMBINED", hint: "everything · DJ feel" },
              ]}
            />
          </div>
        </div>

        <Slider
          label="INTENSITY"
          value={intensity}
          min={0}
          max={200}
          onChange={onIntensityChange}
          format={(n) => `${String(n).padStart(3, "0")}%`}
        />

        <Slider
          label="BASS PUMP"
          value={bassBump}
          min={0}
          max={32}
          onChange={onBassBumpChange}
          format={(n) => `${String(n).padStart(3, "0")} px`}
        />

        <p className="text-[9px] tracking-wider text-ink-700 leading-relaxed normal-case">
          Drop a track. Block size pulses with the kick; mode adds GPU FX. The
          canvas re-renders each audio frame — needs an image loaded first.
        </p>
      </div>
    </Section>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? "…" + s.slice(-n + 1) : s;
}
