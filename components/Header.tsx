export function Header({ buildDate }: { buildDate: string }) {
  return (
    <header className="border-b border-ink-400 bg-ink-50 px-6 py-3 flex items-center justify-between text-[11px] tracking-widest uppercase">
      <div className="flex items-center gap-4">
        <span className="font-display text-2xl leading-none text-lime tracking-normal text-shadow-glow">
          LORES
        </span>
        <span className="text-ink-700">//</span>
        <span className="text-ink-800">PIXEL ART OPERATOR</span>
        <span className="hidden sm:inline text-ink-700">//</span>
        <span className="hidden sm:inline text-ink-700">BUILD {buildDate}</span>
      </div>
      <div className="flex items-center gap-4 text-ink-700">
        <a
          href="https://github.com/amoghgg/lores"
          target="_blank"
          rel="noopener"
          className="hover:text-lime transition-colors"
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
