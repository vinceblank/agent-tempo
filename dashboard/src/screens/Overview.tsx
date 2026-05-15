/**
 * Overview screen — PR-B of #389. Rebuilt from `screens.jsx:Overview`
 * (lines 4-93 of the v3 design bundle) on top of PR-A1's primitives.
 *
 * Layout (sticky page-header above scrolling page-pad, per components.css):
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Overview   ● 3 ensembles · 13 players · 4 hosts        │  PageHeader
 *   │ All ensembles, rolled up. Tap one to dive in.   ↻ + ⊕  │  + actions
 *   ├────────────────────────────────────────────────────────┤
 *   │  I / RUNNING                                           │  SectionHead
 *   │  Active ensembles                                      │
 *   │  ┌──────────┐ ┌──────────┐ ┌──────────┐                │  ensemble-grid
 *   │  │ @demo    │ │ @other   │ │ @api-svc │                │
 *   │  └──────────┘ └──────────┘ └──────────┘                │
 *   │                                                        │
 *   │  II / RECENT       <across all ensembles>              │  SectionHead
 *   │  ┌────────────────────────────────────────────────┐    │  Recent activity
 *   │  │ 14:23  ROUTE   my-band · conductor → critic    │    │  panel
 *   │  │ 14:22  MESSAGE my-band · lead → ensemble       │    │
 *   │  └────────────────────────────────────────────────┘    │
 *   └────────────────────────────────────────────────────────┘
 *
 * Per audit rev 4 PR-B: the page-header is pushed into the AppShell
 * slot via {@link useScreenPageHeader}, so the default operator chrome
 * (density slider + theme toggle) is replaced by Overview's own
 * Refresh + New ensemble actions. PR-G eventually moves the chrome to
 * `/settings`.
 *
 * Recent activity event-log is wire-pending (Q5 graceful-degrade
 * decision in audit rev 4): the cross-ensemble ClusterEvent stream
 * isn't surfaced through `/v1/events?global=true` to the dashboard
 * yet (Task #15, beta.8). We render the panel chrome + an honest
 * empty-state row rather than copying the design's mock event list,
 * which would lie to users about what's running.
 */
import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Btn } from '../components/Btn';
import { EnsembleCard } from '../components/EnsembleCard';
import { PageHeader } from '../components/PageHeader';
import { SectionHead } from '../components/SectionHead';
import { useScreenPageHeader } from '../components/AppShell';
import { useEnsembleList, useHosts, ENSEMBLES_QUERY_KEY, HOSTS_QUERY_KEY } from '../lib/queries';
import { logEvent } from '../lib/log';
import { emptyCardStyle, errorPanelStyle, monoStyle } from '../lib/screen-styles';

function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

interface StatPillProps {
  testId: string;
  count: number;
  label: string;
  pluralLabel?: string;
  showDot?: boolean;
}
function StatPill({ testId, count, label, pluralLabel, showDot }: StatPillProps) {
  return (
    <span className="page-pill" data-testid={testId}>
      {showDot && <span className="pill-dot" />}
      <span className="pill-num">{count}</span>
      {pluralize(count, label, pluralLabel)}
    </span>
  );
}

export function Overview() {
  const list = useEnsembleList();
  const hostsQuery = useHosts();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const ensembles = list.data;
  const stats = useMemo(() => {
    const list = ensembles ?? [];
    return {
      ensembles: list.length,
      players: list.reduce((sum, e) => sum + (e.playerCount ?? 0), 0),
      hosts: hostsQuery.data?.length ?? 0,
      hasRunning: list.some((e) => e.playerCount > 0),
    };
  }, [ensembles, hostsQuery.data]);

  const onRefresh = useCallback(() => {
    logEvent('overview.refresh', {});
    void qc.invalidateQueries({ queryKey: ENSEMBLES_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: HOSTS_QUERY_KEY });
  }, [qc]);

  const onNewEnsemble = useCallback(() => {
    logEvent('overview.new-ensemble.click', {});
    navigate('/create-ensemble');
  }, [navigate]);

  // Stable across refetches so the AppShell slot doesn't re-set every tick.
  const renderHeader = useCallback(
    () => (
      <PageHeader
        title="Overview"
        pills={
          <>
            <StatPill
              testId="overview-stat-ensembles"
              count={stats.ensembles}
              label="ensemble"
              showDot={stats.hasRunning}
            />
            <StatPill testId="overview-stat-players" count={stats.players} label="player" />
            <StatPill testId="overview-stat-hosts" count={stats.hosts} label="host" />
          </>
        }
        subtitle="All ensembles, rolled up. Tap one to dive in."
        actions={
          <>
            <Btn
              variant="ghost"
              size="sm"
              icon="↻"
              data-testid="overview-refresh"
              onClick={onRefresh}
              aria-label="Refresh"
            >
              Refresh
            </Btn>
            <Btn
              variant="primary"
              size="sm"
              icon="+"
              data-testid="overview-new-ensemble"
              onClick={onNewEnsemble}
              aria-label="New ensemble"
            >
              New ensemble
            </Btn>
          </>
        }
      />
    ),
    [stats, onRefresh, onNewEnsemble],
  );
  useScreenPageHeader(renderHeader);

  if (list.isLoading) {
    return (
      <section data-testid="screen-overview">
        <div
          data-testid="loading"
          data-resource="ensemble-list"
          className="dim"
          style={{ padding: 'var(--density-pad)' }}
        >
          Loading ensembles…
        </div>
      </section>
    );
  }

  if (list.isError) {
    return (
      <section data-testid="screen-overview">
        <div role="alert" data-testid="error-ensemble-list" style={errorPanelStyle}>
          {list.error?.message ?? 'Failed to load ensembles'}
        </div>
      </section>
    );
  }

  return (
    <section data-testid="screen-overview">
      <SectionHead kicker="I / RUNNING" title="Active ensembles" />
      {stats.ensembles === 0 ? (
        <div data-testid="overview-empty" className="dim" style={emptyCardStyle}>
          No ensembles are running. Open a terminal and run{' '}
          <code style={monoStyle}>agent-tempo up &lt;name&gt;</code> to start one.
        </div>
      ) : (
        <div className="ensemble-grid">
          {(ensembles ?? []).map((e) => (
            <EnsembleCard key={e.name} ensemble={e} />
          ))}
        </div>
      )}

      <RecentActivity />
    </section>
  );
}

function RecentActivity() {
  return (
    <div
      style={{ marginTop: 'calc(var(--density-gap) * 1.5)' }}
      data-testid="overview-recent-activity"
    >
      <SectionHead
        kicker="II / RECENT"
        title="Recent activity"
        right={
          <span className="mono dim" style={{ fontSize: 11 }}>
            across all ensembles
          </span>
        }
      />
      <div className="panel">
        <div className="panel-body flush event-log">
          <div
            className="event-row"
            data-testid="overview-recent-activity-empty"
            style={{ display: 'flex', justifyContent: 'center', color: 'var(--dim)' }}
          >
            <span>No recent activity. Cross-ensemble event stream coming soon.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
