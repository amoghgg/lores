type Props = {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  label?: string;
  format?: (n: number) => string;
};

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format,
}: Props) {
  const display = format ? format(value) : String(value).padStart(3, "0");
  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center justify-between text-[10px] tracking-widest uppercase">
          <span className="text-ink-700">{label}</span>
          <span className="readout font-medium">[ {display} ]</span>
        </div>
      )}
      <input
        type="range"
        className="chunky"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="flex items-center justify-between text-[9px] tracking-widest text-ink-700">
        <span>{String(min).padStart(3, "0")}</span>
        <span>{String(max).padStart(3, "0")}</span>
      </div>
    </div>
  );
}
