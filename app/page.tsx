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
import { AmountSlider } from "@/components/AmountSlider";
import {
  VisualizeSection,
  VIZ_MODE_BITS,
} from "@/components/VisualizeSection";
import type { VizMode } from "@/components/VisualizeSection";
import {
  TextureSection,
  type BlendName,
  type FitName,
  type TextureMeta,
} from "@/components/TextureSection";

import {
  processBest,
  upscaleNN,
  downloadPNG,
  effectiveBlockSize,
  type DitherMode,
  type Settings,
  type OverlayInput,
} from "@/lib/pipeline";
import { getPalette, PALETTES } from "@/lib/palettes";
import { getAudio } from "@/lib/audio";
import {
  getWebGPU,
  OVERLAY_BLEND_BITS,
  OVERLAY_FIT_BITS,
} from "@/lib/gpu/webgpu";

const BUILD_DATE = "2026.04.27";

type SourceState = {
  image: ImageBitmap;
  filename: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
};

type TextureState = {
  image: ImageBitmap;
  filename: string;
  width: number;
  height: number;
};

// Cap source at this many pixels before processing. Pixel art doesn't need
// 12 MP detail — the chunky output looks identical, and CPU stays under 100 ms
// even at the largest block sizes.
const MAX_SOURCE_PIXELS = 2_500_000;

async function loadDownscaled(file: File): Promise<SourceState> {
  let bitmap = await createImageBitmap(file);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  let w = originalWidth;
  let h = originalHeight;

  if (w * h > MAX_SOURCE_PIXELS) {
    const scale = Math.sqrt(MAX_SOURCE_PIXELS / (w * h));
    const newW = Math.max(64, Math.round(w * scale));
    const newH = Math.max(64, Math.round(h * scale));
    const original = bitmap;
    bitmap = await createImageBitmap(original, {
      resizeWidth: newW,
      resizeHeight: newH,
      resizeQuality: "high",
    });
    original.close();
    w = newW;
    h = newH;
    console.log("[lores] downscaled source", {
      from: { w: originalWidth, h: originalHeight },
      to: { w, h },
    });
  }

  return {
    image: bitmap,
    filename: file.name,
    width: w,
    height: h,
    originalWidth,
    originalHeight,
  };
}

export default function Page() {
  const [source, setSource] = useState<SourceState | null>(null);
  const [settings, setSettings] = useState<Settings>({
    blockSize: 8,
    pixelAmount: 1,
    paletteId: "gb",
    paletteAmount: 1,
    dither: "none",
    ditherAmount: 1,
  });
  const [outScale, setOutScale] = useState<number>(1);
  const [output, setOutput] = useState<{
    canvas: HTMLCanvasElement;
    ms: number;
    engine: "gpu" | "cpu";
  } | null>(null);
  // True between the moment a setting/source change is detected and the moment
  // the resulting canvas is fully presented + GPU-completed. Drives the loading
  // bar and disables the export button so users can't grab a half-rendered PNG.
  const [processing, setProcessing] = useState(false);
  // Increments while a download blob is being assembled — kept separate so we
  // can show progress on the export button without affecting the preview bar.
  const [exporting, setExporting] = useState(false);

  // ─── Texture overlay state ───────────────────────────────────────────
  const [texture, setTexture] = useState<TextureState | null>(null);
  const [textureBlend, setTextureBlend] = useState<BlendName>("multiply");
  const [textureFit, setTextureFit] = useState<FitName>("cover");
  const [textureOpacity, setTextureOpacity] = useState<number>(60);

  const overlayInput: OverlayInput | null = useMemo(() => {
    if (!texture) return null;
    return {
      image: texture.image,
      width: texture.width,
      height: texture.height,
      blendMode: textureBlend as GlobalCompositeOperation,
      blendBit: OVERLAY_BLEND_BITS[textureBlend],
      fitBit: OVERLAY_FIT_BITS[textureFit],
      fit: textureFit,
      opacity: textureOpacity / 100,
    };
  }, [texture, textureBlend, textureFit, textureOpacity]);

  const textureMeta: TextureMeta | null = useMemo(
    () =>
      texture
        ? {
            filename: texture.filename,
            width: texture.width,
            height: texture.height,
          }
        : null,
    [texture]
  );

  // ─── Visualize state ─────────────────────────────────────────────────
  const [vizMode, setVizMode] = useState<VizMode>("off");
  const [vizIntensity, setVizIntensity] = useState<number>(100);
  const [bassBump, setBassBump] = useState<number>(12);
  const [audioState, setAudioState] = useState(getAudio().state);
  useEffect(() => {
    const audio = getAudio();
    return audio.subscribe(() => setAudioState(audio.state));
  }, []);

  const live =
    (audioState === "playing" || audioState === "mic") &&
    vizMode !== "off" &&
    !!source;
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (typeof document !== "undefined" && !liveCanvasRef.current) {
    liveCanvasRef.current = document.createElement("canvas");
  }

  // Refs hold the latest live-render inputs so the rAF tick reads them on every
  // frame without the effect having to tear down. We sync inline (during render)
  // — synchronous, no useEffect timing window where the rAF could read a stale
  // ref between a setState and its post-commit effect. Standard React pattern.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const vizModeRef = useRef<VizMode>(vizMode);
  vizModeRef.current = vizMode;
  const vizIntensityRef = useRef(vizIntensity);
  vizIntensityRef.current = vizIntensity;
  const bassBumpRef = useRef(bassBump);
  bassBumpRef.current = bassBump;
  const overlayRef = useRef(overlayInput);
  overlayRef.current = overlayInput;

  // ─── Static processing path ──────────────────────────────────────────
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!source || live) {
      setProcessing(false);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    let cancelled = false;
    setProcessing(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const result = await processBest(source.image, settings, overlayInput);
        if (!cancelled) setOutput(result);
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setProcessing(false);
      }
    }, 80);
    return () => {
      cancelled = true;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [source, settings, live, overlayInput]);

  // ─── Live audio-reactive render loop ─────────────────────────────────
  // Deps intentionally just [live, source]. Settings/mode/intensity flow in
  // through refs so we don't tear down and rebuild the loop on every slider tick.
  useEffect(() => {
    if (!live || !source) return;
    const audio = getAudio();
    const canvas = liveCanvasRef.current!;
    let raf = 0;
    let cancelled = false;
    let lastReportedAt = 0;

    (async () => {
      const gpu = await getWebGPU();
      if (!gpu || cancelled) {
        console.warn("[lores live] cannot start — gpu unavailable", {
          gpu,
          cancelled,
        });
        return;
      }

      console.log("[lores live] render loop started", {
        vizMode: vizModeRef.current,
        sourceDims: { w: source.width, h: source.height },
      });

      setOutput({ canvas, ms: 0, engine: "gpu" });

      let frameCount = 0;
      let lastLoggedPalette = "";

      const tick = async () => {
        if (cancelled) return;

        // Read the latest user inputs from refs every frame.
        const s = settingsRef.current;
        const vm = vizModeRef.current;
        const vi = vizIntensityRef.current;
        const bp = bassBumpRef.current;

        // Log when palette changes so we can verify settings flow through to the loop.
        if (s.paletteId !== lastLoggedPalette) {
          console.log("[lores live] settings updated mid-loop", {
            paletteId: s.paletteId,
            blockSize: s.blockSize,
            dither: s.dither,
            vizMode: vm,
            frame: frameCount,
          });
          lastLoggedPalette = s.paletteId;
        }
        frameCount++;

        const frame = audio.sample();

        const applyBassPump = vm === "bass-bump" || vm === "combined";
        // Nonlinear bass curve so kicks pop more visibly than gentle hums
        const bassCurve = Math.pow(frame.bass, 0.55);
        const liveSettings: Settings = applyBassPump
          ? {
              ...s,
              blockSize: Math.min(
                48,
                Math.max(
                  1,
                  Math.round(s.blockSize + bassCurve * bp * (vi / 100))
                )
              ),
            }
          : s;

        // Push the latest texture upload state to the GPU pipeline. The setter
        // is identity-cached so this is free when nothing changed.
        const ov = overlayRef.current;
        gpu.setOverlayTexture(ov ? ov.image : null);

        try {
          const r = await gpu.process(source.image, liveSettings, {
            outCanvas: canvas,
            viz: {
              bass: frame.bass,
              mid: frame.mid,
              treble: frame.treble,
              beat: frame.beat,
              time: frame.time,
              intensity: vi / 100,
              mode: VIZ_MODE_BITS[vm],
              fft: frame.fft,
            },
            overlay: ov
              ? {
                  blendMode: ov.blendBit,
                  fitMode: ov.fitBit,
                  opacity: ov.opacity,
                }
              : undefined,
            bitmapAlreadyOwned: true,
          });
          // Throttle status-bar updates to 1 Hz so we don't trigger React
          // re-renders of the entire control panel on every frame.
          const now = performance.now();
          if (now - lastReportedAt > 1000) {
            lastReportedAt = now;
            setOutput((prev) =>
              prev
                ? { ...prev, ms: r.ms }
                : { canvas, ms: r.ms, engine: "gpu" }
            );
          }
        } catch (err) {
          console.warn("[lores] live frame failed:", err);
        }

        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [live, source]);

  const onFile = async (file: File) => {
    try {
      // Free the previous bitmap to avoid GPU/system memory bloat across uploads
      if (source) source.image.close();
      const next = await loadDownscaled(file);
      setSource(next);
    } catch (err) {
      console.error("[lores] image load failed:", err);
    }
  };

  const clearSource = () => {
    if (source) source.image.close();
    setSource(null);
  };

  const onTextureFile = async (file: File) => {
    try {
      const bitmap = await createImageBitmap(file);
      // Free the previous overlay bitmap so we don't leak across uploads.
      if (texture) texture.image.close();
      setTexture({
        image: bitmap,
        filename: file.name,
        width: bitmap.width,
        height: bitmap.height,
      });
    } catch (err) {
      console.error("[lores] texture load failed:", err);
    }
  };

  const clearTexture = () => {
    if (texture) texture.image.close();
    setTexture(null);
  };

  const onExport = async () => {
    if (!output || processing || exporting) return;
    setExporting(true);
    try {
      // Yield once so the loading state actually paints before we block the
      // main thread on toBlob/encodePNG (can be 100-500ms for 4x/8x scale).
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const upscaled = upscaleNN(output.canvas, outScale);
      const base = source?.filename.replace(/\.[^.]+$/, "") ?? "lores";
      const palette = getPalette(settings.paletteId);
      const tag = `${palette.id}-${settings.blockSize}px${
        settings.dither !== "none" ? `-${settings.dither}` : ""
      }${outScale > 1 ? `-x${outScale}` : ""}`;
      downloadPNG(upscaled, `${base}-${tag}.png`);
    } finally {
      // toBlob is async under the hood but the user-visible work is done once
      // the click on the synthetic <a> fires; release the busy state on the
      // next tick so the bar doesn't flash off too early.
      setTimeout(() => setExporting(false), 200);
    }
  };

  const paletteName = useMemo(
    () => getPalette(settings.paletteId).name,
    [settings.paletteId]
  );

  const showPixelAmount = settings.blockSize > 1;
  const showPaletteAmount = settings.paletteId !== "none";
  const showDitherAmount =
    settings.dither !== "none" && settings.paletteId !== "none";

  const effBlock = effectiveBlockSize(settings);
  const pixelBadge =
    settings.pixelAmount < 1 && settings.blockSize > 1
      ? `[ ${String(effBlock).padStart(3, "0")} / ${String(settings.blockSize).padStart(3, "0")} ]`
      : `[ ${String(settings.blockSize).padStart(3, "0")} ]`;

  return (
    <div className="min-h-[100svh] lg:h-screen lg:max-h-screen lg:overflow-hidden flex flex-col bg-ink-100 text-ink-900">
      <Header buildDate={BUILD_DATE} />

      {source && (
        <MobileSourceChips
          filename={source.filename}
          width={source.width}
          height={source.height}
          onClear={clearSource}
        />
      )}

      <main className="flex-1 lg:min-h-0 grid lg:grid-cols-[260px_1fr_320px] lg:grid-rows-1 lg:overflow-hidden">
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
                  onClick={clearSource}
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

          {live && (
            <div className="px-4 py-3 border-t border-ink-400 text-[9px] tracking-widest uppercase">
              <div className="flex items-center gap-2">
                <span className="text-lime animate-blink">●</span>
                <span className="text-lime">VIZ ACTIVE</span>
              </div>
              <p className="mt-1 text-ink-700 normal-case tracking-normal text-[10px] leading-snug font-normal">
                Audio is driving the canvas. Adjust block size, palette, and
                dither — they all compose with the reactive layer.
              </p>
            </div>
          )}

          <div className="mt-auto p-4 text-[9px] tracking-widest text-ink-700 leading-relaxed border-t border-ink-400">
            <p className="mb-2 text-ink-800">PRIVACY</p>
            <p className="text-ink-700 normal-case tracking-normal text-[10px] leading-snug font-normal">
              Everything runs in your browser. No upload, no tracking, no
              account. Your image and audio never leave this tab.
            </p>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-ink-600">v0.3.0</span>
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
          {(processing || exporting) && (
            <LoadingBar label={exporting ? "ENCODING PNG" : "PROCESSING"} />
          )}
        </div>

        {/* RIGHT RAIL — controls */}
        <aside className="bg-ink-50 lg:overflow-y-auto border-t lg:border-t-0 lg:border-l border-ink-400 flex flex-col">
          <Section index="02" title="PIXEL" badge={pixelBadge}>
            <Slider
              label="BLOCK SIZE"
              value={settings.blockSize}
              min={1}
              max={48}
              onChange={(blockSize) =>
                setSettings((s) => ({ ...s, blockSize }))
              }
            />
            {showPixelAmount && (
              <AmountSlider
                value={settings.pixelAmount}
                onChange={(pixelAmount) =>
                  setSettings((s) => ({ ...s, pixelAmount }))
                }
              />
            )}
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
            {showPaletteAmount && (
              <AmountSlider
                value={settings.paletteAmount}
                onChange={(paletteAmount) =>
                  setSettings((s) => ({ ...s, paletteAmount }))
                }
              />
            )}
          </Section>

          <Section index="04" title="DITHER" badge={settings.dither.toUpperCase()}>
            <RadioBoxes<DitherMode>
              value={settings.dither}
              onChange={(dither) => setSettings((s) => ({ ...s, dither }))}
              cols={3}
              options={[
                { value: "none", label: "NONE", hint: "flat quantize" },
                { value: "floyd", label: "F·STEIN", hint: "error diffusion" },
                { value: "atkinson", label: "ATKINSON", hint: "1984 mac, crisp" },
                { value: "jarvis", label: "JARVIS", hint: "wide kernel" },
                { value: "bayer4", label: "BAYER 4", hint: "ordered 4×4" },
                { value: "bayer8", label: "BAYER 8", hint: "ordered 8×8" },
                { value: "bluenoise", label: "BLUE NOISE", hint: "perceptual" },
                { value: "ign", label: "IGN", hint: "hash dither" },
                { value: "halftone", label: "HALFTONE", hint: "dot screen" },
              ]}
            />
            {showDitherAmount && (
              <AmountSlider
                value={settings.ditherAmount}
                onChange={(ditherAmount) =>
                  setSettings((s) => ({ ...s, ditherAmount }))
                }
              />
            )}
          </Section>

          <TextureSection
            texture={textureMeta}
            blend={textureBlend}
            opacity={textureOpacity}
            fit={textureFit}
            onLoad={onTextureFile}
            onClear={clearTexture}
            onBlendChange={setTextureBlend}
            onOpacityChange={setTextureOpacity}
            onFitChange={setTextureFit}
          />

          <VisualizeSection
            mode={vizMode}
            intensity={vizIntensity}
            bassBump={bassBump}
            onModeChange={setVizMode}
            onIntensityChange={setVizIntensity}
            onBassBumpChange={setBassBump}
          />

          <Section index="07" title="EXPORT" badge={`${outScale}× SCALE`}>
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
              disabled={!output || processing || exporting}
              className="mt-3 w-full px-4 py-3 border border-lime bg-lime text-ink-100 hover:bg-lime-glow active:bg-lime-glow disabled:bg-ink-400 disabled:border-ink-400 disabled:text-ink-700 disabled:cursor-not-allowed text-[11px] tracking-widest uppercase font-bold transition-colors"
            >
              {!output
                ? "[ AWAITING INPUT ]"
                : processing
                ? "[ PROCESSING… ]"
                : exporting
                ? "[ ENCODING… ]"
                : "[ DOWNLOAD PNG ]"}
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

      {output && (
        <div className="lg:hidden sticky bottom-0 z-10 border-t border-ink-400 bg-ink-50/95 backdrop-blur px-3 py-2 flex items-center gap-2">
          <div className="flex-1 min-w-0 text-[10px] tracking-widest uppercase text-ink-700 flex items-center gap-2">
            {live ? (
              <>
                <span className="text-lime animate-blink">●</span>
                <span className="text-lime">VIZ LIVE</span>
              </>
            ) : (
              <>
                <span className="text-ink-600">READY</span>
                <span className="readout text-lime tabular-nums">
                  {output.canvas.width}×{output.canvas.height}
                </span>
                <span className="text-ink-600">·</span>
                <span className="text-ink-700">{outScale}×</span>
              </>
            )}
          </div>
          {!live && (
            <button
              onClick={onExport}
              disabled={processing || exporting}
              className="px-4 py-2 border border-lime bg-lime text-ink-100 active:bg-lime-glow disabled:bg-ink-400 disabled:border-ink-400 disabled:text-ink-700 text-[11px] tracking-widest uppercase font-bold flex-shrink-0"
            >
              {processing
                ? "[ PROCESSING… ]"
                : exporting
                ? "[ ENCODING… ]"
                : "[ DOWNLOAD ]"}
            </button>
          )}
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
        engine={output?.engine ?? null}
      />
    </div>
  );
}

function LoadingBar({ label }: { label: string }) {
  return (
    <div className="absolute inset-x-0 top-0 z-20 pointer-events-none">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-ink-50/85 backdrop-blur border-b border-ink-400">
        <span className="text-[9px] tracking-widest text-lime animate-blink">●</span>
        <span className="text-[9px] tracking-widest uppercase text-ink-800">
          {label}
        </span>
        <span className="ml-auto text-[9px] tracking-widest text-ink-700">
          please wait
        </span>
      </div>
      <div className="h-0.5 w-full bg-ink-300 overflow-hidden">
        <div className="h-full w-1/4 bg-lime animate-loading-stripe" />
      </div>
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
