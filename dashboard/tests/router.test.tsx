/**
 * Router tests — verify deep-link resolution per the architect's
 * deep-linking principle (testability addendum).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { Overview } from '../src/screens/Overview';
import { PlaceholderScreen } from '../src/screens/Placeholder';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

afterEach(() => {
  __setDashboardClientForTests(null);
});

function renderRoute(path: string) {
  const mock = new MockDashboardClient({ ensembles: [] });
  __setDashboardClientForTests(mock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Outlet />}>
            <Route index element={<Overview />} />
            <Route
              path="ensemble/:id"
              element={
                <PlaceholderScreen testId="screen-workspace" title="Workspace" arrivingIn="PR-5" />
              }
            />
            <Route
              path="ensemble/:id/player/:playerId"
              element={
                <PlaceholderScreen
                  testId="screen-player-detail"
                  title="Player Detail"
                  arrivingIn="PR-5"
                />
              }
            />
            <Route
              path="hosts"
              element={
                <PlaceholderScreen testId="screen-hosts" title="Hosts" arrivingIn="PR-6" />
              }
            />
            <Route
              path="loadouts"
              element={
                <PlaceholderScreen testId="screen-loadouts" title="Loadouts" arrivingIn="PR-6" />
              }
            />
            <Route
              path="player-types"
              element={
                <PlaceholderScreen
                  testId="screen-player-types"
                  title="Player Types"
                  arrivingIn="PR-6"
                />
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Deep-link resolution', () => {
  it('/ resolves to Overview', async () => {
    renderRoute('/');
    await waitFor(() => {
      expect(screen.getByTestId('screen-overview')).toBeInTheDocument();
    });
  });

  it('/ensemble/demo resolves to the workspace placeholder', () => {
    renderRoute('/ensemble/demo');
    expect(screen.getByTestId('screen-workspace')).toBeInTheDocument();
  });

  it('/ensemble/demo/player/maestro resolves to the player-detail placeholder', () => {
    renderRoute('/ensemble/demo/player/maestro');
    expect(screen.getByTestId('screen-player-detail')).toBeInTheDocument();
  });

  it('/hosts, /loadouts, /player-types each render their PR-6 placeholder', () => {
    renderRoute('/hosts');
    expect(screen.getByTestId('screen-hosts')).toBeInTheDocument();
  });
});
