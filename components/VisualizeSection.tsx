"use client";

import { useEffect, useRef, useState } from "react";
import { Section } from "./Section";
import { Slider } from "./Slider";
import { RadioBoxes } from "./RadioBoxes";
import { getAudio, type AudioState } from "@/lib/audio";

export type VizMode =
  | "off"
  | "bass-bump"
  | "chroma"
  | "shockwave"
  | "spectrum"
  | "combined";

export const VIZ_MODE_BITS: Record<VizMode, number> = {
  off: 0,
  "bass-bump": 0,
  chroma: 1,
  shockwave: 2,
  spectrum: 8,
  combined: 1 | 2 | 4 | 8,
};

type AudioSource = "file" | "mic";

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
  const [errorMsg, setErrorMsg] = useState(audio.errorMessage);
  const [audioSource, setAudioSource] = useState<AudioSource>("file");
  const [loop, setLoopState] = useState(audio.loop);
  const [currentTime, setCurrentTime] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = audio.subscribe(() => {
      setState(audio.state);
      setFilename(audio.filename);
      setDuration(audio.duration);
      setErrorMsg(audio.errorMessage);
      setLoopState(audio.loop);
    });
    return unsubscribe;
  }, [audio]);

  // Poll currentTime for the scrubber while playing
  useEffect(() => {
    if (state !== "playing") return;
    const id = window.setInterval(() => {
      setCurrentTime(audio.getCurrentTime());
    }, 100);
    return () => window.clearInterval(id);
  }, [audio, state]);

  // Switch source: stop one, start the other
  useEffect(() => {
    if (audioSource === "mic") void audio.startMic();
    else audio.stopMic();
  }, [audio, audioSource]);

  const handleFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) return;
    if (audioSource !== "file") setAudioSource("file");
    await audio.loadFile(file);
  };

  const onPickClick = () => inputRef.current?.click();
  const onTogglePlay = async () => {
    if (state === "playing") audio.pause();
    else if (state === "loaded" || state === "paused") await audio.play();
  };
  const onStop = () => audio.stop();
  const onClearAudio = () => audio.dispose();
  const onToggleLoop = () => audio.setLoop(!loop);
  const onSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    void audio.seek(ratio * duration);
    setCurrentTime(ratio * duration);
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
      : state === "mic"
      ? "MIC ON"
      : state === "error"
      ? "FAILED"
      : "EMPTY";

  return (
    <Section index="05" title="VISUALIZE" badge={badge}>
      <div className="space-y-3">
        {/* Source toggle — file vs mic */}
        <div>
          <div className="text-[10px] tracking-widest uppercase text-ink-700 mb-2">
            SOURCE
          </div>
          <RadioBoxes<AudioSource>
            value={audioSource}
            onChange={setAudioSource}
            options={[
              { value: "file", label: "FILE", hint: "MP3 · WAV · OGG" },
              { value: "mic", label: "MIC", hint: "live input" },
            ]}
          />
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          className="sr-only"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        {/* MIC mode */}
        {audioSource === "mic" && (
          <div className="border border-ink-400 bg-ink-50 p-3 space-y-2">
            <div className="flex items-center gap-2 text-[10px] tracking-widest uppercase">
              {state === "mic" ? (
                <>
                  <span className="text-lime animate-blink">●</span>
                  <span className="text-lime">LIVE INPUT</span>
                  <span className="ml-auto text-ink-700 normal-case tracking-normal text-[10px]">
                    monitor off · feedback safe
                  </span>
                </>
              ) : state === "error" ? (
                <span className="text-err">{errorMsg || "MIC ERROR"}</span>
              ) : (
                <span className="text-ink-700">requesting mic…</span>
              )}
            </div>
            {state === "error" && (
              <button
                onClick={() => void audio.startMic()}
                className="w-full px-3 py-2 border border-ink-400 hover:border-lime hover:text-lime text-[10px] tracking-widest uppercase transition-colors"
              >
                [ RETRY ]
              </button>
            )}
          </div>
        )}

        {/* FILE mode */}
        {audioSource === "file" &&
          (state === "empty" || state === "error" || state === "mic") ? (
          <button
            onClick={onPickClick}
            className="w-full px-4 py-4 border border-dashed border-ink-500 hover:border-lime hover:text-lime active:border-lime text-[10px] tracking-widest uppercase text-ink-700 bg-ink-50 hover:bg-ink-200 transition-colors"
          >
            <div className="flex flex-col items-center gap-1">
              <span className="font-display text-xl tracking-wider leading-none">
                DROP AUDIO
              </span>
              <span className="text-[9px] text-ink-700">
                MP3 · WAV · OGG · M4A
              </span>
            </div>
          </button>
        ) : null}

        {audioSource === "file" &&
          (state === "loaded" ||
            state === "playing" ||
            state === "paused" ||
            state === "loading") && (
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

              {/* Seek bar */}
              <div className="space-y-1">
                <div
                  onClick={onSeek}
                  className="h-2 bg-ink-200 border border-ink-400 cursor-pointer relative hover:border-lime transition-colors"
                  role="slider"
                  aria-label="Seek"
                >
                  <div
                    className="absolute left-0 top-0 bottom-0 bg-lime"
                    style={{
                      width:
                        duration > 0
                          ? `${Math.min(100, (currentTime / duration) * 100)}%`
                          : "0%",
                    }}
                  />
                </div>
                <div className="flex items-baseline justify-between text-[9px] tracking-widest uppercase tabular-nums">
                  <span className="text-lime">{fmtTime(currentTime)}</span>
                  <span className="text-ink-700">{fmtTime(duration)}</span>
                </div>
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
                  onClick={onToggleLoop}
                  className={`px-3 py-2 border text-[10px] tracking-widest uppercase transition-colors ${
                    loop
                      ? "border-lime text-lime bg-ink-200"
                      : "border-ink-400 text-ink-700 hover:text-ink-900 hover:bg-ink-200"
                  }`}
                  title="Loop"
                >
                  ↻
                </button>
                <button
                  onClick={onClearAudio}
                  className="px-3 py-2 border border-ink-400 hover:border-err hover:text-err text-[10px] tracking-widest uppercase text-ink-700 transition-colors"
                  title="Clear"
                >
                  ×
                </button>
              </div>
            </div>
          )}

        {/* Modes */}
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
          <div className="grid grid-cols-2 gap-1 mt-1">
            <button
              onClick={() => onModeChange("spectrum")}
              className={`text-left px-3 py-2 border transition-colors ${
                mode === "spectrum"
                  ? "border-lime bg-ink-200 text-ink-900"
                  : "border-ink-400 bg-ink-50 text-ink-700 hover:text-ink-900 hover:bg-ink-200"
              }`}
            >
              <div className="text-[10px] tracking-widest uppercase font-medium flex items-center gap-2">
                <span className={mode === "spectrum" ? "text-lime" : "text-ink-600"}>
                  {mode === "spectrum" ? "■" : "□"}
                </span>
                SPECTRUM
              </div>
              <div className="text-[9px] tracking-wider text-ink-700 mt-1">
                FFT-driven wave
              </div>
            </button>
            <button
              onClick={() => onModeChange("combined")}
              className={`text-left px-3 py-2 border transition-colors ${
                mode === "combined"
                  ? "border-lime bg-ink-200 text-ink-900"
                  : "border-ink-400 bg-ink-50 text-ink-700 hover:text-ink-900 hover:bg-ink-200"
              }`}
            >
              <div className="text-[10px] tracking-widest uppercase font-medium flex items-center gap-2">
                <span className={mode === "combined" ? "text-lime" : "text-ink-600"}>
                  {mode === "combined" ? "■" : "□"}
                </span>
                COMBINED
              </div>
              <div className="text-[9px] tracking-wider text-ink-700 mt-1">
                everything · DJ feel
              </div>
            </button>
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
          Drop a track or pipe a mic. Block size pulses with the kick; mode
          adds GPU FX. Needs an image loaded first.
        </p>
      </div>
    </Section>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? "…" + s.slice(-n + 1) : s;
}
