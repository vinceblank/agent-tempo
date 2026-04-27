/**
 * Schedules screen — verifies aggregation across ensembles + per-row testids.
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

describe('Schedules screen', () => {
  it('renders empty state when no ensembles are running', async () => {
    renderScreen(new MockDashboardClient({ ensembles: [] }));
    await waitFor(() => {
      expect(screen.getByTestId('schedules-empty')).toBeInTheDocument();
    });
  });

  it('renders one schedule row per (ensemble, schedule)', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        schedules: [
          {
            name: 'morning-stand-up', target: 'conductor', message: 'standup',
            createdBy: 'maestro', nextFireAt: '2026-04-27T09:00:00.000Z',
            firedCount: 5, type: 'cron',
          },
          {
            name: 'release-checklist', target: 'tempo-eng', message: 'release-check',
            createdBy: 'maestro', nextFireAt: '2026-04-27T17:00:00.000Z',
            firedCount: 0, type: 'once',
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
});
