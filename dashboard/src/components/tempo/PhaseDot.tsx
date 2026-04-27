/**
 * PhaseDot — colored attachment-phase indicator. Ported from the
 * canonical handoff bundle's `primitives.jsx:44-52`.
 *
 * Active phases (`processing`) pulse; the pulse is suppressed when
 * `prefers-reduced-motion: reduce` is set.
 */
import { specForPhase } from '../../lib/tempo-helpers';
import { useReducedMotion } from '../../lib/use-reduced-motion';

interface PhaseDotProps {
  phase: string | undefined;
  playerId: string;
  showLabel?: boolean;
}

export function PhaseDot({ phase, playerId, showLabel = false }: PhaseDotProps) {
  const spec = specForPhase(phase);
  const reduceMotion = useReducedMotion();
  const animate = !!spec.pulse && !reduceMotion;
  return (
    <span
      data-testid={`phase-dot-${playerId}`}
      data-phase={phase ?? 'unknown'}
      data-bucket={spec.bucket}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: spec.color,
        fontFamily: 'var(--ff-ui)',
        fontSize: 'var(--density-fs-sm)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontSize: 11,
          lineHeight: 1,
          animation: animate ? 'phase-dot-pulse 1.4s ease-in-out infinite' : 'none',
        }}
      >
        {spec.icon}
      </span>
      {showLabel && <span className="dim">{spec.label}</span>}
    </span>
  );
}
