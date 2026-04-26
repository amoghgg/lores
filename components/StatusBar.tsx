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
    <footer className="border-t border-ink-400 bg-ink-50 px-3 sm:px-4 py-2 text-[10px] tracking-widest uppercase text-ink-700 flex items-center gap-2 sm:gap-3 overflow-x-auto whitespace-nowrap">
      {/* FILE — desktop only (mobile shows it in source chips) */}
      <Cell label="FILE" hideOnMobile>
        {filename ? truncate(filename, 28) : <em className="not-italic text-ink-600">—</em>}
      </Cell>
      <Sep hideOnMobile />
      <Cell label="DIMS" hideOnMobile>
        {width && height ? `${width}×${height}` : "—"}
      </Cell>
      <Sep hideOnMobile />
      <Cell label="PIX">{String(blockSize).padStart(3, "0")}</Cell>
      <Sep />
      <Cell label="PAL">{paletteName}</Cell>
      <Sep hideOnMobile />
      <Cell label="OUT" hideOnMobile>{outScale}×</Cell>
      <Sep />
      <Cell label="DT">{ms === null ? "—" : `${ms.toFixed(0)}ms`}</Cell>
      <div className="flex-1" />
      <span className="text-lime animate-blink flex-shrink-0">●</span>
      <span className="text-ink-700 flex-shrink-0">READY</span>
    </footer>
  );
}

function Cell({
  label,
  children,
  hideOnMobile,
}: {
  label: string;
  children: React.ReactNode;
  hideOnMobile?: boolean;
}) {
  return (
    <span
      className={`flex items-center gap-2 flex-shrink-0 ${
        hideOnMobile ? "hidden md:flex" : ""
      }`}
    >
      <span className="text-ink-600">{label}</span>
      <span className="text-ink-900">{children}</span>
    </span>
  );
}

function Sep({ hideOnMobile }: { hideOnMobile?: boolean }) {
  return (
    <span className={`text-ink-500 flex-shrink-0 ${hideOnMobile ? "hidden md:inline" : ""}`}>
      │
    </span>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? "…" + s.slice(-n + 1) : s;
}
