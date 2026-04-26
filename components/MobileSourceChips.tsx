type Props = {
  filename: string;
  width: number;
  height: number;
  onClear: () => void;
};

export function MobileSourceChips({ filename, width, height, onClear }: Props) {
  return (
    <div className="lg:hidden flex items-center gap-2 px-3 py-2 border-b border-ink-400 bg-ink-50 overflow-x-auto whitespace-nowrap text-[9px] tracking-widest uppercase">
      <Chip label="FILE">
        <span className="font-mono normal-case">{truncate(filename, 18)}</span>
      </Chip>
      <Chip label="DIMS">
        {width}×{height}
      </Chip>
      <Chip label="MP">
        {((width * height) / 1_000_000).toFixed(2)}
      </Chip>
      <button
        onClick={onClear}
        className="ml-auto px-2 py-1 border border-ink-400 text-ink-700 hover:border-lime hover:text-lime active:bg-ink-200 transition-colors flex-shrink-0"
      >
        [ CLEAR ]
      </button>
    </div>
  );
}

function Chip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 px-2 py-1 border border-ink-400 bg-ink-50 flex-shrink-0">
      <span className="text-ink-700">{label}</span>
      <span className="text-lime tabular-nums">{children}</span>
    </span>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? "…" + s.slice(-n + 1) : s;
}
