"use client";

import { useMemo, useRef, useState } from "react";
import { Section } from "./Section";
import { Slider } from "./Slider";
import { RadioBoxes } from "./RadioBoxes";
import {
  generateGIF,
  downloadGIF,
  estimateFileSize,
  type AnimationMode,
} from "@/lib/animate";
import type { Settings } from "@/lib/pipeline";

type Props = {
  source: HTMLImageElement | null;
  filename: string | null;
  settings: Settings;
  width: number;
  height: number;
};

type PhaseState =
  | { phase: "idle" }
  | { phase: "busy"; current: number; total: number }
  | { phase: "done" }
  | { phase: "error"; message: string };

export function AnimateSection({
  source,
  filename,
  settings,
  width,
  height,
}: Props) {
  const [mode, setMode] = useState<AnimationMode>("pixel-sweep");
  const [duration, setDuration] = useState(2000); // ms
  const [fps, setFps] = useState(15);
  const [scale, setScale] = useState(1);
  const [state, setState] = useState<PhaseState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const totalFrames = Math.max(2, Math.min(120, Math.round((duration / 1000) * fps)));
  const sizeEstimate = useMemo(
    () => estimateFileSize(width * scale, height * scale, totalFrames),
    [width, height, scale, totalFrames]
  );

  const run = async () => {
    if (!source) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setState({ phase: "busy", current: 0, total: totalFrames });
    try {
      const blob = await generateGIF({
        source,
        settings,
        mode,
        durationMs: duration,
        fps,
        scale,
        signal: abortRef.current.signal,
        onProgress: (current, total) =>
          setState({ phase: "busy", current, total }),
      });
      const base = (filename ?? "lores").replace(/\.[^.]+$/, "");
      downloadGIF(blob, `${base}-${mode}-${fps}fps.gif`);
      setState({ phase: "done" });
      setTimeout(() => setState({ phase: "idle" }), 1800);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setState({ phase: "idle" });
        return;
      }
      console.error(err);
      setState({ phase: "error", message: (err as Error).message });
      setTimeout(() => setState({ phase: "idle" }), 2400);
    }
  };

  const cancel = () => abortRef.current?.abort();

  const progress =
    state.phase === "busy" && state.total > 0 ? state.current / state.total : 0;

  return (
    <Section
      index="05"
      title="ANIMATE"
      badge={
        state.phase === "busy"
          ? `ENC ${state.current}/${state.total}`
          : state.phase === "done"
          ? "DONE"
          : state.phase === "error"
          ? "FAILED"
          : `${totalFrames} F`
      }
    >
      <div className="space-y-3">
        <RadioBoxes<AnimationMode>
          value={mode}
          onChange={setMode}
          options={[
            { value: "pixel-sweep", label: "PIXEL SWEEP", hint: "1 → block size" },
            { value: "amount-fade", label: "AMOUNT FADE", hint: "in from source" },
            { value: "block-pulse", label: "BLOCK PULSE", hint: "wobble" },
          ]}
        />

        <Slider
          label="DURATION"
          value={duration}
          min={500}
          max={5000}
          step={100}
          onChange={setDuration}
          format={(n) => `${(n / 1000).toFixed(1)}s`}
        />

        <Slider
          label="FPS"
          value={fps}
          min={6}
          max={30}
          onChange={setFps}
        />

        <div className="flex items-center justify-between gap-2 text-[9px] tracking-widest uppercase">
          <span className="text-ink-700">OUT SCALE</span>
          <div className="flex gap-1">
            {[1, 2, 4].map((s) => (
              <button
                key={s}
                onClick={() => setScale(s)}
                className={`px-2 py-1 border transition-colors ${
                  scale === s
                    ? "border-lime text-lime bg-ink-200"
                    : "border-ink-400 text-ink-700 hover:text-ink-900 hover:bg-ink-200"
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1 text-[9px] tracking-widest text-ink-700">
          <span>FRAMES</span>
          <span className="text-right text-ink-900 tabular-nums">
            {String(totalFrames).padStart(3, "0")}
          </span>
          <span>SIZE EST</span>
          <span className="text-right text-ink-900 tabular-nums">
            {sizeEstimate}
          </span>
          <span>DIMS OUT</span>
          <span className="text-right text-ink-900 tabular-nums">
            {(width * scale).toLocaleString()}×{(height * scale).toLocaleString()}
          </span>
        </div>

        {state.phase === "busy" && (
          <div className="border border-ink-400 bg-ink-200 h-2 relative overflow-hidden">
            <div
              className="absolute left-0 top-0 bottom-0 bg-lime transition-[width] duration-75"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}

        {state.phase === "busy" ? (
          <button
            onClick={cancel}
            className="w-full px-4 py-3 border border-err text-err bg-ink-200 hover:bg-ink-300 text-[11px] tracking-widest uppercase font-bold transition-colors"
          >
            [ CANCEL ]
          </button>
        ) : (
          <button
            onClick={run}
            disabled={!source || state.phase === "done"}
            className="w-full px-4 py-3 border border-lime bg-lime text-ink-100 hover:bg-lime-glow active:bg-lime-glow disabled:bg-ink-400 disabled:border-ink-400 disabled:text-ink-700 disabled:cursor-not-allowed text-[11px] tracking-widest uppercase font-bold transition-colors"
          >
            {!source
              ? "[ AWAITING INPUT ]"
              : state.phase === "done"
              ? "[ DONE — DOWNLOADED ]"
              : state.phase === "error"
              ? "[ ERROR — RETRY ]"
              : "[ GENERATE GIF ]"}
          </button>
        )}

        <p className="text-[9px] tracking-wider text-ink-700 leading-relaxed normal-case">
          Encodes in your browser. The animation lands on your current settings;
          tweak Pixel/Palette/Dither first to taste.
        </p>
      </div>
    </Section>
  );
}
