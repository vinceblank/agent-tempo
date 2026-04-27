/**
 * WorkspaceToolbar — Pause / Play / Release controls + "Recruit" link
 * mounted at the top-right of the Workspace screen (PR-7b of #340).
 *
 * Each button calls the corresponding mutation hook and surfaces a
 * Sonner toast on success/error. The visual state is driven from the
 * cached snapshot's `flags` so the buttons reflect live state — paused
 * ensembles show "Resume" instead of "Pause", etc.
 *
 * Testability:
 *   - `data-testid="workspace-toolbar"` on the root
 *   - `data-testid="workspace-toolbar-{pause,play,release,recruit}"` per button
 *   - `aria-pressed` on Pause/Play to reflect the current state for SR users
 */
import { Link } from 'react-router-dom';
import { usePauseMutation, usePlayMutation, useReleaseMutation } from '../lib/mutations';

interface WorkspaceToolbarProps {
  ensemble: string;
  paused: boolean;
  held: boolean;
}

export function WorkspaceToolbar({ ensemble, paused, held }: WorkspaceToolbarProps) {
  const pauseM = usePauseMutation(ensemble);
  const playM = usePlayMutation(ensemble);
  const releaseM = useReleaseMutation(ensemble);

  const handleTogglePause = () => {
    if (paused) {
      playM.mutate({ release: held });
    } else {
      pauseM.mutate();
    }
  };

  const handleRelease = () => {
    releaseM.mutate();
  };

  const togglePending = paused ? playM.isPending : pauseM.isPending;

  return (
    <div
      data-testid="workspace-toolbar"
      role="toolbar"
      aria-label="Ensemble controls"
      style={toolbarStyle}
    >
      <button
        type="button"
        data-testid="workspace-toolbar-pause"
        aria-pressed={paused}
        disabled={togglePending}
        onClick={handleTogglePause}
        title={paused ? 'Unpause this ensemble' : 'Pause this ensemble'}
        style={buttonStyle(paused ? 'primary' : 'default')}
      >
        {togglePending ? '…' : paused ? 'Resume' : 'Pause'}
      </button>

      <button
        type="button"
        data-testid="workspace-toolbar-release"
        disabled={releaseM.isPending || !held}
        onClick={handleRelease}
        title={held ? 'Release held sessions' : 'No held sessions'}
        style={buttonStyle(held ? 'default' : 'disabled')}
      >
        {releaseM.isPending ? 'Releasing…' : 'Release'}
      </button>

      <Link
        data-testid="workspace-toolbar-recruit"
        to={`/recruit?ensemble=${encodeURIComponent(ensemble)}`}
        title="Recruit a new player into this ensemble"
        style={{ ...buttonStyle('default'), textDecoration: 'none' }}
      >
        Recruit
      </Link>
    </div>
  );
}

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};

function buttonStyle(variant: 'default' | 'primary' | 'disabled'): React.CSSProperties {
  return {
    padding: '6px 12px',
    fontSize: 13,
    fontFamily: 'var(--ff-ui)',
    fontWeight: 500,
    background:
      variant === 'primary' ? 'var(--accent)' :
      variant === 'disabled' ? 'var(--bg-3)' :
      'var(--bg-2)',
    color:
      variant === 'primary' ? 'var(--accent-ink)' :
      variant === 'disabled' ? 'var(--dim)' :
      'var(--text)',
    border: '1px solid var(--rule)',
    borderRadius: 6,
    cursor: variant === 'disabled' ? 'not-allowed' : 'pointer',
  };
}
