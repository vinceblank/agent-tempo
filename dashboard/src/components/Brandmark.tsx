/**
 * Brandmark — the smallest tempo motif: a static metronome glyph + the
 * `claude-tempo` wordmark. Ported from the canonical handoff bundle's
 * `primitives.jsx:30-41`.
 *
 * PR-2 ships a STATIC metronome (no animation, no `bpm` prop) so the
 * scaffold stays minimal. The animated `<Metronome>` primitive (and its
 * `--bpm-dur` CSS-variable plumbing) lands in PR-4 alongside the rest
 * of `src/components/tempo/`.
 */
import type { CSSProperties } from 'react';

interface BrandmarkProps {
  size?: 'sm' | 'md' | 'lg';
}

export function Brandmark({ size = 'md' }: BrandmarkProps) {
  const iconSize = size === 'lg' ? 40 : size === 'sm' ? 20 : 28;
  const fontSize = size === 'lg' ? 26 : size === 'sm' ? 13 : 17;
  const wordStyle: CSSProperties = {
    fontFamily: 'var(--ff-mono)',
    fontWeight: 600,
    letterSpacing: '-0.02em',
    fontSize,
  };
  return (
    <span
      className={`brandmark brandmark-${size}`}
      data-testid="brandmark"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--text)' }}
    >
      <svg
        viewBox="0 0 64 64"
        width={iconSize}
        height={iconSize}
        fill="none"
        aria-hidden="true"
        data-testid-exempt="decorative-glyph"
      >
        <path
          d="M32 8 L14 54 L50 54 Z"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinejoin="round"
        />
        <line x1={32} y1={46} x2={32} y2={14} stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" />
        <circle cx={32} cy={46} r={3} fill="var(--accent)" />
      </svg>
      <span style={wordStyle}>
        claude<span style={{ color: 'var(--dim)' }}>-</span>tempo
      </span>
    </span>
  );
}
