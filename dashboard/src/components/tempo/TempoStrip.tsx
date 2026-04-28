/**
 * TempoStrip — sparkline of recent message activity with a BPM overlay
 * (PR-A2 of #389, rev 4 C6).
 *
 * Ports the canonical handoff primitive (`primitives.jsx:101-144` +
 * `web-design-system.html` ".tempo-strip · 60 bars · 92 bpm" block) so
 * the rendered dashboard matches the design bundle byte-for-byte:
 *
 *   - `.tempo-strip` wrapper with absolute-positioned `.tempo-strip-label`
 *     and an SVG below — color tokens, padding, label typography all live
 *     in `components.css`.
 *   - 60 buckets typical (caller decides; the component just renders
 *     whatever array it receives).
 *   - Last 10 bars render in `var(--accent)`; older bars render in
 *     `var(--rule-strong)` at 0.75 opacity.
 *   - Every 10th column gets a dashed `var(--rule)` ruler line.
 *   - The most-recent bar pulses via `tempo-strip-pulse` keyframes when
 *     activity > 0; the pulse is suppressed under
 *     `prefers-reduced-motion: reduce`.
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
      className="tempo-strip"
      data-testid="tempo-strip"
      style={{ height }}
    >
      <div className="tempo-strip-label">
        <span className="mono dim">tempo</span>
        <span className="tempo-bpm">
          <span className="mono num" data-testid="tempo-strip-bpm">{bpm}</span>
          <span className="mono dim">bpm</span>
        </span>
      </div>
      <svg
        className="tempo-strip-svg"
        viewBox={`0 0 ${total} ${height}`}
        width="100%"
        height={height}
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
              y2={height}
              stroke="var(--rule)"
              strokeDasharray="2 3"
            />
          ) : null,
        )}
        {series.map((v, i) => {
          const h = (v / max) * (height - 8);
          const x = i * (w + gap);
          const y = height - h - 2;
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
