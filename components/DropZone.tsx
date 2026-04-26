"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  onFile: (file: File) => void;
};

export function DropZone({ onFile }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file.type.startsWith("image/")) return;
      onFile(file);
    },
    [onFile]
  );

  // Paste from clipboard support
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) onFile(file);
          break;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onFile]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={`relative h-full w-full cursor-pointer flex items-center justify-center checker transition-colors ${
        dragOver ? "drag-active" : ""
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />

      {/* Camera viewfinder corner brackets */}
      <CornerBracket position="tl" active={dragOver} />
      <CornerBracket position="tr" active={dragOver} />
      <CornerBracket position="bl" active={dragOver} />
      <CornerBracket position="br" active={dragOver} />

      {/* Crosshair center */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
        <div
          className={`flex flex-col items-center gap-3 ${
            dragOver ? "text-lime" : "text-ink-700"
          }`}
        >
          <CrosshairIcon className="w-8 h-8" />
          <div className="font-display text-3xl tracking-wider leading-none">
            {dragOver ? "RELEASE" : "DROP IMAGE"}
          </div>
          <div className="text-[10px] tracking-widest uppercase text-ink-700 flex items-center gap-2">
            <span>OR PASTE</span>
            <span className="text-ink-600">·</span>
            <span>OR CLICK</span>
          </div>
          <div className="text-[10px] tracking-wider text-ink-600 mt-2 text-center">
            JPG · PNG · WEBP · GIF
          </div>
        </div>
      </div>

      {/* Coordinate marks on each edge — pure decoration */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[9px] tracking-widest text-ink-600 pointer-events-none">
        N
      </div>
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[9px] tracking-widest text-ink-600 pointer-events-none">
        S
      </div>
      <div className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] tracking-widest text-ink-600 pointer-events-none">
        W
      </div>
      <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] tracking-widest text-ink-600 pointer-events-none">
        E
      </div>
    </div>
  );
}

function CornerBracket({
  position,
  active,
}: {
  position: "tl" | "tr" | "bl" | "br";
  active: boolean;
}) {
  const cls = active ? "text-lime" : "text-ink-600";
  const positions: Record<typeof position, string> = {
    tl: "top-3 left-3",
    tr: "top-3 right-3",
    bl: "bottom-3 left-3",
    br: "bottom-3 right-3",
  };
  return (
    <div className={`corner absolute ${positions[position]} ${cls} pointer-events-none`}>
      <CornerSvg position={position} />
    </div>
  );
}

function CornerSvg({ position }: { position: "tl" | "tr" | "bl" | "br" }) {
  const rotations: Record<typeof position, string> = {
    tl: "rotate(0deg)",
    tr: "rotate(90deg)",
    br: "rotate(180deg)",
    bl: "rotate(270deg)",
  };
  return (
    <svg
      width="24"
      height="24"
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
  );
}

function CrosshairIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <circle cx="16" cy="16" r="10" />
      <line x1="16" y1="2" x2="16" y2="8" />
      <line x1="16" y1="24" x2="16" y2="30" />
      <line x1="2" y1="16" x2="8" y2="16" />
      <line x1="24" y1="16" x2="30" y2="16" />
      <circle cx="16" cy="16" r="1.5" fill="currentColor" />
    </svg>
  );
}
