/**
 * SectionHead — `kicker + title` pattern used inside panels and pages.
 *
 * Audit rev 4 C4 (italic discipline): the title is serif display
 * NON-italic. Italics inside the title body are reserved for `<em>`
 * accents on a single accent word; never italicize the entire title.
 *
 * Source: `docs/design/dashboard-handoff/project/primitives.jsx:147-157`
 * + components.css `.section-head*`.
 */
import type { ReactNode } from 'react';

interface SectionHeadProps {
  /** Mono uppercase label rendered above the title (e.g. "I / RUNNING"). */
  kicker?: ReactNode;
  /** Display-serif title text. Wrap accent words in `<em>` for italics. */
  title: ReactNode;
  /** Optional right-side slot (e.g. action buttons, meta text). */
  right?: ReactNode;
  /** Compact variant — reduces bottom margin for tighter stacks. */
  tight?: boolean;
}

export function SectionHead({ kicker, title, right, tight = false }: SectionHeadProps) {
  return (
    <div className={`section-head${tight ? ' is-tight' : ''}`}>
      <div>
        {kicker && <div className="section-kicker mono">{kicker}</div>}
        <div className="section-title">{title}</div>
      </div>
      {right && <div className="section-head-right">{right}</div>}
    </div>
  );
}
