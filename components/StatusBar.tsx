type Props = {
  filename: string | null;
  width: number | null;
  height: number | null;
  paletteName: string;
  blockSize: number;
  ms: number | null;
  outScale: number;
};

export function StatusBar({
  filename,
  width,
  height,
  paletteName,
  blockSize,
  ms,
  outScale,
}: Props) {
  return (
    <footer className="border-t border-ink-400 bg-ink-50 px-4 py-2 text-[10px] tracking-widest uppercase text-ink-700 flex items-center gap-3 overflow-x-auto whitespace-nowrap">
      <Cell label="FILE">
        {filename ? truncate(filename, 28) : <em className="not-italic text-ink-600">—</em>}
      </Cell>
      <Sep />
      <Cell label="DIMS">
        {width && height ? `${width}×${height}` : "—"}
      </Cell>
      <Sep />
      <Cell label="PIX">{String(blockSize).padStart(3, "0")}</Cell>
      <Sep />
      <Cell label="PAL">{paletteName}</Cell>
      <Sep />
      <Cell label="OUT">{outScale}×</Cell>
      <Sep />
      <Cell label="DT">{ms === null ? "—" : `${ms.toFixed(0)}ms`}</Cell>
      <div className="flex-1" />
      <span className="text-lime animate-blink">●</span>
      <span className="text-ink-700">READY</span>
    </footer>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-ink-600">{label}</span>
      <span className="text-ink-900">{children}</span>
    </span>
  );
}

function Sep() {
  return <span className="text-ink-500">│</span>;
}

function truncate(s: string, n: number) {
  return s.length > n ? "…" + s.slice(-n + 1) : s;
}
