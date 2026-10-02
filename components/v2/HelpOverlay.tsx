"use client";

const KEYS: [string, string][] = [
  ["HOLD PHOTO  ·  \\", "See the original"],
  ["← →", "Previous / next look"],
  ["SPACE", "Surprise me"],
  ["1  2  3", "Film · Pixel · More"],
  ["F", "Save the current film to ★"],
  ["⌘Z  ⇧⌘Z", "Undo / redo"],
  ["⌘S", "Save image"],
  ["E", "Save options"],
  ["O", "Open a photo (or drop / paste anywhere)"],
  ["⌘K", "Search every look and action"],
  ["H", "Hide the controls"],
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay overlay-dim" onMouseDown={onClose}>
      <div className="export max-w-lg" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard">
        <div className="flex items-baseline justify-between">
          <span className="font-display text-2xl text-lime leading-none">KEYS</span>
          <button className="btn-ghost" onClick={onClose}>ESC ×</button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
          {KEYS.map(([k, d]) => (
            <div key={k} className="contents">
              <kbd className="kbd justify-self-start">{k}</kbd>
              <span className="text-ink-800 normal-case tracking-normal">{d}</span>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-ink-700 normal-case tracking-normal leading-snug">
          Everything runs on your GPU, in this tab. No upload, no account, no watermark. The URL is the recipe — copy it to share the look, never the photo.
        </p>
      </div>
    </div>
  );
}
