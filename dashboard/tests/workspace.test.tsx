/**
 * Workspace screen tests — render the screen behind a memory router
 * with a snapshot fixture, then verify testids + logEvents + the
 * conductor-derivation contract (#358).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient } from './fixtures/mock-client';
import { makePlayer, makeSnapshot } from './fixtures/factories';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWorkspace(client: MockDashboardClient, initialPath = '/ensemble/demo') {
  __setDashboardClientForTests(client);
  const qc = newQc();
  const router = createDashboardMemoryRouter([initialPath]);
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

describe('Workspace screen', () => {
  it('renders the workspace testid + roster + chat-log when the snapshot lands', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'demo', playerCount: 2, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [
          makePlayer({ playerId: 'tempo-conductor', isConductor: true, playerType: 'tempo-conductor' }),
          makePlayer({ playerId: 'tempo-eng', playerType: 'my-tempo-engineer' }),
        ],
      }),
    });
    renderWorkspace(mock);

    // `roster` only renders in the data-loaded branch, so wait for it
    // explicitly instead of `workspace-demo` (which the loading branch
    // also renders).
    expect(await screen.findByTestId('roster')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-demo')).toBeInTheDocument();
    expect(screen.getByTestId('chat-log-demo')).toBeInTheDocument();
    expect(screen.getByTestId('player-row-tempo-conductor')).toBeInTheDocument();
    expect(screen.getByTestId('player-row-tempo-eng')).toBeInTheDocument();
  });

  it('marks exactly the conductor row with conductor-indicator (#358 derivation)', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        hasConductor: true,
        players: [
          // Non-conductor first to prove the derivation walks the array
          // (mirrors the TUI's #358 regression test).
          makePlayer({ playerId: 'tempo-eng' }),
          makePlayer({ playerId: 'boss', isConductor: true, playerType: 'tempo-conductor' }),
        ],
      }),
    });
    renderWorkspace(mock);

    // Wait for the data branch (roster only renders post-snapshot).
    await screen.findByTestId('roster');
    const indicators = screen.getAllByTestId('conductor-indicator');
    expect(indicators).toHaveLength(1);
    // The conductor-indicator is nested inside the conductor's row,
    // so the closest ancestor `[data-testid^="player-row"]` identifies
    // which player owns it.
    const ownerRow = indicators[0].closest('[data-testid^="player-row-"]');
    expect(ownerRow).toHaveAttribute('data-testid', 'player-row-boss');
  });

  it('emits workspace.opened logEvent on mount', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo', players: [makePlayer()] }),
    });
    renderWorkspace(mock);
    await waitFor(() => {
      const lines = (console.info as unknown as { mock: { calls: string[][] } }).mock.calls
        .flat()
        .map(String);
      expect(
        lines.some(
          (l) => l.includes('[claude-tempo:dashboard]') && l.includes('workspace.opened'),
        ),
      ).toBe(true);
    });
  });

  it('renders an empty-roster message when no players are present', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({ ensemble: 'demo', players: [], hasConductor: false }),
    });
    renderWorkspace(mock);
    const roster = await screen.findByTestId('roster');
    expect(roster.textContent).toMatch(/Empty ensemble/);
  });

  it('shows the chat-log compressed-gap banner when chat is empty + hasMore is true', async () => {
    const mock = new MockDashboardClient({
      snapshot: makeSnapshot({
        ensemble: 'demo',
        players: [makePlayer()],
        chat: { messages: [], total: 12, hasMore: true },
      }),
    });
    renderWorkspace(mock);
    await waitFor(() => {
      expect(screen.getByTestId('chat-log-demo-compressed-gap')).toBeInTheDocument();
    });
  });

  it('surfaces a role=alert error when the snapshot fails', async () => {
    const mock = new MockDashboardClient({ snapshotError: new Error('snapshot-down') });
    renderWorkspace(mock);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByTestId('error-workspace-demo').textContent).toMatch(/snapshot-down/);
  });
});
