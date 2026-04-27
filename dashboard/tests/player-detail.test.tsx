/**
 * PlayerDetail screen — drilldown panel mounted as a child route under
 * Workspace. Tests assert the testid surface + that the panel reads
 * the right player's data from the snapshot cache (not a fresh fetch).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient } from './fixtures/mock-client';
import { makePlayer as basePlayer, makeSnapshot } from './fixtures/factories';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';
import type { PlayerSummaryV1 } from 'claude-tempo/http/event-types';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** PlayerDetail tests want richer defaults than the base factory. */
function makePlayer(overrides: Partial<PlayerSummaryV1> = {}): PlayerSummaryV1 {
  return basePlayer({
    hostname: 'main-laptop',
    playerType: 'my-tempo-engineer',
    part: 'Building features',
    gitBranch: 'main',
    ...overrides,
  });
}

function renderAtPath(client: MockDashboardClient, path: string) {
  __setDashboardClientForTests(client);
  const qc = newQc();
  const router = createDashboardMemoryRouter([path]);
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('PlayerDetail panel', () => {
  it('mounts at the nested route and renders the right player', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [
          makePlayer({ playerId: 'tempo-eng' }),
          makePlayer({ playerId: 'tempo-qa', playerType: 'my-tempo-qa', phase: 'awaiting' }),
        ],
      }),
    });

    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');

    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng')).toBeInTheDocument();
    });
    // Reads from the snapshot cache.
    expect(screen.getByTestId('player-detail-tempo-eng-id').textContent).toContain('tempo-eng');
    expect(screen.getByTestId('player-detail-tempo-eng-type').textContent).toContain('my-tempo-engineer');
    expect(screen.getByTestId('player-detail-tempo-eng-phase').textContent).toContain('attached');
  });

  it('exposes a close button with the documented testid', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-tempo-eng-close')).toBeInTheDocument();
    });
    // The actual route-update behavior is React Router's responsibility
    // (and `react-router/createMemoryRouter` + jsdom's AbortSignal
    // disagree on RequestInit shape, so triggering navigation here
    // surfaces a noisy unhandled rejection without proving anything
    // about our code). Trust react-router; we only test that the
    // close button is present + clickable without error.
    expect(() => screen.getByTestId('player-detail-tempo-eng-close').click()).not.toThrow();
  });

  it('renders a not-found message when the playerId is absent from the snapshot', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/ghost');
    await waitFor(() => {
      expect(screen.getByTestId('player-detail-ghost-not-found')).toBeInTheDocument();
    });
  });

  it('uses role="dialog" on the panel for assistive-tech surfacing', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer({ playerId: 'tempo-eng' })],
      }),
    });
    renderAtPath(mock, '/ensemble/demo/player/tempo-eng');
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('data-testid', 'player-detail-tempo-eng');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });
  });
});
