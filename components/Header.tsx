export function Header({ buildDate }: { buildDate: string }) {
  return (
    <header className="border-b border-ink-400 bg-ink-50 px-4 sm:px-6 py-3 flex items-center justify-between text-[11px] tracking-widest uppercase gap-3">
      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
        <span className="font-display text-2xl leading-none text-lime tracking-normal text-shadow-glow flex-shrink-0">
          LORES
        </span>
        <span className="hidden sm:inline text-ink-700">//</span>
        <span className="hidden sm:inline text-ink-800 truncate">
          PIXEL ART OPERATOR
        </span>
        <span className="hidden md:inline text-ink-700">//</span>
        <span className="hidden md:inline text-ink-700">
          BUILD {buildDate}
        </span>
        <span className="sm:hidden text-[9px] tracking-widest text-ink-700 readout">
          v0.1
        </span>
      </div>
      <div className="flex items-center gap-3 sm:gap-4 text-ink-700 flex-shrink-0">
        <a
          href="https://github.com/amoghgg/lores"
          target="_blank"
          rel="noopener"
          className="hover:text-lime active:text-lime transition-colors"
        >
          [ SOURCE ]
        </a>
        <a
          href="https://amoghbajpai.com"
          target="_blank"
          rel="noopener"
          className="hidden sm:inline hover:text-lime transition-colors"
        >
          [ AMOGH ]
        </a>
      </div>
    </header>
  );
}
