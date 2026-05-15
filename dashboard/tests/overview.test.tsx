/**
 * Overview screen tests — rendered inside a mocked router so the
 * EnsembleCard's `<Link>` resolves cleanly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { HostInfo } from 'claude-tempo/types';
import { AppShell } from '../src/components/AppShell';
import { Overview } from '../src/screens/Overview';
import { MockDashboardClient, makeSnapshot } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

interface RenderOpts {
  client: MockDashboardClient;
  qc?: QueryClient;
  initialPath?: string;
  /**
   * When true, wraps Overview in AppShell so the PageHeader pushed via
   * `useScreenPageHeader` actually renders (its testids — pills, refresh,
   * new-ensemble — only show inside the slot). Most tests need this; only
   * the snapshot-error logging test renders bare since AppShell isn't
   * relevant to its assertion.
   */
  withShell?: boolean;
}

function renderOverview({
  client,
  qc = newQc(),
  initialPath = '/',
  withShell = true,
}: RenderOpts) {
  __setDashboardClientForTests(client);
  const overview = withShell ? (
    <AppShell>
      <Overview />
    </AppShell>
  ) : (
    <Overview />
  );
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={overview} />
          <Route
            path="/create-ensemble"
            element={<div data-testid="probe-create-ensemble">create</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider> as ReactNode,
  );
}

/**
 * Minimal HostInfo factory — Overview only reads `hosts.length`, so the
 * inner profile/instance fields can be cheap stubs without losing
 * coverage of the count logic.
 */
function host(hostname: string): HostInfo {
  return {
    hostname,
    instances: [],
    recruitReady: true,
    freshness: 'live',
    profile: {
      hostname,
      version: '0.28.0',
      defaultAgent: 'claude',
      platform: 'linux',
      capabilities: [],
    },
    profileStaleness: 'fresh',
  };
}

afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('Overview screen', () => {
  it('renders an empty-state when no ensembles are running', async () => {
    const mock = new MockDashboardClient({ ensembles: [] });
    renderOverview({ client: mock });
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
    renderOverview({ client: mock });
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo')).toBeInTheDocument();
      expect(screen.getByTestId('ensemble-card-other')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ensemble-card-demo-link')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('ensemble-card-demo-player-count')).toBeInTheDocument();
    });
  });

  it('EnsembleCard preview puts the conductor first AND keeps it in a 7-player slice (#462)', async () => {
    // The latent dropout case the conductor-first sort exists to prevent:
    // EnsembleCard previews the first 5 players via `players.slice(0, 5)`.
    // A 7-player ensemble whose conductor sorts late alphabetically would
    // push the conductor past the slice and silently drop it from the
    // card. With the sort, the conductor lands at index 0 regardless.
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'big', playerCount: 7, hasConductor: true, state: 'online' }],
      snapshot: makeSnapshot({
        ensemble: 'big',
        hasConductor: true,
        players: [
          { playerId: 'alpha', ensemble: 'big', hostname: 'h', isConductor: false, agentType: 'claude', phase: 'attached', part: '', workDir: '/r' },
          { playerId: 'bravo', ensemble: 'big', hostname: 'h', isConductor: false, agentType: 'claude', phase: 'attached', part: '', workDir: '/r' },
          { playerId: 'charlie', ensemble: 'big', hostname: 'h', isConductor: false, agentType: 'claude', phase: 'attached', part: '', workDir: '/r' },
          { playerId: 'delta', ensemble: 'big', hostname: 'h', isConductor: false, agentType: 'claude', phase: 'attached', part: '', workDir: '/r' },
          { playerId: 'echo', ensemble: 'big', hostname: 'h', isConductor: false, agentType: 'claude', phase: 'attached', part: '', workDir: '/r' },
          { playerId: 'foxtrot', ensemble: 'big', hostname: 'h', isConductor: false, agentType: 'claude', phase: 'attached', part: '', workDir: '/r' },
          { playerId: 'zulu-conductor', ensemble: 'big', hostname: 'h', isConductor: true, agentType: 'claude', phase: 'attached', part: '', workDir: '/r' },
        ],
      }),
    });
    renderOverview({ client: mock });

    // The card mounts immediately; the player avatars only appear after
    // the card's own snapshot fetch resolves. Use `findBy` for the first
    // avatar (the conductor) which acts as a paint-after-snapshot fence.
    await screen.findByTestId('player-avatar-zulu-conductor');
    const card = screen.getByTestId('ensemble-card-big');
    const avatars = Array.from(card.querySelectorAll<HTMLElement>('[data-testid^="player-avatar-"]'));
    // Card previews 5; assert the conductor is in there AND it's first.
    expect(avatars).toHaveLength(5);
    expect(avatars[0].getAttribute('data-testid')).toBe('player-avatar-zulu-conductor');
    // The remaining 4 slots are the alphabetically earliest non-conductors.
    expect(avatars.slice(1).map((a) => a.getAttribute('data-testid'))).toEqual([
      'player-avatar-alpha',
      'player-avatar-bravo',
      'player-avatar-charlie',
      'player-avatar-delta',
    ]);
  });

  it('shows role=alert error when ensemble list query fails', async () => {
    const mock = new MockDashboardClient({
      ensemblesError: new Error('boom'),
    });
    renderOverview({ client: mock });
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
    renderOverview({ client: mock });
    await waitFor(() => {
      const messages = consoleWarn.mock.calls.flat().map(String);
      expect(messages.some((m) => m.includes('[agent-tempo:dashboard]') && m.includes('snapshot.error'))).toBe(true);
    });
  });

  it('quick-stat pills render the rolled-up counts (with singular/plural)', async () => {
    const mock = new MockDashboardClient({
      ensembles: [
        { name: 'a', playerCount: 4, hasConductor: true, state: 'online' },
        { name: 'b', playerCount: 9, hasConductor: false, state: 'online' },
      ],
      hosts: [host('h1'), host('h2'), host('h3')],
    });
    renderOverview({ client: mock });
    await waitFor(() => {
      // Plural form (2 ensembles).
      expect(screen.getByTestId('overview-stat-ensembles').textContent).toContain('2');
      expect(screen.getByTestId('overview-stat-ensembles').textContent).toMatch(/ensembles$/);
      // Sum across ensembles (4 + 9).
      expect(screen.getByTestId('overview-stat-players').textContent).toContain('13');
      expect(screen.getByTestId('overview-stat-players').textContent).toMatch(/players$/);
      expect(screen.getByTestId('overview-stat-hosts').textContent).toContain('3');
      expect(screen.getByTestId('overview-stat-hosts').textContent).toMatch(/hosts$/);
    });
  });

  it('quick-stat pills singularize on count=1', async () => {
    const mock = new MockDashboardClient({
      ensembles: [{ name: 'solo', playerCount: 1, hasConductor: false, state: 'online' }],
      hosts: [host('only')],
    });
    renderOverview({ client: mock });
    await waitFor(() => {
      expect(screen.getByTestId('overview-stat-ensembles').textContent).toMatch(/1\s*ensemble$/);
      expect(screen.getByTestId('overview-stat-players').textContent).toMatch(/1\s*player$/);
      expect(screen.getByTestId('overview-stat-hosts').textContent).toMatch(/1\s*host$/);
    });
  });

  it('Refresh button invalidates the ensembles + hosts queries', async () => {
    const mock = new MockDashboardClient({ ensembles: [], hosts: [] });
    const qc = newQc();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderOverview({ client: mock, qc });
    // Wait for the header to mount before clicking.
    await waitFor(() => {
      expect(screen.getByTestId('overview-refresh')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('overview-refresh'));
    // Two invalidations (ensembles + hosts), in either order.
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      ([opts]) => (opts as { queryKey?: unknown[] } | undefined)?.queryKey,
    );
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([['ensembles'], ['hosts']]),
    );
  });

  it('+ New ensemble navigates to /create-ensemble', async () => {
    const mock = new MockDashboardClient({ ensembles: [], hosts: [] });
    renderOverview({ client: mock });
    await waitFor(() => {
      expect(screen.getByTestId('overview-new-ensemble')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('overview-new-ensemble'));
    await waitFor(() => {
      expect(screen.getByTestId('probe-create-ensemble')).toBeInTheDocument();
    });
  });

  it('renders the recent-activity panel + empty-state placeholder', async () => {
    const mock = new MockDashboardClient({ ensembles: [], hosts: [] });
    renderOverview({ client: mock });
    await waitFor(() => {
      expect(screen.getByTestId('overview-recent-activity')).toBeInTheDocument();
    });
    // Empty-state row is wire-pending per Q5 (#438 removed version reference).
    expect(screen.getByTestId('overview-recent-activity-empty')).toBeInTheDocument();
    expect(screen.getByTestId('overview-recent-activity-empty').textContent).toMatch(/coming soon/);
  });
});
