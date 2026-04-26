type Props = {
  value: number; // 0..1
  onChange: (v: number) => void;
};

/**
 * 0..1 amount slider rendered as 0..100%. Used under each filter section
 * to blend the processed output back toward the source.
 */
export function AmountSlider({ value, onChange }: Props) {
  const pct = Math.round(value * 100);
  return (
    <div className="mt-3 space-y-1">
      <div className="flex items-center justify-between text-[9px] tracking-widest uppercase">
        <span className="text-ink-700">AMOUNT</span>
        <span className="readout text-[9px]">[ {String(pct).padStart(3, "0")}% ]</span>
      </div>
      <input
        type="range"
        className="chunky"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <div className="flex items-center justify-between text-[9px] tracking-widest text-ink-700">
        <span>OFF</span>
        <span>FULL</span>
      </div>
    </div>
  );
}
