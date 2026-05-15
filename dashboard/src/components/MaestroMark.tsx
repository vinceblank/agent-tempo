/**
 * MaestroMark — the operator's identity mark. Italic serif `M`.
 *
 * Per audit rev 4 C2: distinct primitive from `BrandMark`. Both render
 * an "M" but mean different things — BrandMark is the brand wordmark
 * (agent-tempo + metronome); MaestroMark is the human operator's
 * personal mark, italic per audit C4 (italic discipline allows
 * italic only on `<em>` accents and the MaestroMark M).
 *
 * Source: `docs/design/dashboard-handoff/project/primitives.jsx:237-255`.
 * The original used Fraunces; post-PR-0 we use the global serif display
 * stack (`var(--ff-display)` = Instrument Serif).
 *
 * Used inside `.sidebar-maestro` (the identity row at the bottom of the
 * sidebar, above the connection-status footer).
 */
import type { CSSProperties } from 'react';

interface MaestroMarkProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

export function MaestroMark({
  size = 16,
  color = 'var(--bone, #F5EBDD)',
  style = {},
}: MaestroMarkProps) {
  return (
    <span
      className="maestro-mark"
      data-testid="maestro-mark"
      style={{
        fontFamily: 'var(--ff-display)',
        fontStyle: 'italic',
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1,
        color,
        display: 'inline-block',
        letterSpacing: '-0.02em',
        ...style,
      }}
    >
      M
    </span>
  );
}
