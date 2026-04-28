/**
 * EnsembleSwitcher — bottom-sheet (phone) / centered modal (≥521px).
 * PR-A1m of #389.
 *
 * Layout — single component, two visual modes selected by container query
 * on the artboard. CSS in `components.css` (`.ens-switcher*` rules) does
 * the layout swap; this component renders identical markup either way:
 *
 *   ┌─────────────────────────────┐ ← .ens-switcher (full-shell scrim)
 *   │              ╭─────────╮              │
 *   │              ┃    ▔     ┃ ← grip (sheet only)
 *   │              ┃ Switch ensemble │   × │
 *   │              ┃────────────────────│
 *   │              ┃ ● @my-band  3 players│
 *   │              ┃ ○ @backend  0 players│
 *   │              ┃────────────────────│
 *   │              ┃ + New ensemble…    │
 *   │              ╰────────────────────╯
 *   └─────────────────────────────┘
 *
 * Click on the scrim closes the switcher; the sheet itself stops
 * propagation so its content stays clickable. Selecting a row navigates
 * to `/ensemble/:name` and closes; "+ New ensemble" routes to
 * `/create-ensemble` and closes.
 */
import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEnsembleList } from '../lib/queries';

interface EnsembleSwitcherProps {
  open: boolean;
  onClose: () => void;
  /** Highlights the matching row with the active treatment + ✓ glyph.
   *  Defaults to undefined when invoked outside an `/ensemble/:id` route. */
  activeEnsemble?: string;
}

export function EnsembleSwitcher({ open, onClose, activeEnsemble }: EnsembleSwitcherProps) {
  const navigate = useNavigate();
  const list = useEnsembleList();
  const ensembles = list.data ?? [];

  if (!open) return null;

  const onSelect = (name: string) => {
    navigate(`/ensemble/${encodeURIComponent(name)}`);
    onClose();
  };

  const onNew = () => {
    navigate('/create-ensemble');
    onClose();
  };

  // Click on the scrim closes; click anywhere on the sheet stops the
  // bubble so the close-on-scrim handler doesn't fire.
  const onScrimClick = () => onClose();
  const onSheetClick = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className="ens-switcher"
      role="dialog"
      aria-modal="true"
      aria-label="Switch ensemble"
      data-testid="ensemble-switcher"
      onClick={onScrimClick}
    >
      <div className="ens-switcher-sheet" onClick={onSheetClick} data-testid="ensemble-switcher-sheet">
        <div className="ens-switcher-grip" />
        <div className="ens-switcher-head">
          <div className="ens-switcher-title">Switch ensemble</div>
          <button
            type="button"
            className="ens-switcher-close"
            aria-label="Close"
            onClick={onClose}
            data-testid="ensemble-switcher-close"
          >
            ×
          </button>
        </div>
        <div className="ens-switcher-list">
          {ensembles.length === 0 ? (
            <div
              className="dim"
              data-testid="ensemble-switcher-empty"
              style={{ padding: '20px 12px', textAlign: 'center', fontFamily: 'var(--ff-mono)', fontSize: 12 }}
            >
              No ensembles yet
            </div>
          ) : (
            ensembles.map((e) => {
              const isActive = e.name === activeEnsemble;
              return (
                <button
                  key={e.name}
                  type="button"
                  className={'ens-switcher-row' + (isActive ? ' is-active' : '')}
                  onClick={() => onSelect(e.name)}
                  data-testid={`ensemble-switcher-row-${e.name}`}
                >
                  <span className={'ens-switcher-dot' + (e.playerCount > 0 ? ' on' : '')} />
                  <span className="ens-switcher-meta">
                    <span className="ens-switcher-name">
                      <span className="at">@</span>
                      {e.name}
                    </span>
                    <span className="ens-switcher-sub">
                      {e.playerCount} {e.playerCount === 1 ? 'player' : 'players'}
                    </span>
                  </span>
                  {isActive && (
                    <span className="ens-switcher-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <button
          type="button"
          className="ens-switcher-new"
          onClick={onNew}
          data-testid="ensemble-switcher-new"
        >
          <span className="ens-switcher-plus">+</span>
          <span>New ensemble…</span>
        </button>
      </div>
    </div>
  );
}
