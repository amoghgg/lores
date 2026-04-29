"use client";

import { useRef } from "react";
import { Section } from "./Section";
import { Slider } from "./Slider";
import { RadioBoxes } from "./RadioBoxes";

export type BlendName =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "color-burn";

export type FitName = "cover" | "tile" | "fit";

export type TextureMeta = {
  filename: string;
  width: number;
  height: number;
};

type Props = {
  texture: TextureMeta | null;
  blend: BlendName;
  opacity: number; // 0..100
  fit: FitName;
  onLoad: (file: File) => void;
  onClear: () => void;
  onBlendChange: (b: BlendName) => void;
  onOpacityChange: (n: number) => void;
  onFitChange: (f: FitName) => void;
};

export function TextureSection({
  texture,
  blend,
  opacity,
  fit,
  onLoad,
  onClear,
  onBlendChange,
  onOpacityChange,
  onFitChange,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = () => inputRef.current?.click();
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) onLoad(f);
  };

  const badge = texture ? "LOADED" : "EMPTY";

  return (
    <Section index="05" title="TEXTURE" badge={badge}>
      <div className="space-y-3">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoad(f);
            e.currentTarget.value = "";
          }}
        />

        {texture ? (
          <div className="border border-ink-400 bg-ink-50 p-3 space-y-2">
            <div className="flex items-baseline justify-between gap-2 text-[10px] tracking-widest uppercase">
              <span className="text-ink-700">FILE</span>
              <span
                className="text-ink-900 normal-case font-mono truncate flex-1 text-right"
                title={texture.filename}
              >
                {truncate(texture.filename, 22)}
              </span>
            </div>
            <div className="flex items-baseline justify-between text-[10px] tracking-widest uppercase">
              <span className="text-ink-700">DIMS</span>
              <span className="text-ink-900 tabular-nums">
                {texture.width} × {texture.height}
              </span>
            </div>
            <div className="flex gap-1 pt-1">
              <button
                onClick={onPick}
                className="flex-1 px-3 py-2 border border-ink-400 hover:border-lime hover:text-lime text-[10px] tracking-widest uppercase text-ink-700 transition-colors"
              >
                [ REPLACE ]
              </button>
              <button
                onClick={onClear}
                className="px-3 py-2 border border-ink-400 hover:border-err hover:text-err text-[10px] tracking-widest uppercase text-ink-700 transition-colors"
                title="Remove overlay"
              >
                ×
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={onPick}
            onDragOver={onDragOver}
            onDrop={onDrop}
            className="w-full px-4 py-4 border border-dashed border-ink-500 hover:border-lime hover:text-lime active:border-lime text-[10px] tracking-widest uppercase text-ink-700 bg-ink-50 hover:bg-ink-200 transition-colors"
          >
            <div className="flex flex-col items-center gap-1">
              <span className="font-display text-xl tracking-wider leading-none">
                DROP TEXTURE
              </span>
              <span className="text-[9px] text-ink-700">
                PNG · JPG · paper · grain · noise · anything
              </span>
            </div>
          </button>
        )}

        <div>
          <div className="text-[10px] tracking-widest uppercase text-ink-700 mb-2">
            BLEND
          </div>
          <RadioBoxes<BlendName>
            value={blend}
            onChange={onBlendChange}
            options={[
              { value: "multiply", label: "MULTIPLY", hint: "darken / ink" },
              { value: "screen", label: "SCREEN", hint: "lighten / glow" },
              { value: "overlay", label: "OVERLAY", hint: "contrast" },
              { value: "soft-light", label: "SOFT LIGHT", hint: "subtle" },
              { value: "hard-light", label: "HARD LIGHT", hint: "punchy" },
              { value: "difference", label: "DIFFERENCE", hint: "invert mix" },
              { value: "color-burn", label: "COLOR BURN", hint: "deep dark" },
              { value: "normal", label: "NORMAL", hint: "alpha only" },
            ]}
          />
        </div>

        <div>
          <div className="text-[10px] tracking-widest uppercase text-ink-700 mb-2">
            FIT
          </div>
          <RadioBoxes<FitName>
            value={fit}
            onChange={onFitChange}
            cols={3}
            options={[
              { value: "cover", label: "COVER", hint: "fill, may crop" },
              { value: "tile", label: "TILE", hint: "repeat native" },
              { value: "fit", label: "FIT", hint: "letterbox" },
            ]}
          />
        </div>

        <Slider
          label="OPACITY"
          value={opacity}
          min={0}
          max={100}
          onChange={onOpacityChange}
          format={(n) => `${String(n).padStart(3, "0")}%`}
        />

        <p className="text-[9px] tracking-wider text-ink-700 leading-relaxed normal-case">
          Drop a paper, grain, scanline, or any image. Composites onto the
          dithered base — dither stays crisp, texture rides on top.
        </p>
      </div>
    </Section>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? "…" + s.slice(-n + 1) : s;
}
