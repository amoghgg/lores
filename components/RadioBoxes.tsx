type Option<V extends string> = {
  value: V;
  label: string;
  hint?: string;
};

type Props<V extends string> = {
  value: V;
  options: Option<V>[];
  onChange: (v: V) => void;
  /** Grid column count. Defaults to 2. */
  cols?: 2 | 3;
};

export function RadioBoxes<V extends string>({
  value,
  options,
  onChange,
  cols = 2,
}: Props<V>) {
  const gridClass = cols === 3 ? "grid-cols-3" : "grid-cols-2";
  return (
    <div className={`grid ${gridClass} gap-1`}>
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`text-left px-3 py-2 border transition-colors ${
              selected
                ? "border-lime bg-ink-200 text-ink-900"
                : "border-ink-400 bg-ink-50 text-ink-700 hover:text-ink-900 hover:bg-ink-200"
            }`}
          >
            <div className="text-[10px] tracking-widest uppercase font-medium flex items-center gap-2">
              <span className={selected ? "text-lime" : "text-ink-600"}>
                {selected ? "■" : "□"}
              </span>
              {opt.label}
            </div>
            {opt.hint && (
              <div className="text-[9px] tracking-wider text-ink-700 mt-1">
                {opt.hint}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
