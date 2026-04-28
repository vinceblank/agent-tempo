/**
 * Loadouts — library of reusable ensemble lineups (PR-F1 of #389).
 *
 * Mirrors `screens.jsx:Loadouts` (lines 329-382): PageHeader with
 * "Import YAML" + "New loadout" actions, then a 6-column table inside
 * a `.panel`. Mobile (≤520px) collapses to stacked cards via the
 * `data-label` rule in `components.css`.
 *
 * **Data source**: `useLineups()` against `/v1/lineups` (#400). Eager
 * fallback to `lineups-catalog.SHIPPED_LINEUPS` while the query loads
 * (and on error) so the table is always populated — same pattern the
 * Recruit / CreateEnsemble / PlayerTypes wizards use post-DB2.
 *
 * Action buttons (`Edit`, `Load`, `Import YAML`, `New loadout`) all
 * surface `disabled-with-tooltip` until PR-7 wires the safe-write
 * paths.
 */
import { useEffect } from 'react';
import type { LineupRow } from '../lib/client';
import { PageHeader } from '../components/PageHeader';
import { DisabledWithTooltip } from '../components/DisabledWithTooltip';
import { logEvent } from '../lib/log';
import { useLineups } from '../lib/queries';
import { SHIPPED_LINEUPS } from '../lib/lineups-catalog';

const COL_HEADERS = ['Name', 'Summary', 'Players', 'Source', 'Last used'] as const;
const PR7_REASON = 'Loadout writes wire up in PR-7 of #389.';

export function Loadouts() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'loadouts' });
  }, []);

  const lineupsQuery = useLineups();
  // Eager fallback — table is populated immediately from the bundled
  // catalog while the wire loads, then swaps to wire data once the
  // query resolves. The shapes diverge slightly: the local
  // `LoadoutEntry` carries a `summary` + `lastUsed`; the wire
  // `LineupRow` exposes `description` + no last-used. Adapter logic
  // in `LoadoutRow` handles both.
  const lineups: ReadonlyArray<LineupRow> = lineupsQuery.data ?? SHIPPED_LINEUPS;

  return (
    <main className="main" data-testid="screen-loadouts">
      <PageHeader
        title="Loadouts"
        subtitle={
          <>
            Reusable ensemble lineups. Loaded via{' '}
            <span className="mono">claude-tempo up --lineup</span> or from here.
          </>
        }
        actions={
          <>
            <DisabledWithTooltip
              testId="loadouts-action-import"
              action="loadouts.import-yaml"
              reason={PR7_REASON}
            >
              ↑ Import YAML
            </DisabledWithTooltip>
            <DisabledWithTooltip
              testId="loadouts-action-new"
              action="loadouts.new"
              reason={PR7_REASON}
            >
              + New loadout
            </DisabledWithTooltip>
          </>
        }
      />
      <div className="page-pad scroll">
        <div className="panel">
          <table className="table" data-testid="loadouts-table">
            <thead>
              <tr>
                {COL_HEADERS.map((c) => (
                  <th key={c} className={c === 'Players' ? 'num' : undefined}>
                    {c}
                  </th>
                ))}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {lineups.length === 0 ? (
                <tr data-testid="loadouts-empty">
                  <td colSpan={COL_HEADERS.length + 1} className="dim" style={{ textAlign: 'center', padding: 18 }}>
                    No loadouts available yet.
                  </td>
                </tr>
              ) : (
                lineups.map((l) => <LoadoutRow key={l.name} l={l} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function LoadoutRow({ l }: { l: LineupRow }) {
  return (
    <tr data-testid={`loadouts-row-${l.name}`}>
      <td className="mono">
        <span className="accent">≡</span> {l.name}
      </td>
      <td
        data-label="Summary"
        style={{ color: 'var(--text-2)', fontSize: 12.5, maxWidth: 320 }}
      >
        {l.description ?? '—'}
      </td>
      <td data-label="Players" className="num">
        {l.players}
      </td>
      <td data-label="Source">
        <span className="mono dim" style={{ fontSize: 11 }}>
          {l.source}
        </span>
      </td>
      {/* `Last used` is wire-pending — no daemon-side timestamp ships
        * with `/v1/lineups` today, so degrade to `—` per the audit's
        * graceful-degrade rule. */}
      <td data-label="Last used" className="mono dim" style={{ fontSize: 11.5 }}>
        —
      </td>
      <td style={{ textAlign: 'right' }}>
        <DisabledWithTooltip
          testId={`loadouts-row-${l.name}-edit`}
          action="loadouts.edit"
          reason={PR7_REASON}
        >
          Edit
        </DisabledWithTooltip>
        <DisabledWithTooltip
          testId={`loadouts-row-${l.name}-load`}
          action="loadouts.load"
          reason={PR7_REASON}
        >
          ▶ Load
        </DisabledWithTooltip>
      </td>
    </tr>
  );
}
