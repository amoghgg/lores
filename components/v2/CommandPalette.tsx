"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type Command = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keys?: string;
  run: () => void;
};

/** Subsequence fuzzy score; higher is better, -1 = no match. */
function score(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - t.length * 0.1;
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    s += 10 + run * 5 - (found - ti);
    ti = found + 1;
  }
  return s;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return commands
      .map((c) => ({ c, s: score(qq, `${c.label} ${c.group} ${c.hint ?? ""}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.c);
  }, [q, commands]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <div className="overlay overlay-dim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={input}
          className="palette-input"
          placeholder="Search looks, palettes, dithers, actions…  (try “kodachrome”, “export”, “1~px:8~pal:gb”)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            }
            if (e.key === "Enter") run(results[sel]);
          }}
        />
        <div ref={list} className="palette-list">
          {results.length === 0 && <div className="palette-empty">No match.</div>}
          {results.map((c, i) => (
            <button
              key={c.id}
              data-i={i}
              className={`palette-item ${i === sel ? "palette-sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(c)}
            >
              <span className="palette-group">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
              {c.keys && <kbd className="kbd ml-auto">{c.keys}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
