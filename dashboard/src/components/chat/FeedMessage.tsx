/**
 * FeedMessage — single chat row in the Maestro feed (PR-A2 of #389).
 *
 * Three variants, mirroring the canonical bundle (`workspace.jsx:495-549`):
 *
 *   - `out`   — outbound from "you" → recipient. Right-aligned bubble,
 *               no avatar tile. The "you" identity uses {@link MaestroMark}
 *               (rev 4 C2 — operator's own mark, not a player avatar).
 *   - `in`    — inbound to maestro. Left-aligned with {@link PlayerAvatar}
 *               and a `from ← maestro` header.
 *   - `route` — overheard third-party message (player → player). Indented
 *               with the "overhearing rail" CSS treatment.
 *
 * Rev 4 markers:
 *   - **C3**: when `fromPhase` is supplied, {@link PhaseDot} renders the
 *     real codebase phase (no playing/paused/error abstraction).
 *   - **C4**: italic discipline — bodies render `children` verbatim so
 *     callers may pass `<em>` accents; no JSX-level italic on wrappers.
 *     (`.msg.route .msg-body { font-style: italic }` in `components.css`
 *     is the canonical "overheard" treatment, not a blanket rule.)
 *
 * Stable testids: `feed-message-${id}` on the row, `…-body` on the body.
 *
 * Presentational only — no SSE / mutation wiring. PR-C2 stitches it
 * into `EnsembleWorkspace`.
 */
import type { ReactNode } from 'react';
import { MaestroMark } from '../MaestroMark';
import { PlayerAvatar } from '../tempo/PlayerAvatar';
import { PhaseDot } from '../tempo/PhaseDot';
import { hueForType } from '../../lib/tempo-helpers';

export type FeedMessageKind = 'in' | 'out' | 'route';

export interface FeedMessageData {
  /** Stable identifier for testids and React keys. */
  id: string;
  kind: FeedMessageKind;
  /** Sender label (e.g., "tempo-soloist-1"). Ignored for `kind === "out"`. */
  from?: string;
  /** Recipient label (e.g., "conductor", "maestro"). */
  to?: string;
  /** Display timestamp (already formatted, e.g., "14:02"). */
  time: string;
  /** Message body — rendered as React children so callers can include `<em>`. */
  body: ReactNode;
  /** Sender's player type (drives avatar hue + identity colour). */
  fromType?: string;
  /** Whether the sender is the conductor (decorates with the gold star). */
  fromIsConductor?: boolean;
  /** Sender's attachment phase — when supplied, a PhaseDot renders next to the sender. */
  fromPhase?: string;
}

interface FeedMessageProps {
  m: FeedMessageData;
}

interface VariantConfig {
  /** Class on the root `.msg` element. */
  className: string;
  /** Arrow glyph between sender and target. */
  arrow: '→' | '←';
  /** Default target when `m.to` is omitted. */
  defaultTarget: string;
}

const VARIANTS: Record<FeedMessageKind, VariantConfig> = {
  out:   { className: 'msg out',   arrow: '→', defaultTarget: 'conductor' },
  in:    { className: 'msg in',    arrow: '←', defaultTarget: 'maestro' },
  route: { className: 'msg route', arrow: '→', defaultTarget: 'maestro' },
};

export function FeedMessage({ m }: FeedMessageProps) {
  const baseTestId = `feed-message-${m.id}`;
  const variant = VARIANTS[m.kind];
  const fromName = m.from ?? 'unknown';
  const target = m.to ?? variant.defaultTarget;

  // Sender label colouring differs per variant; no other JSX divergence.
  const senderEl = renderSender(m, fromName);
  const phaseDot = m.fromPhase ? <PhaseDot phase={m.fromPhase} playerId={fromName} /> : null;

  const head = (
    <div className="msg-head">
      {m.kind === 'out' && <MaestroMark size={12} />}
      {senderEl}
      {m.kind === 'in' && m.fromIsConductor && (
        <span style={{ color: 'var(--warn)' }} aria-label="conductor">★</span>
      )}
      {phaseDot}
      <span className="arrow">{variant.arrow}</span>
      <span className="target">{target}</span>
      <span className="time">{m.time}</span>
    </div>
  );

  const body = (
    <div className="msg-body" data-testid={`${baseTestId}-body`}>
      {m.body}
    </div>
  );

  return (
    <div className={variant.className} data-testid={baseTestId} data-direction={m.kind}>
      {m.kind !== 'out' && (
        <div className="msg-avatar">
          <PlayerAvatar
            playerId={fromName}
            playerType={m.fromType}
            isConductor={m.fromIsConductor}
            size={28}
          />
        </div>
      )}
      <div>
        {head}
        {body}
      </div>
    </div>
  );
}

function renderSender(m: FeedMessageData, fromName: string): ReactNode {
  if (m.kind === 'out') {
    return <span className="sender mono">you</span>;
  }
  if (m.kind === 'route') {
    return <span className="sender" style={{ color: 'var(--dim)' }}>{fromName}</span>;
  }
  // kind === 'in'
  const senderColor =
    m.fromType !== undefined
      ? `oklch(0.8 0.12 ${hueForType(m.fromType)})`
      : 'var(--accent)';
  return <span className="sender" style={{ color: senderColor }}>{fromName}</span>;
}
