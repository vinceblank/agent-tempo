/**
 * TempoStrip — sparkline of recent message activity with a BPM overlay.
 *
 * Ports the canonical handoff primitive (`primitives.jsx:101-144` +
 * `web-design-system.html` ".tempo-strip · 60 bars · 92 bpm" block) so
 * the rendered dashboard matches the design bundle byte-for-byte:
 *
 *   - `.tempo-strip` wrapper with absolute-positioned `.tempo-strip-label`
 *     and an SVG below — color tokens, padding, label typography all live
 *     in `components.css`.
 *   - Always renders {@link TARGET_BARS} bars. Shorter series left-pad
 *     with zeros so a fresh ensemble still draws the canonical full-width
 *     sparkline instead of a stunted few-bar nub. Longer series clip to
 *     the most recent N.
 *   - Last 10 bars render in `var(--accent)`; older bars render in
 *     `var(--rule-strong)` at 0.75 opacity.
 *   - Every 10th column gets a dashed `var(--rule)` ruler line.
 *   - The most-recent bar pulses via `tempo-strip-pulse` keyframes when
 *     activity > 0; the pulse is suppressed under
 *     `prefers-reduced-motion: reduce`.
 */
import { useReducedMotion } from '../../lib/use-reduced-motion';

/** Canonical sparkline width — `web-design-system.html` calls it "60 bars". */
const TARGET_BARS = 60;

/**
 * Left-pad a series to `target` length with zeros, OR slice to the most
 * recent `target` entries when longer. Exported for unit testing and for
 * any future caller that wants to feed a non-default `targetBars` count.
 */
export function padTempoSeries(series: number[], target: number = TARGET_BARS): number[] {
  if (series.length === target) return series;
  if (series.length > target) return series.slice(-target);
  return [...Array(target - series.length).fill(0), ...series];
}

interface TempoStripProps {
  /** Per-bucket activity counts (typically messages/min, last N minutes). */
  series: number[];
  height?: number;
  bpm?: number;
  /** Target bar count; defaults to {@link TARGET_BARS} (60). */
  targetBars?: number;
}

export function TempoStrip({ series, height = 44, bpm = 92, targetBars = TARGET_BARS }: TempoStripProps) {
  const reduceMotion = useReducedMotion();
  const padded = padTempoSeries(series, targetBars);
  const max = Math.max(...padded, 1);
  const w = 4;
  const gap = 2;
  const total = Math.max(padded.length, 1) * (w + gap);
  // Use the original `series` (not the padded one) for "last bar active"
  // — leading zeros from the pad shouldn't pulse.
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
        {padded.map((_, i) =>
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
        {padded.map((v, i) => {
          const h = (v / max) * (height - 8);
          const x = i * (w + gap);
          const y = height - h - 2;
          const recent = i > padded.length - 10;
          const isLast = i === padded.length - 1;
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
