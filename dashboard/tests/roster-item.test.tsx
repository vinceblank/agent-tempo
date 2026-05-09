/**
 * RosterItem — fallback adapter-type chip tests (#537).
 *
 * Verifies that:
 *   - A typed player renders a TypeBadge (existing behaviour).
 *   - An untyped player with a non-default agentType renders a muted
 *     adapter-badge fallback chip.
 *   - An untyped player with the default 'claude' agentType renders
 *     no chip at all (avoids noise on the pre-#535 wire).
 *   - When both playerType and a non-default agentType are set, only
 *     the TypeBadge renders (no double-chip).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RosterItem } from '../src/components/RosterItem';
import { makePlayer } from './fixtures/factories';

describe('RosterItem fallback chip (#537)', () => {
  it('renders TypeBadge when playerType is set', () => {
    render(
      <RosterItem
        player={makePlayer({ playerId: 'eng', playerType: 'tempo-soloist', agentType: 'claude' })}
      />,
    );
    expect(screen.getByTestId('type-badge-tempo-soloist')).toBeInTheDocument();
    expect(screen.queryByTestId(/^adapter-badge-/)).not.toBeInTheDocument();
  });

  it('renders muted adapter-badge when playerType is absent and agentType is non-default', () => {
    render(
      <RosterItem
        player={makePlayer({
          playerId: 'scribe',
          playerType: undefined,
          agentType: 'copilot' as any,
        })}
      />,
    );
    expect(screen.queryByTestId(/^type-badge-/)).not.toBeInTheDocument();
    const chip = screen.getByTestId('adapter-badge-copilot');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe('copilot');
  });

  it('renders no chip when playerType is absent and agentType is "claude"', () => {
    render(
      <RosterItem
        player={makePlayer({
          playerId: 'scribe',
          playerType: undefined,
          agentType: 'claude',
        })}
      />,
    );
    expect(screen.queryByTestId(/^type-badge-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/^adapter-badge-/)).not.toBeInTheDocument();
  });

  it('renders only TypeBadge when both playerType and non-default agentType are set', () => {
    render(
      <RosterItem
        player={makePlayer({
          playerId: 'eng',
          playerType: 'tempo-soloist',
          agentType: 'copilot' as any,
        })}
      />,
    );
    expect(screen.getByTestId('type-badge-tempo-soloist')).toBeInTheDocument();
    expect(screen.queryByTestId(/^adapter-badge-/)).not.toBeInTheDocument();
  });

  it('renders adapter-badge for mock agentType (dev mode)', () => {
    render(
      <RosterItem
        player={makePlayer({
          playerId: 'mock-player',
          playerType: undefined,
          agentType: 'mock',
        })}
      />,
    );
    const chip = screen.getByTestId('adapter-badge-mock');
    expect(chip).toBeInTheDocument();
    expect(chip.textContent).toBe('mock');
  });
});
