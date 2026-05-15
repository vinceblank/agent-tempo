/**
 * BrandMark — the metronome motif + `agent-tempo` mono wordmark.
 *
 * Per audit rev 4 C1: the brand identity is the metronome icon (triangle
 * shell with terracotta pendulum) paired with the lowercase `agent-tempo`
 * wordmark, terracotta hyphen between the two halves. Distinct from
 * `MaestroMark` (the operator's italic-M identity, see C2).
 *
 * Animation: pendulum swings at one period per beat — `animation-duration`
 * is `60 / bpm` seconds, plumbed via the `--bpm-dur` CSS variable. Set
 * `running={false}` to freeze (used when the ensemble is paused). When the
 * user prefers reduced motion, the running pendulum is suppressed at
 * the React layer so the `<span>` carries `is-running` only when both
 * `running` and motion preference allow it.
 *
 * Source: `docs/design/dashboard-handoff/project/primitives.jsx:6-26`
 * (BrandMark + Metronome) + components.css `.brandmark*` / `.tempo-metronome*`.
 */
import type { CSSProperties } from 'react';
import { useReducedMotion } from '../lib/use-reduced-motion';

interface BrandmarkProps {
  size?: 'sm' | 'md' | 'lg';
  /** Beats per minute. Drives the pendulum's animation period. */
  bpm?: number;
  /** When false, freezes the pendulum (e.g. paused ensemble). */
  running?: boolean;
}

const ICON_SIZES: Record<NonNullable<BrandmarkProps['size']>, number> = {
  sm: 20,
  md: 28,
  lg: 40,
};

const FONT_SIZES: Record<NonNullable<BrandmarkProps['size']>, number> = {
  sm: 13,
  md: 17,
  lg: 26,
};

export function Brandmark({ size = 'md', bpm = 92, running = true }: BrandmarkProps) {
  const iconSize = ICON_SIZES[size];
  const fontSize = FONT_SIZES[size];
  const reduceMotion = useReducedMotion();
  const animate = running && !reduceMotion;
  // Period of one beat in seconds. Floor at 20 bpm so a stalled feed
  // can't divide-by-zero or produce a comically slow swing.
  const dur = 60 / Math.max(20, bpm);

  // `--bpm-dur` is consumed by the `.pendulum` rule in components.css.
  // The size prop is plumbed through inline `style` because the SVG
  // viewBox and wordmark font-size are runtime-computed.
  const rootStyle: CSSProperties = {
    ['--bpm-dur' as string]: `${dur}s`,
    width: undefined, // metronome span sizes itself via inline width
    height: undefined,
  };

  return (
    <span
      className={`brandmark brandmark-${size}`}
      data-testid="brandmark"
      data-running={animate || undefined}
      style={rootStyle}
    >
      <span
        className={`tempo-metronome${animate ? ' is-running' : ''}`}
        aria-label="metronome"
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
          <g className="pendulum">
            <line x1={32} y1={46} x2={32} y2={14} stroke="var(--accent)" strokeWidth={3} strokeLinecap="round" />
            <circle cx={32} cy={46} r={3} fill="var(--accent)" />
          </g>
        </svg>
      </span>
      <span className="brandmark-word" style={{ fontSize }}>
        claude<span className="brandmark-dash">-</span>tempo
      </span>
    </span>
  );
}
