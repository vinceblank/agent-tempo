/**
 * RosterItem — single player row in the Workspace roster panel. PR-A1 of #389.
 *
 * Per audit (line 876-877): 2-row flex → 3-col grid:
 *
 *   ┌──────┬──────────────────────────────┬─────────┐
 *   │ ♩    │ <name>★ ●processing          │ <hb>    │
 *   │  32  │ <type-badge> <part text>     │ <msg>   │
 *   └──────┴──────────────────────────────┴─────────┘
 *      .roster-item with `display: grid; grid-template-columns: 32px 1fr auto;`
 *
 * The heartbeat / message-count fields aren't on `PlayerSummaryV1` yet
 * (Task #15 lands them in beta.8). Until they are, the right meta
 * column shows `hostname` so something useful sits in that slot.
 *
 * Test ids preserved per architect's testability addendum:
 *   - `data-testid="player-row-${playerId}"` on the root row
 *   - `data-testid="conductor-indicator"` on the conductor's row only
 *
 * Source: `workspace.jsx:386-404` (Roster panel) + components.css
 * `.roster-item` / `.rn` / `.rp` / `.rmeta`.
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
  const cls = 'roster-item' + (selected ? ' is-active' : '');
  const part = player.part?.trim();
  return (
    <button
      type="button"
      data-testid={`player-row-${player.playerId}`}
      data-selected={selected || undefined}
      data-conductor={player.isConductor || undefined}
      onClick={() => onSelect?.(player.playerId)}
      className={cls}
      // The button overrides a few defaults of <button> that .roster-item
      // doesn't reach (background, border, text-align). Keep these inline
      // because the source CSS targets a div in the design and we're
      // using <button> for the keyboard-activatable target.
      style={{
        background: selected ? 'var(--accent-soft)' : 'transparent',
        color: 'var(--text)',
        border: 0,
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'var(--ff-ui)',
        // Override the components.css `.roster-item { display: grid; … }`
        // template only when we need the button reset; the grid columns
        // are inherited from the class.
        width: '100%',
      }}
    >
      <PlayerAvatar
        playerId={player.playerId}
        playerType={player.playerType}
        isConductor={player.isConductor}
        size={32}
      />
      <span className="col" style={{ minWidth: 0, gap: 2 }}>
        <span className="rn">
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {player.playerId}
          </span>
          {player.isConductor && (
            <span
              data-testid="conductor-indicator"
              className="conductor-star"
              title="Conductor"
              aria-label="conductor"
            >
              ★
            </span>
          )}
          <PhaseDot phase={player.phase} playerId={player.playerId} />
        </span>
        <span className="rp">
          {player.playerType && <TypeBadge type={player.playerType} />}
          {part && <span style={{ marginLeft: 6 }}>{part}</span>}
        </span>
      </span>
      <div className="rmeta">
        {/* Heartbeat / message-count not yet on the wire (Task #15). Show
          * hostname in the heartbeat slot until the snapshot grows those
          * fields. Both rows stay so the grid template `auto` keeps a
          * consistent right column. */}
        <div className="heartbeat">{player.hostname || '—'}</div>
        <div>{player.agentType}</div>
      </div>
    </button>
  );
}
