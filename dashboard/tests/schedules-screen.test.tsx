/**
 * Schedules screen — verifies the rebuilt table layout (PR-F1 of #389).
 *
 * Aggregates schedules across every ensemble from `useEnsembleList` +
 * `useEnsembleSnapshot`, then renders one `<tr>` per (ensemble,
 * schedule) inside a single table.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Schedules } from '../src/screens/Schedules';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderScreen(client: MockDashboardClient) {
  __setDashboardClientForTests(client);
  return render(
    <QueryClientProvider client={newQc()}>
      <MemoryRouter><Schedules /></MemoryRouter>
    </QueryClientProvider> as ReactNode,
  );
}
afterEach(() => __setDashboardClientForTests(null));

describe('Schedules screen — header', () => {
  it('renders PageHeader + the New schedule action (disabled-with-tooltip)', () => {
    renderScreen(new MockDashboardClient({ ensembles: [] }));
    expect(screen.getByTestId('page-header').textContent).toContain('Schedules');
    const action = screen.getByTestId('schedules-action-new');
    expect(action).toHaveAttribute('aria-disabled', 'true');
    expect(action.getAttribute('title')).toMatch(/PR-7/);
  });
});

describe('Schedules screen — empty state', () => {
  it('renders empty state when no ensembles are running', async () => {
    renderScreen(new MockDashboardClient({ ensembles: [] }));
    await waitFor(() => {
      expect(screen.getByTestId('schedules-empty')).toBeInTheDocument();
    });
  });
});

describe('Schedules screen — table', () => {
  it('renders one schedule row per (ensemble, schedule)', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        schedules: [
          {
            name: 'morning-stand-up',
            target: 'conductor',
            message: 'standup',
            createdBy: 'maestro',
            nextFireAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            firedCount: 5,
            type: 'cron',
            cronExpression: '0 9 * * 1-5',
          },
          {
            name: 'release-checklist',
            target: 'tempo-eng',
            message: 'release-check',
            createdBy: 'maestro',
            nextFireAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            firedCount: 0,
            type: 'once',
          },
        ],
      }),
    });
    renderScreen(mock);
    await waitFor(() => {
      expect(screen.getByTestId('schedule-row-demo-morning-stand-up')).toBeInTheDocument();
      expect(screen.getByTestId('schedule-row-demo-release-checklist')).toBeInTheDocument();
    });
  });

  it('every middle <td> carries data-label for the mobile-card collapse', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        schedules: [{
          name: 's1',
          target: 'conductor',
          message: 'm',
          createdBy: 'maestro',
          nextFireAt: new Date(Date.now() + 1000).toISOString(),
          firedCount: 0,
          type: 'cron',
          cronExpression: '*/5 * * * *',
        }],
      }),
    });
    const { container } = renderScreen(mock);
    await waitFor(() => {
      expect(screen.getByTestId('schedule-row-demo-s1')).toBeInTheDocument();
    });
    const row = container.querySelector('[data-testid="schedule-row-demo-s1"]') as HTMLTableRowElement;
    const cells = row.querySelectorAll('td');
    const labels = Array.from(cells)
      .slice(1, cells.length - 1)
      .map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['Target', 'Cadence', 'Kind', 'Next fire']);
  });

  it('cron schedules surface the cron expression in the Cadence column', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        schedules: [{
          name: 'cron-job',
          target: 'tempo-eng',
          message: 'm',
          createdBy: 'maestro',
          nextFireAt: new Date(Date.now() + 60_000).toISOString(),
          firedCount: 1,
          type: 'cron',
          cronExpression: '0 9 * * 1-5',
        }],
      }),
    });
    renderScreen(mock);
    await waitFor(() => {
      expect(screen.getByTestId('schedule-row-demo-cron-job').textContent).toContain('0 9 * * 1-5');
    });
  });

  it('row carries data-schedule-type and exposes Edit + Cancel CTAs', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        schedules: [{
          name: 'one-shot',
          target: 'tempo-eng',
          message: 'm',
          createdBy: 'maestro',
          nextFireAt: new Date(Date.now() + 30_000).toISOString(),
          firedCount: 0,
          type: 'once',
        }],
      }),
    });
    renderScreen(mock);
    await waitFor(() => {
      const row = screen.getByTestId('schedule-row-demo-one-shot');
      expect(row).toHaveAttribute('data-schedule-type', 'once');
    });
    expect(screen.getByTestId('schedule-row-demo-one-shot-edit')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('schedule-row-demo-one-shot-cancel')).toHaveAttribute('aria-disabled', 'true');
  });
});
