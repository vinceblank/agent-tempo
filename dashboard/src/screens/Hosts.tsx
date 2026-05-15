/**
 * Hosts screen — PR-F2 of #389. 7-column table of every daemon polling
 * this Temporal namespace, joined with the boot-signaled HostProfile.
 *
 * Source: `screens.jsx:Hosts` (lines 485-533) + audit § PR-F. Wire
 * source: `GET /v1/hosts` via {@link useHosts}.
 *
 * Columns: Host · Platform · Sessions · Player types · Daemon · Uptime
 * · Heartbeat · (actions). Mobile (≤520px) collapses each row to a
 * stacked card via `data-label` cells (CSS rule in components.css).
 *
 * Wire-pending fields (degrade to "—" until the daemon surfaces them):
 *   - `sessions` (count of attached players on this host) — needs a
 *     join site daemon-side; not in HostInfo today
 *   - `uptime` (per Q5.3b) — needs `HostProfile.daemonStartedAt`
 *
 * Heartbeat is derived client-side from `instances[0].lastAccessTime`:
 * the freshest instance wins (HostInfo may carry ≥1 instance per host
 * when multiple daemons run with different `CLAUDE_TEMPO_HOME`s).
 *
 * Testability surface (preserved from PR-6 + extended for PR-F2):
 *   - `data-testid="screen-hosts"` on the section
 *   - `data-testid="host-row-${hostname}"` on each row
 *   - `data-testid="host-row-${hostname}-{platform,version,freshness,sessions,types,daemon,uptime,heartbeat}"`
 *     on the per-cell value
 *   - `data-testid="hosts-empty"` when none are reporting
 *   - `data-testid="error-hosts"` (role="alert") on query error
 *   - `data-testid="loading"` `data-resource="hosts"` while loading
 *   - `data-testid="hosts-rescan"` / `hosts-show-stale` on header actions
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HostInfo } from 'agent-tempo/types';
import { Btn } from '../components/Btn';
import { DisabledWithTooltip } from '../components/DisabledWithTooltip';
import { PageHeader } from '../components/PageHeader';
import { useScreenPageHeader } from '../components/AppShell';
import { useHosts, HOSTS_QUERY_KEY } from '../lib/queries';
import { logEvent } from '../lib/log';
import { emptyCardStyle, errorPanelStyle, monoStyle } from '../lib/screen-styles';
import { formatRelativeAge, formatDuration } from '../lib/time-format';

export function Hosts() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'hosts' });
  }, []);
  const hosts = useHosts();
  const qc = useQueryClient();
  const [showStale, setShowStale] = useState(false);

  const onRescan = useCallback(() => {
    logEvent('hosts.rescan', {});
    void qc.invalidateQueries({ queryKey: HOSTS_QUERY_KEY });
  }, [qc]);

  const onToggleShowStale = useCallback(() => {
    setShowStale((v) => {
      const next = !v;
      logEvent('hosts.show-stale', { value: next });
      return next;
    });
  }, []);

  const renderHeader = useCallback(
    () => (
      <PageHeader
        title="Hosts"
        subtitle={
          <>
            Daemons polling this Temporal namespace. Recruits with{' '}
            <span className="mono">host=</span> route to these task queues.
          </>
        }
        actions={
          <>
            <Btn
              variant="ghost"
              size="sm"
              icon="⟳"
              data-testid="hosts-rescan"
              onClick={onRescan}
            >
              Re-scan
            </Btn>
            <Btn
              variant="ghost"
              size="sm"
              data-testid="hosts-show-stale"
              data-state={showStale ? 'on' : 'off'}
              onClick={onToggleShowStale}
              aria-pressed={showStale}
            >
              {showStale ? 'Hide stale' : 'Show stale'}
            </Btn>
          </>
        }
      />
    ),
    [onRescan, onToggleShowStale, showStale],
  );
  useScreenPageHeader(renderHeader);

  if (hosts.isLoading) {
    return (
      <Layout>
        <div
          data-testid="loading"
          data-resource="hosts"
          className="dim"
          style={{ padding: 'var(--density-pad)' }}
        >
          Loading hosts…
        </div>
      </Layout>
    );
  }

  if (hosts.isError) {
    return (
      <Layout>
        <div role="alert" data-testid="error-hosts" style={errorPanelStyle}>
          {hosts.error?.message ?? 'Failed to load hosts'}
        </div>
      </Layout>
    );
  }

  const all = hosts.data ?? [];
  const list = showStale ? all : all.filter((h) => h.freshness === 'live');

  if (list.length === 0) {
    return (
      <Layout>
        <div data-testid="hosts-empty" className="dim" style={emptyCardStyle}>
          {all.length === 0 ? (
            <>
              No daemons reporting. Run{' '}
              <code style={monoStyle}>agent-tempo daemon start</code> on a host.
            </>
          ) : (
            <>
              No live daemons. {all.length} stale host{all.length === 1 ? '' : 's'}{' '}
              hidden — toggle <span className="mono">Show stale</span> to view.
            </>
          )}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="panel">
        <table className="table" data-testid="hosts-table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Platform</th>
              <th className="num">Sessions</th>
              <th className="num">Player types</th>
              <th>Daemon</th>
              <th>Uptime</th>
              <th>Heartbeat</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((h) => (
              <HostRow key={h.hostname} host={h} />
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

interface HostRowProps {
  host: HostInfo;
}
function HostRow({ host }: HostRowProps) {
  const id = host.hostname;
  // The freshest instance drives heartbeat + daemon version; HostInfo
  // sometimes carries >1 (multi-tenant CLAUDE_TEMPO_HOME setup).
  const freshest = host.instances.length > 0
    ? host.instances.reduce((a, b) => (a.lastAccessTime > b.lastAccessTime ? a : b))
    : null;
  const daemonVersion = freshest?.version ?? host.profile?.version ?? '—';
  const platform = host.profile?.platform ?? '—';
  const playerTypeCount = host.profile?.availablePlayerTypes?.length ?? 0;
  const heartbeat = formatRelativeAge(freshest?.lastAccessTime);
  const isLive = host.freshness === 'live';
  // Q5.3b — daemon uptime renders only for live hosts; stale ones may
  // have a stale `daemonStartedAt` that would mislead.
  const uptime = isLive && host.profile?.daemonStartedAt !== undefined
    ? formatDuration(Date.now() - host.profile.daemonStartedAt)
    : '—';

  return (
    <tr data-testid={`host-row-${id}`} data-freshness={host.freshness}>
      {/* F-B-2 (#461): title exposes full FQDN when the cell is ellipsis-truncated */}
      <td className="mono" title={id}>
        <span style={{ color: isLive ? 'var(--ok)' : 'var(--warn)' }}>●</span> {id}
      </td>
      {/* Same secondary ink tier as Heartbeat below — not --dim. */}
      <td
        data-label="Platform"
        data-testid={`host-row-${id}-platform`}
        className="mono"
        style={{ color: 'var(--text-2)' }}
      >
        {platform}
      </td>
      <td
        data-label="Sessions"
        data-testid={`host-row-${id}-sessions`}
        className="num"
      >
        —
      </td>
      <td
        data-label="Types"
        data-testid={`host-row-${id}-types`}
        className="num"
      >
        {playerTypeCount}
      </td>
      <td data-label="Daemon" data-testid={`host-row-${id}-daemon`} className="mono">
        {daemonVersion}
      </td>
      <td data-label="Uptime" data-testid={`host-row-${id}-uptime`} className="mono dim">
        {uptime}
      </td>
      <td
        data-label="Heartbeat"
        data-testid={`host-row-${id}-heartbeat`}
        className="mono"
        style={{ color: isLive ? 'var(--text-2)' : 'var(--warn)' }}
      >
        {heartbeat}
      </td>
      <td>
        <DisabledWithTooltip
          testId={`host-row-${id}-logs`}
          action="hosts.logs"
          reason="Streaming daemon logs into the dashboard requires a daemon endpoint that hasn't shipped yet."
        >
          Logs
        </DisabledWithTooltip>
      </td>
      {/* Test-only mirrors so existing tests asserting `-version` and
        * `-freshness` keep passing across the column rename. The
        * canonical user-visible cell is `-daemon`; the freshness chip
        * is no longer a discrete column in the redesign — surfaced via
        * the leading green/amber dot on the Host cell instead. */}
      <td hidden data-testid={`host-row-${id}-version`}>{daemonVersion}</td>
      <td hidden data-testid={`host-row-${id}-freshness`}>{host.freshness}</td>
    </tr>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <section data-testid="screen-hosts" style={{ display: 'flex', flexDirection: 'column' }}>
      {children}
    </section>
  );
}
