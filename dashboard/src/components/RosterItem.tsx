/**
 * RosterItem — single player row in the Workspace sidebar. Composes
 * the tempo motifs (PlayerAvatar + PhaseDot + TypeBadge) into a row
 * that doubles as a navigation target into PlayerDetail.
 *
 * Test ids documented in `dashboard/README.md` § Testability:
 *   - `data-testid="player-row-${playerId}"`
 *   - `data-testid="conductor-indicator"` on the conductor's row only
 */
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';
import { PlayerAvatar } from './tempo/PlayerAvatar';
import { PhaseDot } from './tempo/PhaseDot';
import { TypeBadge } from './tempo/TypeBadge';

interface RosterItemProps {
  player: PlayerSummaryV1;
  selected?: boolean;
  onSelect?: (playerId: string) => void;
}

export function RosterItem({ player, selected = false, onSelect }: RosterItemProps) {
  return (
    <button
      type="button"
      data-testid={`player-row-${player.playerId}`}
      data-selected={selected || undefined}
      data-conductor={player.isConductor || undefined}
      onClick={() => onSelect?.(player.playerId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: 'var(--density-pad-y) var(--density-pad)',
        background: selected ? 'var(--bg-2)' : 'transparent',
        color: 'var(--text)',
        border: 0,
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'var(--ff-ui)',
      }}
    >
      <PlayerAvatar
        playerId={player.playerId}
        playerType={player.playerType}
        isConductor={player.isConductor}
        size={28}
      />
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2, flex: 1 }}>
        <span
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            fontSize: 'var(--density-fs)',
            fontWeight: player.isConductor ? 600 : 400,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {player.playerId}
          {player.isConductor && (
            <span
              data-testid="conductor-indicator"
              className="dim"
              style={{ fontSize: 'var(--density-fs-sm)' }}
            >
              · conductor
            </span>
          )}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <PhaseDot phase={player.phase} playerId={player.playerId} showLabel />
          {player.playerType && <TypeBadge type={player.playerType} />}
        </span>
      </span>
    </button>
  );
}
