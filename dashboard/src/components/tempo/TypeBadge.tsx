/**
 * TypeBadge — small chip rendering a player type (`tempo-soloist`,
 * `tempo-conductor`, etc.) coloured by `hueForType`. Ported from
 * `primitives.jsx:83-98`.
 */
import { hueForType } from '../../lib/tempo-helpers';

interface TypeBadgeProps {
  type: string;
}

export function TypeBadge({ type }: TypeBadgeProps) {
  const hue = hueForType(type);
  return (
    <span
      data-testid={`type-badge-${type}`}
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        fontFamily: 'var(--ff-mono)',
        fontSize: 11,
        letterSpacing: '0.02em',
        borderRadius: 4,
        color: `oklch(0.82 0.11 ${hue})`,
        border: `1px solid oklch(0.38 0.07 ${hue})`,
        background: `oklch(0.2 0.035 ${hue} / 0.5)`,
      }}
    >
      {type}
    </span>
  );
}
