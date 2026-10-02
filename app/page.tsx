"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Viewer } from "@/components/v2/Viewer";
import { Tabs, Looks, Now, type Tab } from "@/components/v2/Panel";
import { ExportPanel } from "@/components/v2/ExportPanel";
import { CommandPalette, type Command } from "@/components/v2/CommandPalette";
import { HelpOverlay } from "@/components/v2/HelpOverlay";
import { Home } from "@/components/v2/Home";
import { PixelWipe, type PixelWipeHandle } from "@/components/v2/PixelWipe";
import { VisualizeSection, VIZ_MODE_BITS, type VizMode } from "@/components/VisualizeSection";

import { processBest } from "@/lib/pipeline";
import { PALETTES } from "@/lib/palettes";
import { FILM_CATEGORIES, FILM_STOCKS, getStock } from "@/lib/filmStocks";
import { getAudio } from "@/lib/audio";
import { getWebGPU, OVERLAY_BLEND_BITS, OVERLAY_FIT_BITS } from "@/lib/gpu/webgpu";
import {
  BLOCKS,
  DEFAULT_RECIPE,
  DITHERS,
  decodeRecipe,
  describeRecipe,
  encodeRecipe,
  sameRecipe,
  shuffleRecipe,
  toFilm,
  toOverlayOpts,
  toSettings,
  type Recipe,
} from "@/lib/recipe";
import { getThumbs } from "@/lib/thumbs";
import { idbGet, idbSet, lsGet, lsSet } from "@/lib/persist";
import { readRecipe } from "@/lib/pngmeta";
import { renderExport, saveBlob, toBlob, type ExportOptions } from "@/lib/exporter";
import { SAMPLE, randomFact } from "@/lib/sample";

// Pixel art doesn't need 12 MP; film looks read fine at 2.5 MP and the GPU
// stays well under a frame.
const MAX_SOURCE_PIXELS = 2_500_000;

type Source = {
  image: ImageBitmap;
  filename: string;
  width: number;
  height: number;
  id: string;
};

type Texture = { image: ImageBitmap; filename: string; id: string };

async function decodeImage(blob: Blob, filename: string): Promise<Source> {
  let bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  if (width * height > MAX_SOURCE_PIXELS) {
    const s = Math.sqrt(MAX_SOURCE_PIXELS / (width * height));
    const full = bitmap;
    bitmap = await createImageBitmap(full, {
      resizeWidth: Math.max(64, Math.round(width * s)),
      resizeHeight: Math.max(64, Math.round(height * s)),
      resizeQuality: "high",
    });
    full.close();
  }
  return {
    image: bitmap,
    filename,
    width: bitmap.width,
    height: bitmap.height,
    id: `${filename}:${blob.size}:${Date.now()}`,
  };
}

function bitmapCanvas(b: ImageBitmap): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = b.width;
  c.height = b.height;
  c.getContext("2d")!.drawImage(b, 0, 0);
  return c;
}

// Kept in capitals in saved filenames.
const ACRONYMS = new Set(["CGA", "IGN", "NEG"]);

const isPixelArt = (r: Recipe) => r.block > 1 || r.palette !== "none";

export default function Page() {
  // ─── Image ───────────────────────────────────────────────────────────
  const [source, setSource] = useState<Source | null>(null);
  const [original, setOriginal] = useState<HTMLCanvasElement | null>(null);
  const [texture, setTexture] = useState<Texture | null>(null);

  // ─── Recipe + history ────────────────────────────────────────────────
  const [recipe, setRecipeState] = useState<Recipe>(DEFAULT_RECIPE);
  const recipeRef = useRef(recipe);
  recipeRef.current = recipe;
  const committed = useRef<Recipe>(DEFAULT_RECIPE);
  const past = useRef<Recipe[]>([]);
  const future = useRef<Recipe[]>([]);
  const [, bumpHistory] = useState(0);
  const [preview, setPreview] = useState<Recipe | null>(null);

  /** Apply a new recipe. `commit` = it's a settled change (one undo step). */
  const apply = useCallback((next: Recipe, commit = true) => {
    setRecipeState(next);
    if (!commit) return;
    if (!sameRecipe(committed.current, next)) {
      past.current.push(committed.current);
      if (past.current.length > 200) past.current.shift();
      future.current = [];
      committed.current = next;
      bumpHistory((n) => n + 1);
    }
  }, []);

  const set = useCallback(
    (patch: Partial<Recipe>, commit = true) => apply({ ...recipeRef.current, ...patch, off: {} }, commit),
    [apply]
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(committed.current);
    committed.current = prev;
    setRecipeState(prev);
    bumpHistory((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(committed.current);
    committed.current = next;
    setRecipeState(next);
    bumpHistory((n) => n + 1);
  }, []);

  // ─── UI state ────────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("film");
  const [filmCat, setFilmCat] = useState<string>(FILM_CATEGORIES[0].id);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<null | "export" | "palette" | "help">(null);
  const [holdKey, setHoldKey] = useState(false);
  const [hideUI, setHideUI] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Every visit starts on the home screen.
  const [view, setView] = useState<"home" | "app">("home");
  const viewRef = useRef(view);
  viewRef.current = view;
  const wipeRef = useRef<PixelWipeHandle>(null);
  const firstVisit = useRef(false);
  // The user has a photo of their own loaded (vs. the sample).
  const [ownPhoto, setOwnPhoto] = useState(false);
  const [credit, setCredit] = useState(false);
  const pendingEnter = useRef<{ x: number; y: number } | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    lsSet("theme", next);
  };
  const toastT = useRef<number | null>(null);
  const say = useCallback((msg: string, ms = 1600) => {
    setToast(msg);
    if (toastT.current) window.clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  const [exportOpts, setExportOpts] = useState<ExportOptions>({
    scale: 1,
    frame: "none",
    format: "png",
    crisp: false,
    matte: "#0a0a0a",
  });
  const [exporting, setExporting] = useState(false);

  // ─── Render output ───────────────────────────────────────────────────
  const [output, setOutput] = useState<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = preview ?? recipe;

  const overlayInput = useMemo(
    () => toOverlayOpts(shown, texture?.image ?? null, { blend: OVERLAY_BLEND_BITS, fit: OVERLAY_FIT_BITS }),
    [shown, texture]
  );
  const settings = useMemo(() => toSettings(shown), [shown]);
  const film = useMemo(() => toFilm(shown), [shown]);

  // ─── Sound (live mode) ───────────────────────────────────────────────
  const [vizMode, setVizMode] = useState<VizMode>("off");
  const [vizIntensity, setVizIntensity] = useState(100);
  const [bassBump, setBassBump] = useState(12);
  const [audioState, setAudioState] = useState(getAudio().state);
  useEffect(() => {
    const audio = getAudio();
    return audio.subscribe(() => setAudioState(audio.state));
  }, []);
  const live = (audioState === "playing" || audioState === "mic") && vizMode !== "off" && !!source;
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (typeof document !== "undefined" && !liveCanvasRef.current) {
    liveCanvasRef.current = document.createElement("canvas");
  }

  // Refs carry the latest inputs into the render loops without re-subscribing.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const filmRef = useRef(film);
  filmRef.current = film;
  const overlayRef = useRef(overlayInput);
  overlayRef.current = overlayInput;
  const vizRef = useRef({ vizMode, vizIntensity, bassBump });
  vizRef.current = { vizMode, vizIntensity, bassBump };

  // Static render: coalesced — at most one in flight, latest settings win.
  const rendering = useRef(false);
  const dirty = useRef(false);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const renderNow = useCallback(async () => {
    if (rendering.current) {
      dirty.current = true;
      return;
    }
    rendering.current = true;
    setBusy(true);
    try {
      do {
        dirty.current = false;
        const src = sourceRef.current;
        if (!src) break;
        const r = await processBest(src.image, settingsRef.current, overlayRef.current, filmRef.current);
        if (!dirty.current) setOutput(r.canvas);
      } while (dirty.current);
    } catch (err) {
      console.error("[pixel] render failed", err);
    } finally {
      rendering.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!source || live) return;
    const id = requestAnimationFrame(() => void renderNow());
    return () => cancelAnimationFrame(id);
  }, [source, settings, film, overlayInput, live, renderNow]);

  useEffect(() => {
    if (!live || !source) return;
    const audio = getAudio();
    const canvas = liveCanvasRef.current!;
    let raf = 0;
    let cancelled = false;
    (async () => {
      const gpu = await getWebGPU();
      if (!gpu || cancelled) return;
      setOutput(canvas);
      const tick = async () => {
        if (cancelled) return;
        const s = settingsRef.current;
        const { vizMode: vm, vizIntensity: vi, bassBump: bp } = vizRef.current;
        const frame = audio.sample();
        const pump = vm === "bass-bump" || vm === "combined";
        const liveSettings = pump
          ? { ...s, blockSize: Math.min(48, Math.max(1, Math.round(s.blockSize + Math.pow(frame.bass, 0.55) * bp * (vi / 100)))) }
          : s;
        const ov = overlayRef.current;
        gpu.setOverlayTexture(ov ? ov.image : null);
        try {
          await gpu.process(source.image, liveSettings, {
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
            overlay: ov ? { blendMode: ov.blendBit, fitMode: ov.fitBit, opacity: ov.opacity } : undefined,
            film: filmRef.current ? { ...filmRef.current, time: frame.time } : null,
            bitmapAlreadyOwned: true,
          });
        } catch (err) {
          console.warn("[pixel] live frame failed:", err);
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

  // ─── Home ↔ app, through the pixel wipe ──────────────────────────────
  const enterApp = useCallback(
    (from: { x: number; y: number }) => {
      const go = () => {
        setView("app");
        if (firstVisit.current) {
          firstVisit.current = false;
          window.setTimeout(() => say("TAP A LOOK · HOLD THE PHOTO TO COMPARE", 4200), 700);
        }
      };
      if (wipeRef.current) wipeRef.current.run(from, go);
      else go();
    },
    [say]
  );
  const goHome = (from: { x: number; y: number }) => {
    setOverlay(null);
    if (wipeRef.current) wipeRef.current.run(from, () => setView("home"));
    else setView("home");
  };
  const centerOf = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  // ─── Loading images ──────────────────────────────────────────────────
  const loadBlob = useCallback(
    async (blob: Blob, filename: string, opts: { remember?: boolean } = {}) => {
      try {
        // A PIXEL PNG carries its recipe — dropping one restores the look.
        const code = await readRecipe(blob);
        const next = await decodeImage(blob, filename);
        setSource((prev) => {
          prev?.image.close();
          return next;
        });
        setOriginal(bitmapCanvas(next.image));
        getThumbs().setSource(next.image, next.id);
        if (code) {
          const r = decodeRecipe(code);
          if (r) {
            apply(r);
            say("RECIPE RESTORED FROM IMAGE");
          }
        }
        if (opts.remember !== false) {
          void idbSet("source", { blob, filename });
          setOwnPhoto(true);
          const from = pendingEnter.current;
          pendingEnter.current = null;
          if (viewRef.current === "home") enterApp(from ?? { x: innerWidth / 2, y: innerHeight / 2 });
        }
      } catch (err) {
        console.error("[pixel] image load failed", err);
        say("COULDN'T OPEN THAT FILE");
      }
    },
    [apply, say, enterApp]
  );

  const fileInput = useRef<HTMLInputElement>(null);
  const openPicker = () => fileInput.current?.click();

  const loadTexture = async (f: File) => {
    try {
      const image = await createImageBitmap(f);
      const id = `${f.name}:${f.size}:${Date.now()}`;
      setTexture((prev) => {
        prev?.image.close();
        return { image, filename: f.name, id };
      });
      getThumbs().setTexture(image, id);
    } catch {
      say("COULDN'T OPEN THAT TEXTURE");
    }
  };
  const clearTexture = () => {
    setTexture((prev) => {
      prev?.image.close();
      return null;
    });
    getThumbs().setTexture(null, "");
  };

  // ─── Boot: recipe from URL › last session › default; image from last
  // session › sample. Never an empty screen.
  useEffect(() => {
    const fromHash = window.location.hash.startsWith("#r=")
      ? decodeRecipe(decodeURIComponent(window.location.hash.slice(3)))
      : null;
    // A shared link's look is applied, then the address bar goes back to clean.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    const fromLast = decodeRecipe(lsGet("recipe", ""));
    const start = fromHash ?? fromLast ?? DEFAULT_RECIPE;
    committed.current = start;
    setRecipeState(start);
    setFavorites(lsGet<string[]>("favorites", []));
    const opts = lsGet<ExportOptions | null>("export", null);
    if (opts) setExportOpts(opts);
    const stock = getStock(start.film);
    if (stock) setFilmCat(stock.category);
    if (!fromHash && start.film === "none" && isPixelArt(start)) setTab("pixel");

    void (async () => {
      const saved = await idbGet<{ blob: Blob; filename: string }>("source");
      if (saved?.blob) {
        await loadBlob(saved.blob, saved.filename, { remember: false });
        setOwnPhoto(true);
      } else {
        const res = await fetch(SAMPLE.url);
        await loadBlob(await res.blob(), SAMPLE.filename, { remember: false });
      }
      if (!lsGet("seen", false)) {
        lsSet("seen", true);
        firstVisit.current = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A shared link opened in an already-open tab: apply it, clean the URL.
  useEffect(() => {
    const onHash = () => {
      if (!window.location.hash.startsWith("#r=")) return;
      const r = decodeRecipe(decodeURIComponent(window.location.hash.slice(3)));
      window.history.replaceState(null, "", window.location.pathname);
      if (r) {
        apply(r);
        say("LOOK FROM LINK APPLIED");
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [apply, say]);

  // Remember the look on this device (the URL stays clean).
  useEffect(() => {
    const t = window.setTimeout(() => {
      lsSet("recipe", encodeRecipe(recipe));
    }, 250);
    return () => window.clearTimeout(t);
  }, [recipe]);

  // ─── Actions ─────────────────────────────────────────────────────────
  const surprise = useCallback(() => {
    const next = shuffleRecipe(recipeRef.current, {}, Math.floor(Math.random() * 1e9));
    apply(next);
    if (next.film !== "none") {
      const s = getStock(next.film);
      if (s) setFilmCat(s.category);
    }
    setTab(next.film !== "none" ? "film" : "pixel");
    // On the sample, every third roll comes with a fact.
    if (sourceRef.current?.filename === SAMPLE.filename && Math.random() < 0.34) say(randomFact(), 3200);
    else say(describeRecipe(next));
  }, [apply, say]);

  const toggleFavorite = (id: string) => {
    setFavorites((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
      lsSet("favorites", next);
      say(next.includes(id) ? "SAVED TO ★" : "REMOVED FROM ★");
      return next;
    });
  };

  /** "chuck-norris (Portra 400).png" — the photo's name and the look, readable. */
  const fileName = (ext: string) => {
    const base = (source?.filename ?? "photo").replace(/\.[^.]+$/, "").replace(/\s*\([^)]*\)\s*$/, "") || "photo";
    const look = describeRecipe(recipeRef.current)
      .split(" · ")
      .slice(0, 2)
      .map((w) =>
        w
          // Title-case plain words (PORTRA → Portra); keep acronyms (CGA, C64, PICO-8).
          .replace(/(^|[\s])([A-Z])([A-Z]{2,})(?=$|[\s,])/g, (m: string, sp: string, a: string, b: string) =>
            ACRONYMS.has(a + b) ? m : sp + a + b.toLowerCase()
          )
          .replace(/(\d+)PX\b/, "$1px")
      )
      .join(", ");
    return `${base} (${look === "Original" ? "Pixel" : look}).${ext}`;
  };

  const exportBlob = async (opts: ExportOptions) => {
    if (!output || !source) return null;
    // Live mode renders to a WebGPU canvas; export the stable static render.
    const r = live
      ? await processBest(source.image, settingsRef.current, overlayRef.current, filmRef.current)
      : { canvas: output };
    const canvas = renderExport(r.canvas as HTMLCanvasElement, opts);
    const blob = await toBlob(canvas, opts, encodeRecipe(recipeRef.current));
    return { blob, name: fileName(opts.format === "png" ? "png" : "jpg") };
  };

  const save = async (opts = exportOpts) => {
    if (exporting) return;
    setExporting(true);
    try {
      // Pixel art always exports with hard edges, photos smooth — never a choice to get wrong.
      const out = await exportBlob({ ...opts, crisp: isPixelArt(recipeRef.current) });
      if (out) {
        saveBlob(out.blob, out.name);
        say("SAVED");
      }
    } finally {
      setExporting(false);
    }
  };

  /** One-tap save with the last-used options (native PNG by default). */
  const quickSave = () => void save();

  const canShare =
    typeof navigator !== "undefined" &&
    !!navigator.canShare &&
    navigator.canShare({ files: [new File([""], "x.png", { type: "image/png" })] });

  const share = async () => {
    const out = await exportBlob({ ...exportOpts, crisp: isPixelArt(recipeRef.current) });
    if (!out) return;
    try {
      await navigator.share({ files: [new File([out.blob], out.name, { type: out.blob.type })] });
    } catch {
      /* user cancelled */
    }
  };

  const copyLink = async () => {
    try {
      const url = `${window.location.origin}/#r=${encodeRecipe(recipeRef.current)}`;
      await navigator.clipboard.writeText(url);
      say("LINK COPIED — IT CARRIES THE LOOK, NOT THE PHOTO");
    } catch {
      say("COULDN'T COPY");
    }
  };

  // ←/→ steps through the options of the current tab.
  const step = useCallback(
    (dir: 1 | -1) => {
      const r = recipeRef.current;
      if (tab === "film") {
        const list = ["none", ...FILM_STOCKS.map((s) => s.id)];
        const i = list.indexOf(r.film);
        const id = list[(i + dir + list.length) % list.length];
        set({ film: id });
        const s = getStock(id);
        if (s) setFilmCat(s.category);
        say(s ? s.name : "NO FILM", 900);
      } else if (tab === "pixel") {
        const i = BLOCKS.indexOf(r.block);
        const b = BLOCKS[Math.max(0, Math.min(BLOCKS.length - 1, (i < 0 ? 0 : i) + dir))];
        set({ block: b });
        say(b === 1 ? "NO PIXELS" : `${b}PX`, 900);
      }
    },
    [tab, set, say]
  );

  // ─── Keyboard (all optional — nothing on screen depends on it) ────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOverlay((o) => (o === "palette" ? null : "palette"));
        return;
      }
      if (overlay) {
        if (e.key === "Escape") setOverlay(null);
        return;
      }
      if (viewRef.current === "home") {
        if (e.key === "Enter") enterApp({ x: innerWidth / 2, y: innerHeight / 2 });
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        quickSave();
        return;
      }
      if (mod) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          surprise();
          break;
        case "ArrowRight":
          e.preventDefault();
          step(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-1);
          break;
        case "\\":
          setHoldKey(true);
          break;
        case "1":
          setTab("film");
          break;
        case "2":
          setTab("pixel");
          break;
        case "3":
          setTab("more");
          break;
        case "f":
          if (recipeRef.current.film !== "none") toggleFavorite(recipeRef.current.film);
          break;
        case "o":
          openPicker();
          break;
        case "e":
          setOverlay("export");
          break;
        case "h":
          setHideUI((h) => !h);
          break;
        case "?":
          setOverlay("help");
          break;
        case "Escape":
          setHideUI(false);
          break;
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "\\") setHoldKey(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  });

  // ─── Drop anywhere / paste ───────────────────────────────────────────
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f && f.type.startsWith("image/")) void loadBlob(f, f.name);
    };
    const paste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) void loadBlob(f, f.name || "pasted.png");
          return;
        }
      }
      const text = e.clipboardData?.getData("text") ?? "";
      const m = text.match(/(?:#r=)?(1~[^\s]+)/);
      const r = m ? decodeRecipe(decodeURIComponent(m[1])) : null;
      if (r) {
        apply(r);
        say("RECIPE PASTED");
      }
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, [loadBlob, apply, say]);

  // ─── Command palette entries ─────────────────────────────────────────
  const commands = useMemo<Command[]>(() => {
    const c: Command[] = [
      { id: "save", label: "Save image", group: "ACTION", keys: "⌘S", run: quickSave },
      { id: "export", label: "Save options…", group: "ACTION", keys: "E", run: () => setOverlay("export") },
      { id: "open", label: "Open image…", group: "ACTION", keys: "O", run: openPicker },
      { id: "surprise", label: "Surprise me", group: "ACTION", keys: "SPACE", run: surprise },
      { id: "undo", label: "Undo", group: "ACTION", keys: "⌘Z", run: undo },
      { id: "redo", label: "Redo", group: "ACTION", keys: "⇧⌘Z", run: redo },
      { id: "link", label: "Copy recipe link", group: "ACTION", run: copyLink },
      { id: "reset", label: "Reset to original", group: "ACTION", run: () => apply({ ...DEFAULT_RECIPE, film: "none" }) },
      { id: "help", label: "Keyboard shortcuts", group: "ACTION", keys: "?", run: () => setOverlay("help") },
    ];
    for (const s of FILM_STOCKS) {
      c.push({
        id: "film:" + s.id,
        label: s.name,
        group: "FILM",
        hint: s.hint,
        run: () => {
          set({ film: s.id });
          setTab("film");
          setFilmCat(s.category);
        },
      });
    }
    for (const p of PALETTES) {
      c.push({ id: "pal:" + p.id, label: p.name, group: "COLOURS", hint: p.description, run: () => { set({ palette: p.id }); setTab("pixel"); } });
    }
    for (const d of DITHERS) {
      c.push({ id: "dt:" + d.id, label: d.name, group: "PATTERN", hint: d.hint, run: () => { set({ dither: d.id }); setTab("pixel"); } });
    }
    for (const b of BLOCKS) {
      c.push({ id: "px:" + b, label: b === 1 ? "No pixels" : `${b}px pixels`, group: "SIZE", run: () => { set({ block: b }); setTab("pixel"); } });
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [set, surprise, undo, redo, apply]);

  const epoch = `${source?.id ?? ""}|${texture?.id ?? ""}`;
  const crisp = isPixelArt(shown);

  const sound = (
    <VisualizeSection
      bare
      mode={vizMode}
      intensity={vizIntensity}
      bassBump={bassBump}
      onModeChange={setVizMode}
      onIntensityChange={setVizIntensity}
      onBassBumpChange={setBassBump}
    />
  );

  return (
    <div className={`app ${hideUI ? "app-bare" : ""}`}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void loadBlob(f, f.name);
          e.currentTarget.value = "";
        }}
      />

      <header className="bar">
        <button
          className="bar-logo"
          onClick={(e) => goHome(centerOf(e.currentTarget.getBoundingClientRect()))}
          title="Home"
        >
          PIXEL
        </button>
        <button className="bar-file" onClick={openPicker} title="Open another image (or drop / paste one anywhere)">
          <span className="truncate">{source?.filename ?? "…"}</span>
          <span className="bar-file-cta">CHANGE PHOTO</span>
        </button>
        <span className="flex-1" />
        <button className="bar-icon" onClick={undo} disabled={!past.current.length} title="Undo (⌘Z)" aria-label="Undo">↶</button>
        <button className="bar-icon bar-redo" onClick={redo} disabled={!future.current.length} title="Redo (⇧⌘Z)" aria-label="Redo">↷</button>
        <button
          className="bar-icon"
          onClick={toggleTheme}
          title={theme === "light" ? "Dark mode" : "Light mode"}
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {theme === "light" ? "☾" : "☀"}
        </button>
        <button className="bar-btn" onClick={surprise} title="Surprise me (Space)">
          <span aria-hidden>⚄</span> <span className="hidden sm:inline">SURPRISE</span>
        </button>
        <div className="bar-save">
          <button className="btn-primary" onClick={quickSave} disabled={!output || exporting} title="Save (⌘S)">
            {exporting ? "SAVING…" : "SAVE"}
          </button>
          <button className="btn-primary bar-save-more" onClick={() => setOverlay("export")} disabled={!output} title="Save options (E)" aria-label="Save options">
            ▾
          </button>
        </div>
      </header>

      <main className="stage">
        <Viewer output={output} original={original} crisp={crisp} holdKey={holdKey} busy={busy}>
          {hideUI && <div className="viewer-hint">H · SHOW CONTROLS</div>}
          {source?.filename === SAMPLE.filename && !hideUI && (
            <>
              <button
                className="egg"
                onClick={() => setCredit((c) => !c)}
                aria-expanded={credit}
                title="Who is this?"
              >
                ?
              </button>
              {credit && (
                <div className="egg-card" role="dialog" aria-label="About the test subject">
                  <p className="egg-lore">
                    Test subject: Chuck Norris. He approved all 63 looks. Nobody asked him to.
                  </p>
                  <a href={SAMPLE.source} target="_blank" rel="noopener">
                    {SAMPLE.credit}
                  </a>
                </div>
              )}
            </>
          )}
        </Viewer>

        <aside className="panel">
          <div key={tab} className="tab-anim contents-panel">
          <Now
            tab={tab}
            recipe={recipe}
            set={set}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            hasTexture={!!texture}
          />
          <Looks
            tab={tab}
            recipe={recipe}
            epoch={epoch}
            set={set}
            onPreview={setPreview}
            favorites={favorites}
            filmCat={filmCat}
            onFilmCat={setFilmCat}
            texture={texture}
            onTexture={loadTexture}
            onClearTexture={clearTexture}
            sound={sound}
          />
          </div>
          <Tabs tab={tab} onTab={setTab} />
          <footer className="panel-foot">
            <span>ON-DEVICE · NOTHING UPLOADED</span>
            <button onClick={() => setOverlay("help")} className="hover:text-lime" title="Keyboard shortcuts">
              ? KEYS
            </button>
          </footer>
        </aside>
      </main>

      {toast && <div className="toast" role="status">{toast}</div>}
      {dragging && (
        <div className="dropveil">
          <span className="font-display text-5xl text-lime">DROP TO OPEN</span>
        </div>
      )}

      {overlay === "export" && source && (
        <ExportPanel
          opts={exportOpts}
          onChange={(o) => {
            setExportOpts(o);
            lsSet("export", o);
          }}
          width={output?.width ?? source.width}
          height={output?.height ?? source.height}
          busy={exporting}
          canShare={canShare}
          onDownload={() => void save().then(() => setOverlay(null))}
          onShare={() => void share()}
          onCopyLink={() => void copyLink()}
          onClose={() => setOverlay(null)}
        />
      )}
      {view === "home" && (
        <Home
          photo={original}
          canContinue={ownPhoto}
          onOpen={(r) => {
            pendingEnter.current = centerOf(r);
            openPicker();
          }}
          onEnter={(r) => enterApp(centerOf(r))}
        />
      )}
      <PixelWipe ref={wipeRef} />
      {overlay === "palette" && <CommandPalette commands={commands} onClose={() => setOverlay(null)} />}
      {overlay === "help" && <HelpOverlay onClose={() => setOverlay(null)} />}
    </div>
  );
}
