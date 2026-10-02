"use client";

import { FRAMES, type ExportOptions } from "@/lib/exporter";

type Props = {
  opts: ExportOptions;
  onChange: (o: ExportOptions) => void;
  width: number;
  height: number;
  busy: boolean;
  canShare: boolean;
  onDownload: () => void;
  onShare: () => void;
  onCopyLink: () => void;
  onClose: () => void;
};

const MATTES = [
  { id: "#0a0a0a", name: "INK" },
  { id: "#f4f1ea", name: "PAPER" },
  { id: "#ffffff", name: "WHITE" },
];

export function ExportPanel({ opts, onChange, width, height, busy, canShare, onDownload, onShare, onCopyLink, onClose }: Props) {
  const f = FRAMES.find((x) => x.id === opts.frame)!;
  const outW = f.id === "none" ? width * opts.scale : f.w;
  const outH = f.id === "none" ? height * opts.scale : f.h;
  const set = (p: Partial<ExportOptions>) => onChange({ ...opts, ...p });
  return (
    <div className="overlay overlay-dim" onMouseDown={onClose}>
      <div className="export" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Save options">
        <div className="flex items-baseline justify-between">
          <span className="font-display text-2xl text-lime leading-none">SAVE</span>
          <button className="btn-ghost" onClick={onClose}>ESC ×</button>
        </div>

        <Row label="FRAME">
          {FRAMES.map((x) => (
            <Chip key={x.id} on={opts.frame === x.id} onClick={() => set({ frame: x.id })}>{x.name}</Chip>
          ))}
        </Row>
        {opts.frame === "none" ? (
          <Row label="SCALE">
            {[1, 2, 4, 8].map((s) => (
              <Chip key={s} on={opts.scale === s} onClick={() => set({ scale: s })}>{s}×</Chip>
            ))}
          </Row>
        ) : (
          <Row label="MATTE">
            {MATTES.map((m) => (
              <Chip key={m.id} on={opts.matte === m.id} onClick={() => set({ matte: m.id })}>
                <span className="inline-block w-2 h-2 mr-1 border border-ink-600" style={{ background: m.id }} />
                {m.name}
              </Chip>
            ))}
          </Row>
        )}
        <Row label="FORMAT">
          <Chip on={opts.format === "png"} onClick={() => set({ format: "png" })}>PNG + RECIPE</Chip>
          <Chip on={opts.format === "jpeg"} onClick={() => set({ format: "jpeg" })}>JPEG</Chip>
        </Row>
        <div className="flex justify-between text-[10px] tracking-widest text-ink-700 pt-1">
          <span>OUT</span>
          <span className="text-ink-900 tabular-nums">{outW.toLocaleString()} × {outH.toLocaleString()} PX</span>
        </div>
        {opts.format === "png" && (
          <p className="text-[10px] text-ink-700 leading-snug normal-case tracking-normal">
            The recipe rides inside the PNG. Drop the file back into lores — anyone&apos;s copy — and the look comes with it.
          </p>
        )}

        <div className="flex gap-1 pt-1">
          <button className="btn-primary flex-1" disabled={busy} onClick={onDownload}>
            {busy ? "SAVING…" : "SAVE IMAGE"}
          </button>
          {canShare && (
            <button className="btn-ghost" disabled={busy} onClick={onShare}>SHARE</button>
          )}
        </div>
        <button className="btn-ghost w-full" onClick={onCopyLink}>COPY RECIPE LINK</button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[9px] tracking-widest text-ink-700">{label}</div>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={`tab ${on ? "tab-on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}
