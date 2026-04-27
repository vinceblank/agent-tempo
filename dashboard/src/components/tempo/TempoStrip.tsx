/**
 * TempoStrip — sparkline of recent message activity with beat bars.
 * Ported from `primitives.jsx:101-144`. Recent activity (last 10 buckets)
 * highlights with the accent colour; older bars use a muted rule tone.
 *
 * Renders an animated pulse on the most recent bar when activity is
 * above zero. The pulse is suppressed under `prefers-reduced-motion`.
 */
import { useReducedMotion } from '../../lib/use-reduced-motion';

interface TempoStripProps {
  /** Per-bucket activity counts (typically messages/min, last N minutes). */
  series: number[];
  height?: number;
  bpm?: number;
}

export function TempoStrip({ series, height = 44, bpm = 92 }: TempoStripProps) {
  const reduceMotion = useReducedMotion();
  const max = Math.max(...series, 1);
  const w = 4;
  const gap = 2;
  const total = Math.max(series.length, 1) * (w + gap);
  const lastBarActive = series.length > 0 && series[series.length - 1] > 0;
  return (
    <div
      data-testid="tempo-strip"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        height,
        minWidth: 120,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: 'var(--density-fs-sm)',
        }}
      >
        <span className="mono dim">tempo</span>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
          <span className="mono num" data-testid="tempo-strip-bpm">{bpm}</span>
          <span className="mono dim">bpm</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${total} ${height - 16}`}
        width="100%"
        height={height - 16}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {series.map((_, i) =>
          i % 10 === 0 ? (
            <line
              key={`g${i}`}
              x1={i * (w + gap)}
              x2={i * (w + gap)}
              y1={0}
              y2={height - 16}
              stroke="var(--rule)"
              strokeDasharray="2 3"
            />
          ) : null,
        )}
        {series.map((v, i) => {
          const h = (v / max) * (height - 24);
          const x = i * (w + gap);
          const y = (height - 16) - h - 2;
          const recent = i > series.length - 10;
          const isLast = i === series.length - 1;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={w}
              height={Math.max(1.5, h)}
              rx={1}
              fill={recent ? 'var(--accent)' : 'var(--rule-strong)'}
              opacity={recent ? 1 : 0.75}
              style={
                isLast && lastBarActive && !reduceMotion
                  ? { animation: 'tempo-strip-pulse 0.9s ease-in-out infinite' }
                  : undefined
              }
            />
          );
        })}
      </svg>
    </div>
  );
}
