"use client";

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  /** Double-click the label to restore this value. */
  reset?: number;
  onChange: (v: number) => void;
  /** Fires on release — one undo step per drag. */
  onCommit: (v: number) => void;
};

export function Range({ label, value, min, max, step = 1, format, reset, onChange, onCommit }: Props) {
  const t = (value - min) / (max - min || 1);
  return (
    <label className="range">
      <span
        className="range-label"
        onDoubleClick={() => reset !== undefined && onCommit(reset)}
        title={reset !== undefined ? "Double-click to reset" : undefined}
      >
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ["--t" as string]: `${t * 100}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span className="range-value">{format ? format(value) : value}</span>
    </label>
  );
}
