/**
 * PlayerDetail screen — Screen B (drilldown). Renders the selected
 * player's metadata + phase + part inside a `ResponsivePanel` so the
 * layout switches between right-Sheet on desktop and bottom-Sheet on
 * mobile.
 *
 * Reads the snapshot the parent Workspace already populated — same
 * `useEnsembleSnapshot` query key, so TanStack Query serves from the
 * cache. When the user closes the panel we navigate back to the
 * Workspace route (i.e. drop the `/player/:playerId` segment).
 */
import { useNavigate, useParams } from 'react-router-dom';
import { useEnsembleSnapshot } from '../lib/queries';
import { ResponsivePanel } from '../components/ResponsivePanel';
import { PlayerAvatar } from '../components/tempo/PlayerAvatar';
import { PhaseDot } from '../components/tempo/PhaseDot';
import { TypeBadge } from '../components/tempo/TypeBadge';

interface KvProps {
  label: string;
  value: string | undefined;
  testId?: string;
}

function Kv({ label, value, testId }: KvProps) {
  return (
    <div
      data-testid={testId}
      style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 12, padding: '4px 0' }}
    >
      <span className="dim" style={{ fontSize: 'var(--density-fs-sm)' }}>{label}</span>
      <span
        className="mono"
        style={{
          fontSize: 'var(--density-fs-sm)',
          overflowWrap: 'anywhere',
          color: value ? 'var(--text)' : 'var(--dim)',
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

export function PlayerDetail() {
  const { id, playerId } = useParams<{ id: string; playerId: string }>();
  const navigate = useNavigate();
  const snapshot = useEnsembleSnapshot(id ?? null);
  const player = snapshot.data?.players.find((p) => p.playerId === playerId);

  const close = () => {
    if (id) navigate(`/ensemble/${encodeURIComponent(id)}`);
    else navigate('/');
  };

  return (
    <ResponsivePanel
      open={true}
      onClose={close}
      testId={`player-detail-${playerId}`}
      ariaLabel={`Player ${playerId}`}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: 'var(--density-pad) calc(var(--density-pad) * 1.4)',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          {player && (
            <PlayerAvatar
              playerId={player.playerId}
              playerType={player.playerType}
              isConductor={player.isConductor}
              size={36}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <h2 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 18 }}>
              {playerId}
            </h2>
            {player && (
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <PhaseDot phase={player.phase} playerId={player.playerId} showLabel />
                {player.playerType && <TypeBadge type={player.playerType} />}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          data-testid={`player-detail-${playerId}-close`}
          onClick={close}
          aria-label="Close player detail"
          style={{
            background: 'transparent',
            color: 'var(--dim)',
            border: '1px solid var(--rule)',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
            fontFamily: 'var(--ff-ui)',
          }}
        >
          ✕
        </button>
      </header>

      <div style={{ padding: 'var(--density-pad) calc(var(--density-pad) * 1.4)', overflowY: 'auto' }}>
        {!player ? (
          <p
            data-testid={`player-detail-${playerId}-not-found`}
            role="status"
            className="dim"
          >
            {snapshot.isLoading
              ? 'Loading player…'
              : `${playerId} is not in the snapshot for ${id}.`}
          </p>
        ) : (
          <>
            <Kv label="Player ID" value={player.playerId} testId={`player-detail-${playerId}-id`} />
            <Kv label="Type" value={player.playerType} testId={`player-detail-${playerId}-type`} />
            <Kv label="Phase" value={player.phase} testId={`player-detail-${playerId}-phase`} />
            <Kv label="Conductor" value={player.isConductor ? 'yes' : 'no'} />
            <Kv label="Hostname" value={player.hostname} />
            <Kv label="Agent" value={player.agentType} />
            <Kv label="Working dir" value={player.workDir} />
            <Kv label="Git branch" value={player.gitBranch} />
            <Kv label="Part" value={player.part || undefined} />
            <p
              className="dim"
              style={{ marginTop: 16, fontSize: 'var(--density-fs-sm)' }}
            >
              Pause / play / release wires up in PR-7 of #340.
            </p>
          </>
        )}
      </div>
    </ResponsivePanel>
  );
}
