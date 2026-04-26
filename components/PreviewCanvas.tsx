"use client";

import { useEffect, useRef } from "react";

type Props = {
  canvas: HTMLCanvasElement | null;
};

export function PreviewCanvas({ canvas }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canvas) return;
    container.replaceChildren(canvas);
    canvas.className = "max-h-full max-w-full pixelated";
    canvas.style.imageRendering = "pixelated";
    canvas.style.objectFit = "contain";
  }, [canvas]);

  return (
    <div className="relative h-full w-full checker overflow-hidden">
      <div
        ref={containerRef}
        className="absolute inset-0 flex items-center justify-center p-8"
      />

      {/* Frame brackets — same camera viewfinder treatment */}
      <FrameBracket position="tl" />
      <FrameBracket position="tr" />
      <FrameBracket position="bl" />
      <FrameBracket position="br" />
    </div>
  );
}

function FrameBracket({
  position,
}: {
  position: "tl" | "tr" | "bl" | "br";
}) {
  const positions: Record<typeof position, string> = {
    tl: "top-3 left-3",
    tr: "top-3 right-3",
    bl: "bottom-3 left-3",
    br: "bottom-3 right-3",
  };
  const rotations: Record<typeof position, string> = {
    tl: "rotate(0deg)",
    tr: "rotate(90deg)",
    br: "rotate(180deg)",
    bl: "rotate(270deg)",
  };
  return (
    <div className={`absolute ${positions[position]} text-ink-600 pointer-events-none`}>
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        style={{ transform: rotations[position] }}
      >
        <path
          d="M2 12V2H12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
        />
      </svg>
    </div>
  );
}
