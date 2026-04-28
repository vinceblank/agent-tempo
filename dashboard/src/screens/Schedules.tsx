/**
 * Schedules — durable message-delivery rules per ensemble (PR-F1 of #389).
 *
 * Mirrors `screens.jsx:Schedules` (lines 436-481): PageHeader with
 * "+ New schedule" action, then a 6-column table inside a `.panel`.
 * Mobile (≤520px) collapses to stacked cards via the `data-label` rule
 * in `components.css`.
 *
 * **Data source**: aggregates per-ensemble snapshots from
 * `useEnsembleList` + `useEnsembleSnapshot`. The daemon doesn't yet
 * expose a `/v1/schedules` aggregate endpoint; the same N+1 caveat as
 * `Overview` applies (one snapshot fetch per ensemble). PR-7+ may add
 * a dedicated aggregate if scale grows.
 *
 * Action buttons (`Edit`, `Cancel`, `New schedule`) all surface
 * `disabled-with-tooltip` until PR-7 wires the safe-write paths.
 */
import { useEffect, type ReactNode } from 'react';
import type { ScheduleEntry } from 'claude-tempo/types';
import { PageHeader } from '../components/PageHeader';
import { DisabledWithTooltip } from '../components/DisabledWithTooltip';
import { useEnsembleList, useEnsembleSnapshot } from '../lib/queries';
import { useSseSubscription } from '../lib/sse';
import { logEvent } from '../lib/log';
import { formatRelativeAge } from '../lib/time-format';
import { errorPanelStyle, emptyCardStyle } from '../lib/screen-styles';

const COL_HEADERS = ['Name', 'Target', 'Cadence', 'Kind', 'Next fire'] as const;
const PR7_REASON = 'Schedule writes wire up in PR-7 of #389.';

export function Schedules() {
  useEffect(() => {
    logEvent('screen.opened', { screen: 'schedules' });
  }, []);
  const list = useEnsembleList();
  const ensembles = list.data ?? [];

  return (
    <main className="main" data-testid="screen-schedules">
      <PageHeader
        title="Schedules"
        subtitle={
          <>
            Durable message deliveries via{' '}
            <span className="mono">claudeSchedulerWorkflow</span>.
          </>
        }
        actions={
          <DisabledWithTooltip
            testId="schedules-action-new"
            action="schedules.new"
            reason={PR7_REASON}
          >
            + New schedule
          </DisabledWithTooltip>
        }
      />
      <div className="page-pad scroll">{renderBody(list, ensembles)}</div>
    </main>
  );
}

function renderBody(
  list: ReturnType<typeof useEnsembleList>,
  ensembles: ReadonlyArray<{ name: string }>,
): ReactNode {
  if (list.isError) {
    return (
      <div role="alert" data-testid="schedules-error" style={errorPanelStyle}>
        {list.error?.message ?? 'Failed to load ensembles'}
      </div>
    );
  }
  if (list.isLoading) {
    return (
      <div
        data-testid="schedules-loading"
        data-resource="schedules"
        className="dim"
        style={{ padding: 'var(--density-pad)' }}
      >
        Loading ensembles…
      </div>
    );
  }
  if (ensembles.length === 0) {
    return (
      <div data-testid="schedules-empty" className="dim" style={emptyCardStyle}>
        No ensembles running, so no schedules to show.
      </div>
    );
  }
  return (
    <div className="panel">
      <table className="table" data-testid="schedules-table">
        <thead>
          <tr>
            {COL_HEADERS.map((c) => (
              <th key={c}>{c}</th>
            ))}
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {ensembles.map((e) => (
            <EnsembleScheduleRows key={e.name} ensembleName={e.name} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnsembleScheduleRows({ ensembleName }: { ensembleName: string }) {
  const snap = useEnsembleSnapshot(ensembleName);
  // Live updates via SSE — `schedules.changed` events project into the
  // same cache key as the snapshot, so the table stays current.
  useSseSubscription(ensembleName);

  if (snap.isError) {
    return (
      <tr data-testid={`schedules-error-${ensembleName}`}>
        <td colSpan={COL_HEADERS.length + 1} role="alert" style={{ color: 'var(--accent)' }}>
          {ensembleName}: {snap.error?.message}
        </td>
      </tr>
    );
  }
  const schedules = snap.data?.schedules ?? [];
  if (schedules.length === 0) return null;

  return (
    <>
      {schedules.map((s) => (
        <ScheduleRow key={`${ensembleName}-${s.name}`} ensembleName={ensembleName} s={s} />
      ))}
    </>
  );
}

function ScheduleRow({
  ensembleName,
  s,
}: {
  ensembleName: string;
  s: ScheduleEntry;
}) {
  const baseTestId = `schedule-row-${ensembleName}-${s.name}`;
  const cadence = describeCadence(s);
  return (
    <tr data-testid={baseTestId} data-schedule-type={s.type}>
      <td className="mono">
        <span className="accent">⧗</span> {s.name}
      </td>
      <td data-label="Target">
        <span className="mono">{s.target}</span>
      </td>
      <td data-label="Cadence" className="mono" style={{ color: 'var(--text-2)' }}>
        {cadence}
      </td>
      <td data-label="Kind">
        <KindBadge type={s.type} />
      </td>
      <td
        data-label="Next fire"
        className="mono"
        style={{ color: 'var(--accent)' }}
      >
        {formatNextFire(s.nextFireAt)}
      </td>
      <td style={{ textAlign: 'right' }}>
        <DisabledWithTooltip
          testId={`${baseTestId}-edit`}
          action="schedules.edit"
          reason={PR7_REASON}
        >
          Edit
        </DisabledWithTooltip>
        <DisabledWithTooltip
          testId={`${baseTestId}-cancel`}
          action="schedules.cancel"
          reason={PR7_REASON}
        >
          Cancel
        </DisabledWithTooltip>
      </td>
    </tr>
  );
}

function KindBadge({ type }: { type: ScheduleEntry['type'] }) {
  // `cron` + `interval` are recurring; `once` is a single-shot.
  // Recurring renders in `--info`, once in `--warn` per the canonical
  // design's accent-coding for the badge.
  const isRecurring = type === 'cron' || type === 'interval';
  return (
    <span
      className="type-badge"
      style={{
        color: isRecurring ? 'var(--info)' : 'var(--warn)',
        borderColor: 'var(--rule-strong)',
        background: 'transparent',
      }}
    >
      {type}
    </span>
  );
}

/** Describe a schedule's cadence as a single mono-friendly string. */
function describeCadence(s: ScheduleEntry): string {
  if (s.cronExpression) return s.cronExpression;
  if (s.type === 'interval' && s.interval !== undefined) {
    return `every ${formatIntervalMs(s.interval)}`;
  }
  if (s.type === 'once') return 'once';
  return '—';
}

/** Compact ISO → "in Xs" / "in Xm" / "in Xh" / "Xs ago". */
function formatNextFire(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const deltaMs = t - Date.now();
  if (deltaMs <= 0) return formatRelativeAge(iso);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  return `in ${hr}h`;
}

/** Compact "5m" / "1h30m" / "2d" — for the `interval` type. */
function formatIntervalMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin ? `${hr}h${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
