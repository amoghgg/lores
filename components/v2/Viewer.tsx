"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  output: HTMLCanvasElement | null;
  original: HTMLCanvasElement | null;
  /** Nearest-neighbour display for pixel art; smooth for photo looks. */
  crisp: boolean;
  /** Keyboard hold (\) — shows the original. */
  holdKey: boolean;
  busy: boolean;
  children?: React.ReactNode;
};

/** The photo. Press and hold anywhere on it to see the original. */
export function Viewer({ output, original, crisp, holdKey, busy, children }: Props) {
  const outRef = useRef<HTMLDivElement>(null);
  const origRef = useRef<HTMLDivElement>(null);
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    const h = outRef.current;
    if (!h || !output) return;
    if (h.firstChild !== output) h.replaceChildren(output);
    output.className = "viewer-canvas";
  }, [output]);

  useEffect(() => {
    const h = origRef.current;
    if (!h || !original) return;
    if (h.firstChild !== original) h.replaceChildren(original);
    original.className = "viewer-canvas";
  }, [original]);

  const showOriginal = holding || holdKey;

  return (
    <div
      className={`viewer ${crisp ? "viewer-crisp" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || !output) return;
        if ((e.target as HTMLElement).closest("button,a,input")) return;
        setHolding(true);
      }}
      onPointerUp={() => setHolding(false)}
      onPointerLeave={() => setHolding(false)}
      onPointerCancel={() => setHolding(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="viewer-stack">
        <div ref={origRef} className="viewer-layer" style={{ visibility: showOriginal ? "visible" : "hidden" }} />
        <div ref={outRef} className="viewer-layer" style={{ visibility: showOriginal ? "hidden" : "visible" }} />
      </div>
      {showOriginal && <div className="viewer-badge">ORIGINAL</div>}
      {busy && <div className="viewer-busy" aria-label="Rendering" />}
      {children}
    </div>
  );
}
