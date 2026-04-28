/**
 * EnsembleCard — one card per ensemble on the Overview screen. PR-A1 of #389.
 *
 * Layout per audit + components.css `.ensemble-card`:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ @<name>                          ## bpm  │  .ec-head: name + tempo
 *   │ <description text>                       │  .ec-desc
 *   │ ┌─────────┬─────────┬─────────┐          │  .ec-stats: 3 numerics
 *   │ │   N     │   M     │  T      │          │
 *   │ │ players │ active  │ uptime  │          │
 *   │ └─────────┴─────────┴─────────┘          │
 *   │ <lineup>                  <host>         │  lineup/host metadata row
 *   │ ♩ ♪ ♫ ♬ +N                              │  .ec-roster: avatar stack
 *   └──────────────────────────────────────────┘
 *
 * Hover translateY(-1px) + accent border via .ensemble-card:hover.
 * `.is-empty` modifier on cards with zero players (60% opacity).
 *
 * Fields not yet in `EnsembleSummary` (description / tempo / uptime /
 * lineup / host) gracefully degrade to `—`. Task #15 (architect's wire
 * extension epic, beta.8) adds those fields to `/v1/ensembles`; until
 * then, PR-A1 reads them from the snapshot when present and shows
 * placeholders otherwise.
 *
 * Click target: the entire card is wrapped in a `<Link>`. Existing
 * testids preserved verbatim per the architect's testability addendum:
 *   - `ensemble-card-${name}` on the root <article>
 *   - `ensemble-card-${name}-link` on the click target
 *   - `ensemble-card-${name}-player-count` on the player count stat
 *   - `ensemble-card-${name}-conductor` (only when conductor present)
 *   - `ensemble-card-${name}-flag-paused` / `-flag-held` (when set)
 *   - `error-ensemble-snapshot-${name}` (role=alert) on snapshot error
 *   - `loading` + `data-resource="ensemble-snapshot-${name}"` on skeleton
 *
 * Source: `screens.jsx:32-62` (Overview's EnsembleCard render) +
 * components.css `.ensemble-card` / `.ec-*`.
 */
import { Link } from 'react-router-dom';
import { useEnsembleSnapshot } from '../lib/queries';
import { useSseSubscription } from '../lib/sse';
import type { EnsembleSummary } from '../lib/client';
import { asExtended } from '../lib/wire-shape';
import { logEvent } from '../lib/log';
import { formatDuration } from '../lib/time-format';
import { PlayerAvatar } from './tempo/PlayerAvatar';

interface EnsembleCardProps {
  ensemble: EnsembleSummary;
}

export function EnsembleCard({ ensemble }: EnsembleCardProps) {
  const snapshot = useEnsembleSnapshot(ensemble.name);
  // Live updates — the hook hangs an SSE subscription that diffs into
  // the same cache key the query above reads. Per-card streams give
  // independent error recovery; the daemon caps at 100 connections, and
  // the Overview is sized for ≤10 ensembles per browser tab. A future
  // "fleet view" with 100+ ensembles should drop to the global
  // `/v1/events` stream + per-card snapshot only.
  useSseSubscription(ensemble.name);

  const data = asExtended(snapshot.data);
  const players = data?.players ?? [];
  const playerCount = players.length || ensemble.playerCount;
  const hasConductor = data?.hasConductor ?? ensemble.hasConductor;
  const state = data?.state ?? ensemble.state ?? 'online';
  const flags = data?.flags;
  const isEmpty = playerCount === 0;
  const activeCount = players.filter((p) => p.phase === 'attached' || p.phase === 'processing').length;
  // Lineup / host still require dedicated wire fields (out of #399 scope).
  const lineup = '—';
  const host = '—';
  // #399 W1 (Q5.3a / Q5.6 / Q5.1) — uptime, BPM, and description bind
  // to the new snapshot projections from DB1a. Each falls back to "—"
  // when missing so the card stays grid-aligned.
  const startedAtMs = data?.startedAt ? Date.parse(data.startedAt) : NaN;
  const uptime = Number.isFinite(startedAtMs)
    ? formatDuration(Date.now() - startedAtMs)
    : '—';
  const bpm = data?.currentBpm;
  const description = data?.description?.trim() ?? '';

  return (
    <article
      data-testid={`ensemble-card-${ensemble.name}`}
      data-state={state}
      className={'ensemble-card' + (isEmpty ? ' is-empty' : '')}
    >
      <Link
        to={`/ensemble/${encodeURIComponent(ensemble.name)}`}
        data-testid={`ensemble-card-${ensemble.name}-link`}
        onClick={() => logEvent('ensemble-card.click', { ensemble: ensemble.name })}
        // The card is the click target; this Link stretches over the card
        // so any tap inside it routes. Removing the underline keeps the
        // typography readable; the hover treatment lives in components.css
        // (`.ensemble-card:hover { border-color: var(--accent); ... }`).
        style={{
          color: 'inherit',
          textDecoration: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div className="ec-head">
          <div className="ec-name">
            <span className="at">@</span>
            {ensemble.name}
          </div>
          <div className="ec-tempo">
            <span className="bpm" data-testid={`ensemble-card-${ensemble.name}-bpm`}>
              {bpm !== undefined ? bpm : '—'}
            </span>
            <span>bpm</span>
          </div>
        </div>

        {snapshot.isLoading && !snapshot.data ? (
          <div
            data-testid="loading"
            data-resource={`ensemble-snapshot-${ensemble.name}`}
            className="dim ec-desc"
          >
            Loading…
          </div>
        ) : snapshot.isError ? (
          <div
            role="alert"
            data-testid={`error-ensemble-snapshot-${ensemble.name}`}
            className="ec-desc"
            style={{ color: 'var(--accent)' }}
          >
            {snapshot.error?.message ?? 'Snapshot unavailable'}
          </div>
        ) : (
          <>
            {/* `.ec-desc` reserves a 40px min-height so cards with no
              * description still align in the grid. The conductor agent
              * keeps this populated via `set_ensemble_description`
              * (#399 Q5.1); fresh ensembles without a description fall
              * back to a presence sentinel so the row never collapses. */}
            <div className="ec-desc" data-testid={`ensemble-card-${ensemble.name}-desc`}>
              {description || (hasConductor ? 'Conductor active.' : 'No conductor yet.')}
            </div>

            <div className="ec-stats" data-testid={`ensemble-card-${ensemble.name}-stats`}>
              <div className="ec-stat">
                <div className="n" data-testid={`ensemble-card-${ensemble.name}-player-count`}>
                  {playerCount}
                </div>
                <div className="l">{playerCount === 1 ? 'player' : 'players'}</div>
              </div>
              <div className="ec-stat">
                <div className="n" style={{ color: activeCount > 0 ? 'var(--ok)' : 'var(--dim)' }}>
                  {activeCount}
                </div>
                <div className="l">active</div>
              </div>
              <div className="ec-stat">
                <div
                  className="n"
                  data-testid={`ensemble-card-${ensemble.name}-uptime`}
                  style={{ fontFamily: 'var(--ff-mono)', fontSize: 12 }}
                >
                  {uptime}
                </div>
                <div className="l">uptime</div>
              </div>
            </div>

            <div
              className="mono dim"
              style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between' }}
            >
              <span>
                {lineup}
                {hasConductor && (
                  <>
                    {' · '}
                    <span data-testid={`ensemble-card-${ensemble.name}-conductor`}>
                      conductor
                    </span>
                  </>
                )}
              </span>
              <span>{host}</span>
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

            {playerCount > 0 && (
              <div className="ec-roster">
                {players.slice(0, 5).map((p) => (
                  <PlayerAvatar
                    key={p.playerId}
                    playerId={p.playerId}
                    playerType={p.playerType}
                    isConductor={p.isConductor}
                    size={22}
                  />
                ))}
                {playerCount > 5 && (
                  <span
                    className="mono dim"
                    style={{ alignSelf: 'center', marginLeft: 4, fontSize: 11 }}
                  >
                    +{playerCount - 5}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </Link>
    </article>
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
        fontSize: 11,
      }}
    >
      {label}
    </span>
  );
}
