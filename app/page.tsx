"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "@/components/Header";
import { DropZone } from "@/components/DropZone";
import { PreviewCanvas } from "@/components/PreviewCanvas";
import { Section } from "@/components/Section";
import { Slider } from "@/components/Slider";
import { PaletteGrid } from "@/components/PaletteGrid";
import { RadioBoxes } from "@/components/RadioBoxes";
import { StatusBar } from "@/components/StatusBar";
import { MobileSourceChips } from "@/components/MobileSourceChips";

import {
  process,
  upscaleNN,
  downloadPNG,
  type DitherMode,
  type Settings,
} from "@/lib/pipeline";
import { getPalette, PALETTES } from "@/lib/palettes";

const BUILD_DATE = "2026.04.23";

type SourceState = {
  image: HTMLImageElement;
  filename: string;
  width: number;
  height: number;
};

export default function Page() {
  const [source, setSource] = useState<SourceState | null>(null);
  const [settings, setSettings] = useState<Settings>({
    blockSize: 8,
    paletteId: "gb",
    dither: "none",
  });
  const [outScale, setOutScale] = useState<number>(1);
  const [output, setOutput] = useState<{
    canvas: HTMLCanvasElement;
    ms: number;
  } | null>(null);

  // Process pipeline whenever source or settings change. Debounced to keep slider snappy.
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!source) {
      setOutput(null);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      try {
        const result = process(source.image, settings);
        setOutput(result);
      } catch (err) {
        console.error(err);
      }
    }, 80);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [source, settings]);

  const onFile = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setSource({
        image: img,
        filename: file.name,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const onExport = () => {
    if (!output) return;
    const upscaled = upscaleNN(output.canvas, outScale);
    const base = source?.filename.replace(/\.[^.]+$/, "") ?? "lores";
    const palette = getPalette(settings.paletteId);
    const tag = `${palette.id}-${settings.blockSize}px${
      settings.dither !== "none" ? `-${settings.dither}` : ""
    }${outScale > 1 ? `-x${outScale}` : ""}`;
    downloadPNG(upscaled, `${base}-${tag}.png`);
  };

  const paletteName = useMemo(
    () => getPalette(settings.paletteId).name,
    [settings.paletteId]
  );

  return (
    <div className="min-h-[100svh] lg:h-screen flex flex-col bg-ink-100 text-ink-900">
      <Header buildDate={BUILD_DATE} />

      {source && (
        <MobileSourceChips
          filename={source.filename}
          width={source.width}
          height={source.height}
          onClear={() => setSource(null)}
        />
      )}

      <main className="flex-1 grid lg:grid-cols-[260px_1fr_320px] lg:grid-rows-1 lg:overflow-hidden">
        {/* LEFT RAIL — meta (desktop only) */}
        <aside className="hidden lg:flex flex-col border-r border-ink-400 bg-ink-50 text-[10px] tracking-widest uppercase">
          <Section index="01" title="SOURCE" badge={source ? "LOADED" : "EMPTY"}>
            {source ? (
              <div className="space-y-2 text-ink-800">
                <Field label="NAME" value={source.filename} mono />
                <Field
                  label="DIMS"
                  value={`${source.width} × ${source.height} px`}
                />
                <Field
                  label="MEGAPIXELS"
                  value={((source.width * source.height) / 1_000_000).toFixed(2)}
                />
                <button
                  onClick={() => setSource(null)}
                  className="mt-2 w-full text-[10px] tracking-widest uppercase border border-ink-400 hover:border-lime hover:text-lime bg-ink-50 hover:bg-ink-200 py-2 transition-colors"
                >
                  [ CLEAR ]
                </button>
              </div>
            ) : (
              <p className="text-ink-700 leading-relaxed">
                Awaiting input. Drop, paste, or click the central grid to load
                an image.
              </p>
            )}
          </Section>

          <div className="mt-auto p-4 text-[9px] tracking-widest text-ink-700 leading-relaxed border-t border-ink-400">
            <p className="mb-2 text-ink-800">PRIVACY</p>
            <p className="text-ink-700 normal-case tracking-normal text-[10px] leading-snug font-normal">
              Everything runs in your browser. No upload, no tracking, no
              account. Your image never leaves this tab.
            </p>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-ink-600">v0.1.0</span>
              <span className="text-ink-600">MIT</span>
            </div>
          </div>
        </aside>

        {/* CENTER — preview */}
        <div className="relative bg-ink-100 lg:border-r border-ink-400 min-h-[55svh] lg:min-h-0 row-span-1">
          {source && output ? (
            <PreviewCanvas canvas={output.canvas} />
          ) : (
            <DropZone onFile={onFile} />
          )}
        </div>

        {/* RIGHT RAIL — controls */}
        <aside className="bg-ink-50 lg:overflow-y-auto border-t lg:border-t-0 lg:border-l border-ink-400 flex flex-col">
          <Section
            index="02"
            title="PIXEL"
            badge={`[ ${String(settings.blockSize).padStart(3, "0")} ]`}
          >
            <Slider
              label="BLOCK SIZE"
              value={settings.blockSize}
              min={1}
              max={48}
              onChange={(blockSize) =>
                setSettings((s) => ({ ...s, blockSize }))
              }
            />
            <p className="mt-2 text-[9px] tracking-wider text-ink-700 leading-relaxed normal-case">
              Larger blocks → chunkier pixels. Each block becomes one solid
              color.
            </p>
          </Section>

          <Section
            index="03"
            title="PALETTE"
            badge={`${PALETTES.length} PRESETS`}
          >
            <PaletteGrid
              selected={settings.paletteId}
              onSelect={(paletteId) =>
                setSettings((s) => ({ ...s, paletteId }))
              }
            />
          </Section>

          <Section index="04" title="DITHER" badge={settings.dither.toUpperCase()}>
            <RadioBoxes<DitherMode>
              value={settings.dither}
              onChange={(dither) => setSettings((s) => ({ ...s, dither }))}
              options={[
                { value: "none", label: "NONE", hint: "flat quantize" },
                { value: "floyd", label: "F·STEIN", hint: "error diffusion" },
                { value: "bayer4", label: "BAYER 4", hint: "ordered 4×4" },
                { value: "bayer8", label: "BAYER 8", hint: "ordered 8×8" },
              ]}
            />
            <p className="mt-2 text-[9px] tracking-wider text-ink-700 leading-relaxed normal-case">
              Dithering simulates more colors than the palette holds.
            </p>
          </Section>

          <Section index="05" title="EXPORT" badge={`${outScale}× SCALE`}>
            <RadioBoxes<string>
              value={String(outScale)}
              onChange={(v) => setOutScale(Number(v))}
              options={[
                { value: "1", label: "1×", hint: "actual size" },
                { value: "2", label: "2×", hint: "double" },
                { value: "4", label: "4×", hint: "chunky" },
                { value: "8", label: "8×", hint: "print" },
              ]}
            />
            <button
              onClick={onExport}
              disabled={!output}
              className="mt-3 w-full px-4 py-3 border border-lime bg-lime text-ink-100 hover:bg-lime-glow active:bg-lime-glow disabled:bg-ink-400 disabled:border-ink-400 disabled:text-ink-700 disabled:cursor-not-allowed text-[11px] tracking-widest uppercase font-bold transition-colors"
            >
              {output ? "[ DOWNLOAD PNG ]" : "[ AWAITING INPUT ]"}
            </button>
            {output && (
              <div className="mt-3 grid grid-cols-2 gap-1 text-[9px] tracking-widest text-ink-700">
                <span>OUT W</span>
                <span className="text-right text-ink-900">
                  {(output.canvas.width * outScale).toLocaleString()} px
                </span>
                <span>OUT H</span>
                <span className="text-right text-ink-900">
                  {(output.canvas.height * outScale).toLocaleString()} px
                </span>
              </div>
            )}
          </Section>

          <div className="mt-auto p-4 border-t border-ink-400 text-[9px] tracking-widest text-ink-700">
            <div className="flex items-center justify-between">
              <span className="hidden sm:inline">SHIFT + L</span>
              <span className="sm:hidden">PRIVACY</span>
              <span className="text-ink-600 hidden sm:inline">CYCLE PALETTE</span>
              <span className="text-ink-600 sm:hidden normal-case tracking-normal text-[10px]">
                runs in your browser
              </span>
            </div>
          </div>
        </aside>
      </main>

      {/* Mobile: floating quick-export action when image is loaded */}
      {output && (
        <div className="lg:hidden sticky bottom-0 z-10 border-t border-ink-400 bg-ink-50/95 backdrop-blur px-3 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0 text-[10px] tracking-widest uppercase text-ink-700 flex items-center gap-2">
            <span className="text-ink-600">READY</span>
            <span className="readout text-lime tabular-nums">
              {output.canvas.width}×{output.canvas.height}
            </span>
            <span className="text-ink-600">·</span>
            <span className="text-ink-700">{outScale}×</span>
          </div>
          <button
            onClick={onExport}
            className="px-4 py-2 border border-lime bg-lime text-ink-100 active:bg-lime-glow text-[11px] tracking-widest uppercase font-bold flex-shrink-0"
          >
            [ DOWNLOAD ]
          </button>
        </div>
      )}

      <StatusBar
        filename={source?.filename ?? null}
        width={source?.width ?? null}
        height={source?.height ?? null}
        paletteName={paletteName}
        blockSize={settings.blockSize}
        ms={output?.ms ?? null}
        outScale={outScale}
      />
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[10px] tracking-wider">
      <span className="text-ink-700 uppercase tracking-widest">{label}</span>
      <span
        className={`text-ink-900 truncate ${
          mono ? "font-mono normal-case" : ""
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
