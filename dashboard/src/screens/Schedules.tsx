/**
 * Schedules screen — Screen H of the dashboard design (PR-6 of #340).
 * Read-only view of every active schedule across every running ensemble.
 *
 * Source: per-ensemble snapshots from `/v1/state/:ensemble`. The
 * snapshot embeds `schedules: ScheduleEntry[]`; we walk every ensemble
 * from the list query and aggregate. **Scale note**: same N+1 caveat
 * as `Overview` (each ensemble eats one snapshot fetch + one SSE
 * subscription); intended for ≤10 ensembles per browser tab. PR-7+
 * may add a dedicated `/v1/schedules` aggregate if scale grows.
 *
 * Testability:
 *   - `data-testid="screen-schedules"` on the root
 *   - `data-testid="schedule-row-${ensemble}-${name}"` per schedule
 */
import { useEffect } from 'react';
import { useEnsembleList, useEnsembleSnapshot } from '../lib/queries';
import { useSseSubscription } from '../lib/sse';
import { logEvent } from '../lib/log';
import {
  compactRowStyle,
  emptyCardStyle,
  errorCardStyle,
  errorPanelStyle,
  monoStyle,
} from '../lib/screen-styles';

export function Schedules() {
  useEffect(() => { logEvent('screen.opened', { screen: 'schedules' }); }, []);
  const list = useEnsembleList();

  if (list.isLoading) {
    return (
      <Layout>
        <div
          data-testid="loading"
          data-resource="schedules"
          className="dim"
          style={{ padding: 'var(--density-pad)' }}
        >
          Loading ensembles…
        </div>
      </Layout>
    );
  }

  if (list.isError) {
    return (
      <Layout>
        <div
          role="alert"
          data-testid="error-schedules"
          style={errorPanelStyle}
        >
          {list.error?.message ?? 'Failed to load ensembles'}
        </div>
      </Layout>
    );
  }

  const ensembles = list.data ?? [];
  if (ensembles.length === 0) {
    return (
      <Layout>
        <div data-testid="schedules-empty" className="dim" style={emptyCardStyle}>
          No ensembles running, so no schedules to show.
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {ensembles.map((e) => <EnsembleSchedules key={e.name} ensembleName={e.name} />)}
    </Layout>
  );
}

function EnsembleSchedules({ ensembleName }: { ensembleName: string }) {
  const snap = useEnsembleSnapshot(ensembleName);
  // Live updates via SSE — `schedules.changed` events project into the
  // same cache key the snapshot reads, so the list stays current
  // without a polling refetch. Without this subscription the screen
  // would only reflect changes via the 5 s `staleTime` window.
  useSseSubscription(ensembleName);
  const schedules = snap.data?.schedules ?? [];

  return (
    <section
      data-testid={`schedules-group-${ensembleName}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
    >
      <h3 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 16, fontWeight: 500 }}>
        {ensembleName}
      </h3>
      {snap.isError ? (
        <div role="alert" data-testid={`error-schedules-${ensembleName}`} style={errorCardStyle}>
          {snap.error?.message}
        </div>
      ) : schedules.length === 0 ? (
        <div className="dim" style={{ fontSize: 13, padding: '4px 12px' }}>
          No schedules.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {schedules.map((s) => (
            <article
              key={s.name}
              data-testid={`schedule-row-${ensembleName}-${s.name}`}
              data-schedule-type={s.type}
              style={compactRowStyle}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontFamily: 'var(--ff-display)' }}>{s.name}</span>
                <span style={{ ...monoStyle, fontSize: 11, color: 'var(--dim)' }}>{s.type}</span>
              </div>
              <div className="dim" style={{ fontSize: 12 }}>
                → {s.target} · next {s.nextFireAt}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <section
      data-testid="screen-schedules"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 24, fontWeight: 400 }}>
        Schedules
      </h1>
      {children}
    </section>
  );
}

