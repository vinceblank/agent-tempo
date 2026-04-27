/**
 * EnsembleCard — one card per ensemble on the Overview screen.
 *
 * Renders a quick-look projection: name, conductor presence, player
 * count, paused/held flags. Clicking links to the per-ensemble Workspace
 * (placeholder in PR-4; real screen lands in PR-5).
 *
 * Testability surface (architect's testability addendum):
 *   - `data-testid="ensemble-card-${id}"` on the root
 *   - `data-testid="ensemble-card-${id}-link"` on the click target
 *   - `data-testid="ensemble-card-${id}-player-count"` on the count
 *   - `data-testid="ensemble-card-${id}-conductor"` when a conductor is present
 *   - `role="alert"` + `data-testid="error-ensemble-snapshot-${id}"` on error
 *   - `data-testid="loading"` + `data-resource="ensemble-snapshot-${id}"` on skeleton
 */
import { Link } from 'react-router-dom';
import { useEnsembleSnapshot } from '../lib/queries';
import { useSseSubscription } from '../lib/sse';
import type { EnsembleSummary } from '../lib/client';
import { logEvent } from '../lib/log';

interface EnsembleCardProps {
  ensemble: EnsembleSummary;
}

export function EnsembleCard({ ensemble }: EnsembleCardProps) {
  const snapshot = useEnsembleSnapshot(ensemble.name);
  // Live updates — the hook hangs an SSE subscription that diffs into
  // the same cache key the query above reads. Snapshot landing seeds;
  // SSE diffs apply incremental changes.
  //
  // Scale note: each card opens its own `/v1/events/:ensemble` stream;
  // the daemon caps at 100 connections (`DEFAULT_MAX_CONNECTIONS`). The
  // Overview is sized for ≤10 ensembles per browser tab — the per-card
  // stream gives independent error recovery. A future "fleet view"
  // with 100+ ensembles should drop down to the global `/v1/events`
  // stream + per-card snapshot only.
  useSseSubscription(ensemble.name);

  const playerCount = snapshot.data?.players.length ?? ensemble.playerCount;
  const hasConductor = snapshot.data?.hasConductor ?? ensemble.hasConductor;
  const state = snapshot.data?.state ?? ensemble.state ?? 'online';
  const flags = snapshot.data?.flags;

  return (
    <article
      data-testid={`ensemble-card-${ensemble.name}`}
      data-state={state}
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--rule)',
        borderRadius: 8,
        padding: 'var(--density-pad)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Link
          to={`/dashboard/ensemble/${encodeURIComponent(ensemble.name)}`}
          data-testid={`ensemble-card-${ensemble.name}-link`}
          onClick={() => logEvent('ensemble-card.click', { ensemble: ensemble.name })}
          style={{
            color: 'var(--text)',
            textDecoration: 'none',
            fontFamily: 'var(--ff-display)',
            fontSize: 18,
            fontWeight: 500,
          }}
        >
          {ensemble.name}
        </Link>
        <StateBadge state={state} />
      </header>

      {snapshot.isLoading && !snapshot.data ? (
        <div
          data-testid="loading"
          data-resource={`ensemble-snapshot-${ensemble.name}`}
          className="dim"
          style={{ fontSize: 13 }}
        >
          Loading…
        </div>
      ) : snapshot.isError ? (
        <div
          role="alert"
          data-testid={`error-ensemble-snapshot-${ensemble.name}`}
          style={{ color: 'var(--accent)', fontSize: 13 }}
        >
          {snapshot.error?.message ?? 'Snapshot unavailable'}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
            <span data-testid={`ensemble-card-${ensemble.name}-player-count`} className="dim">
              {playerCount} {playerCount === 1 ? 'player' : 'players'}
            </span>
            {hasConductor && (
              <span data-testid={`ensemble-card-${ensemble.name}-conductor`} className="dim">
                conductor
              </span>
            )}
          </div>
          {flags && (flags.paused || flags.held) && (
            <div style={{ display: 'flex', gap: 6, fontSize: 12 }}>
              {flags.paused && (
                <FlagPill testId={`ensemble-card-${ensemble.name}-flag-paused`} label="paused" />
              )}
              {flags.held && (
                <FlagPill testId={`ensemble-card-${ensemble.name}-flag-held`} label="held" />
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}

function StateBadge({ state }: { state: 'online' | 'paused' | 'offline' }) {
  const tint =
    state === 'online' ? 'var(--ok)' : state === 'paused' ? 'var(--warn)' : 'var(--dim)';
  return (
    <span
      data-testid={`ensemble-state-${state}`}
      style={{
        fontFamily: 'var(--ff-mono)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: tint,
      }}
    >
      {state}
    </span>
  );
}

function FlagPill({ testId, label }: { testId: string; label: string }) {
  return (
    <span
      data-testid={testId}
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--rule)',
        borderRadius: 4,
        padding: '1px 6px',
        fontFamily: 'var(--ff-mono)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {label}
    </span>
  );
}
