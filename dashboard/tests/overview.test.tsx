/**
 * Overview screen tests — rendered inside a mocked router so the
 * EnsembleCard's `<Link>` resolves cleanly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Overview } from '../src/screens/Overview';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderOverview(client: MockDashboardClient, qc = newQc()) {
  __setDashboardClientForTests(client);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider> as ReactNode,
  );
}

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('Overview screen', () => {
  it('renders an empty-state when no ensembles are running', async () => {
    const mock = new MockDashboardClient({ ensembles: [] });
    renderOverview(mock);
    await waitFor(() => {
      expect(screen.getByTestId('overview-empty')).toBeInTheDocument();
    });
  });

  it('renders one card per ensemble with the required testids', async () => {
    const mock = new MockDashboardClient({
      ensembles: [
        { name: 'demo', playerCount: 2, hasConductor: true, state: 'online' },
        { name: 'other', playerCount: 1, hasConductor: false, state: 'paused' },
      ],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [
          {
            playerId: 'maestro', ensemble: 'demo', hostname: 'h',
            isConductor: true, agentType: 'claude',
            phase: 'attached', part: '', workDir: '/r',
          },
          {
            playerId: 's1', ensemble: 'demo', hostname: 'h',
            isConductor: false, agentType: 'claude',
            phase: 'attached', part: '', workDir: '/r',
          },
        ],
      }),
    });
    renderOverview(mock);
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo')).toBeInTheDocument();
      expect(screen.getByTestId('ensemble-card-other')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ensemble-card-demo-link')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo-player-count')).toBeInTheDocument();
    });
  });

  it('shows role=alert error when ensemble list query fails', async () => {
    const mock = new MockDashboardClient({
      ensemblesError: new Error('boom'),
    });
    renderOverview(mock);
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('data-testid', 'error-ensemble-list');
    });
    expect(screen.getByTestId('error-ensemble-list').textContent).toMatch(/boom/);
  });

  it('emits a snapshot.error log on snapshot fetch failure', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 1, hasConductor: false, state: 'online' }],
      snapshotError: new Error('snapshot-fail'),
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderOverview(mock);
    await waitFor(() => {
      const messages = consoleWarn.mock.calls.flat().map(String);
      expect(messages.some((m) => m.includes('[claude-tempo:dashboard]') && m.includes('snapshot.error'))).toBe(true);
    });
  });
});
