import { PALETTES, type Palette } from "@/lib/palettes";

type Props = {
  selected: string;
  onSelect: (id: string) => void;
};

export function PaletteGrid({ selected, onSelect }: Props) {
  return (
    <div className="space-y-1">
      {PALETTES.map((p) => (
        <PaletteRow
          key={p.id}
          palette={p}
          selected={p.id === selected}
          onSelect={() => onSelect(p.id)}
        />
      ))}
    </div>
  );
}

function PaletteRow({
  palette,
  selected,
  onSelect,
}: {
  palette: Palette;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left border ${
        selected ? "border-lime" : "border-ink-400"
      } bg-ink-50 hover:bg-ink-200 transition-colors group`}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <span
          className={`text-[8px] w-3 h-3 inline-flex items-center justify-center ${
            selected ? "text-lime" : "text-ink-600"
          }`}
        >
          {selected ? "■" : "□"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] tracking-widest uppercase text-ink-900">
            {palette.name}
          </div>
          <div className="text-[9px] tracking-wider text-ink-700 truncate">
            {palette.description}
          </div>
        </div>
        <span className="text-[9px] tracking-widest text-ink-700 readout">
          {palette.colors.length === 0 ? "----" : String(palette.colors.length).padStart(2, "0")}
        </span>
      </div>
      {palette.colors.length > 0 && (
        <div className="flex h-3 border-t border-ink-400">
          {palette.colors.map((c, i) => (
            <div
              key={i}
              className="flex-1"
              style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }}
            />
          ))}
        </div>
      )}
    </button>
  );
}
