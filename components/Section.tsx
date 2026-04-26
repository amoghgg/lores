import type { ReactNode } from "react";

type Props = {
  index: string;
  title: string;
  badge?: string;
  children: ReactNode;
};

export function Section({ index, title, badge, children }: Props) {
  return (
    <section className="border-t border-ink-400 first:border-t-0">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-3 text-[10px] tracking-widest uppercase">
          <span className="text-ink-700">{index}</span>
          <span className="text-ink-700">/</span>
          <span className="text-ink-900">{title}</span>
        </div>
        {badge && (
          <span className="text-[9px] tracking-widest text-ink-700 readout">
            {badge}
          </span>
        )}
      </header>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}
