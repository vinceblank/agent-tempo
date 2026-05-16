/**
 * Orphans screen — #579. Surfaces cluster-wide cross-host orphan
 * candidates so an operator on one host can recover sessions that were
 * left behind by another (downed daemon, crash without orderly destroy).
 *
 * Source: `GET /v1/orphans` via {@link useOrphans}. View-only in v1 —
 * the only action is "copy the migrate command" the daemon already
 * rendered server-side. Click-to-restore / click-to-destroy were
 * deliberately excluded per the design (architect doc + brief DO-NOT).
 *
 * Layout mirrors `Hosts.tsx`:
 *   - 5 columns (Player · Ensemble · Host · Status · Action)
 *   - Soft amber border around the panel (orphan = something needs
 *     attention but not a hard failure)
 *   - Empty state copy: "No cross-host orphans. The cluster is tidy."
 *
 * Testability:
 *   - `data-testid="screen-orphans"` on the section
 *   - `data-testid="orphan-row-${workflowId}"` per row
 *   - `data-testid="orphan-row-${workflowId}-{player,ensemble,host,liveness,migrate-copy}"`
 *     on per-cell controls
 *   - `data-testid="orphans-empty"` / `orphans-error` / `loading` (resource=orphans)
 *   - `data-testid="orphans-rescan"` on the header action button
 */
import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { OrphanV1 } from 'agent-tempo/http/event-types';
import { Btn } from '../components/Btn';
import { PageHeader } from '../components/PageHeader';
import { useScreenPageHeader } from '../components/AppShell';
import { useOrphans, ORPHANS_QUERY_KEY } from '../lib/queries';
import { logEvent } from '../lib/log';
import { emptyCardStyle, errorPanelStyle, monoStyle } from '../lib/screen-styles';
import { formatRelativeAge } from '../lib/time-format';

const LIVENESS_GLYPH: Record<OrphanV1['hostLiveness'], string> = {
  live: '●',
  stale: '◐',
  missing: '✗',
};

const LIVENESS_COLOR: Record<OrphanV1['hostLiveness'], string> = {
  live: 'var(--ok)',
  stale: 'var(--warn)',
  missing: 'var(--err, var(--warn))',
};

const PANEL_STYLE: React.CSSProperties = {
  border: '1px solid var(--warn-border, var(--warn))',
  borderRadius: 'var(--radius, 6px)',
  // The amber tint is deliberately soft — orphans are an attention
  // signal, not a hard alert. Avoids dashboard "alert fatigue."
  background: 'var(--warn-bg, transparent)',
};

export function Orphans() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'orphans' });
  }, []);
  const orphans = useOrphans();
  const qc = useQueryClient();

  const onRescan = useCallback(() => {
    logEvent('orphans.rescan', {});
    void qc.invalidateQueries({ queryKey: ORPHANS_QUERY_KEY });
  }, [qc]);

  const renderHeader = useCallback(
    () => (
      <PageHeader
        title="Orphans"
        subtitle={
          <>
            Cross-host orphan sessions — adapters that left the cluster without
            an orderly destroy. Paste the <span className="mono">/migrate</span>{' '}
            command into a local session to recover.
          </>
        }
        actions={
          <Btn
            variant="ghost"
            size="sm"
            icon="⟳"
            data-testid="orphans-rescan"
            onClick={onRescan}
          >
            Re-scan
          </Btn>
        }
      />
    ),
    [onRescan],
  );
  useScreenPageHeader(renderHeader);

  if (orphans.isLoading) {
    return (
      <Layout>
        <div
          data-testid="loading"
          data-resource="orphans"
          className="dim"
          style={{ padding: 'var(--density-pad)' }}
        >
          Loading orphans…
        </div>
      </Layout>
    );
  }

  if (orphans.isError) {
    return (
      <Layout>
        <div role="alert" data-testid="orphans-error" style={errorPanelStyle}>
          {orphans.error?.message ?? 'Failed to load orphans'}
        </div>
      </Layout>
    );
  }

  const list = orphans.data?.orphans ?? [];

  if (list.length === 0) {
    return (
      <Layout>
        <div data-testid="orphans-empty" className="dim" style={emptyCardStyle}>
          No cross-host orphans. The cluster is tidy.{' '}
          <a href="/docs/ops/cross-host-orphans.md" className="mono dim">
            (what's an orphan?)
          </a>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="panel" style={PANEL_STYLE}>
        <table className="table" data-testid="orphans-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Ensemble</th>
              <th>Host</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <OrphanRow key={o.workflowId} orphan={o} />
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

interface OrphanRowProps {
  orphan: OrphanV1;
}

function OrphanRow({ orphan }: OrphanRowProps) {
  const id = orphan.workflowId;
  const onCopy = useCallback(() => {
    // navigator.clipboard isn't available in older test environments —
    // guard so the row still renders even when the API is missing.
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(orphan.migrateCommand);
    }
    logEvent('orphans.copy-migrate', {
      workflowId: orphan.workflowId,
      ensemble: orphan.ensemble,
    });
  }, [orphan.migrateCommand, orphan.workflowId, orphan.ensemble]);

  // Workflow ids look like `agent-session-<ensemble>-<player>` —
  // surface just the trailing player segment + a hover-title with the
  // full id so the column stays scannable.
  const workflowIdShort = orphan.workflowId.length > 28
    ? '…' + orphan.workflowId.slice(-26)
    : orphan.workflowId;

  return (
    <tr data-testid={`orphan-row-${id}`} data-liveness={orphan.hostLiveness}>
      <td data-label="Player" data-testid={`orphan-row-${id}-player`} className="mono">
        <div>{orphan.playerId}</div>
        <div className="mono dim" style={{ fontSize: '0.85em' }} title={orphan.workflowId}>
          {workflowIdShort}
        </div>
      </td>
      <td data-label="Ensemble" data-testid={`orphan-row-${id}-ensemble`} className="mono">
        {orphan.ensemble}
      </td>
      <td data-label="Host" data-testid={`orphan-row-${id}-host`} className="mono">
        {orphan.preferredHost ?? <span className="dim">(unknown)</span>}
      </td>
      <td data-label="Status" data-testid={`orphan-row-${id}-liveness`} className="mono">
        <span
          style={{ color: LIVENESS_COLOR[orphan.hostLiveness] }}
          aria-label={`host ${orphan.hostLiveness}`}
        >
          {LIVENESS_GLYPH[orphan.hostLiveness]}
        </span>{' '}
        {orphan.hostLiveness}{' '}
        {orphan.detachedSince && (
          <span className="dim" style={{ fontSize: '0.85em' }}>
            ({formatRelativeAge(orphan.detachedSince)})
          </span>
        )}
      </td>
      <td data-label="Action">
        <Btn
          variant="ghost"
          size="sm"
          data-testid={`orphan-row-${id}-migrate-copy`}
          title={orphan.migrateCommand}
          onClick={onCopy}
        >
          📋 Copy <span style={monoStyle}>/migrate</span>
        </Btn>
      </td>
    </tr>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <section data-testid="screen-orphans" style={{ display: 'flex', flexDirection: 'column' }}>
      {children}
    </section>
  );
}
