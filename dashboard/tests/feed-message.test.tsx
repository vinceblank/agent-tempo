/**
 * FeedMessage primitive — covers the three direction variants
 * (in / out / route), MaestroMark on outbound (rev 4 C2), PhaseDot
 * integration on inbound (rev 4 C3), and italic discipline
 * (rev 4 C4 — `<em>` accents render verbatim, body wrapper does not
 * impose italic).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeedMessage } from '../src/components/chat/FeedMessage';

describe('FeedMessage primitive', () => {
  it('renders an outbound message with MaestroMark + "you → target" header', () => {
    render(
      <FeedMessage
        m={{
          id: 'm1',
          kind: 'out',
          to: 'conductor',
          time: '14:02',
          body: 'ping the conductor',
        }}
      />,
    );
    const row = screen.getByTestId('feed-message-m1');
    expect(row).toHaveAttribute('data-direction', 'out');
    expect(row.classList.contains('msg')).toBe(true);
    expect(row.classList.contains('out')).toBe(true);
    expect(screen.getByTestId('maestro-mark')).toBeInTheDocument();
    expect(row.textContent).toContain('you');
    expect(row.textContent).toContain('conductor');
    expect(row.textContent).toContain('14:02');
    expect(screen.getByTestId('feed-message-m1-body').textContent).toBe(
      'ping the conductor',
    );
  });

  it('renders an inbound message with PlayerAvatar + "← maestro" arrow', () => {
    render(
      <FeedMessage
        m={{
          id: 'm2',
          kind: 'in',
          from: 'tempo-soloist-1',
          to: 'maestro',
          time: '14:03',
          body: 'on it',
          fromType: 'tempo-soloist',
        }}
      />,
    );
    const row = screen.getByTestId('feed-message-m2');
    expect(row).toHaveAttribute('data-direction', 'in');
    expect(row.classList.contains('in')).toBe(true);
    expect(screen.getByTestId('player-avatar-tempo-soloist-1')).toBeInTheDocument();
    expect(row.textContent).toContain('tempo-soloist-1');
    expect(row.textContent).toContain('←');
    expect(row.textContent).toContain('maestro');
  });

  it('renders a route (overheard) message with the route class + smaller affordance', () => {
    render(
      <FeedMessage
        m={{
          id: 'm3',
          kind: 'route',
          from: 'critic',
          to: 'soloist',
          time: '14:04',
          body: 'ship it',
          fromType: 'tempo-critic',
        }}
      />,
    );
    const row = screen.getByTestId('feed-message-m3');
    expect(row).toHaveAttribute('data-direction', 'route');
    expect(row.classList.contains('route')).toBe(true);
    expect(row.textContent).toContain('critic');
    expect(row.textContent).toContain('→');
    expect(row.textContent).toContain('soloist');
  });

  it('renders the conductor star ★ when fromIsConductor is true (inbound)', () => {
    render(
      <FeedMessage
        m={{
          id: 'm4',
          kind: 'in',
          from: 'conductor',
          to: 'maestro',
          time: '14:05',
          body: 'standing by',
          fromType: 'tempo-conductor',
          fromIsConductor: true,
        }}
      />,
    );
    const row = screen.getByTestId('feed-message-m4');
    expect(row.textContent).toContain('★');
  });

  it('attaches a PhaseDot when fromPhase is provided (rev 4 C3)', () => {
    render(
      <FeedMessage
        m={{
          id: 'm5',
          kind: 'in',
          from: 'tempo-tuner-1',
          to: 'maestro',
          time: '14:06',
          body: 'green',
          fromPhase: 'processing',
        }}
      />,
    );
    const dot = screen.getByTestId('phase-dot-tempo-tuner-1');
    expect(dot).toHaveAttribute('data-phase', 'processing');
  });

  it('preserves <em> accents in the body without forcing italic on the wrapper (rev 4 C4)', () => {
    render(
      <FeedMessage
        m={{
          id: 'm6',
          kind: 'out',
          to: 'soloist',
          time: '14:07',
          body: (
            <>
              please <em>fix</em> the lease math
            </>
          ),
        }}
      />,
    );
    const body = screen.getByTestId('feed-message-m6-body');
    const em = body.querySelector('em');
    expect(em?.textContent).toBe('fix');
    // The wrapper must NOT add a JSX-level fontStyle (CSS handles
    // overheard `.msg.route` styling on its own; out/in bodies stay
    // upright per C4).
    expect(body.style.fontStyle).toBe('');
  });
});
